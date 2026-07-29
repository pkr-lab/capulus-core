# Pi-hole — Netzwerkweites Werbeblocking

[Pi-hole](https://pi-hole.net) läuft als ArgoCD-verwaltete App im k3s-Cluster
(`argocd/apps/pihole/`) und wird von `dnsmasq` auf dem Home-Server als
Upstream-DNS genutzt. Dadurch bekommt jedes Gerät, das dnsmasq bereits als
DNS-Server verwendet (siehe [`09-dns-architecture.md`](09-dns-architecture.md)),
automatisch Werbe-/Tracking-Blocking — **ohne die Fritz!Box anzufassen**.

```
Client → dnsmasq (192.168.178.94:53)
           ├── *.homeserver   → statische IPs (unverändert)
           └── alles andere   → Pi-hole (NodePort :30053) → Fritz!Box → Internet
```

Details zum Forward-Pfad und zum Failure-Mode (kein Fallback auf die
Fritz!Box, falls Pi-hole ausfällt) stehen in
[`09-dns-architecture.md#pi-hole-werbeblocking-im-dns-forward`](09-dns-architecture.md#pi-hole-werbeblocking-im-dns-forward).

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
<http://kubeseal-webgui.homeserver>:

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

`argocd/apps/pihole/values.yaml` öffnen und den Platzhalter ersetzen:

```yaml
adminSecret:
  enabled: true
  secretName: pihole-webpassword
  encryptedPassword: "AgB...langes-base64..."     # ← aus 1.2
```

Committen + pushen:

```bash
git add argocd/apps/pihole/values.yaml
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

Web-UI unter `http://pihole.homeserver/admin` mit dem Passwort aus 1.1
öffnen.

---

## 2. Blocklisten & Ausnahmen pflegen

Alles Weitere läuft über die Pi-hole-Web-UI (`http://pihole.homeserver`):

- **Group Management → Adlists**: zusätzliche Blocklisten eintragen, danach
  **Tools → Update Gravity**.
- **Domains**: einzelne Domains manuell auf Allow-/Denylist setzen (z. B.
  wenn eine legitime Seite fälschlich blockiert wird).
- **Query Log**: zeigt live, welche Domains angefragt und ggf. geblockt
  wurden — hilfreich zum Debuggen von "Seite lädt nicht mehr"-Fällen nach
  dem Rollout.

Diese Einstellungen liegen in der PVC (`/etc/pihole`) und überleben
Pod-Neustarts, sind aber **nicht** in Git versioniert.

---

## 3. Passwort rotieren

Wie bei Gotify: per `kubeseal` aus einem neuen Klartext neu erzeugen,
`adminSecret.encryptedPassword` in `values.yaml` ersetzen, committen +
pushen. Das alte `pihole-webpassword`-Secret im Cluster löschen, falls
ArgoCD es nicht automatisch prunt, dann den Pi-hole-Pod neu starten.

---

## 4. Troubleshooting

| Symptom | Hinweis |
|---|---|
| Pod `CrashLoopBackOff` nach Erstdeployment | `encryptedPassword` ist noch `REPLACE_ME_WITH_KUBESEAL_OUTPUT` — Schritt 1.3 abschließen |
| `pihole-webpassword`-Secret fehlt | `kubectl -n pihole describe sealedsecret pihole-webpassword` — Ciphertext muss gegen den Public Key dieses Clusters erzeugt worden sein |
| Kein Internet mehr auf Geräten, die dnsmasq als DNS nutzen | Pi-hole-Pod down + `make dnsmasq` bereits gelaufen → kein Fallback auf die Fritz!Box (siehe [`09-dns-architecture.md`](09-dns-architecture.md)). `kubectl -n pihole get pods` prüfen, Pod ggf. neu starten |
| Legitime Seite wird geblockt | Domain in der Pi-hole-Web-UI unter **Domains** auf die Allowlist setzen |
| `pihole.homeserver` löst nicht auf | Prüfen, ob `pihole` in `dnsmasq_hosts` in `group_vars/all.yml` steht (wird automatisch über die `*.homeserver`-Wildcard aufgelöst, sollte also ohne Eintrag funktionieren), sonst `make dnsmasq` erneut ausführen |
| DNS-Antworten kommen doppelt so langsam | NodePort-Hop (`dnsmasq → Pi-hole → Fritz!Box`) fügt einen zusätzlichen Forward hinzu — normal, sollte aber im einstelligen ms-Bereich bleiben. Bei spürbaren Verzögerungen `kubectl -n pihole top pod` prüfen |
