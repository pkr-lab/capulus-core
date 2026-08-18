cat > ~/capulus-memory.md << 'EOF'
# Capulus-Core Setup Memory

## Server-Spezifikation
- **IP**: 192.168.1.100 (anpassen!)
- **Hostname**: homeserver
- **OS**: Ubuntu Server 26.04 LTS
- **RAM**: 32 GB
- **Storage**: 512 GB NVMe + HDD für Backups
- **Netzwerk**: LAN 192.168.1.0/24, Tailscale für Remote-Access

## Kubernetes Stack
- **k3s**: v1.29 (stable)
- **Control-Plane**: Single-Node auf homeserver
- **Ingress**: Traefik v2 (bundled mit k3s)
- **Storage**: local-path provisioner (default), HDD-StorageClass optional
- **Metrics**: metrics-server, node-exporter

## GitOps & Deployment
- **Repo**: https://github.com/pkr-lab/capulus-core.git
- **GitOps-Tool**: ArgoCD
- **ArgoCD-URL**: http://192.168.1.100:30080 (oder http://argocd.homeserver)
- **App-Struktur**: argocd/apps/{{ app-name }}/
- **Auto-Discovery**: root-applicationset.yaml erkennt alle Ordner in argocd/apps/

## Networking & VPN
- **Tailscale**: Wired VPN für Remote-Access, keine Portfreigaben
- **Split-DNS**: dnsmasq auf tailscale0 für *.homeserver auflösbar
- **Firewall**: UFW, erlaubt SSH/HTTP/HTTPS/k3s-API/Tailscale

## Ansible Setup
- **Entry-Point**: ansible/site.yml
- **Inventory**: ansible/inventory/hosts.yml
- **Group Vars**: ansible/group_vars/all.yml (vault-encrypted)
- **Roles**: ansible/roles/{{ role-name }}/ (role-per-concern)
- **Vault Password**: (solltest du nur lokal haben!)

## Laufende Apps (ArgoCD)
- **Monitoring**: VictoriaMetrics + Grafana
- **Notifications**: Gotify + ntfy
- **Kubernetes UI**: Headlamp
- **Secrets**: Sealed Secrets + kubeseal-webgui
- **CI/CD**: Argo Workflows + MinIO
- **SSO**: Authentik
- **Web Ansible**: Semaphore
- **Alerts**: Alertmanager mit Gotify/ntfy Bridges

## Häufige Tasks
- **Neue App deployen**: mkdir argocd/apps/my-app/ → Git push → ArgoCD synct
- **Ansible-Run**: make install (oder ansible-playbook -i ... --ask-vault-pass)
- **k3s-Upgrade**: Playbook mit auto_upgrade: true
- **Troubleshooting**: kubectl, helm, argocd CLI, journalctl

## Backup-Strategie
- [HIER: Deine Backup-Strategie eintragen, falls vorhanden]

## Bekannte Besonderheiten
- VictoriaMetrics hat 15 Tage Retention, 10Gi PVC
- Tailscale braucht auth-key (vault-encrypted in group_vars)
- ArgoCD hat kein öffentlicher IP-Zugriff (nur LAN + Tailnet)
- dnsmasq NICHT als LAN-DNS — nur Auflösung von *.homeserver
EOF
cat ~/capulus-memory.md