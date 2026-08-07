#!/usr/bin/env bash
# =============================================================================
#  nginx-einrichten.sh — Vhost und Zertifikat für den Voice-Agent
# =============================================================================
#  Braucht root. Aufruf:
#
#      sudo bash deploy/nginx-einrichten.sh
#
#  Auf diesem Server laufen noch andere Seiten (damjan-savic.com, n8n,
#  snipeflip, pharmacy). Ein Fehler in der nginx-Konfiguration legt sie ALLE
#  lahm, nicht nur diese. Deshalb:
#
#    * Vorher wird geprüft, dass die bestehende Konfiguration gültig ist —
#      war sie schon vorher kaputt, brechen wir ab, statt es uns anzulasten.
#    * Jede Änderung wird sofort mit "nginx -t" geprüft.
#    * Schlägt etwas fehl, wird der vorherige Zustand wiederhergestellt und
#      nginx neu geladen, bevor das Skript endet.
#    * Erst am Schluss wird neu geladen, nie zwischendurch mit halber
#      Konfiguration.
#
#  Der Ablauf in zwei Stufen, weil eine Henne-Ei-Lage besteht: Der fertige
#  Vhost verweist auf Zertifikatsdateien, die es noch nicht gibt — nginx
#  würde ihn ablehnen. Also erst ein reiner HTTP-Vhost, damit certbot die
#  Domain bestätigen kann, dann der richtige.
# =============================================================================

set -uo pipefail

B='\033[1m'; GR='\033[0;32m'; GE='\033[0;33m'; RO='\033[0;31m'; GA='\033[0;90m'; A='\033[0m'
gut()  { echo -e "  ${GR}✓${A} $1"; }
warn() { echo -e "  ${GE}!${A} $1"; }
bad()  { echo -e "  ${RO}✗${A} $1"; }
info() { echo -e "  ${GA}· $1${A}"; }
schritt() { echo; echo -e "${B}▸ $1${A}"; }

[[ $EUID -eq 0 ]] || { bad "Bitte mit sudo starten: sudo bash deploy/nginx-einrichten.sh"; exit 1; }

# Das Repo liegt beim aufrufenden Benutzer, nicht bei root.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUELLE="$REPO/deploy/nginx/voice-agent.conf"
[[ -f "$QUELLE" ]] || { bad "Vhost-Vorlage fehlt: $QUELLE"; exit 1; }

DOMAIN="$(grep -E '^N8N_DOMAIN=' "$REPO/.env" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"' ')"
DOMAIN="${DOMAIN:-voice.damjan-savic.com}"
MAIL="$(grep -E '^LETSENCRYPT_MAIL=' "$REPO/.env" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"' ')"
MAIL="${MAIL:-info@damjan-savic.com}"

VERFUEGBAR="/etc/nginx/sites-available/voice-agent"
AKTIV="/etc/nginx/sites-enabled/voice-agent"
SICHERUNG="/root/nginx-vor-voiceagent-$(date +%Y%m%d-%H%M%S).tar.gz"

echo
echo -e "${B}Voice-Agent — nginx und Zertifikat${A}"
info "Domain: $DOMAIN"
info "E-Mail: $MAIL"

# --- 0 · Ausgangslage --------------------------------------------------------
schritt "Ausgangslage prüfen"

if ! nginx -t >/dev/null 2>&1; then
  bad "Die BESTEHENDE nginx-Konfiguration ist schon fehlerhaft."
  nginx -t 2>&1 | sed 's/^/      /'
  info "Erst das beheben — sonst lässt sich hinterher nicht sagen, woran es lag."
  exit 1
fi
gut "bestehende Konfiguration ist gültig"

tar czf "$SICHERUNG" /etc/nginx/sites-available /etc/nginx/sites-enabled 2>/dev/null
gut "gesichert nach $SICHERUNG"

AUFGELOEST="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)"
if [[ -z "$AUFGELOEST" ]]; then
  bad "$DOMAIN löst nicht auf — certbot würde scheitern."
  exit 1
fi
gut "$DOMAIN → $AUFGELOEST"

