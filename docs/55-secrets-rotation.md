# 55 — Secrets-Rotation-Checkliste (Security-Härtung Phase 7)

Detail-Doku zu Phase 7 aus [docs/51-security-hardening-roadmap.md](51-security-hardening-roadmap.md).

**Ziel:** Keine dokumentierte Rotationskadenz für die zentralen Secrets
dieses Setups. Statt einer reinen Doku, die niemand von sich aus wieder
aufschlägt, erinnert ein jährliches Zammad-Ticket aktiv daran — siehe
[Automatisierte Erinnerung](#automatisierte-erinnerung-n8n--zammad)
unten. Diese Seite ist das Ziel, auf das das Ticket verlinkt.

---

## Die vier zentralen Secrets

| Secret | Wo | Empfohlener Turnus | Rotieren |
|---|---|---|---|
| **Ansible-Vault-Passwort** | Schützt alle `!vault \|`-Werte in `ansible/group_vars/`, `host_vars/` | Alle 1–2 Jahre, oder sofort bei Verdacht auf Kompromittierung | `ansible-vault rekey ansible/group_vars/all.yml` (+ alle weiteren vault-verschlüsselten Dateien im Repo) — neues Passwort danach auch in `semaphore_vault_password` (docs/08-semaphore.md) und bei allen, die lokal `--ask-vault-pass` nutzen, aktualisieren |
| **restic-Passwort** (NAS-Backup) | Verschlüsselt das komplette Backup-Repository, siehe [docs/36-nas-backup.md](36-nas-backup.md) | **Nicht routinemäßig rotieren** — ein Passwortwechsel macht alle bisherigen Snapshots unlesbar, außer man migriert das ganze Repository (`restic copy`/`init --repository2`, aufwendig). Nur bei tatsächlichem Verdacht auf Kompromittierung, dann mit vollständiger Repo-Migration | Bei Bedarf: neues Repo mit neuem Passwort anlegen, alte Snapshots per `restic copy` migrieren, siehe [restic-Doku](https://restic.readthedocs.io/en/stable/070_encryption.html) |
| **ArgoCD-Admin-Passwort** | Login unter `https://<server-ip>:30443` | Alle 6–12 Monate | `argocd account update-password` (oder `kubectl -n argocd patch secret argocd-secret ...`, siehe [ArgoCD-Doku](https://argo-cd.readthedocs.io/en/stable/faq/#i-forgot-the-admin-password-how-do-i-reset-it)) |
| **Sealed-Secrets-Schlüssel** | Verschlüsselt alle `SealedSecret`-Objekte im Repo | **Rotiert automatisch** — der Controller generiert standardmäßig alle 30 Tage einen neuen aktiven Schlüssel (`--key-renew-period`, hier auf Chart-Default belassen, siehe `argocd/apps/platform/sealed-secrets/values.yaml`). Alte Schlüssel bleiben für bereits versiegelte Secrets nötig und werden nicht automatisch gelöscht | Nichts zu tun für neue Secrets. Nur bei Verdacht auf Kompromittierung: `kubeseal --re-encrypt` auf alle bestehenden SealedSecrets im Repo anwenden, danach alte Controller-Keys manuell löschen (siehe [sealed-secrets-Doku](https://github.com/bitnami-labs/sealed-secrets#secret-rotation)) |

---

## Automatisierte Erinnerung: n8n → Zammad

Eine reine Markdown-Checkliste wird erfahrungsgemäß nie von sich aus
wieder aufgeschlagen. Deshalb: ein n8n-Workflow
([argocd/apps/workloads/n8n/workflows/yearly-secrets-rotation-reminder.json](../argocd/apps/workloads/n8n/workflows/yearly-secrets-rotation-reminder.json))
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
   - Base URL: `https://zammad.homeserver`
   - Access Token: neuen Token in Zammad unter **Profil → Token Access**
     erzeugen (Berechtigung `ticket.agent` reicht), analog zu
     [docs/25-github-release-watcher.md → Schritt 1](25-github-release-watcher.md#schritt-1--zammad-api-token-erzeugen)
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
[docs/25](25-github-release-watcher.md#schritt-3--valuesyaml-anpassen)).
