# 041 ArgoCD: Initial-Admin-Secret seit 134 Tagen vorhanden, lokales Admin-Konto aktiv

- Severity: Low
- Bereich: Repo
- Betroffen: Namespace `argocd`: Secret `argocd-initial-admin-secret`, ConfigMap `argocd-cm` (`admin.enabled: "true"`)
- Status: Offen

## Beschreibung

ArgoCD legt bei der Installation das Secret `argocd-initial-admin-secret` mit dem Start-Passwort des Kontos `admin` an und empfiehlt, es nach dem ersten Login und der Passwortänderung zu löschen. Es existiert noch (Alter 134 Tage). Das Konto `admin` ist aktiviert, der Login läuft über Klartext-HTTP (Incident 013). Ob das Passwort inzwischen geändert wurde, ist aus dem Secret ohne Lesen des Werts nicht zu erkennen; der Wert wurde nicht gelesen.

## Nachweis

```
$ kubectl -n argocd get secret argocd-initial-admin-secret
NAME                          TYPE     DATA   AGE
argocd-initial-admin-secret   Opaque   1      134d
$ kubectl -n argocd get cm argocd-cm -o jsonpath='{.data.admin\.enabled}'
true
```

## Risiko / Angriffsszenario

Ist das Startpasswort nie geändert worden, kennt jeder mit Leserechten auf Secrets im Namespace `argocd` den Admin-Zugang des GitOps-Systems. Ist es geändert, ist das Secret nur ein irreführender Rest.

## Empfohlene Behebung

1. Admin-Passwort prüfen bzw. ändern: `argocd account update-password`.
2. Secret löschen: `kubectl -n argocd delete secret argocd-initial-admin-secret`.
3. Langfristig `admin.enabled: "false"` und Anmeldung über SSO oder einen Token mit eigenen Rollen (`accounts.<name>: login`).

## Rollback

Das Secret ist nicht wiederherstellbar; der Admin-Zugang wird über `argocd admin initial-password` bzw. ein Zurücksetzen des Passworts im `argocd-secret` erneuert.

## Verifikation

```
kubectl -n argocd get secret argocd-initial-admin-secret
```
Meldung `NotFound`; Login mit dem neuen Passwort funktioniert.

## Risiko der Behebung

Niedrig: Das Secret wird nach der Passwortänderung nicht mehr gebraucht. Vorher prüfen, dass das Admin-Passwort geändert wurde und im Passwortmanager liegt.

## Bearbeitungsstand (2026-10-18)

Nicht umgesetzt: Eine Passwortrotation und das Löschen des Secrets brauchen deine Freigabe. Geprüft habe ich, ob das Startpasswort noch das gültige ist, ohne den Wert zu lesen (nur der Zeitstempel `admin.passwordMtime` in `argocd-secret`):

| Cluster | `argocd-initial-admin-secret` angelegt | `admin.passwordMtime` | Bedeutung |
|---|---|---|---|
| Hub (TECH) | 2026-06-03 19:35:42 | 2026-06-03 19:35:42 | Passwort **nie geändert**, das Startpasswort ist das gültige Admin-Passwort |
| ENTW | 2026-09-18 16:31:12 | 2026-09-18 16:31:12 | ebenso |

Das Secret ist damit kein irreführender Rest, sondern der Klartext des aktiven Admin-Zugangs; wer Secrets im Namespace `argocd` lesen kann, kann sich als Admin anmelden. Die CI nutzt dafür ein eigenes Konto-Token (Incident 013), der Admin-Login ist nur für dich.

Der Test, dass es geklappt hat: `argocd account get --grpc-web` mit neuem Passwort, danach `kubectl -n argocd get secret argocd-initial-admin-secret` → `NotFound`. Sag Bescheid, wenn ich es mit einem von mir erzeugten Passwort ausführen soll (das dir dann einmal angezeigt wird); ohne dein Zutun rotiere ich es nicht.

**Langfristig (Punkt 3).** `admin.enabled: "false"` setzt voraus, dass es einen anderen Zugang gibt (`accounts.<name>: login` plus Rollen in `argocd-rbac-cm`); die Konfiguration kommt aus der Rolle `argocd` und braucht den Render-Lauf mit Vault-Passwort, deshalb nicht umgesetzt.