zurueck() {
  warn "Es ist etwas schiefgegangen — stelle den vorherigen Zustand wieder her."
  rm -f "$AKTIV"
  tar xzf "$SICHERUNG" -C / 2>/dev/null
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    gut "vorheriger Zustand wiederhergestellt, nginx läuft"
  else
    bad "Wiederherstellung fehlgeschlagen. Sicherung: $SICHERUNG"
  fi
  exit 1
}

# --- 1 · Zertifikat ----------------------------------------------------------
schritt "Zertifikat"

if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  gut "Zertifikat für $DOMAIN ist bereits vorhanden"
else
  command -v certbot >/dev/null || { bad "certbot ist nicht installiert (apt install certbot python3-certbot-nginx)"; exit 1; }

  # Vorübergehend ein reiner HTTP-Vhost. Der fertige Vhost verweist auf
  # Zertifikatsdateien, die es noch nicht gibt — nginx würde ihn ablehnen.
  info "lege vorübergehend einen HTTP-Vhost an, damit certbot prüfen kann"
  mkdir -p /var/www/html
  cat > "$VERFUEGBAR" <<VHOST
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
VHOST
  ln -sfn "$VERFUEGBAR" "$AKTIV"

  nginx -t >/dev/null 2>&1 || { bad "Der vorübergehende Vhost wird abgelehnt:"; nginx -t 2>&1 | sed 's/^/      /'; zurueck; }
  systemctl reload nginx
  gut "vorübergehender HTTP-Vhost aktiv"

  info "hole das Zertifikat …"
  if certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
       --non-interactive --agree-tos -m "$MAIL" 2>&1 | sed 's/^/      /'; then
    gut "Zertifikat ausgestellt"
  else
    bad "certbot ist gescheitert."
    zurueck
  fi
fi

# --- 2 · Der richtige Vhost --------------------------------------------------
schritt "Vhost einspielen"

install -m 0644 "$QUELLE" "$VERFUEGBAR"
ln -sfn "$VERFUEGBAR" "$AKTIV"
gut "$QUELLE → $VERFUEGBAR"

if ! nginx -t >/dev/null 2>&1; then
  bad "Der Vhost wird abgelehnt:"
  nginx -t 2>&1 | sed 's/^/      /'
  zurueck
fi
gut "Konfiguration ist gültig"

systemctl reload nginx || zurueck
gut "nginx neu geladen"

# --- 3 · Nachsehen -----------------------------------------------------------
schritt "Nachsehen, ob es wirklich geht"

sleep 2
CODE="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' -d '{}' \
        "https://$DOMAIN/webhook/voice/init" 2>/dev/null)"

case "$CODE" in
  403) gut "Webhook antwortet mit 403 — genau richtig: der Weg steht, nur der Token fehlt beim Test" ;;
  200) gut "Webhook antwortet mit 200" ;;
  404) warn "404 — n8n kennt den Webhook nicht. Als normaler Benutzer: node scripts/import-n8n-workflows.mjs" ;;
  000) bad "keine Verbindung — Zertifikat oder Firewall prüfen" ;;
  *)   warn "HTTP $CODE — unerwartet, aber die Verbindung steht" ;;
esac

# Der Ausweichweg ist das Herzstück: Fällt n8n aus, muss die Control-API
# einspringen. Das lässt sich nur hier prüfen, wo nginx schon läuft.
AUS="$(curl -s -m 15 -D- -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' \
       "https://$DOMAIN/webhook/voice/init" 2>/dev/null | grep -ci 'x-voice-ausweich')"
[[ "$AUS" -gt 0 ]] && info "Ausweichweg hat gegriffen — n8n antwortet gerade nicht"

echo
echo -e "${B}Fertig.${A}"
info "Zertifikat erneuert sich von selbst (certbot.timer)."
info "Sicherung der alten Konfiguration: $SICHERUNG"
echo
echo -e "  Als normaler Benutzer weiter:"
echo -e "      ${GA}cd $REPO && bash scripts/status.sh${A}"
echo
