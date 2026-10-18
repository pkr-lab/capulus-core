# 011 power-agent und Banana-Pi-WoL-Agent: Bearer-Token über Klartext-HTTP auf `0.0.0.0`, power-agent als ungehärteter root-Dienst

- Severity: Medium
- Bereich: Repo
- Betroffen: `ansible/roles/power_agent/files/power-agent.py:208`, `ansible/roles/power_agent/templates/power-agent.service.j2`, `ansible/roles/banana_pi_kiosk/files/banana-pi-wol-agent.py:72`
- Status: Behoben am 2026-10-17 (Punkt 5 bewusst nicht umgesetzt)

## Beschreibung

Der `power-agent` läuft als root-systemd-Dienst (kein `User=`, kein Sandboxing) auf dem Homeserver und bietet per HTTP auf `0.0.0.0:9101` Helligkeit, Wake-on-LAN, `kubectl drain`, `poweroff` der Worker sowie `POST /poweroff-self` (Homeserver herunterfahren). Authentifizierung ist ausschließlich ein Bearer-Token (32 Byte Zufall, Datei `0600`, gut). Die Bestätigungscode-Abfrage für den Homeserver-Shutdown sitzt nur in `carplay-api`, nicht im Agent: Wer den Token hat, fährt den Homeserver direkt herunter. Verkehr läuft unverschlüsselt über das LAN (`http://192.168.178.94:9101`), die UFW lässt das gesamte LAN zu. Zusätzlich ruft der Agent `ssh -o StrictHostKeyChecking=accept-new` auf (Trust on first use). Der Banana-Pi-Agent (`:9102`) ist baugleich aufgebaut.

Beide Server sind `ThreadingHTTPServer` ohne Timeouts; ein einzelner Client mit offener Verbindung hält Threads fest.

## Nachweis

```
$ sed -n 208p ansible/roles/power_agent/files/power-agent.py
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)

$ sed -n 6,11p ansible/roles/power_agent/templates/power-agent.service.j2
[Service]
Type=simple
EnvironmentFile=/etc/power-agent/config.env
ExecStart=/usr/bin/python3 /usr/local/bin/power-agent.py
Restart=always
RestartSec=10

$ grep -n 'poweroff-self' ansible/roles/power_agent/files/power-agent.py
183:        if self.path == "/poweroff-self":
(nur der Bearer-Token wird geprüft, keine zweite Bestätigung)
```

## Phase-2-Nachweis (live, lesend)

Live-Stand: `power-agent` läuft als `root` (`/usr/local/bin/power-agent.py`, `0.0.0.0:9101`), vom LAN-Client erreichbar. Ein `GET /brightness` ohne Token liefert `401 {"error": "invalid bearer token"}`: Die Token-Prüfung greift. Die Konfiguration (`/etc/power-agent/config.env`, `token`) hat Modus `0600 root:root`.

## Risiko / Angriffsszenario

Ein Angreifer im LAN, der den Token mitschneidet (Klartext-HTTP, z. B. durch ARP-Spoofing) oder aus der iOS-App/dem Secret abgreift, kann den Homeserver und die Worker abschalten (Denial of Service auf die gesamte Infrastruktur). Ein Fehler im Python-Dienst (root, ungehärtet) wiegt schwerer als nötig.

## Empfohlene Behebung

1. Firewall: Port 9101 nur für die Quellen öffnen, die ihn brauchen (Worker/Pod-Netz von `carplay-api`, Admin-Client), nicht für das ganze LAN.
2. Verkehr verschlüsseln: HTTPS mit der internen CA (Zertifikat vom cert-manager) oder die Verbindung über den Tailnet-Pfad führen.
3. systemd-Härtung ergänzen (soweit mit `kubectl`, `ssh`, `poweroff` vereinbar):
   ```
   ProtectHome=yes
   PrivateTmp=yes
   ProtectKernelModules=yes
   ProtectKernelTunables=yes
   RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
   LockPersonality=yes
   ```
4. `StrictHostKeyChecking=accept-new` durch einen festen `known_hosts`-Eintrag der Worker ersetzen.
5. Bestätigungscode auch im Agent prüfen, zusätzlich zum Token.

## Rollback

Drop-in mit Härtung entfernen (`systemctl revert power-agent`), Firewall-Regel auf das LAN zurücksetzen.

## Verifikation

```
systemd-analyze security power-agent.service
sudo ufw status | grep 9101
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.178.94:9101/brightness
```
Von nicht freigegebenen Quellen muss Port 9101 `filtered` sein; `systemd-analyze security` zeigt eine bessere Bewertung als vorher; Helligkeit/Wake/Shutdown in der App funktionieren.

## Risiko der Behebung

Mittel: Wake/Shutdown/Helligkeit in der iOS-App fallen aus, wenn die Quellfreigabe in der Firewall falsch ist.

## Behebung (2026-10-17)

**Fix.**

