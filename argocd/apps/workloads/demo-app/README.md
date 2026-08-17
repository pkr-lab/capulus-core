# demo-app — GitOps Live-Demo für ArgoCD

Eine winzige Beispiel-App für eine ArgoCD-Self-Heal-Demo. Der **komplette
angezeigte Text** kommt aus einer Environment-Variable (`MESSAGE`) und lässt sich
**live mit einem `kubectl`-Befehl** überschreiben. Das löst einen echten Rollout
aus → ArgoCD erkennt die Abweichung (*OutOfSync*) → setzt beim Sync den Git-Stand
wieder her.

> Alle Werte in diesem Chart sind **Beispieldaten**. `repoURL`, `path`, der
> Deployment-Name (`fullnameOverride`) und der Text (`message`) sind frei anpassbar.

---

## 1. Ins Repo einbinden

Kein manuelles `kubectl apply` nötig: Sobald der Ordner `demo-app/` unter
`argocd/apps/workloads/` committet und gepusht ist, entdeckt das
Workloads-ApplicationSet (`argocd/bootstrap/root-applicationset.yaml`) das
neue Verzeichnis automatisch (innerhalb von ca. 3 Minuten) und legt die
Application **demo-app** an — Namespace ist dabei immer der Ordnername,
hier also **`demo-app`** (nicht `default`).

Die mitgelieferte `argocd-application.yaml` in diesem Ordner wird dafür
**nicht** gebraucht und von nichts im Repo referenziert — reines
Demo-Artefakt für den Fall, dass du diesen Chart mal isoliert außerhalb
dieses Repos/ApplicationSet-Setups betreiben willst (dann `repoURL` und
`path` darin anpassen und manuell
`kubectl apply -f argocd-application.yaml -n argocd` ausführen).

Damit `demo-app` als eigenes AppProject-Ziel erlaubt ist, muss der
Namespace zusätzlich in `argocd_workloads_apps`
(`ansible/roles/argocd/defaults/main.yml`) stehen und `make
render-bootstrap` gelaufen sein — für dieses Beispiel bereits erledigt.

## 2. App im Browser ansehen

```bash
kubectl port-forward svc/demo-app 8080:80 -n demo-app
# Browser: http://localhost:8080
```

Du siehst den Soll-Text aus `values.yaml`: `Hello from GitOps - Version 1`

---

## 3. Der Live-Eingriff (der "Hack")

Ein Befehl überschreibt den kompletten Inhalt und erzwingt einen Rollout.
Das Deployment läuft im Namespace `demo-app` (== Ordnername, siehe Schritt 1)
auf dem Homeserver (`192.168.178.94`) — lokal per `kubectl` erreichbar,
sofern dein Kontext auf den Cluster zeigt, sonst per SSH direkt auf dem
Server ausführen:

```bash
# lokal, falls kubeconfig bereits auf den Cluster zeigt
kubectl set env deployment/demo-app -n demo-app \
  MESSAGE="CBS-koblenz: IT-Secruity kennen wir nicht!"

# alternativ direkt auf dem Homeserver via SSH
ssh ubuntu@192.168.178.94 'kubectl set env deployment/demo-app -n demo-app MESSAGE="CBS-koblenz: IT-Secruity kennen wir nicht!"'
```

- Kubernetes ändert das Pod-Template → **neue Pods werden ausgerollt**.
- Browser aktualisieren → der neue Text erscheint.
- In ArgoCD springt `demo-app` auf **OutOfSync** ⚠️ (live ≠ Git).

## 4. ArgoCD stellt die Wahrheit wieder her

- In der ArgoCD-Oberfläche auf **Sync** klicken *(oder `argocd app sync demo-app`)*.
- ArgoCD setzt `MESSAGE` zurück auf den Git-Wert → **erneuter Rollout** →
  Browser zeigt wieder den Original-Text. **Synced** ✅

*(Alternativ in `argocd-application.yaml` den `automated: selfHeal`-Block
aktivieren — dann macht ArgoCD das ohne Klick automatisch.)*

---

## Ablauf auf einen Blick

| Schritt | Aktion | ArgoCD-Status |
|--------|--------|---------------|
| 1 | App läuft, Text = Git-Stand | **Synced** ✅ |
| 2 | `kubectl set env ... MESSAGE=...` | Rollout läuft |
| 3 | Neuer Text im Browser | **OutOfSync** ⚠️ |
| 4 | Sync (Klick oder selfHeal) | Rollout läuft |
| 5 | Original-Text zurück | **Synced** ✅ |

## Text dauerhaft ändern (der "richtige" GitOps-Weg)

Nicht per `kubectl`, sondern in **`values.yaml`** das Feld `message:` ändern,
committen und pushen. ArgoCD zieht den neuen Stand automatisch — genau die
Kernaussage: **Änderungen laufen nur über Git.**
