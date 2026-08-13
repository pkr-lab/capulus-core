# Security-Härtung — Roadmap

Laufende, mehrteilige Security-Härtung des Homeservers. Diese Seite ist die
Übersicht über alle Phasen — erledigte mit Verweis auf die jeweilige
Detail-Doku, offene mit dem, was konkret noch zu tun ist. Reihenfolge ist
absichtlich so gewählt, dass jede Phase auf der vorherigen aufbaut.

---

## Erledigt

| Phase | Inhalt | Doku |
|---|---|---|
| 0 | Quick Wins: Vaultwarden `SIGNUPS_ALLOWED: false`, ArgoCD-NodePort 30080 (HTTP) aus UFW entfernt, nur noch HTTPS (30443) | [docs/05-argocd.md](05-argocd.md), [docs/42-port-uebersicht.md](42-port-uebersicht.md) |
| 1 | CrowdSec — Brute-Force-Schutz SSH + Traefik | [docs/46-crowdsec.md](46-crowdsec.md) |
| 2 | ArgoCD AppProject-Trennung Platform/Workloads + Namespace-Tier-Label | [docs/49-argocd-projects.md](49-argocd-projects.md) — **inkl. eines Incidents beim Rollout**, siehe [docs/50-incident-2026-08-12.md](50-incident-2026-08-12.md) |
| 9 | Renovate (automatische Update-PRs) + semantic-release (GitHub Release bei jedem Merge auf `main`) | [docs/47-renovate.md](47-renovate.md), [docs/48-release-automation.md](48-release-automation.md) |
| 3 | Cluster-NetworkPolicies — grobe Tier-Policy + vollständige Verfeinerung auf alle 36 App-Namespaces (nur noch eigener Namespace + kube-system + monitoring + cloudflared + gezielte Ausnahmen) | [docs/52-network-policies.md](52-network-policies.md) — **inkl. eines Beinahe-Incidents (Cloudflare-Tunnel-Ausfall während des Rollouts)** |
| 4 | k3s Secrets-Encryption-at-Rest (AES-CBC, per Byte-Dump verifiziert) + Audit-Log (Metadata-Level, 14 Tage Retention) | [docs/53-secrets-encryption-audit-log.md](53-secrets-encryption-audit-log.md) |

---

## Offen

### Phase 5 — Internes TLS für `*.homeserver`

**Status (13.08.2026): Cluster-seitig live und verifiziert.** Eigene
openssl-CA (statt mkcert direkt — Nutzer-Metadaten, Repo ist öffentlich),
Zertifikat mit expliziter SAN-Liste statt Wildcard (`*.homeserver`
scheitert strukturell an einer OpenSSL-Sicherheitsregel gegen
Single-Label-Suffix-Wildcards — siehe docs/54 für die Details, per
`openssl s_client -verify_hostname` gegen mehrere echte Hosts bestätigt).
Vollständige Detail-Doku, Design-Entscheidungen und Anleitung pro
Geräte-Typ (Linux/Windows/macOS/iOS/Android):
[docs/54-internal-tls.md](54-internal-tls.md).

**Ziel:** Aktuell laufen alle `*.homeserver`-Adressen über Klartext-`http://`
(Traefik hat keine TLS-Zertifikate für das interne LAN).

**Ansatz:**
1. Eigene kleine CA (openssl statt mkcert). **[Erledigt]**
2. Zertifikat (SAN-Liste statt Wildcard, siehe docs/54), als
   Traefik-Default-TLS-Cert (`TLSStore`) hinterlegt. **[Erledigt, verifiziert]**
3. Root-CA-Zertifikat auf allen Client-Geräten im Trust-Store installieren
   — das ist der aufwendigste Teil (pro Gerät manuell). **[Teilweise —
   Haupt-Dev-Rechner erledigt, weitere Geräte offen]**
4. `http://` → `https://` in Docs/README nachziehen, sobald verifiziert. **[Offen]**

**Risiko:** gering für den Cluster selbst, Aufwand liegt beim Verteilen des
CA-Zertifikats auf alle Geräte.

### Phase 6 — NAS/UGOS-Härtung

**Ziel:** Das UGREEN-NAS wird bewusst nicht per Ansible verwaltet — kein
automatisches Patch-Management, keine dokumentierte Firewall-/2FA-Härtung
für das Admin-Panel des NAS selbst.

**Ansatz:** Checkliste als neue Doku (`docs/NN-nas-hardening.md`): Auto-Update
im UGOS-Panel aktivieren, Admin-2FA einschalten, Web-Admin-UI nicht
LAN-weit ohne Not exponieren, unnötige UGOS-Dienste deaktivieren. Rein
manuell, kein Ansible (bewusste bestehende Design-Entscheidung, siehe
[docs/16-nas-storage.md](16-nas-storage.md)).

**Risiko:** keins — reine Doku + manuelle Klicks im NAS-Panel.

### Phase 7 — Secrets-Rotation & Security-Alerting

**Ziel:** Keine dokumentierte Rotationskadenz für Ansible-Vault-Passwort,
restic-Passwort, ArgoCD-Admin-PW, Sealed-Secrets-Key. Kein Alerting auf
sicherheitsrelevante Events (UFW-Denies, CrowdSec-Bans, gehäufte
Authentik-Login-Fehlschläge).

**Ansatz:**
1. Kurze Rotations-Checkliste als Doku, mit empfohlenem Turnus je Secret.
2. CrowdSec-Ban-Events (aus Phase 1) über den bestehenden
   Gotify/ntfy-Bridge-Mechanismus ausliefern — keine neue Infrastruktur
   nötig, nur eine weitere Alert-Quelle an den bestehenden Stack anhängen.

**Risiko:** gering, additiv zum bestehenden Monitoring.

---

## Reihenfolge-Empfehlung

Phase 3 → 4 → 5 → 6 → 7 → (8 optional). Phase 6 kann jederzeit
zwischengeschoben werden (rein manuell, keine Abhängigkeiten). Vor Phase 3
und 4 jeweils sicherstellen, dass der Cluster in einem stabilen,
vollständig verifizierten Zustand ist — siehe die offenen Punkte in
[docs/50-incident-2026-08-12.md](50-incident-2026-08-12.md), die vor
weiteren strukturellen Cluster-Änderungen abgeschlossen sein sollten.