- **Netz (Punkte 1 und 2):** Der `power-agent` lauscht nur noch auf der Adresse der Pod-Bridge `cni0` des homeservers (`10.42.2.1:9101`). `carplay-api` ruft ihn dort auf (`powerAgent.url`, zuvor `http://192.168.178.94:9101`). Er ist damit weder aus dem LAN noch aus dem Tailnet, von den Workern oder über `127.0.0.1` erreichbar, und der Token läuft nur über die Bridge des eigenen Nodes. Das ersetzt HTTPS: Der Verkehr verlässt den Node nicht. Der WoL-Agent des Alarmmonitors lauscht nur noch auf seiner Tailscale-Adresse (`100.123.214.4:9102`), der Weg dorthin ist durch Tailscale verschlüsselt.
- **Härtung (Punkt 3):** Beide Dienste laufen mit `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, `ProtectSystem=full`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `RestrictRealtime`, `RestrictNamespaces`, `LockPersonality`, `SystemCallArchitectures=native` und `UMask=0077`. Nicht gesetzt sind `ProtectKernelTunables` (die Helligkeit wird über `/sys` geschrieben) und `User=`/`DynamicUser` (der power-agent braucht root).
- **Hostschlüssel (Punkt 4):** `StrictHostKeyChecking=yes` mit `/etc/power-agent/known_hosts`, die Rolle schreibt sie aus den Einträgen in `/root/.ssh/known_hosts` des homeservers (6 Einträge für worker-0 und worker-1).
- **Zusätzlich (Beschreibung, Absatz 2):** Der Handler schließt Verbindungen nach 10 Sekunden ohne Daten. Der Body darf höchstens 4096 Byte haben, eine negative oder unlesbare `Content-Length` ergibt `400`.
- **Nicht umgesetzt (Punkt 5):** Der Bestätigungscode für den Shutdown des Homeservers wird weiter nur in `carplay-api` geprüft. Eine zweite Prüfung im Agent ändert den Vertrag zwischen App, `carplay-api` und Agent.

**Nachweis** (live):

| Test | Ergebnis |
|---|---|
| `systemd-analyze security` power-agent | 9.6 UNSAFE → **6.7 MEDIUM** |
| `systemd-analyze security` WoL-Agent | 9.6 UNSAFE → **6.7 MEDIUM** |
| Sandbox-Test mit kurzlebiger Einheit gleicher Einstellungen | `kubectl get nodes`, Helligkeit schreiben (derselbe Wert), `wakeonlan`, `systemctl is-active`, Hostschlüssel-Prüfung ok |
| Hostschlüssel-Prüfung (`PreferredAuthentications=none`, kein Befehl) | mit dem festen `known_hosts` akzeptiert, mit leerer Datei `Host key verification failed` |
| power-agent: Lauschadresse | `10.42.2.1:9101` (vorher `0.0.0.0:9101`) |
| Erreichbarkeit | Pod im Namespace `carplay-api` → `10.42.2.1:9101` offen, `192.168.178.94:9101` abgelehnt; LAN-Gerät (an `enp7s0` gebunden) Timeout; Tailscale-Adresse, `127.0.0.1` und worker-0 abgelehnt |
| Ohne Token / mit Token (vom Host über `10.42.2.1`) | `401` / `200` |
| Grenzen des Agents | negative `Content-Length` `400`, leere Verbindung nach 10 s geschlossen |
| WoL-Agent | lauscht nur auf `100.123.214.4:9102`, LAN-Adresse `192.168.1.201` und `127.0.0.1` lehnen ab, über Tailscale ohne Token `401`, falsches Ziel `400` |
| Dienste danach | `NRestarts=0`, Kiosk, Heartbeat, `vmagent`, `alert-caller` am Pi aktiv |
| 28 lokale Fälle (beide Agenten, Auth, Grenzen, Timeout, ssh-Argumente ohne `accept-new`) | alle ok |

`/wake`, `/poweroff` und `/poweroff-self` wurden bewusst nicht aufgerufen (`/wake` schreibt `woke_at`-Dateien des Power-Managers, die anderen fahren Hosts herunter).

**Geänderte Dateien.**

- `ansible/roles/power_agent/` (`files/power-agent.py`, `defaults/main.yml`, `tasks/main.yml`, `templates/config.env.j2`, `templates/power-agent.service.j2`)
- `ansible/roles/banana_pi_kiosk/` (`files/banana-pi-wol-agent.py`, `defaults/main.yml`, `templates/banana-pi-wol-agent.env.j2`, `templates/banana-pi-wol-agent.service.j2`)
- `ansible/host_vars/homeserver/vars.yml`, `ansible/host_vars/vereinsheim-alarmmonitor/vars.yml`
- `argocd/apps/tech/carplay-api/values.yaml`, `argocd/apps/tech/carplay-api/README.md`
- Doku: `docs/6-hintergruende/60020-ansible-rollen.md`, `60080-carplay-api-und-ios-app.md`, `docs/3-apps-workloads/300d0-carplay-api.md`

**Rollback.** power-agent: `power_agent_bind_address: "0.0.0.0"` in `host_vars/homeserver` und Rollenlauf (`make power-agent`), `powerAgent.url` in `carplay-api` zurück auf `http://192.168.178.94:9101`. Härtung entfällt, indem die Optionen aus `power-agent.service.j2` entfernt werden. WoL-Agent: `banana_pi_kiosk_wol_agent_bind_address: "0.0.0.0"` und `make banana-pi-kiosks`. Die Sicherungskopien der Dateien vor der Umstellung (mit Tokens) wurden am 2026-10-17 nach dem Ende-zu-Ende-Test gelöscht, der alte Stand steht im Git-Verlauf.

**Offen.**

- **App:** Ende-zu-Ende ist die Strecke `carplay-api` → Agent belegt (`GET /api/brightness` mit dem API-Token über `https://carplay-api.prod.homeserver` lieferte `200`, `carplay-api` protokolliert die Anfrage, der Agent nahm sie über `10.42.2.1` an). Die iOS-App selbst erreichte `carplay-api` nicht (siehe Nachtrag bei Incident 018).
- Die Rollen auf dem Pi (`make banana-pi-kiosks`) und homeserver (`make power-agent`) gleichen die von Hand abgelegten bzw. per Rolle gesetzten Dateien nur noch ab.
