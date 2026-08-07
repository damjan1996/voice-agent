#!/usr/bin/env bash
# =============================================================================
#  sichern.sh — Datenbanksicherung
# =============================================================================
#  Eigenes Skript statt nur eines Makefile-Ziels, aus zwei Gründen: make ist
#  nicht überall installiert, und ein Cronjob soll nicht über make laufen
#  müssen.
#
#    bash scripts/sichern.sh              nach backups/
#    bash scripts/sichern.sh /pfad/ziel   woandershin
#
#  Für die Nacht:
#    0 3 * * * cd /home/damjan/voice-agent && bash scripts/sichern.sh >/dev/null
#
#  Ein Fehlschlag ist hier NICHT still. Der frühere Einzeiler im Makefile
#  nahm den Exit-Code von gzip statt den von pg_dumpall — ein gescheiterter
#  Dump hinterließ eine gültige, leere Datei und die Meldung "Gesichert".
#  Aufgefallen wäre das erst beim Wiederherstellen.
# =============================================================================

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

GR='\033[0;32m'; GE='\033[0;33m'; RO='\033[0;31m'; GA='\033[0;90m'; A='\033[0m'

[[ -f .env ]] && { set -a; source <(grep -E '^[A-Z_][A-Z0-9_]*=' .env); set +a; }

ORDNER="${1:-backups}"
BENUTZER="${DB_USER:-voiceagent}"
# Unter dieser Größe kann kein echter Dump herauskommen — selbst eine leere
# Datenbank bringt mehr an Kopfzeilen mit.
MINDESTGROESSE=2000

mkdir -p "$ORDNER" || { echo -e "${RO}Kann $ORDNER nicht anlegen.${A}"; exit 1; }
ZIEL="$ORDNER/voiceagent-$(date +%Y%m%d-%H%M%S).sql.gz"

if ! docker compose exec -T postgres pg_dumpall -U "$BENUTZER" 2>/tmp/voiceagent-dump-err.txt | gzip > "$ZIEL"; then
  rm -f "$ZIEL"
  echo -e "${RO}Sicherung fehlgeschlagen.${A}"
  echo -e "${GA}$(head -3 /tmp/voiceagent-dump-err.txt 2>/dev/null)${A}"
  echo -e "${GA}Läuft die Datenbank? docker compose ps${A}"
  exit 1
fi

BYTES=$(gunzip -c "$ZIEL" 2>/dev/null | wc -c)
if [[ "$BYTES" -lt "$MINDESTGROESSE" ]]; then
  rm -f "$ZIEL"
  echo -e "${RO}Sicherung war leer ($BYTES Byte) — verworfen.${A}"
  echo -e "${GA}$(head -3 /tmp/voiceagent-dump-err.txt 2>/dev/null)${A}"
  exit 1
fi

# Eine Sicherung, die sich nicht entpacken lässt, ist keine.
gzip -t "$ZIEL" || { rm -f "$ZIEL"; echo -e "${RO}Datei ist beschädigt — verworfen.${A}"; exit 1; }

# Ein grober Blick in den Inhalt: Sind unsere Tabellen überhaupt drin?
if ! gunzip -c "$ZIEL" | grep -q "voice.agent_state"; then
  echo -e "${GE}Achtung: Im Dump fehlt voice.agent_state.${A}"
  echo -e "${GA}Die Datei bleibt liegen, aber bitte nachsehen, was gesichert wurde.${A}"
fi

rm -f /tmp/voiceagent-dump-err.txt
echo -e "${GR}Gesichert:${A} $ZIEL ($(du -h "$ZIEL" | cut -f1), $BYTES Byte entpackt)"

# Aufräumen, damit backups/ nicht unbegrenzt wächst. 30 Tage decken den
# Fall ab, dass jemand erst spät merkt, dass Daten fehlen.
ALT=$(find "$ORDNER" -name 'voiceagent-*.sql.gz' -mtime +30 2>/dev/null | wc -l)
if [[ "$ALT" -gt 0 ]]; then
  find "$ORDNER" -name 'voiceagent-*.sql.gz' -mtime +30 -delete
  echo -e "${GA}  $ALT Sicherung(en) älter als 30 Tage entfernt${A}"
fi
