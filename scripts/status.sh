#!/usr/bin/env bash
# =============================================================================
#  status.sh — Was läuft, und in welchem Zustand?
# =============================================================================
#  Erste Anlaufstelle, wenn etwas nicht stimmt. Geht von unten nach oben:
#  Container, dann Dienste, dann der fachliche Zustand.
# =============================================================================

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

B='\033[1m'; GR='\033[0;32m'; GE='\033[0;33m'; RO='\033[0;31m'; GA='\033[0;90m'; A='\033[0m'

if [[ -f .env ]]; then set -a; source <(grep -E '^[A-Z_][A-Z0-9_]*=' .env); set +a; fi

CONTROL="${CONTROL_API_URL:-http://127.0.0.1:${CONTROL_API_PORT:-3010}}"
N8N="${N8N_INTERN_URL:-http://127.0.0.1:${N8N_LOCAL_PORT:-5679}}"

echo
echo -e "${B}Voice-Agent${A}"
echo

# --- Container ---------------------------------------------------------------
echo -e "${B}Container${A}"
if ! docker compose ps --format '{{.Name}}\t{{.State}}\t{{.Status}}' 2>/dev/null | grep -q .; then
  echo -e "  ${RO}keine${A} — starten mit: make hoch"
else
  docker compose ps --format '{{.Name}}\t{{.State}}\t{{.Status}}' 2>/dev/null \
  | while IFS=$'\t' read -r name state status; do
      case "$state" in
        running) echo -e "  ${GR}●${A} ${name}  ${GA}${status}${A}" ;;
        exited)  echo -e "  ${GA}○${A} ${name}  ${GA}${status}${A}" ;;
        *)       echo -e "  ${RO}●${A} ${name}  ${GE}${status}${A}" ;;
      esac
    done
fi
echo

# --- Dienste -----------------------------------------------------------------
echo -e "${B}Erreichbarkeit${A}"

pruefe() {  # name url erwarteter_code
  local code
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$2" 2>/dev/null || echo 000)
  if [[ "$code" == "$3" ]]; then
    echo -e "  ${GR}✓${A} $1 ${GA}(HTTP $code)${A}"
  else
    echo -e "  ${RO}✗${A} $1 ${GE}(HTTP $code, erwartet $3)${A}"
  fi
}

pruefe "Control-API" "$CONTROL/healthz" 200
pruefe "n8n"         "$N8N/healthz"     200

if [[ -n "${N8N_BASE_URL:-}" ]]; then
  # 401 ist hier der Erfolg: die Route steht, die Control-API weist den
  # tokenlosen Aufruf ab. 404 hieße, n8n kennt den Webhook nicht.
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST \
         -H 'Content-Type: application/json' -d '{"__probe":true}' \
         "$N8N_BASE_URL/webhook/voice/init" 2>/dev/null || echo 000)
  if [[ "$code" == "404" ]]; then
    echo -e "  ${RO}✗${A} Webhook /voice/init ${GE}nicht registriert (HTTP 404)${A}"
    echo -e "      ${GA}docker compose restart n8n && sleep 30 && make import${A}"
  elif [[ "$code" == "000" ]]; then
    echo -e "  ${RO}✗${A} Webhook /voice/init ${GE}nicht erreichbar — DNS/nginx/Zertifikat prüfen${A}"
  else
    echo -e "  ${GR}✓${A} Webhook /voice/init ${GA}(HTTP $code)${A}"
  fi
fi
echo

# --- Fachlicher Zustand ------------------------------------------------------
if [[ -n "${CONTROL_API_TOKEN:-}" ]]; then
  antwort=$(curl -s -m 20 -H "Authorization: Bearer $CONTROL_API_TOKEN" "$CONTROL/v1/status" 2>/dev/null)
  if [[ -n "$antwort" ]] && echo "$antwort" | grep -q '"text"'; then
    echo "$antwort" | python3 -c "
import json,sys,re
d = json.load(sys.stdin)
t = d.get('text','')
t = re.sub(r'\*(.+?)\*', lambda m: '\033[1m'+m.group(1)+'\033[0m', t)
t = re.sub(r'_(.+?)_',  lambda m: '\033[3m'+m.group(1)+'\033[0m', t)
print(t)
" 2>/dev/null || echo "$antwort" | head -c 600
  else
    echo -e "  ${GE}Zustand nicht abrufbar — Token falsch oder Dienst noch am Hochfahren.${A}"
  fi
else
  echo -e "  ${GE}CONTROL_API_TOKEN fehlt in der .env.${A}"
fi

echo
echo -e "${GA}  n8n-Oberfläche:  ssh -L ${N8N_LOCAL_PORT:-5679}:127.0.0.1:${N8N_LOCAL_PORT:-5679} $(whoami)@\$(hostname)${A}"
echo -e "${GA}  dann http://127.0.0.1:${N8N_LOCAL_PORT:-5679} im Browser${A}"
echo
