# Rufnummer über Telnyx

Der Weg für eine **Privatperson in Deutschland ohne Gewerbe**. Er ist der
einzige, der ohne eigenen SIP-Server und ohne Gewerbeanmeldung auskommt — und
ElevenLabs hat dafür eine eigene Anleitung.

## Warum nicht die naheliegenden Anbieter

| Anbieter | Warum nicht |
|---|---|
| **sipgate** | Trunking ist Geschäftskunden vorbehalten. Privatkunden bekommen *Satellite*, eine reine App. Aus deren Hilfe: „Auf anderen VoIP-Clients wie Zoiper kannst du satellite nicht nutzen." Keine SIP-Zugangsdaten, kein Anschluss an ElevenLabs. |
| **Twilio** | „German local numbers are not available to individuals." Ohne Gewerbe geht gar nichts. |
| **easybell** (Privat) | Gibt zwar SIP-Zugangsdaten heraus, aber der Anschluss ist *registrierungsbasiert*: Ein Gerät meldet sich bei easybell an. Ein eigenes Weiterleitungsziel lässt sich nicht setzen — genau das bräuchte ElevenLabs. Die Funktionen *Trusted IP* und *FQDN-Authentifizierung* sind ausdrücklich „nur in unseren Business-Tarifen verfügbar". |
| **dus.net** | Dasselbe Muster, aber sehr günstig (Nummer ~5 €/Jahr). Nur mit eigener Brücke nutzbar. |

Der gemeinsame Nenner: Ein Privatkunden-VoIP-Anschluss ist ein **SIP-Client**,
der sich anmeldet. ElevenLabs ist aber kein Client — es erwartet, dass der
Anbieter den Anruf an `sip.rtc.elevenlabs.io` schickt. Dazu braucht es einen
Trunk, und den geben deutsche Anbieter nur an Gewerbetreibende.

Telnyx macht diese Unterscheidung nicht.

## Was Telnyx verlangt

| | |
|---|---|
| Personen | Privatpersonen ausdrücklich zugelassen, eigener Prüfpfad „personal identity verification" |
| Dokumente | Ausweis oder Reisepass, Adressnachweis (Rechnung, nicht älter als 3 Monate), deutsches Registrierungsformular |
| Adresse | Muss im **Vorwahlgebiet der Nummer** liegen — für Köln also eine 0221er |
| Ort | Man muss sich beim Kauf physisch in Deutschland aufhalten |
| Format | Nur eingescannte Dokumente |
| Dauer | rund 72 Stunden |

> Gilt für **Local** und **National**. Eine 0800-Nummer geht *nicht* auf
> diesem Weg — dafür verlangt Telnyx wie alle anderen einen
> Zuteilungsbescheid der Bundesnetzagentur.

## Kosten

| Posten | Betrag |
|---|---|
| Rufnummer | ab 1 $ einmalig, ab 1 $/Monat |
| eingehend | ab 0,0032 $/Min |
| Grundgebühr | keine, reines Pay-as-you-go |
| Mindestlaufzeit | keine |

Damit ist Telnyx günstiger als sipgate trunking (11,84 €/Monat) — und der
Agent nimmt ohnehin nur die Anrufe an, die dein Handy nicht beantwortet.

## Einrichten

### 1 · Konto und Nummer

1. [telnyx.com](https://telnyx.com) → Konto anlegen
2. **Numbers → Search & Buy** → Germany → Ortsvorwahl deiner Adresse
3. Dokumente hochladen, wenn Telnyx danach fragt
4. Etwa 72 Stunden warten

### 2 · SIP-Verbindung

**Voice → SIP Connections → Create SIP Connection**, Typ **FQDN**.

*Inbound* (was zu ElevenLabs geht):

| Feld | Wert |
|---|---|
| Destination Number Format | `+E.164` |
| SIP Transport Protocol | `TCP` |
| SIP Region | Europe |

Telnyx nutzt bei eingehenden Trunks **keine** Digest-Authentifizierung —
hier sind keine Zugangsdaten nötig.

*Outbound* (falls der Agent später zurückrufen soll):

| Feld | Wert |
|---|---|
| Authentication | `Credentials` (Benutzername und Passwort vergeben) |
| FQDN | `sip.rtc.elevenlabs.io` |

Dann **Numbers → deine Nummer → Connection** auf diese Verbindung setzen und
unter **Outbound Voice Profile** eines anlegen und zuweisen.

### 3 · Mit dem Agent verbinden

In die `.env`:

```bash
TELEFON_ANBIETER=sip_trunk
AGENT_PHONE_NUMBER=+49221XXXXXXX     # die neue Nummer
SIP_BENUTZER=<aus Schritt 2, Outbound>
SIP_PASSWORT=<aus Schritt 2, Outbound>
SIP_ADRESSE=sip.telnyx.com           # reiner Hostname, ohne "sip:"
SIP_TRANSPORT=tls
```

Dann:

```bash
node scripts/telefonnummer.mjs
```

Das legt die Nummer bei ElevenLabs an und weist sie dem Agent zu.

### 4 · Rufumleitung auf dem Handy

Im Wählfeld eingeben, grüne Taste:

```
**004*+49221XXXXXXX**25#
```

Damit leitet dein Handy nach 25 Sekunden ohne Antwort, bei besetzt und bei
ausgeschaltetem Gerät auf den Agent um. Prüfen mit `*#61#`, zurücknehmen mit
`##002#`.

> Deine Mailbox ist danach für diese Fälle aus — sie hängt an denselben
> Codes. Beides gleichzeitig geht nicht.

## Nachher prüfen

```bash
node scripts/telefonnummer.mjs --liste     # ist die Nummer zugewiesen?
bash scripts/status.sh
```

Dann von einem anderen Telefon aus anrufen, nicht abnehmen, warten. Danach:

```bash
voiceagent anrufe
```

**Sieh dort nach, welche Nummer angekommen ist.** Steht dort die des
Anrufers, ist alles richtig. Steht dort deine eigene, reicht der Carrier die
ursprüngliche Rufnummer nicht durch — dann in Telnyx nach einer Einstellung
für CLI-Passthrough suchen und mit Testanrufen von Mobil *und* Festnetz
gegenprüfen.

## Wenn Telnyx nicht klappt

Zwei Auswege, beide mit mehr Aufwand:

**Eigene SIP-Brücke.** easybell (0,99 €/Monat) oder dus.net (~5 €/Jahr) als
Privatkunde, dazu ein Asterisk auf diesem Server, der sich dort registriert
und Anrufe an ElevenLabs weiterreicht. sipgate hat dafür einen
[fertigen Container](https://github.com/sipgate/sip-bridge) veröffentlicht,
der sich auf andere Anbieter umkonfigurieren lässt. Der Preis: SIP-Ports
offen im Netz, und SIP-Scanner suchen ununterbrochen danach.

**Kleingewerbe.** 15–65 € je nach Kommune, bei elektronischer Anmeldung oft
am selben Tag. Damit stehen sipgate trunking, Twilio und easybell Business
(1,95 €/Monat) offen. Das ist allerdings eine steuerliche Entscheidung, keine
technische.
