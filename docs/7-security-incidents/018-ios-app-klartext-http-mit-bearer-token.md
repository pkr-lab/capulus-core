# 018 iOS-App: Klartext-HTTP mit Bearer-Token zu `carplay-api` und WoL-Agent, ATS-Ausnahme für `homeserver`

- Severity: Medium
- Bereich: Repo
- Betroffen: `ios/project.yml:33-37`, `ios/HomeserverDashboard/Utilities/Constants.swift:4,6`, `ios/HomeserverDashboard/Utilities/MTLSDelegate.swift`
- Status: Behoben am 2026-10-18 (carplay-api und WoL-Agent per HTTPS, ATS-Ausnahme entfernt; Gerätetest durch den Nutzer und optionales Pinning offen)

## Beschreibung

Die App spricht `http://carplay-api.prod.homeserver` und `http://100.123.214.4:9102` an und deaktiviert dafür die App Transport Security für die Domain `homeserver` (`NSExceptionAllowsInsecureHTTPLoads: true`, inklusive Subdomains). Das Bearer-Token von `carplay-api` (Zugriff auf Dashboard, Wake/Shutdown der Worker) und das WoL-Agent-Token laufen damit im Klartext. Über Tailscale sind sie durch WireGuard geschützt, im Heim-WLAN nicht. Die Klasse `MTLSDelegate` führt trotz des Namens nur `performDefaultHandling` aus: kein Client-Zertifikat, kein Pinning. Positiv: Tokens liegen im Keychain mit `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.

## Nachweis

```
$ sed -n 33,37p ios/project.yml
        NSAppTransportSecurity:
          NSExceptionDomains:
            homeserver:
              NSIncludesSubdomains: true
              NSExceptionAllowsInsecureHTTPLoads: true

$ grep -n 'URL(string' ios/HomeserverDashboard/Utilities/Constants.swift
4:    static let apiBaseURL = URL(string: "http://carplay-api.prod.homeserver")!
6:    static let wolAgentBaseURL = URL(string: "http://100.123.214.4:9102")!
```

## Risiko / Angriffsszenario

Ein Angreifer im selben WLAN schneidet das Bearer-Token mit und kann damit Dashboard-Daten lesen und Worker abschalten oder aufwecken. Ohne Zertifikats-Pinning würde auch ein MITM mit fremder CA nur dann auffallen, wenn die Systemprüfung aktiv ist.

## Empfohlene Behebung

1. `carplay-api.prod.homeserver` in die SAN-Liste des internen Zertifikats aufnehmen (cert-manager, siehe `docs/d-sicherheit/d0040-internal-tls.md`), Ingress mit TLS-Eintrag versehen.
2. `Constants.swift` auf `https://…` umstellen, den WoL-Agent ebenfalls hinter HTTPS legen.
3. Die ATS-Ausnahme aus `project.yml` entfernen, Root-CA als Konfigurationsprofil auf dem iPhone installieren.
4. Optional Pinning auf die Root-CA im `URLSessionDelegate` (`SecTrustSetAnchorCertificates`).

## Rollback

ATS-Ausnahme und die HTTP-URLs wiederherstellen, App neu bauen.

## Verifikation

```
curl -sI --cacert homeserver-root-ca.pem https://carplay-api.prod.homeserver/health
curl -sI http://carplay-api.prod.homeserver/health
```
HTTPS liefert `200`, HTTP wird abgewiesen bzw. umgeleitet. In der App Dashboard laden und eine Aktion auslösen; im Charles/mitmproxy-Test darf kein Klartext-Token sichtbar sein.

## Risiko der Behebung

Mittel: Die App funktioniert erst wieder, wenn die interne Root-CA auf dem iPhone installiert und der Hostname im Zertifikat enthalten ist.

## Nachtrag zu 011 (2026-10-17)

