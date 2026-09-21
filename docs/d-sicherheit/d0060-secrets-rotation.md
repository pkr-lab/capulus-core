# Secrets-Rotation-Checkliste (Security-Härtung Phase 7)

Detail-Doku zu Phase 7 aus [docs/d-sicherheit/d0010-security-hardening-roadmap.md](d0010-security-hardening-roadmap.md).

**Ziel:** Keine dokumentierte Rotationskadenz für die zentralen Secrets
dieses Setups. Statt einer reinen Doku, die niemand von sich aus wieder
aufschlägt, erinnert ein jährliches Zammad-Ticket aktiv daran — siehe
[Automatisierte Erinnerung](#automatisierte-erinnerung-n8n--zammad)
unten. Diese Seite ist das Ziel, auf das das Ticket verlinkt.

---

## Die vier zentralen Secrets

| Secret | Wo | Empfohlener Turnus | Rotieren |
|---|---|---|---|
| **Ansible-Vault-Passwort** | Schützt alle `!vault \|`-Werte in `ansible/group_vars/`, `host_vars/` | Alle 1–2 Jahre, oder sofort bei Verdacht auf Kompromittierung | `ansible-vault rekey ansible/group_vars/all.yml` (+ alle weiteren vault-verschlüsselten Dateien im Repo) — neues Passwort danach auch in `semaphore_vault_password` (docs/b-kubernetes-gitops/b0030-semaphore.md) und bei allen, die lokal `--ask-vault-pass` nutzen, aktualisieren |
| **restic-Passwort** (NAS-Backup) | Verschlüsselt das komplette Backup-Repository, siehe [docs/2-betrieb-hardware/20010-nas-backup.md](../2-betrieb-hardware/20010-nas-backup.md) | **Nicht routinemäßig rotieren** — ein Passwortwechsel macht alle bisherigen Snapshots unlesbar, außer man migriert das ganze Repository (`restic copy`/`init --repository2`, aufwendig). Nur bei tatsächlichem Verdacht auf Kompromittierung, dann mit vollständiger Repo-Migration | Bei Bedarf: neues Repo mit neuem Passwort anlegen, alte Snapshots per `restic copy` migrieren, siehe [restic-Doku](https://restic.readthedocs.io/en/stable/070_encryption.html) |
| **ArgoCD-Admin-Passwort** | Login unter `https://<server-ip>:30443` | Alle 6–12 Monate | `argocd account update-password` (oder `kubectl -n argocd patch secret argocd-secret ...`, siehe [ArgoCD-Doku](https://argo-cd.readthedocs.io/en/stable/faq/#i-forgot-the-admin-password-how-do-i-reset-it)) |
| **Sealed-Secrets-Schlüssel** | Verschlüsselt alle `SealedSecret`-Objekte im Repo | **Rotiert automatisch** — der Controller generiert standardmäßig alle 30 Tage einen neuen aktiven Schlüssel (`--key-renew-period`, hier auf Chart-Default belassen, siehe `argocd/apps/tech/sealed-secrets/values.yaml`). Alte Schlüssel bleiben für bereits versiegelte Secrets nötig und werden nicht automatisch gelöscht | Nichts zu tun für neue Secrets. Nur bei Verdacht auf Kompromittierung: `kubeseal --re-encrypt` auf alle bestehenden SealedSecrets im Repo anwenden, danach alte Controller-Keys manuell löschen (siehe [sealed-secrets-Doku](https://github.com/bitnami-labs/sealed-secrets#secret-rotation)) |

### Was seit der Multi-Cluster-Umstellung dazukommt

Die vier Secrets oben sind die zentralen. Mit den drei Clustern gibt es weitere Werte, die **je Cluster**
existieren und bei einer Rotation mitzudenken sind:

| Secret | Wo | Hinweis |
|---|---|---|
| **Sealed-Secrets-Schlüssel je Cluster** | TECH, PROD und ENTW haben jeweils eigene Controller-Schlüssel | Rotiert je Controller automatisch (siehe oben). Ein Secret muss für den **Ziel-Cluster** versiegelt sein, für PROD mit `scripts/reseal-for-prod.sh` |
| **ArgoCD-Admin-Passwort ENTW** | Eigene ArgoCD-Instanz auf der `entw-vm` | Unabhängig vom Hub-Passwort, Passwort-Update per UI/CLI der ENTW-Instanz ([b0050](../b-kubernetes-gitops/b0050-entw-argocd.md#argocd-oberfläche)) |
| **Cluster-Token `argocd-manager` (PROD im Hub)** | Secret `cluster-prod` im Hub, ServiceAccount-Token in der `prod-vm` | Berechtigt den Hub zu Cluster-Admin in PROD, bei Verdacht neu ausstellen ([argocd/bootstrap-prod/README.md](../../argocd/bootstrap-prod/README.md)) |
| **Cloudflare-Tunnel-Credentials** | Tunnel `homeserver` (TECH) und `homeserver-prod` (PROD), je als SealedSecret | Rotation je Tunnel, siehe [e0010](../e-externe-erreichbarkeit/e0010-cloudflare-deploy.md#credentials-rotieren) |
| **Interne CA** | Root-CA-Schlüssel (nur lokal) und PROD-Intermediate-CA | Siehe [d0040](d0040-internal-tls.md#prod-cluster-phase-28-multi-cluster-plan) |
| **Authentik-/lldap-Secrets** | `authentik-credentials` u. a. als SealedSecrets in TECH | Aufbau und Betrieb: [d0073](d0073-authentik-sso.md), [d0072](d0072-lldap.md); beim Neu-Versiegeln auf die Base64-Fallen im Rollout-Log von d0073 achten |

---

## Automatisierte Erinnerung: n8n → Zammad

Eine reine Markdown-Checkliste wird erfahrungsgemäß nie von sich aus
wieder aufgeschlagen. Deshalb: ein n8n-Workflow
([argocd/apps/tech/n8n/workflows/yearly-secrets-rotation-reminder.json](../../argocd/apps/tech/n8n/workflows/yearly-secrets-rotation-reminder.json))
mit einem **jährlichen Schedule-Trigger**, der ein Zammad-Ticket in der
Gruppe **`Support::Administration`** eröffnet — Titel, Fälligkeits-
Charakter und ein Link auf diese Seite, nicht die volle Checkliste im
Ticket-Text dupliziert (diese Seite bleibt die Quelle der Wahrheit für
das *Wie*, das Ticket ist nur der *Auslöser*).

Nutzt den nativen `n8n-nodes-base.zammad`-Node (Ticket → Create), nicht
den generischen HTTP-Request-Node wie beim älteren
`banana-pi-down-to-zammad.json`-Workflow — auf Wunsch, um n8n-eigene
Zammad-Credentials (Type: `zammadTokenAuthApi`) statt eines rohen
API-Tokens im HTTP-Header zu nutzen.

**Import-Anleitung:**

1. In n8n: **Workflows → Import from File** →
   `yearly-secrets-rotation-reminder.json` auswählen.
2. Node **"Zammad-Ticket erstellen"** öffnen → Credential neu anlegen/
   zuweisen (Credential-IDs werden beim Import nicht mitgenommen):
   - Typ: **Zammad Token Auth API**
   - Base URL: `https://zammad.tech.homeserver`
   - Access Token: neuen Token in Zammad unter **Profil → Token Access**
     erzeugen (Berechtigung `ticket.agent` reicht), analog zu
     [docs/f-cicd-automatisierung/f0040-github-release-watcher.md → Schritt 1](../f-cicd-automatisierung/f0040-github-release-watcher.md#schritt-1--zammad-api-token-erzeugen)
3. Trigger-Zeitpunkt bei Bedarf anpassen (Node "Jährlicher Trigger" —
   Default: 15. Januar, 08:00 Uhr; bewusst nicht der 1. Januar, um nicht
   im Feiertagsrauschen unterzugehen).
4. Workflow **aktivieren** (Schalter oben rechts — Import allein reicht
   nicht, wie bei jedem n8n-Workflow in diesem Repo).
5. Zum Testen: Trigger-Node → **Test Workflow** einmalig manuell ausführen,
   prüfen, dass das Ticket wie erwartet in Zammad unter
   **Support → Administration** auftaucht.

**Ticket-Anfrager (`customer`):** `info@edv-kretzer.de`, wie beim
bestehenden `banana-pi-down-to-zammad.json`-Workflow — muss ein
bereits existierender Zammad-User sein (siehe Hinweis in
[docs/f-cicd-automatisierung/f0040-github-release-watcher.md](../f-cicd-automatisierung/f0040-github-release-watcher.md#schritt-3--valuesyaml-anpassen)).
