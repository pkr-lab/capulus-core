# 010 alert-caller: `/alert` und `/watchdog` ohne Authentifizierung, Pod nutzt `hostNetwork`

- Severity: Medium
- Bereich: Repo
- Betroffen: `argocd/apps/tech/alert-caller/src/caller.py:455-470, 488`, `argocd/apps/tech/alert-caller/values.yaml:15` (`hostNetwork: true`)
- Status: Teilweise behoben am 2026-10-17 (Stufe 1 im Modus `log` live; offen: Pi-Rollenlauf, Stufe 2 `enforce`)

## Beschreibung

Der HTTP-Dienst des Telefon-Alarms nimmt `POST /alert` (löst einen Anruf mit synthetisierter Ansage aus) und `POST /watchdog` (setzt den Totmann-Timer zurück) ohne jede Authentifizierung an. Der Pod läuft mit `hostNetwork: true` und bindet `0.0.0.0:9310` direkt auf dem Knoten. NetworkPolicies greifen bei `hostNetwork` nicht; die UFW vertraut dem gesamten LAN und Tailnet (Incident 008). Der Handler liest außerdem `Content-Length` vor jeder Prüfung (negativer Wert → `rfile.read(-1)` blockiert den Thread).

## Nachweis

```
$ sed -n 455,470p argocd/apps/tech/alert-caller/src/caller.py
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY:
            return self._reply(413, "body too large")
        raw = self.rfile.read(length) if length else b""
        if self.path == "/watchdog":
            handle_watchdog()
            return self._reply(200, "ok")
        if self.path == "/alert" and STATIC_ANNOUNCEMENT:
        ...
        if self.path == "/alert":
            ...
            handle_alert(payload)

$ sed -n 15p argocd/apps/tech/alert-caller/values.yaml
hostNetwork: true
```

## Phase-2-Nachweis (live, lesend)

Live-Stand: Der Pod `alert-caller` läuft mit `hostNetwork` (Prozess mit UID 1000, im Host als `ubuntu` sichtbar), lauscht auf `0.0.0.0:9310` und ist vom LAN-Client per TCP erreichbar (nur Verbindungstest). Aus Rücksicht auf den Totmann-Timer und die Anruflogik wurde **kein** `POST` abgesetzt.

## Risiko / Angriffsszenario

Jedes Gerät im LAN/Tailnet kann (a) beliebige Alarme auslösen: Telefonanrufe an die Bereitschaft mit frei wählbarem Inhalt (Alarmmüdigkeit, Social Engineering), (b) per ständigem `/watchdog` den Totmann-Alarm „Cluster meldet sich nicht mehr“ unterdrücken, sodass ein Ausfall unbemerkt bleibt.

## Empfohlene Behebung

Gemeinsames Geheimnis per Header erzwingen (Token aus SealedSecret, `hmac.compare_digest`), Negativwerte für `Content-Length` abweisen:
```diff
+TOKEN = os.environ.get("ALERT_CALLER_TOKEN", "")
 ...
     def do_POST(self):
-        length = int(self.headers.get("Content-Length", "0") or "0")
+        header = self.headers.get("Authorization", "")
+        if not TOKEN or not hmac.compare_digest(header, "Bearer " + TOKEN):
+            return self._reply(401, "unauthorized")
+        length = int(self.headers.get("Content-Length", "0") or "0")
+        if length < 0:
+            return self._reply(400, "bad length")
```
Alertmanager-Webhook (`http_config.authorization.credentials`) und die Watchdog-Quelle (Alert `Watchdog` bzw. vmalert) entsprechend mit dem Token versehen. Zusätzlich prüfen, ob `hostNetwork` wirklich nötig ist (SIP/ICE); wenn ja, UFW-Regel für Port 9310 auf die Quellen der Alertmanager-/Watchdog-Pods beschränken.

## Rollback

Vorherige Image-Version (`image.tag`) wiederherstellen und Alertmanager-Konfiguration zurücksetzen.

