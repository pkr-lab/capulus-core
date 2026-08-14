# 54 — Internes TLS für `*.homeserver` (Security-Härtung Phase 5)

Detail-Doku zu Phase 5 aus [docs/51-security-hardening-roadmap.md](51-security-hardening-roadmap.md).

**Status (13.08.2026): Cluster-seitig live und verifiziert.** TLSStore +
Zertifikat (SAN-Liste, kein Wildcard — siehe unten) sind ausgerollt,
`openssl s_client -verify_hostname` und `curl` bestätigen erfolgreiche
Verifikation gegen mehrere echte Hosts (`whoami`, `wiki`, `vault`,
`grafana`, `n8n`, `mealie`, `nextcloud`, `semaphore`, `minio`), ArgoCD
weiterhin 35/36 `Healthy`. **Offen bleibt nur noch Schritt 3 der Roadmap:**
das CA-Zertifikat auf allen weiteren Client-Geräten installieren (auf dem
Haupt-Dev-Rechner bereits erledigt) — siehe
[Client-Geräte](#client-geräte-vertrauensspeicher) unten. Schritt 4
(`http://` → `https://` in Docs/README) folgt danach.

> **Kein Wildcard-Zertifikat, trotz des Seitentitels** — siehe
> [Design-Entscheidungen](#kein-wildcard-explizite-san-liste) unten. Der
> Titel/Dateiname bezieht sich auf die `*.homeserver`-**Zone**, nicht auf
> ein tatsächliches `*.homeserver`-Wildcard-Zertifikat. Das war der
> ursprüngliche Plan, bis der erste echte HTTPS-Test zeigte, dass er
> strukturell nicht funktioniert (Details unten) — Lektion: ein
> `kubectl get secret`-Check allein hätte das nie aufgedeckt, erst der
> echte Verify-Test gegen den Hostnamen.

---

## Ziel

Alle `*.homeserver`-Adressen liefen bisher über Klartext-`http://` intern
im LAN (Traefik hatte kein TLS-Zertifikat für diese Zone — nur der externe
Pfad über den Cloudflare-Tunnel, `*.pke-lab.de`, ist bereits TLS-terminiert
bei Cloudflare). Diese Phase schließt die Lücke für den lokalen Pfad.

---

## Design-Entscheidungen

### Kleine lokale CA statt step-ca

Eine kleine, lokal generierte CA statt eines laufenden CA-Servers — der
tatsächliche Bedarf ist ein einziges, selten wechselndes
Wildcard-Zertifikat, kein Fleet-Management mit häufiger Rotation. Ein
zusätzlicher `step-ca`-Pod im Cluster wäre eine weitere dauerhaft
laufende Komponente (mehr Wartungsaufwand, mehr Angriffsfläche) für einen
Nutzen, der hier praktisch nie gebraucht wird.

### openssl statt reinem mkcert — wegen des öffentlichen Repos

Ursprünglich per `mkcert` generiert, dann nochmal neu aufgesetzt: `mkcert`
schreibt standardmäßig Username + Hostname des generierenden Rechners in
das `OU`-Feld von CA- **und** Leaf-Zertifikat (`OU=user@host`) — kein
Sicherheitsproblem (nur der öffentliche Teil, keine Secrets), aber ein
unnötiges Metadaten-Leck, sobald das Zertifikat in einem **öffentlichen**
Git-Repo landet (dieses Repo ist `public`, per `gh`/GitHub-API bestätigt).
Deshalb:

1. CA-Schlüsselpaar + selbstsigniertes Root-Zertifikat per `openssl`
   direkt erzeugt, mit neutralem Subject (`O=Homeserver Internal CA,
   CN=Homeserver Root CA`), 10 Jahre gültig.
2. Diese CA-Dateien in `mkcert`s `CAROOT`-Verzeichnis abgelegt (`mkcert
   -CAROOT`) — `mkcert` nutzt automatisch, was es dort vorfindet, statt
   eine neue CA zu generieren.
3. Das Leaf-Zertifikat **ebenfalls per openssl** signiert (nicht per
   `mkcert`), weil `mkcert` das `OU=user@host`-Feld auch beim Leaf
   hartkodiert, unabhängig davon, welche CA verwendet wird. Exakte Befehle
   in [Zertifikat erneuern](#zertifikat-erneuern) unten.

`mkcert` bleibt trotzdem nützlich: `mkcert -install` erkennt automatisch
die richtigen Trust-Store-Pfade für System/Firefox/Chrome auf verschiedenen
Betriebssystemen — das lohnt sich, selbst wenn die Zertifikate selbst per
`openssl` erzeugt werden.

### Kein Wildcard — explizite SAN-Liste

**Ursprünglich als `*.homeserver`-Wildcard geplant — funktioniert
strukturell nicht.** Erst beim echten HTTPS-Test gemerkt (curl:
`subjectAltName does not match hostname`; `openssl s_client
-verify_hostname`: Fehler 62 "hostname mismatch"):
`X509_check_host` (OpenSSL, von curl/den meisten TLS-Stacks genutzt)
lehnt Wildcards unter einem Suffix mit nur **einem** DNS-Label ab — exakt
dieselbe Schutzregel, die ein `*.com`-Zertifikat verhindert.
`.homeserver` hat nur ein Label, `*.homeserver` fällt strukturell in
dieselbe Kategorie, unabhängig von der ausstellenden CA. `mkcert` hatte
das beim allerersten Testlauf explizit als "second-level wildcard"
angemahnt — fälschlich als Multi-Label-Suffix-Sonderfall (`*.co.uk`)
abgetan, bis der echte HTTPS-Test das Gegenteil bewies.

**Fix:** Ein Zertifikat mit einer **expliziten SAN-Liste aller
tatsächlichen `*.homeserver`-Hostnamen** statt eines Wildcards — für
exakte Namen gilt keine Wildcard-Matching-Regel, das funktioniert
uneingeschränkt. Liste wird direkt aus dem Cluster gezogen
(`kubectl get ingress -A`, siehe [Zertifikat erneuern](#zertifikat-erneuern)),
nicht von Hand gepflegt. Nachteil gegenüber einem echten Wildcard: ein
neuer `*.homeserver`-Host braucht eine Zertifikats-Erneuerung (kein
großer Zusatzaufwand, da eh alle paar Jahre nötig, siehe unten) — dafür
funktioniert es überhaupt.

### Zertifikat

- **Subject Alternative Names:** alle 28 aktuellen `*.homeserver`-Hosts
  (aus `kubectl get ingress -A`) plus der nackte Apex `homeserver`.
- **Gültigkeit:** Leaf bis **11.11.2028** (~2,25 Jahre), CA bis 2036 (10
  Jahre) — lang genug, um Rotation selten zu machen, siehe
  [Erneuerung](#zertifikat-erneuern) unten.

### Ablage im Cluster: TLSStore statt pro-App-Ingress

Ein einziges `TLSStore`-Objekt namens `default`
([argocd/apps/platform/traefik-config/tlsstore.yaml](../argocd/apps/platform/traefik-config/tlsstore.yaml))
verweist auf das Zertifikat — `default` ist dabei kein Freitext, sondern
der von Traefik selbst reservierte Name, der automatisch für jeden Router
greift, der nicht explizit ein anderes TLSStore referenziert. Deutlich
weniger invasiv als `spec.tls.secretName` auf jedem der 36
Ingress-Objekte einzeln zu ergänzen.

### Zertifikat + Key: SealedSecret, CA-Private-Key: außerhalb des Repos

Der private Schlüssel des **Leaf-Zertifikats** (nicht der CA) liegt als
[SealedSecret](../argocd/apps/platform/traefik-config/sealedsecret-wildcard-tls.yaml)
im Repo — gleiches Muster wie jedes andere Secret hier. Der
**CA-Private-Key** (`rootCA-key.pem`) ist etwas anderes: er wird nur für
künftige Zertifikats-Erneuerungen gebraucht, nie vom Cluster selbst, und
gehört deshalb **nicht** ins Repo, auch nicht versiegelt — er liegt
aktuell unter `~/.local/share/mkcert/rootCA-key.pem` auf dem
Rechner, der ihn generiert hat, und sollte in einen Passwort-Manager oder
ein anderes sicheres Backup wandern (siehe [Aufräumen](#aufräumen) unten).
Das **öffentliche** CA-Zertifikat (`rootCA.pem`, keine Geheimnisse) liegt
dagegen bewusst versioniert im Repo:
[docs/assets/homeserver-root-ca.pem](assets/homeserver-root-ca.pem) — das
ist genau die Datei, die auf jedem Client-Gerät installiert werden muss.

---

## Rollout

**1. Committen + pushen** (macht der Nutzer selbst) — sobald
`argocd/apps/platform/traefik-config/{sealedsecret-wildcard-tls.yaml,tlsstore.yaml}`
und `docs/assets/homeserver-root-ca.pem` im Repo sind, holt sich ArgoCD
die Änderung automatisch (`automated: {prune: true, selfHeal: true}` in
der ApplicationSet-`syncPolicy`, kein manueller Sync-Trigger nötig).

**2. Sync abwarten und verifizieren:**

```bash
kubectl get application traefik-config -n argocd \
  -o custom-columns='NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status'
kubectl -n kube-system get secret homeserver-wildcard-tls
kubectl -n kube-system get tlsstore default -o yaml
```

**3. HTTPS lokal testen** (von einem Gerät, auf dem die CA schon
installiert ist — siehe [Client-Geräte](#client-geräte-vertrauensspeicher) unten):

```bash
curl -v https://whoami.homeserver/ 2>&1 | grep -E "issuer|subject|SSL certificate verify"
```

Erwartung: `issuer: O=Homeserver Internal CA, CN=Homeserver Root CA`,
**kein** `SSL certificate problem: unable to get local issuer certificate`
(das würde bedeuten, die CA ist auf diesem Gerät nicht vertraut — Schritt
für dieses Gerät nachholen).

**4. Erst danach** `http://` → `https://` in Docs/README nachziehen
(Punkt 4 aus der Roadmap) — nicht vorher, sonst zeigen Links auf Geräten
ohne installierte CA eine Zertifikatswarnung statt der bisher
funktionierenden Klartext-Verbindung.

---

## Client-Geräte (Vertrauensspeicher)

Das ist der aufwendige Teil — pro Gerät manuell, kein Ansible/Automatisierung
möglich (unterschiedliche OS-Mechanismen, teils kein Remote-Zugriff auf
private Geräte).

**Linux (dieser Rechner, teilweise schon erledigt):**

```bash
sudo apt-get install -y mkcert libnss3-tools   # falls noch nicht installiert
mkcert -install
```

Installiert automatisch in den System-Trust-Store **und** in Firefox/
Chrome (NSS-Datenbank, dafür `libnss3-tools`).

**Weitere Linux-Rechner** (ohne mkcert/CA-Private-Key dort): CA-Zertifikat
kopieren und manuell registrieren, statt mkcert erneut zu installieren
(braucht nur die public `.pem`, keinen Private Key):

```bash
sudo cp docs/assets/homeserver-root-ca.pem /usr/local/share/ca-certificates/homeserver-root-ca.crt
sudo update-ca-certificates
# Für Firefox/Chrome zusätzlich (NSS-Datenbank):
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "homeserver-root-ca" -i docs/assets/homeserver-root-ca.pem
```

**Windows:** `docs/assets/homeserver-root-ca.pem` doppelklicken →
"Zertifikat installieren" → **Lokaler Computer** → "Alle Zertifikate in
folgendem Speicher speichern" → **Vertrauenswürdige Stammzertifizierungsstellen**.
Firefox verwendet einen eigenen Speicher (`about:preferences#privacy` →
Zertifikate → Zertifikate anzeigen → Zertifizierungsstellen → Importieren).

**macOS:** `docs/assets/homeserver-root-ca.pem` in Schlüsselbundverwaltung
importieren (System-Schlüsselbund) → Zertifikat öffnen → "Vertrauen" →
"Bei Verwendung dieses Zertifikats" auf **Immer vertrauen** setzen.

**iOS:** Datei per AirDrop/Mail an das Gerät schicken → öffnen → Profil
installieren (Einstellungen → Profil geladen) → **zusätzlich**
Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen →
das Root-Zertifikat manuell aktivieren (iOS installiert es sonst nur,
vertraut ihm aber nicht automatisch für TLS).

**Android:** Datei aufs Gerät kopieren → Einstellungen → Sicherheit →
Verschlüsselung & Anmeldedaten → Zertifikat installieren → CA-Zertifikat.
Ab Android 7 gelten benutzerinstallierte CAs nicht automatisch für alle
Apps (nur für den Browser/System-WebView) — für Apps mit eigenem
Netzwerk-Stack ggf. nicht wirksam, hier aber nicht relevant (nur
Browser-Zugriff auf `*.homeserver`).

---

## Zertifikat erneuern

Vor dem 11.11.2028, oder früher, falls ein **neuer** `*.homeserver`-Host
hinzukommt (kein Wildcard, siehe oben — jeder neue Hostname braucht einen
SAN-Eintrag). **Nur das Leaf-Zertifikat wechselt**, die CA bleibt bis 2036
gültig — kein erneuter Trust-Store-Rollout auf den Client-Geräten nötig.

CA-Private-Key muss verfügbar sein (aus dem Passwort-Manager zurückspielen
nach `$(mkcert -CAROOT)/rootCA-key.pem`, falls nicht mehr auf diesem
Rechner — `rootCA.pem` liegt bereits versioniert unter
[docs/assets/homeserver-root-ca.pem](assets/homeserver-root-ca.pem)):

```bash
CAROOT=$(mkcert -CAROOT)

# SAN-Liste live aus dem Cluster ziehen, nicht von Hand pflegen:
HOSTS="homeserver $(kubectl get ingress -A -o jsonpath='{range .items[*]}{range .spec.rules[*]}{.host}{"\n"}{end}{end}' | grep '\.homeserver$' | sort -u | tr '\n' ' ')"
SAN=$(for h in $HOSTS; do echo -n "DNS:$h,"; done | sed 's/,$//')

openssl genrsa -out cert.key 2048

openssl req -new -key cert.key -out cert.csr \
  -subj "/O=Homeserver Internal CA/CN=homeserver"

cat > leaf-ext.cnf <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=$SAN
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF

openssl x509 -req -in cert.csr \
  -CA "$CAROOT/rootCA.pem" -CAkey "$CAROOT/rootCA-key.pem" -CAcreateserial \
  -out cert.crt -days 821 -sha256 -extfile leaf-ext.cnf

# Kontrolle vor dem Versiegeln — SAN-Liste vollständig?
openssl x509 -in cert.crt -noout -text | grep -A2 "Subject Alternative Name"

kubectl create secret tls homeserver-wildcard-tls \
  --cert=cert.crt --key=cert.key \
  --namespace=kube-system --dry-run=client -o yaml \
  | kubeseal --format yaml --controller-namespace sealed-secrets \
      --controller-name sealed-secrets-controller \
  > argocd/apps/platform/traefik-config/sealedsecret-wildcard-tls.yaml

# Private Key danach nicht liegen lassen:
shred -u cert.key cert.csr leaf-ext.cnf
```

Committen + pushen. **Danach zwingend mit einem echten `openssl s_client
-verify_hostname`- oder curl-Test gegen mindestens zwei verschiedene
Hostnamen verifizieren** (nicht nur `kubectl get secret` — das prüft nur,
dass irgendein Zertifikat da ist, nicht, dass die SAN-Liste zum
tatsächlichen Host passt. Genau dieser übersprungene Schritt hat beim
ersten Rollout das Wildcard-Problem erst spät auffallen lassen).

---

## Aufräumen

- [ ] `~/.local/share/mkcert/rootCA-key.pem` in einen Passwort-Manager
      oder ein anderes sicheres, vom Arbeitsrechner unabhängiges Backup
      kopieren — geht der Rechner verloren, ohne dass der Key gesichert
      wurde, muss bei der nächsten Erneuerung eine komplett neue CA
      generiert und auf **allen** Geräten neu installiert werden.
- [ ] Nach Schritt 3 (HTTPS lokal erfolgreich verifiziert): `http://` →
      `https://` in den restlichen Docs/README nachziehen (Roadmap-Punkt 4).
