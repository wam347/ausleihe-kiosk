# Ausleihe-Kiosk für Snipe-IT

Kleine Kiosk-Seite: Karte scannen (Mitarbeiternummer), Gerät scannen (Asset-Tag) → ausgeliehen.
Gerät noch einmal scannen → zurückgenommen (auch ohne Anmeldung).

## So erkennt die Seite, was gescannt wurde

1. Passt der Code zu einer **Mitarbeiternummer** eines Benutzers → Anmeldung.
2. Sonst: passt er zu einem **Asset-Tag** → Ausleihe oder Rückgabe.

Karten-Nummern und Asset-Tags dürfen sich daher nicht überschneiden
(zum Beispiel `S-1001` / `K-2001` für Karten und `GER-001` für Geräte).

## Einstellungen (Umgebungsvariablen)

| Variable | Bedeutung | Standard |
|---|---|---|
| `SNIPEIT_URL` | Adresse von Snipe-IT, ohne `/` am Ende | (Pflicht) |
| `SNIPEIT_TOKEN` | API-Token aus Snipe-IT | (Pflicht) |
| `IDLE_SECONDS` | Sekunden bis zur automatischen Abmeldung | 45 |
| `PORT` | Port im Container | 3040 |

## Deployment mit Portainer (aus GitHub)

1. Diese Dateien in ein GitHub-Repo legen.
2. Portainer → Stacks → Add stack → **Repository**, Repo-URL eintragen, Compose-Pfad `docker-compose.yml`.
3. Unter *Environment variables* `SNIPEIT_TOKEN` mit dem Token setzen (nicht in die Datei schreiben).
4. Deploy. Aufruf: `http://SERVER-IP:3040`

## NFC-Link (zum Testen mit dem iPhone)

Einen NFC-Aufkleber mit dieser Adresse beschreiben, dann bucht das Antippen das Gerät:
`http://SERVER-IP:3040/?scan=GER-001`