## Verifikation

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://192.168.178.94:9310/watchdog
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ALERT_CALLER_TOKEN" http://192.168.178.94:9310/watchdog
```
Erwartung: `401` ohne Token, `200` mit Token. Danach einen Testalarm von Alertmanager aus senden und den Anruf bestätigen.

## Risiko der Behebung

Mittel: Der Telefon-Alarm fällt still aus, wenn Alertmanager oder die Watchdog-Quelle den Token nicht mitsenden. Stufenweise einführen (erst protokollieren, dann erzwingen).

## Behebung (2026-10-17, Stufe 1)

**Fix** (PR #463, Commit `f348d76`): Der Caller verlangt auf `POST /alert` und `POST /watchdog` den Header `Authorization: Bearer <Token>`, verglichen mit `hmac.compare_digest`. Eine negative oder unlesbare `Content-Length` ergibt `400`, und der Body wird erst nach der Prüfung gelesen. Der Modus kommt aus `ALERT_CALLER_AUTH_MODE`: `log` nimmt Aufrufe ohne gültigen Token an und protokolliert sie mit Quelle (`unauthenticated request <Pfad> from <IP>`), `enforce` antwortet mit `401`. Der Dienst startet im Modus `enforce` nicht ohne Token. Eingeführt wird in zwei Stufen, wie in der Beschreibung verlangt.

- **Sender:** Der Alertmanager schickt den Token an alle drei Webhooks zum Caller (`watchdog` an Pod und Pi, `phone`). Er liest ihn aus einem Secret, das als `/etc/vm/secrets/alert-caller-token/token` gemountet ist (`credentials_file`).
- **Empfänger:** Pod (SealedSecret `alert-caller-secrets`, Schlüssel `ALERT_CALLER_TOKEN`, Modus `config.auth.mode: log`) und Notfall-Caller auf dem Pi (`alert-caller.env`, Vault-Variable `vault_alert_caller_token`).
- **`hostNetwork` bleibt.** SIP/ICE und der RTP-Bereich `10000`–`10100` laufen direkt auf dem Host. Die Firewall (Incident 008) sperrt zwar LAN-Geräte, aber Pods und das Tailnet erreichen Port `9310` weiter, deshalb der Token.
- `caller.py` kommt über die ConfigMap in den Pod, ein Image-Build war nicht nötig.

**Nachweis** (live, nach dem Sync):

| Test | Ergebnis |
|---|---|
| Lokale Tests von `caller.py` (28 Fälle: beide Modi, falscher und fehlender Token, `Bearer`-Format, negative Länge, ungültiges JSON, 404, 413, Startprüfung) | alle ok |
| Secrets: `alert-caller-secrets` | Schlüssel `ALERT_CALLER_TOKEN` und `SIP_PASSWORD` |
| Secret `monitoring/alert-caller-token` | Schlüssel `token`, 64 Zeichen, im Alertmanager-Pod gemountet (64 Byte) |
| Alertmanager | Konfiguration geladen, 5 Webhook-Benachrichtigungen, **0 fehlgeschlagen** |
| Pod-Log nach zwei Watchdog-Takten | **0** Zeilen `unauthenticated` (Alertmanager schickt den Token mit) |
| Gegenprobe von `100.112.94.55` (Modus `log`) | ohne Token `200` und Logzeile, falscher Token `200` und Logzeile, richtiger Token `200` ohne Logzeile, negative `Content-Length` `400` |
| Pi (alter Code bis zum Rollenlauf) | `/watchdog` mit Token `200`, ignoriert den Header |

Während des Rollouts wurde der Alertmanager-Pod neu gestartet (wegen `spec.secrets`), und das Secret war bei seinem Start vorhanden. Es gab dabei keinen Ausfall der Alarmierung, der Caller-Pod startete ebenfalls sauber neu.

**Geänderte Dateien.**

- `argocd/apps/tech/alert-caller/` (`src/caller.py`, `values.yaml`, `templates/deployment.yaml`)
- `argocd/apps/tech/monitoring/` (`values.yaml`, neu `templates/sealedsecret-alert-caller-token.yaml`)
- `ansible/roles/alert_caller/` (`defaults/main.yml`, `tasks/main.yml`, `templates/alert-caller.env.j2`)
- `scripts/seal-alert-caller-token.sh` (neu), `ops/token-register.yaml`
- Doku: `docs/1-benachrichtigungen/10020-telefon-alarm.md` (Abschnitt „Zugriffsschutz (Token)“), `docs/6-hintergruende/60020`, `60040`, `60060`, `600a0`

**Rollback.** Im Modus `log` geht keine Meldung verloren, es genügt ein Revert-PR. Im Modus `enforce` zusätzlich `config.auth.mode: log`. Der Alertmanager-Mount lässt sich entfernen, indem man `spec.secrets` und die `http_config`-Blöcke zurücknimmt; dabei das Secret nicht vor dem Alertmanager löschen.

**Offen.**

- **Pi-Rollenlauf** (braucht das Vault-Passwort): `ansible-playbook -i ansible/inventory/hosts.yml ansible/alert-caller.yml --limit vereinsheim-alarmmonitor --tags alert-caller --ask-vault-pass`. Danach darf das Pi-Log keine `unauthenticated`-Zeile vom Alertmanager mehr zeigen.
- **Stufe 2:** `config.auth.mode: enforce` im Chart und `alert_caller_auth_mode: enforce` in `ansible/group_vars/alert_caller_pi.yml`, danach `401` ohne Token, `200` mit Token und ein echter Testanruf (Testplan 3). Voraussetzung ist ein längerer Zeitraum ohne unauthentifizierte Zeilen.
- `UFW`-Beschränkung von Port `9310` auf die Alertmanager-Quellen ist wegen `hostNetwork` und der Pod-Regel nicht sinnvoll, der Token ersetzt sie.