Bei der Umstellung des power-agent kam von der App keine einzige Anfrage bei `carplay-api` an (weder Dashboard-Abruf noch Helligkeit). Die App spricht `http://carplay-api.prod.homeserver` an, der Traefik leitet HTTP seit 2026-09-13 global per `301`/`308` auf HTTPS um (`curl http://carplay-api.prod.homeserver/health` liefert `301`, ein `PUT` `308`). Ob die App dem Redirect folgen kann, hängt davon ab, ob das iPhone der internen Root-CA vertraut. Die Anfragen, die `carplay-api` protokolliert, kamen nur von den Health-Checks des kubelet und von Testaufrufen. Das spricht dafür, dass die App seit der Umleitung nicht mehr mit `carplay-api` spricht. Zu prüfen: Zeigt die App einen Verbindungsfehler? Die Behebung dieses Incidents (HTTPS mit passendem Zertifikat, Root-CA auf dem iPhone) löst auch das.

## Behebung (2026-10-18)

**Fix.**

- **Server (Schritt 1 der Empfehlung):** keine Änderung nötig. `carplay-api.prod.homeserver` steht schon in der SAN-Liste von `homeserver-wildcard-tls`, der Standard-`TLSStore` greift ohne eigenen TLS-Block im Ingress.
- **App (Schritte 2 und 3):** `apiBaseURL` und die URL der Kurzlink-Kacheln stehen auf `https://`. Der Block `NSAppTransportSecurity` ist aus `project.yml` entfernt, ATS gilt wieder in der Standardeinstellung.
- **WoL-Agent (Stufe 2, live seit 2026-10-18):** `https://100.123.214.4:9102` mit einem Zertifikat der Root-CA (IP-SAN `100.123.214.4`, EC P-256, 365 Tage, Ablauf 2027-10-18, Token-Register `vereinsheim-wol-agent-cert`). Ausgestellt von cert-manager im Cluster, der CA-Schlüssel hat den Cluster nicht verlassen. Der Agent aktiviert TLS nur mit `TLS_CERT`/`TLS_KEY` (mindestens TLS 1.2, Handshake im Handler-Thread). Er lauscht weiter nur auf der Tailscale-Adresse. In der App steht `wolAgentBaseURL` auf `https://`.
- **Nicht umgesetzt (Schritt 4):** Pinning auf die Root-CA. Der Swift-Code lässt sich auf dem Entwicklungsrechner ohne Xcode nicht kompilieren, ein Fehler im Delegate würde alle API-Aufrufe brechen. Eigener Schritt nach dem Gerätetest.

**Nachweis.**

| Test | Ergebnis |
|---|---|
| `curl --cacert docs/assets/homeserver-root-ca.pem https://carplay-api.prod.homeserver/health` | `200`, `ssl_verify_result=0` |
| `curl http://carplay-api.prod.homeserver/health` | `301` nach `https://…` |
| Zertifikat | SAN enthält `carplay-api.prod.homeserver`, Aussteller `Homeserver Root CA`, gültig bis 2027-01-09 (cert-manager erneuert) |
| Kurzlink-Dienste (nextcloud, immich, vault, paperless, n8n, wiki, zammad) per HTTPS mit Root-CA | alle `200` oder `302`, Prüfung bestanden |
| `grep -rn 'http://' ios --include=*.swift` | nur noch `wolAgentBaseURL` |
| `grep -n NSAppTransportSecurity ios/project.yml` | leer, YAML parst, `Info.plist`-Eigenschaften unverändert bis auf den entfernten Block |
| carplay-api nach der Änderung | Pod `1/1 Running`, `/health` `200`, keine neuen Fehler im Log (keine Cluster-Änderung) |
| WoL-Agent: Zertifikat | `openssl verify -CAfile docs/assets/homeserver-root-ca.pem -verify_ip 100.123.214.4` OK, Aussteller `Homeserver Root CA`, SAN nur `IP:100.123.214.4`, Server-EKU |
| WoL-Agent live (`https://100.123.214.4:9102/wol` mit Root-CA) | ohne Token `401`, mit falschem Token `401`, Klartext-HTTP abgewiesen (Verbindung ohne Antwort), TLS 1.3 mit `Verification: OK` |
| Lokaler Test mit Wegwerf-CA | 401/400/200, Klartext auf TLS-Port abgewiesen, hängender Client blockiert nichts, TLS 1.2 und 1.3 gehen, TLS 1.1 nicht, ohne `TLS_CERT` weiter HTTP |
| Pi nach der Umschaltung | Agent `active`, `NRestarts=0`, lauscht nur auf `100.123.214.4:9102`, Kiosk (Chromium-Prozess unverändert), Heartbeat und getty aktiv, `systemctl --failed` leer |

