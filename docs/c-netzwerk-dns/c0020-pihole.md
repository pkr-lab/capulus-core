# Pi-hole — Netzwerkweites Werbeblocking

[Pi-hole](https://pi-hole.net) läuft als ArgoCD-verwaltete App im k3s-Cluster
(`argocd/apps/platform/pihole/`) und wird von `dnsmasq` auf dem Home-Server als
Upstream-DNS genutzt. Dadurch bekommt jedes Gerät, das dnsmasq bereits als
DNS-Server verwendet (siehe [`c0000-dns-architecture.md`](c0000-dns-architecture.md)),
automatisch Werbe-/Tracking-Blocking — **ohne die Fritz!Box anzufassen**.

```
Client → dnsmasq (192.168.178.94:53)
           ├── *.homeserver   → statische IPs (unverändert)
           └── alles andere   → Pi-hole (NodePort :30053) → Fritz!Box → Internet
```

Details zum Forward-Pfad und zum Failure-Mode (kein Fallback auf die
Fritz!Box, falls Pi-hole ausfällt) stehen in
[`c0000-dns-architecture.md#pi-hole-werbeblocking-im-dns-forward`](c0000-dns-architecture.md#pi-hole-werbeblocking-im-dns-forward).

---

## 1. Erstdeployment

### 1.1 Web-/API-Passwort mit Vault verschlüsseln

```bash
ansible-vault encrypt_string 'DEIN_STARKES_PIHOLE_PW' \
  --name 'pihole_admin_password'
```

Den resultierenden `!vault |`-Block optional in `ansible/group_vars/all.yml`
ablegen, damit das Klartext-Passwort bei einer Rotation nicht verloren geht
(wird von Ansible selbst nicht gelesen — Pi-hole bekommt sein Passwort
ausschließlich über den SealedSecret unten).

### 1.2 SealedSecret-Ciphertext erzeugen

Wie bei Gotify — entweder über die Web-UI unter
<https://kubeseal-webgui.homeserver>:

- **Namespace**: `pihole`
- **Secret-Name**: `pihole-webpassword`
- **Key**: `password`
- **Value**: das Klartext-Passwort aus 1.1

Oder per CLI:

```bash
echo -n 'DEIN_STARKES_PIHOLE_PW' \
  | kubeseal --raw \
      --namespace pihole \
      --name pihole-webpassword \
      --from-file=/dev/stdin
```

### 1.3 Ciphertext in `values.yaml` eintragen

`argocd/apps/platform/pihole/values.yaml` öffnen und den Platzhalter ersetzen:

```yaml
adminSecret:
  enabled: true
  secretName: pihole-webpassword
  encryptedPassword: "AgB...langes-base64..."     # ← aus 1.2
```

Committen + pushen:

```bash
git add argocd/apps/platform/pihole/values.yaml
git commit -m "feat(pihole): set sealed web password"
git push
```

ArgoCD übernimmt die Änderung innerhalb von ~3 Minuten (oder **Refresh** in
der ArgoCD-UI bei der `pihole`-App klicken, um sie sofort anzuwenden).

### 1.4 dnsmasq-Forward aktivieren

Der Forward von dnsmasq an Pi-hole (`pihole_dns_nodeport: 30053` in
`ansible/group_vars/all.yml`, gerendert in
`ansible/roles/dnsmasq/templates/dnsmasq.conf.j2`) ist bereits Teil des
Playbooks — nach dem ersten Sync der `pihole`-App einmal ausrollen:

```bash
make dnsmasq
```

> **Reihenfolge beachten:** Erst den Pi-hole-Pod `Running` bekommen (Schritt
> 1.1–1.3), dann `make dnsmasq` laufen lassen. Läuft dnsmasq bereits mit dem
> neuen Forward, bevor Pi-hole erreichbar ist, bricht die Namensauflösung für
> alle Nicht-`*.homeserver`-Anfragen auf Geräten ab, die dnsmasq nutzen.

### 1.5 Verifizieren

```bash
SRV='ssh -i ~/.ssh/id_ed25519 ubuntu@homeserver'

$SRV 'sudo kubectl -n pihole get pods,svc,ingress,pvc,sealedsecret,secret'

# DNS-Filterung direkt gegen den NodePort testen (sollte 0.0.0.0 liefern):
dig @192.168.178.94 -p 30053 doubleclick.net

# Normale Auflösung sollte weiterhin funktionieren:
dig @192.168.178.94 -p 30053 github.com
```

Erwartet:
- Pod `Running`, PVC `Bound`, das `pihole-webpassword`-Secret vorhanden.
- Bekannte Werbe-/Tracking-Domains lösen zu `0.0.0.0` (bzw. `NXDOMAIN`,
  abhängig von der Blocking-Mode-Einstellung) auf, alles andere normal.

Web-UI unter `https://pihole.homeserver/admin` mit dem Passwort aus 1.1
öffnen.

---

## 2. Client-Geräte einrichten

Damit ein Gerät tatsächlich durch Pi-hole gefiltert wird, muss es
**dnsmasq auf dem Home-Server** (`192.168.178.94`, Port 53) als DNS-Server
verwenden — dnsmasq leitet alle nicht-`*.homeserver`-Anfragen automatisch
an Pi-hole weiter (siehe [`c0000-dns-architecture.md`](c0000-dns-architecture.md#pi-hole-werbeblocking-im-dns-forward)).

> **Wichtig**: Trag niemals den Pi-hole-NodePort (`:30053`) direkt als
> DNS-Server ein — Betriebssysteme erwarten DNS auf Port 53, den nur
> dnsmasq bedient. Immer `192.168.178.94` verwenden.

Auf jedem Gerät zwei DNS-Server eintragen:

- **Primär**: `192.168.178.94` (dnsmasq → Pi-hole)
- **Sekundär**: `192.168.178.1` (Fritz!Box-Fallback, falls der Home-Server
  down ist — dann ohne Werbeblocking, aber Internet bleibt nutzbar)

### Windows

1. *Einstellungen → Netzwerk und Internet → WLAN* (oder *Ethernet*) →
   Namen des verbundenen Netzwerks anklicken → *Hardwareeigenschaften →
   DNS-Serverzuweisung: Bearbeiten*
2. Von *Automatisch (DHCP)* auf *Manuell* umstellen, IPv4 aktivieren
3. **Bevorzugter DNS**: `192.168.178.94`, **Alternativer DNS**:
   `192.168.178.1` → *Speichern*

Alternative per PowerShell (als Administrator):

```powershell
Get-NetAdapter                                          # Interface-Namen ermitteln, z. B. "Wi-Fi"
Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ServerAddresses ("192.168.178.94","192.168.178.1")
```

### macOS

1. *Systemeinstellungen → Netzwerk → WLAN* (oder *Ethernet*) → *Details…
   → DNS*
2. Mit **+** `192.168.178.94` hinzufügen, mit einem zweiten **+**
   `192.168.178.1` → *OK → Anwenden*

Alternative per Terminal:

```bash
networksetup -listallnetworkservices        # Dienstnamen ermitteln, z. B. "Wi-Fi"
networksetup -setdnsservers "Wi-Fi" 192.168.178.94 192.168.178.1
```

### iPhone / iPad (iOS)

1. *Einstellungen → WLAN* → **(i)**-Symbol neben dem verbundenen Netzwerk
2. *DNS konfigurieren → Manuell*
3. Bestehenden Eintrag löschen, **Server hinzufügen**: erst
   `192.168.178.94`, dann `192.168.178.1` → *Fertig*

Gilt nur für dieses eine WLAN und muss bei jedem neuen Netzwerk wiederholt
werden; über Mobilfunk greift das Heimnetz ohnehin nicht. Für unterwegs
stattdessen Tailscale mit Split-DNS nutzen (siehe
[`c0000-dns-architecture.md → Weg 1`](c0000-dns-architecture.md)).

### Android

Menüführung variiert je nach Hersteller, im Kern immer:

1. *Einstellungen → Netzwerk & Internet → WLAN* → Zahnrad beim
   verbundenen Netzwerk → *Erweitert / IP-Einstellungen*
2. Von *DHCP* auf **Statisch** umstellen
3. **DNS 1**: `192.168.178.94`, **DNS 2**: `192.168.178.1` → *Speichern*

> Bei "Statisch" verlangen manche Android-Versionen zusätzlich
> IP-Adresse/Gateway/Subnetzmaske korrekt einzutragen (aus den aktuellen
> WLAN-Details ablesen), sonst bricht die Verbindung ab. Die
> **Private-DNS**-Funktion (DNS-over-TLS) ist hier **keine** Alternative,
> da dafür ein gültiges TLS-Zertifikat auf dem DNS-Server nötig wäre, das
> dnsmasq/Pi-hole hier nicht bereitstellt.

### Linux (NetworkManager, z. B. Ubuntu Desktop)

```bash
nmcli con show                                                  # Verbindungsnamen ermitteln
nmcli con modify "<verbindung>" ipv4.dns "192.168.178.94 192.168.178.1"
nmcli con modify "<verbindung>" ipv4.ignore-auto-dns yes
nmcli con up "<verbindung>"
```

### Verifizieren

Auf dem jeweiligen Gerät (Terminal/Eingabeaufforderung, sofern vorhanden):

```bash
nslookup doubleclick.net 192.168.178.94   # sollte 0.0.0.0 / NXDOMAIN liefern
nslookup github.com 192.168.178.94        # sollte normal auflösen
```

Oder einfacher: in der Pi-hole-Web-UI (`https://pihole.homeserver/admin`)
unter **Query Log** prüfen, ob Anfragen von der IP des Geräts auftauchen.

---

## 3. Blocklisten & Ausnahmen pflegen

Alles Weitere läuft über die Pi-hole-Web-UI (`https://pihole.homeserver`):

- **Group Management → Adlists**: zusätzliche Blocklisten eintragen (URL zu
  einer Listendatei, **keine** einzelne Domain — dafür siehe Denylist unten),
  danach **Tools → Update Gravity**.
- **Domains**: einzelne Domains manuell auf Allow-/Denylist setzen (z. B.
  wenn eine legitime Seite fälschlich blockiert wird). Für ganze Domains
  samt aller Subdomains (z. B. ein Ad-Netzwerk, das über viele
  Rechenzentrums-Subdomains rotiert) `pihole --wild <domain>` verwenden statt
  eines exakten Denylist-Eintrags — hosts-Format-Adlists blocken nur exakt
  gelistete Namen, keine automatischen Wildcards.
- **Query Log**: zeigt live, welche Domains angefragt und ggf. geblockt
  wurden — hilfreich zum Debuggen von "Seite lädt nicht mehr"-Fällen nach
  dem Rollout, und um Ad-Domains zu finden, die trotz aktiver Listen noch
  durchkommen.

Aktuell eingetragene Adlists (Stand: initiales Setup):

| Liste | Zweck |
|---|---|
| `StevenBlack/hosts` | Basis-Ad-/Tracking-Blockliste |
| Firebog `Easylist.txt` | Werbung |
| Firebog `AdguardDNS.txt` | Werbung (Ersatz für die tote `adguardteam.github.io`-URL) |
| Firebog `Easyprivacy.txt` | Tracking/Telemetrie |
| `urlhaus.abuse.ch` Hostfile | aktive Malware-/C2-Domains, sehr niedrige False-Positive-Rate |
| Firebog `Prigent-Crypto.txt` | Krypto-Mining-Skripte im Browser |
| Firebog `static/w3kbl.txt` | bewährte Suspicious-Domains-Liste |

Bewusst **nicht** eingetragen: Firebog `Prigent-Ads.txt` (redundant zu den
drei vorhandenen Ad-Listen) und `Prigent-Malware.txt` (248k Zeilen, bekannt
für False-Positives in der Community — bei Bedarf gezielt nachrüsten).

Diese Einstellungen liegen in der PVC (`/etc/pihole`) und überleben
Pod-Neustarts, sind aber **nicht** in Git versioniert.

---

## 4. Passwort rotieren

Wie bei Gotify: per `kubeseal` aus einem neuen Klartext neu erzeugen,
`adminSecret.encryptedPassword` in `values.yaml` ersetzen, committen +
pushen. Das alte `pihole-webpassword`-Secret im Cluster löschen, falls
ArgoCD es nicht automatisch prunt, dann den Pi-hole-Pod neu starten.

---

## 5. Troubleshooting

| Symptom | Hinweis |
|---|---|
| Pod `CrashLoopBackOff` nach Erstdeployment | `encryptedPassword` ist noch `REPLACE_ME_WITH_KUBESEAL_OUTPUT` — Schritt 1.3 abschließen |
| `pihole-webpassword`-Secret fehlt | `kubectl -n pihole describe sealedsecret pihole-webpassword` — Ciphertext muss gegen den Public Key dieses Clusters erzeugt worden sein |
| Kein Internet mehr auf Geräten, die dnsmasq als DNS nutzen | Pi-hole-Pod down + `make dnsmasq` bereits gelaufen → kein Fallback auf die Fritz!Box (siehe [`c0000-dns-architecture.md`](c0000-dns-architecture.md)). `kubectl -n pihole get pods` prüfen, Pod ggf. neu starten |
| Legitime Seite wird geblockt | Domain in der Pi-hole-Web-UI unter **Domains** auf die Allowlist setzen |
| `pihole.homeserver` löst nicht auf | Prüfen, ob `pihole` in `dnsmasq_hosts` in `group_vars/all.yml` steht (wird automatisch über die `*.homeserver`-Wildcard aufgelöst, sollte also ohne Eintrag funktionieren), sonst `make dnsmasq` erneut ausführen |
| DNS-Antworten kommen doppelt so langsam | NodePort-Hop (`dnsmasq → Pi-hole → Fritz!Box`) fügt einen zusätzlichen Forward hinzu — normal, sollte aber im einstelligen ms-Bereich bleiben. Bei spürbaren Verzögerungen `kubectl -n pihole top pod` prüfen |
| Neu geblockte Domain wird trotzdem noch aufgelöst (z. B. nach `pihole --wild`/`pihole -g`) | dnsmasq cached die alte, ungeblockte Antwort bis zum TTL-Ablauf. Fix: `sudo systemctl restart dnsmasq` auf dem Home-Server, um den Cache zu leeren. Direkt gegen den NodePort testen (`dig @192.168.178.94 -p 30053 <domain>`), um Pi-hole isoliert von dnsmasqs Cache zu prüfen |
| Werbung erscheint trotz aktivem Pi-hole weiterhin auf einzelnen Seiten | Häufig eine nicht erfasste Subdomain eines Ad-Netzwerks (Listen blocken meist nur exakte Domains, keine automatischen Wildcards). Im **Query Log** nach nicht geblockten, verdächtigen Domains suchen und gezielt per `pihole --wild <domain>` (blockt die Domain + alle Subdomains) ergänzen |
