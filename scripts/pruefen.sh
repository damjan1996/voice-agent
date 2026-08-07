#!/usr/bin/env bash
# =============================================================================
#  pruefen.sh — Konfiguration durchgehen, bevor der erste Anruf kommt
# =============================================================================
#  Sagt bei jedem Punkt, was zu tun ist, wenn er fehlt. Ein Prüfskript, das
#  nur "FEHLER" sagt, verlagert die Arbeit bloß.
# =============================================================================

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

B='\033[1m'; GR='\033[0;32m'; GE='\033[0;33m'; RO='\033[0;31m'; GA='\033[0;90m'; A='\033[0m'

fehler=0
warnungen=0

ok()   { echo -e "  ${GR}✓${A} $1"; }
warn() { echo -e "  ${GE}!${A} $1"; [[ -n "${2:-}" ]] && echo -e "      ${GA}$2${A}"; warnungen=$((warnungen+1)); }
bad()  { echo -e "  ${RO}✗${A} $1"; [[ -n "${2:-}" ]] && echo -e "      ${GA}$2${A}"; fehler=$((fehler+1)); }

echo
echo -e "${B}Voice-Agent — Konfiguration prüfen${A}"
echo

# --- .env --------------------------------------------------------------------
echo -e "${B}Konfigurationsdatei${A}"
if [[ ! -f .env ]]; then
  bad ".env fehlt" "cp .env.example .env && make schluessel"
  echo; exit 1
fi
ok ".env vorhanden"
set -a; source <(grep -E '^[A-Z_][A-Z0-9_]*=' .env); set +a

muss() {
  local name="$1" hinweis="${2:-}"
  local wert="${!name:-}"
  if [[ -z "$wert" ]]; then bad "$name fehlt" "$hinweis"; else ok "$name"; fi
}
kann() {
  local name="$1" hinweis="${2:-}"
  local wert="${!name:-}"
  if [[ -z "$wert" ]]; then warn "$name fehlt" "$hinweis"; else ok "$name"; fi
}

muss DB_PASSWORD          "make schluessel"
muss N8N_ENCRYPTION_KEY   "make schluessel — danach NIE mehr ändern"
muss CONTROL_API_TOKEN    "make schluessel"
muss VOICE_WEBHOOK_TOKEN  "make schluessel"
muss ELEVENLABS_API_KEY   "elevenlabs.io → Profil → API Keys"
muss VOICE_WEBHOOK_BASE   "z.B. https://voice.damjan-savic.com/webhook/voice"
kann OWNER_PHONE          "ohne sie kann der Agent nicht durchstellen"
kann N8N_API_KEY          "n8n → Settings → n8n API → Create API key"
kann ELEVENLABS_AGENT_ID  "entsteht bei: make agent"
kann ELEVENLABS_WEBHOOK_SECRET "wird bei 'make agent' einmalig ausgegeben"
kann GOOGLE_KALENDER_PRIMAER   "ohne ihn kann der Agent keine Termine vergeben"

if [[ -f google-service-account.json ]]; then
  ok "Google-Dienstkonto hinterlegt"
else
  warn "kein Google-Kalenderzugang" "node scripts/google-kalender.mjs"
fi

if [[ "${GOOGLE_KALENDER_PRIMAER:-}" == "primary" ]]; then
  bad "GOOGLE_KALENDER_PRIMAER steht auf 'primary'" \
      "Bei einem Dienstkonto zeigt 'primary' auf dessen leeren Kalender. Der Agent hielte dann alles für frei und würde in bestehende Termine buchen. Echte Kalender-ID eintragen (meist die E-Mail-Adresse)."
fi

if [[ "${OWNER_PHONE:-}" == "+49XXXXXXXXXX" ]]; then
  bad "OWNER_PHONE ist noch der Platzhalter" "echte Nummer in E.164 eintragen"
fi
echo

# --- Ports -------------------------------------------------------------------
#  Zwei Fragen: Hört überhaupt etwas auf dem Port, und sind wir das selbst?
#  Der Prozessname aus "ss" hilft dabei nicht — Docker bindet die Ports als
#  root, und ohne root sieht man den Namen nicht. Deshalb wird zuerst
#  gefragt, ob unsere eigenen Container laufen.
echo -e "${B}Ports${A}"
hoert_jemand() { ss -tln 2>/dev/null | grep -qE "[:.]$1[[:space:]]"; }

laufende=$(docker compose ps --status running --format '{{.Name}}' 2>/dev/null | tr '\n' ' ')

for eintrag in "${DB_PORT:-5435}:Postgres:voiceagent-db" \
               "${N8N_LOCAL_PORT:-5679}:n8n:voiceagent-n8n" \
               "${CONTROL_API_PORT:-3010}:Control-API:voiceagent-control"; do
  IFS=: read -r port wer container <<< "$eintrag"

  if [[ " $laufende " == *" $container "* ]]; then
    hoert_jemand "$port" && ok "$port — unser $wer läuft" \
                         || bad "$container läuft, hört aber nicht auf $port"
  elif hoert_jemand "$port"; then
    bad "$port ist belegt, aber nicht von uns" \
        "Wer? sudo ss -tlnp | grep :$port — dann anderen Port in der .env wählen"
  else
    ok "$port frei ($wer)"
  fi