**Geänderte Dateien.**

- `ios/HomeserverDashboard/Utilities/Constants.swift`, `ios/HomeserverDashboard/Models/SelfHostedService.swift`, `ios/project.yml`
- Stufe 2: `ansible/roles/banana_pi_kiosk/` (`files/banana-pi-wol-agent.py`, `defaults/main.yml`, `tasks/main.yml`, `templates/banana-pi-wol-agent.env.j2`), `ansible/host_vars/vereinsheim-alarmmonitor/vars.yml` und `vault.yml` (zwei Vault-Variablen), `ops/token-register.yaml`, `ios/HomeserverDashboard/Utilities/Constants.swift`
- Doku: `ios/README.md`, `docs/6-hintergruende/60080-carplay-api-und-ios-app.md`, `60020-ansible-rollen.md`, `docs/3-apps-workloads/300d0-carplay-api.md`, `30020-vereinsheim-alarmmonitor.md`, `docs/d-sicherheit/d0040-internal-tls.md`

**Rollback.** WoL-Agent: `banana_pi_kiosk_wol_agent_tls_enabled: false` und Rollenlauf, oder von Hand in `/etc/banana-pi-wol-agent/config.env` die Zeilen `TLS_CERT` und `TLS_KEY` entfernen und `systemctl restart banana-pi-wol-agent` (der Agent spricht dann wieder HTTP; die Sicherungskopien vom 2026-10-18 sind nach der Prüfung gelöscht). App: Die zwei Swift-Dateien auf `http://` zurücksetzen, den ATS-Block aus dem Abschnitt „Nachweis“ oben in `project.yml` wiederherstellen, `cd ios && xcodegen generate`, App neu bauen. Auf dem Server gibt es nichts zurückzunehmen. Die Rückkehr zu `http://` hilft nicht gegen einen Zertifikatsfehler, denn Traefik leitet auf HTTPS um.

**Offen.**

- **Gerätetest (Nutzer):** `cd ios && xcodegen generate`, bauen, starten. Dashboard lädt, Helligkeit lässt sich ändern, Kurzlinks öffnen, „Aufwecken“ des Vereinsheim-PCs funktioniert (prüft die ATS-Annahme für die IP). Voraussetzung: Root-CA (SHA-256 `45:E7:9F:CB:…:ED:91`) auf dem iPhone installiert und unter Zertifikatsvertrauenseinstellungen aktiviert; Schnelltest `https://carplay-api.prod.homeserver/health` in Safari ohne Warnung. Optional mitmproxy-Lauf: kein Klartext-Token sichtbar.
- **Rollenlauf auf dem Pi (Nutzer, Vault-Passwort nötig):** Der Agent wurde von Hand umgeschaltet. `config.env` ist von Hand auf die Ausgabe des Rollen-Templates gebracht, der Agent selbst sollte im Lauf nichts mehr ändern. Der Lauf rollt aber noch Skripte mit Altkommentaren aus (Autologin-Drop-in, Kiosk-Supervisor, Heartbeat) und startet dabei `getty@tty1` neu, also die Kiosk-Session. Nur in einem Zeitfenster ohne Alarmbetrieb laufen lassen.
- **Token (erledigt 2026-10-18):** Das WoL-Token stand im Prüflauf-Diff im Klartext (Terminal und Chat) und wurde deshalb von Hand rotiert (neuer Wert in `token` und `config.env`, Agent neu gestartet). Alter Wert liefert `401`, neuer Wert wird akzeptiert (Test mit unbekanntem Ziel, es wurde nichts geweckt). **Der neue Wert muss in der App eingetragen werden:** `ssh pela@vereinsheim-alarmmonitor sudo cat /etc/banana-pi-wol-agent/token`, dann Zahnrad → Vereinsheim-WoL-Agent-Token. Bis dahin liefert „Aufwecken“ in der App `401`.
- **Zertifikat:** Läuft am 2027-10-18 ab, Erneuerung nach d0040.
- **Pinning (Schritt 4):** `SecTrustSetAnchorCertificates` für `*.homeserver` mit der Root-CA als Resource. Macht die Profil-Installation für die App überflüssig.
