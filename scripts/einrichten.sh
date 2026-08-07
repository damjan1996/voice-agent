#!/usr/bin/env bash
# =============================================================================
#  einrichten.sh — Erstinstallation, Schritt für Schritt
# =============================================================================
#  Führt durch die Reihenfolge und hält an, wo eine Entscheidung oder ein
#  Klick im Browser nötig ist. Jeder Schritt lässt sich einzeln wiederholen.
# =============================================================================

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

B='\033[1m'; GR='\033[0;32m'; GE='\033[0;33m'; GA='\033[0;90m'; A='\033[0m'

schritt() { echo; echo -e "${B}▸ $1${A}"; }
weiter()  { echo; read -rp "$(echo -e "${GA}[Enter] weiter · [s] überspringen · [a] abbrechen ${A}")" x
            case "$x" in a|A) echo "abgebrochen"; exit 0;; s|S) return 1;; *) return 0;; esac; }

echo
echo -e "${B}Voice-Agent — Erstinstallation${A}"
echo -e "${GA}Alles hier ist wiederholbar. Nichts wird gelöscht.${A}"

# --- 1 -----------------------------------------------------------------------
schritt "1/7  Konfigurationsdatei"
if [[ -f .env ]]; then
  echo -e "  ${GR}✓${A} .env ist vorhanden"
else
  cp .env.example .env && chmod 600 .env
  echo -e "  ${GR}✓${A} .env aus der Vorlage angelegt"
  echo
  echo -e "${GE}  Geheimnisse erzeugen und eintragen:${A}"
  echo
  make -s schluessel
  echo -e "${GE}  Außerdem eintragen: OWNER_PHONE, ELEVENLABS_API_KEY${A}"
  weiter || true
fi

# --- 2 -----------------------------------------------------------------------
schritt "2/7  Container starten"
if weiter; then
  docker compose up -d
  echo -e "  ${GA}warte, bis die Datenbank bereit ist …${A}"
  for _ in $(seq 1 30); do
    docker compose exec -T postgres pg_isready -q 2>/dev/null && break
    sleep 2
  done
  echo -e "  ${GR}✓${A} läuft"
fi

# --- 3 -----------------------------------------------------------------------
schritt "3/7  n8n einrichten"
set -a; [[ -f .env ]] && source <(grep -E '^[A-Z_][A-Z0-9_]*=' .env); set +a
PORT="${N8N_LOCAL_PORT:-5679}"

if [[ -z "${N8N_API_KEY:-}" ]]; then
  cat <<TEXT

  n8n läuft, hat aber noch kein Konto. Öffne einen Tunnel und richte es ein:

    ssh -L ${PORT}:127.0.0.1:${PORT} $(whoami)@\$(hostname -I | awk '{print $1}')

  Dann im Browser: http://127.0.0.1:${PORT}
    a) Eigentümerkonto anlegen
    b) Settings → n8n API → Create API key
    c) Schlüssel in die .env als N8N_API_KEY

TEXT
  weiter || true
  set -a; source <(grep -E '^[A-Z_][A-Z0-9_]*=' .env); set +a
fi
[[ -n "${N8N_API_KEY:-}" ]] && echo -e "  ${GR}✓${A} N8N_API_KEY gesetzt" \
                             || echo -e "  ${GE}!${A} N8N_API_KEY fehlt weiterhin"

# --- 4 -----------------------------------------------------------------------
schritt "4/7  Agent bei ElevenLabs anlegen"
echo -e "  ${GA}Legt Wissensbasis, Werkzeuge, Webhooks und den Agent an.${A}"
if weiter; then
  node scripts/provision-elevenlabs.mjs || true
  echo
  echo -e "${GE}  Falls oben ELEVENLABS_AGENT_ID oder ELEVENLABS_WEBHOOK_SECRET${A}"
  echo -e "${GE}  ausgegeben wurden: jetzt in die .env eintragen.${A}"
  echo -e "${GE}  Das Geheimnis ist NUR JETZT sichtbar.${A}"
  weiter || true
  docker compose up -d control-api >/dev/null 2>&1
fi

# --- 5 -----------------------------------------------------------------------
schritt "5/7  Workflows nach n8n"
if weiter; then
  node scripts/import-n8n-workflows.mjs || true
fi

# --- 6 -----------------------------------------------------------------------
schritt "6/7  Google-Kalender"
cat <<TEXT

  Die Zugangsdaten liegen in n8n, nicht in der .env. In der n8n-Oberfläche:

    Credentials → New → "Google Calendar OAuth2 API"

  Wichtig: Den Zustimmungsbildschirm in der Google Cloud Console auf
  "In Production" veröffentlichen. Bleibt er auf "Testing", verfällt das
  Refresh-Token nach genau 7 Tagen und der Kalender ist wieder tot.

  Der headless-Weg über ein Dienstkonto ist in docs/03-einrichtung.md
  beschrieben — der kann dafür keine Teilnehmer zu Terminen einladen.

  Danach in der .env: GOOGLE_KALENDER_PRIMAER und GOOGLE_KALENDER_IDS
  auf die echte Kalender-ID setzen (meist die E-Mail-Adresse).
  NICHT "primary" eintragen — siehe Doku.

TEXT
weiter || true

# --- 7 -----------------------------------------------------------------------
schritt "7/7  Prüfen"
bash scripts/pruefen.sh || true

cat <<TEXT

$(echo -e "${B}Was jetzt noch fehlt${A}")

  1. nginx und Zertifikat:
       sudo cp deploy/nginx/voice-agent.conf /etc/nginx/sites-available/voice-agent
       sudo ln -s /etc/nginx/sites-available/voice-agent /etc/nginx/sites-enabled/
       sudo certbot --nginx -d ${N8N_DOMAIN:-voice.damjan-savic.com}
       sudo nginx -t && sudo systemctl reload nginx

  2. Rufnummer verbinden:
       node scripts/telefonnummer.mjs --hilfe

  3. WhatsApp-Bot anbinden:
       integration/whatsapp-bot/EINBAU.md

  4. Probelauf ohne Telefon:
       make test-anruf

TEXT