done
echo

# --- Werkzeuge ---------------------------------------------------------------
echo -e "${B}Werkzeuge${A}"
for w in docker node curl openssl python3; do
  if command -v "$w" >/dev/null 2>&1; then ok "$w"; else bad "$w fehlt"; fi
done
docker compose version >/dev/null 2>&1 && ok "docker compose" || bad "docker compose fehlt"

# make ist kein Muss — jedes Ziel hat einen direkten Aufruf. Aber die ganze
# Dokumentation ist in make-Befehlen geschrieben, deshalb muss das Fehlen
# gesagt werden, statt dass jemand an "command not found" hängenbleibt.
if command -v make >/dev/null 2>&1; then
  ok "make"
else
  warn "make ist nicht installiert" \
       "Die Doku nutzt make-Befehle. Entweder 'sudo apt install make', oder direkt:
        make hoch     → docker compose up -d
        make status   → bash scripts/status.sh
        make pruefen  → bash scripts/pruefen.sh
        make agent    → node scripts/provision-elevenlabs.mjs
        make import   → node scripts/import-n8n-workflows.mjs
        make test     → cd control-api && npm test
        make sichern  → bash scripts/sichern.sh"
fi
echo

# --- Fremdsysteme ------------------------------------------------------------
echo -e "${B}Fremdsysteme${A}"

if [[ -n "${ELEVENLABS_API_KEY:-}" ]]; then
  antwort=$(curl -s -m 15 -H "xi-api-key: $ELEVENLABS_API_KEY" \
            https://api.elevenlabs.io/v1/user/subscription 2>/dev/null)
  tarif=$(echo "$antwort" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tier","?"))' 2>/dev/null)
  if [[ -z "$tarif" || "$tarif" == "?" ]]; then
    bad "ElevenLabs-Schlüssel wird abgelehnt"
  elif [[ "$tarif" == "free" ]]; then
    warn "ElevenLabs-Tarif: free" \
         "Der freie Tarif hat 15 Gesprächsminuten pro Monat und erlaubt KEINE Telefonnummern. Zum Telefonieren braucht es mindestens Starter (6 \$/Monat, 75 Minuten)."
  else
    ok "ElevenLabs erreichbar (Tarif: $tarif)"
  fi
fi

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' https://api.anthropic.com/v1/models \
         -H "x-api-key: $ANTHROPIC_API_KEY" -H 'anthropic-version: 2023-06-01' 2>/dev/null)
  [[ "$code" == "200" ]] && ok "Anthropic erreichbar" || bad "Anthropic antwortet mit HTTP $code"
fi

if [[ -n "${N8N_DOMAIN:-}" ]]; then
  aufgeloest=$(getent hosts "$N8N_DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
  if [[ -z "$aufgeloest" ]]; then
    bad "$N8N_DOMAIN löst nicht auf" "A-Record auf die Server-IP setzen"
  else
    ok "$N8N_DOMAIN → $aufgeloest"
  fi
  # Nicht die Datei in /etc/letsencrypt/live/ prüfen — die ist nur für root
  # lesbar, und dieses Skript läuft als normaler Benutzer. Es meldete
  # deshalb "kein Zertifikat", während längst eines ausgeliefert wurde.
  # Was zählt, ist ohnehin nicht die Datei, sondern was am Port ankommt.
  zert=$(echo | timeout 15 openssl s_client -servername "$N8N_DOMAIN" \
         -connect "$N8N_DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null)

  if [[ -n "$zert" ]]; then
    bis="${zert#notAfter=}"
    tage=$(( ($(date -d "$bis" +%s 2>/dev/null || echo 0) - $(date +%s)) / 86400 ))
    if   (( tage > 21 )); then ok "TLS-Zertifikat gültig, noch $tage Tage"
    elif (( tage > 0 ));  then warn "TLS-Zertifikat läuft in $tage Tagen ab" "sudo certbot renew"
    else                       bad "TLS-Zertifikat ist abgelaufen" "sudo certbot renew --force-renewal"
    fi
  else
    warn "kein gültiges Zertifikat an $N8N_DOMAIN:443" \
         "sudo bash deploy/nginx-einrichten.sh"
  fi
fi
echo

# --- Ergebnis ----------------------------------------------------------------
if (( fehler )); then
  echo -e "${RO}${fehler} Fehler${A}, ${warnungen} Hinweise. Die Fehler blockieren den Betrieb."
  exit 1
elif (( warnungen )); then
  echo -e "${GR}Keine Fehler${A}, ${GE}${warnungen} Hinweise${A}. Läuft, aber nicht vollständig."
else
  echo -e "${GR}Alles in Ordnung.${A}"
fi
echo
