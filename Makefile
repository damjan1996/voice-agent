# =============================================================================
#  Voice-Agent
# =============================================================================
#  make            zeigt diese Übersicht
#  make hoch       alles starten
#  make status     was gerade läuft und in welchem Modus
# =============================================================================

SHELL := /bin/bash
.DEFAULT_GOAL := hilfe

COMPOSE := docker compose
ENV     := .env

# .env einlesen, ohne dass Kommentare oder Anführungszeichen stören.
ifneq (,$(wildcard $(ENV)))
include $(ENV)
export
endif

CONTROL := $(if $(CONTROL_API_URL),$(CONTROL_API_URL),http://127.0.0.1:3010)

BLAU  := \033[1;34m
GRAU  := \033[0;90m
GRUEN := \033[0;32m
GELB  := \033[0;33m
AUS   := \033[0m

.PHONY: hilfe hoch runter neu logs status migrate einrichten agent import register \
        test test-anruf sichern wiederherstellen pruefen sauber schluessel

hilfe:
	@echo ""
	@echo -e "$(BLAU)Voice-Agent$(AUS) — Telefon-Vorzimmer"
	@echo ""
	@echo -e "$(BLAU)Betrieb$(AUS)"
	@echo -e "  make hoch            Container starten"
	@echo -e "  make runter          Container stoppen"
	@echo -e "  make neu             Neu bauen und starten"
	@echo -e "  make logs            Logs folgen  $(GRAU)(dienst=n8n für einen einzelnen)$(AUS)"
	@echo -e "  make status          Modus, offene Nachrichten, Workflows"
	@echo ""
	@echo -e "$(BLAU)Einrichten$(AUS)"
	@echo -e "  make schluessel      Geheimnisse für die .env erzeugen"
	@echo -e "  make einrichten      Erstinstallation Schritt für Schritt"
	@echo -e "  make migrate         Datenbankschema anlegen/aktualisieren"
	@echo -e "  make agent           Agent bei ElevenLabs anlegen/aktualisieren"
	@echo -e "  make import          Workflows nach n8n bringen"
	@echo -e "  make register        Nur das Workflow-Register auffrischen"
	@echo ""
	@echo -e "$(BLAU)Prüfen$(AUS)"
	@echo -e "  make pruefen         Konfiguration und Erreichbarkeit"
	@echo -e "  make test            Testlauf der Control-API"
	@echo -e "  make test-anruf      Anruf simulieren, ohne zu telefonieren"
	@echo ""
	@echo -e "$(BLAU)Daten$(AUS)"
	@echo -e "  make sichern         Datenbank sichern"
	@echo -e "  make wiederherstellen datei=... "
	@echo ""

# -----------------------------------------------------------------------------
#  Betrieb
# -----------------------------------------------------------------------------

hoch:
	@test -f $(ENV) || { echo -e "$(GELB).env fehlt.$(AUS) cp .env.example .env"; exit 1; }
	$(COMPOSE) up -d
	@echo -e "$(GRUEN)Läuft.$(AUS)  n8n: http://127.0.0.1:$(or $(N8N_LOCAL_PORT),5679)"

runter:
	$(COMPOSE) down

neu:
	$(COMPOSE) up -d --build

logs:
	$(COMPOSE) logs -f --tail=120 $(dienst)

status:
	@scripts/status.sh

# -----------------------------------------------------------------------------
#  Einrichten
# -----------------------------------------------------------------------------

schluessel:
	@echo ""
	@echo "# In die .env übernehmen:"
	@echo "DB_PASSWORD=$$(openssl rand -hex 24)"
	@echo "N8N_ENCRYPTION_KEY=$$(openssl rand -hex 32)"
	@echo "CONTROL_API_TOKEN=$$(openssl rand -hex 32)"
	@echo "VOICE_WEBHOOK_TOKEN=$$(openssl rand -hex 32)"
	@echo ""

einrichten:
	@bash scripts/einrichten.sh

# Die Migrationen laufen beim ersten Start automatisch. Danach greift
# initdb.d nicht mehr — deshalb dieser Weg für alles Spätere.
migrate:
	@for f in db/migrations/*.sql; do \
		echo "→ $$f"; \
		$(COMPOSE) exec -T postgres psql -v ON_ERROR_STOP=1 \
			-U $(or $(DB_USER),voiceagent) -d $(or $(DB_NAME),voiceagent) < $$f || exit 1; \
	done
	@echo -e "$(GRUEN)Schema aktuell.$(AUS)"

agent:
	@node scripts/provision-elevenlabs.mjs $(args)

import:
	@node scripts/import-n8n-workflows.mjs $(args)

register:
	@node scripts/import-n8n-workflows.mjs --nur-register

# -----------------------------------------------------------------------------
#  Prüfen
# -----------------------------------------------------------------------------

pruefen:
	@bash scripts/pruefen.sh

# Auf dem Host, nicht im Container: Das Image enthält nur src/, kein test/.
# Im Container fand "node --test" deshalb null Tests und meldete trotzdem
# Erfolg — ein Testziel, das nie etwas prüft, ist schlimmer als keines.
test:
	@cd control-api && npm test

test-anruf:
	@node scripts/test-anruf.mjs $(args)

# -----------------------------------------------------------------------------
#  Daten
# -----------------------------------------------------------------------------

# pipefail und Größenprüfung sind hier keine Förmlichkeit: Ohne sie ist der
# Exit-Code der von gzip, nicht der von pg_dumpall. Ein gescheiterter Dump
# hinterließ dann eine gültige, leere .sql.gz und die Meldung "Gesichert" —
# per Cron mit >/dev/null vollständig lautlos. Aufgefallen wäre das erst beim
# Wiederherstellen, also im schlechtesten Moment.
sichern:
	@bash scripts/sichern.sh

wiederherstellen:
	@test -n "$(datei)" || { echo "Aufruf: make wiederherstellen datei=backups/....sql.gz"; exit 1; }
	@test -f "$(datei)" || { echo -e "$(GELB)Datei nicht gefunden: $(datei)$(AUS)"; exit 1; }
	@gzip -t "$(datei)" || { echo -e "$(GELB)Datei ist kein gültiges gzip.$(AUS)"; exit 1; }
	@echo -e "$(GELB)Überschreibt die aktuelle Datenbank.$(AUS)"
	@read -p "Wirklich? [nein/ja] " a; [ "$$a" = "ja" ] || exit 1
	@set -o pipefail; \
	gunzip -c "$(datei)" | $(COMPOSE) exec -T postgres psql -v ON_ERROR_STOP=1 \
		-U $(or $(DB_USER),voiceagent) -d postgres \
		|| { echo -e "$(GELB)Einspielen fehlgeschlagen — Datenbank prüfen.$(AUS)"; exit 1; }
	@echo -e "$(GRUEN)Eingespielt.$(AUS)"

sauber:
	@echo -e "$(GELB)Löscht Container UND Daten (Anrufe, Workflows, Kalenderzugang).$(AUS)"
	@read -p "Wirklich alles löschen? [nein/ja] " a; [ "$$a" = "ja" ] || exit 1
	$(COMPOSE) down -v
