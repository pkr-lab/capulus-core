# Windows-PC Deployment – DLRG OG Andernach

Vollautomatische Einrichtung von Windows-PCs über das Heimnetzwerk.  
Alle Werkzeuge sind Open Source. Die Installation kann sowohl von einem
frischen Rechner (ohne Betriebssystem) als auch von einem bereits
installierten Windows-System aus gestartet werden.

## Inhaltsverzeichnis

1. [Übersicht & Architektur](#übersicht--architektur)
2. [Was wird eingerichtet?](#was-wird-eingerichtet)
3. [Szenario A: Neuer PC (kein OS)](#szenario-a-neuer-pc-kein-os)
   - [Variante A1: USB-Stick](#variante-a1-usb-stick-einfachste-methode)
   - [Variante A2: Netzwerk-Boot (PXE)](#variante-a2-netzwerk-boot-pxe-fortgeschritten)
4. [Szenario B: OS installiert, noch nicht eingerichtet](#szenario-b-os-bereits-installiert)
5. [Kubernetes-Infrastruktur (windeployment)](#kubernetes-infrastruktur-windeployment)
6. [Ansible-Verwaltung bestehender PCs](#ansible-verwaltung-bestehender-pcs)
7. [Benutzer & Passwörter](#benutzer--passwörter)
8. [Namenskonvention: 1002011-XXXX](#namenskonvention-1002011-xxxx)
9. [Anpassungen](#anpassungen)
10. [Fehlerbehebung](#fehlerbehebung)

---

## Übersicht & Architektur

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Heimnetzwerk (192.168.178.0/24)              │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Homeserver (192.168.178.94)  — k3s Cluster                 │    │
│  │                                                              │    │
│  │  ArgoCD-App: windeployment                                   │    │
│  │  ┌──────────────────┐  ┌─────────────────────────────────┐  │    │
│  │  │  nginx (HTTP)    │  │  dnsmasq-pxe (TFTP/proxyDHCP)  │  │    │
│  │  │  :30090          │  │  hostNetwork (UDP 67/69)        │  │    │
│  │  │                  │  │                                 │  │    │
│  │  │  /autounattend.xml│  │  iPXE undionly.kpxe (BIOS)    │  │    │
│  │  │  /scripts/       │  │  iPXE ipxe.efi    (UEFI)       │  │    │
│  │  │  /ipxe/menu.ipxe │  │                                 │  │    │
│  │  │  /winpe/         │  └─────────────────────────────────┘  │    │
│  │  │  /iso/           │                                        │    │
│  │  └──────────────────┘                                        │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                   │
│  │1002011-0001 │ │1002011-0002 │ │1002011-0003 │                   │
│  │Büro         │ │Schulung     │ │Empfang      │                   │
│  │.101         │ │.102         │ │.103         │                   │
│  └─────────┘    └─────────┘    └─────────┘                         │
│       ↑                                                              │
│       └── PXE Boot → iPXE → WinPE → Windows-Installation           │
│           oder: USB-Stick mit autounattend.xml + setup.ps1          │
└─────────────────────────────────────────────────────────────────────┘
```

### Eingesetzte Open-Source-Werkzeuge

| Werkzeug | Lizenz | Zweck |
|---|---|---|
| [iPXE](https://ipxe.org) | GPL-2.0 | Netzwerk-Bootloader |
| [nginx](https://nginx.org) | BSD | HTTP-Server für Dateien |
| [dnsmasq](https://thekelleys.org.uk/dnsmasq/doc.html) | GPL-2.0 | TFTP + proxyDHCP |
| [Chocolatey](https://chocolatey.org) | Apache-2.0 | Windows-Paketmanager |
| [Ansible](https://ansible.com) | GPL-3.0 | Konfigurationsmanagement |

---

## Was wird eingerichtet?

### Benutzerkonten

| Konto | Typ | Anzeigename | Standardpasswort |
|---|---|---|---|
| `dlrg` | Standardbenutzer | *1002011-XXXX Einsatzzweck* (z.B. `1002011-0007 Buero`) | `DLRG2024` |
| `Admin` | Lokaler Administrator | Administrator | `DLRG-Admin-2024!` |

> Computername (`1002011-XXXX`) und Einsatzzweck werden automatisch vergeben:
> die Nummer vom Zaehler-Server (`/api/next-number`), der Einsatzzweck aus
> `pc.cfg` auf dem windeployment-Server. Das gilt fuer **alle** Wege
> (PXE, USB, Ansible, manueller `setup.ps1`-Aufruf) — siehe
> [Namenskonvention](#namenskonvention-1002011-xxxx).

> **Sicherheitshinweis:** Das Admin-Passwort **sofort nach der Einrichtung ändern!**

### Installierte Software

| Software | Installationsweg |
|---|---|
| Google Chrome | Chocolatey (`googlechrome`) |
| Microsoft Teams | Chocolatey (`microsoft-teams`) |
| TeamViewer | Chocolatey (`teamviewer`) |
| Microsoft 365 / Office | Microsoft ODT (Office Deployment Tool) |

### Systemkonfiguration

- **Sprache & Tastatur:** Deutsch (Deutschland)
- **Zeitzone:** Europe/Berlin
- **Energieoptionen:** Kein Ruhezustand, Monitor nach 30 Min. aus
- **Windows Update:** Automatisch
- **Telemetrie:** Minimiert (DSGVO)
- **Windows Defender Firewall:** Aktiv
- **Remote Desktop:** Aktiviert (nur LAN)
- **WinRM:** Aktiviert für Ansible-Verwaltung (nur LAN)
- **Cortana:** Deaktiviert
- **Fast Startup:** Deaktiviert (sauberere Neustarts)

---

## Szenario A: Neuer PC (kein OS)

### Variante A1: USB-Stick (einfachste Methode)

**Voraussetzungen:**
- USB-Stick (mind. 8 GB)
- Windows 11 ISO ([kostenlos von Microsoft](https://www.microsoft.com/de-de/software-download/windows11))
- Tool: [Rufus](https://rufus.ie) (Windows) oder `dd`/Etcher (Linux/Mac)

**Schritt 1: USB-Stick erstellen**

Mit **Rufus** (empfohlen):
1. Rufus starten → USB-Stick wählen
2. Windows 11 ISO wählen
3. Partition: GPT, Zielsystem: UEFI
4. **"Überprüfungen entfernen"** für TPM/SecureBoot aktivieren (für ältere Hardware)
5. Starten

**Schritt 2: Dateien auf USB-Stick kopieren**

```
USB-Stick (Wurzelverzeichnis)/
├── autounattend.xml    ← aus scripts/windows/autounattend.xml
└── setup.ps1           ← aus scripts/windows/setup.ps1
```

```bash
# Von diesem Repository kopieren:
cp scripts/windows/autounattend.xml /media/$USER/USB-STICK/
cp scripts/windows/setup.ps1        /media/$USER/USB-STICK/
```

**Schritt 3: Computername/Einsatzzweck**

Nicht mehr nötig: `setup.ps1` holt sich Computername (`1002011-XXXX`) und
Einsatzzweck nach der Installation automatisch vom windeployment-Server
(siehe [Namenskonvention](#namenskonvention-1002011-xxxx)). Der Wert in
`autounattend.xml` (`<ComputerName>DLRG-PC</ComputerName>`) ist nur ein
Platzhalter und wird sofort überschrieben.

**Schritt 4: PC booten**

1. USB-Stick einstecken
2. PC einschalten → im BIOS/UEFI-Setup den USB-Stick als erstes Boot-Medium setzen
3. PC startet automatisch → Windows-Installation läuft vollständig automatisch
4. Nach ca. 20-40 Minuten ist Windows installiert und eingerichtet
5. PC startet neu → `setup.ps1` lädt und installiert Software

**Gesamtdauer:** ca. 45-90 Minuten (je nach PC und Internetgeschwindigkeit)

---

### Variante A2: Netzwerk-Boot (PXE) (Fortgeschritten)

Mehrere PCs gleichzeitig ohne USB-Stick einrichten — direkt aus dem Kubernetes-Cluster.

#### Voraussetzungen

1. **WinPE-Dateien vorbereiten** (einmalig):

   WinPE stammt aus dem Windows Assessment and Deployment Kit (ADK):
   - [Windows ADK](https://learn.microsoft.com/de-de/windows-hardware/get-started/adk-install) installieren
   - Zusatz-Feature "Windows PE" hinzufügen
   - WinPE-Arbeitsumgebung erstellen:

   ```powershell
   # Windows ADK Deployment Tools Command Prompt (als Admin)
   copype.cmd amd64 C:\WinPE_amd64

   # Optionale Pakete hinzufügen (PowerShell, WMI, Netzwerk)
   Dism /Mount-Image /ImageFile:"C:\WinPE_amd64\media\sources\boot.wim" /Index:1 /MountDir:"C:\WinPE_amd64\mount"
   Dism /Image:"C:\WinPE_amd64\mount" /Add-Package /PackagePath:"C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Windows Preinstallation Environment\amd64\WinPE_OCs\WinPE-WMI.cab"
   Dism /Image:"C:\WinPE_amd64\mount" /Add-Package /PackagePath:"C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Windows Preinstallation Environment\amd64\WinPE_OCs\WinPE-NetFX.cab"
   Dism /Image:"C:\WinPE_amd64\mount" /Add-Package /PackagePath:"C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Windows Preinstallation Environment\amd64\WinPE_OCs\WinPE-Scripting.cab"
   Dism /Image:"C:\WinPE_amd64\mount" /Add-Package /PackagePath:"C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Windows Preinstallation Environment\amd64\WinPE_OCs\WinPE-PowerShell.cab"

   # startnet.cmd anpassen: lädt autounattend.xml vom Server
   # Datei: C:\WinPE_amd64\mount\Windows\System32\startnet.cmd
   ```

   Inhalt von `startnet.cmd`:
   ```batch
   @echo off
   wpeinit
   echo Lade Konfiguration vom DLRG-Server...
   powershell -Command "Invoke-WebRequest -Uri 'http://192.168.178.94:30090/autounattend.xml' -OutFile X:\autounattend.xml -UseBasicParsing"
   echo Starte Windows-Installation...
   setup.exe /unattend:X:\autounattend.xml
   ```

   ```powershell
   # WinPE fertigstellen
   Dism /Unmount-Image /MountDir:"C:\WinPE_amd64\mount" /Commit
   ```

2. **WinPE-Dateien auf Server laden:**

   ```bash
   # SSH zum Homeserver
   ssh ubuntu@192.168.178.94

   # PVC-Mount-Pfad ermitteln
   PVC_PATH=$(sudo kubectl -n windeployment get pvc windeployment-files \
     -o jsonpath='{.spec.volumeName}')
   PVC_MOUNT="/var/lib/rancher/k3s/storage/${PVC_PATH}_windeployment_windeployment-files"

   # Verzeichnisse anlegen
   sudo mkdir -p "${PVC_MOUNT}/winpe"
   sudo mkdir -p "${PVC_MOUNT}/iso"
   ```

   Von Windows aus WinPE-Dateien übertragen:
   ```powershell
   # Von Windows-PC aus (WinPE-Dateien übertragen)
   scp -r C:\WinPE_amd64\media\* ubuntu@192.168.178.94:/tmp/winpe/
   ```

   ```bash
   # Auf dem Server
   sudo cp -r /tmp/winpe/* "${PVC_MOUNT}/winpe/"
   ```

3. **Fritz!Box DHCP-Optionen konfigurieren:**

   Fritz!Box → Heimnetz → Netzwerk → DNS-Rebind-Schutz deaktivieren ist **nicht** nötig.

   **Option A (empfohlen):** Fritz!Box proxyDHCP-Einstellung:
   - Fritz!Box Oberfläche → Heimnetz → Netzwerk → DHCP-Server
   - "weitere Optionen" → TFTP-Server eintragen:
     - Option 66 (TFTP-Servername): `192.168.178.94`
     - Option 67 (Bootdateiname): `undionly.kpxe` (BIOS) oder `ipxe.efi` (UEFI)

   > **Hinweis:** Nicht alle Fritz!Box-Modelle unterstützen eigene DHCP-Optionen
   > in der Oberfläche. Falls nicht verfügbar: dnsmasq proxyDHCP wird automatisch
   > durch den `windeployment-pxe` Pod bereitgestellt (hostet proxyDHCP auf Port 67 UDP).

4. **ArgoCD-App deployen** (einmalig, geschieht automatisch per GitOps):
   ```bash
   # Kontrolle ob die App synced ist:
   kubectl -n argocd get app windeployment
   ```

#### PXE-Boot-Ablauf

```
PC einschalten
    │
    ├─► DHCP (Fritz!Box gibt IP)
    │       └─► proxyDHCP (dnsmasq-pxe): "TFTP-Server: 192.168.178.94"
    │
    ├─► TFTP: lädt ipxe.efi / undionly.kpxe
    │
    ├─► iPXE: HTTP-Request an http://192.168.178.94:30090/ipxe/menu.ipxe
    │       └─► Boot-Menü erscheint (30s Timeout → automatisch "Windows installieren")
    │
    ├─► iPXE: lädt WinPE von /winpe/
    │
    ├─► WinPE startet
    │       └─► startnet.cmd lädt autounattend.xml vom Server
    │
    ├─► Windows-Installation (vollautomatisch)
    │
    └─► Nach Installation: setup.ps1 wird ausgeführt (Software, Benutzer, Einstellungen)
```

---

## Szenario B: OS bereits installiert

PC hat bereits Windows 10/11 installiert, muss aber noch eingerichtet werden.

### Methode B1: PowerShell-Skript direkt ausführen

```powershell
# Als Administrator auf dem Windows-PC ausführen:

# Variante 1: Vom Server laden (PC muss im Netz sein)
powershell.exe -ExecutionPolicy Bypass -Command "
    Invoke-WebRequest -Uri 'http://192.168.178.94:30090/scripts/setup.ps1' `
        -OutFile 'C:\Windows\Temp\setup.ps1' -UseBasicParsing
    & 'C:\Windows\Temp\setup.ps1' -PCPurpose 'Buero' -AdminPassword 'MeinSicheresPasswort!'
"

# Variante 2: Von USB-Stick (setup.ps1 auf USB-Stick kopieren)
powershell.exe -ExecutionPolicy Bypass -File D:\setup.ps1 -PCPurpose "Schulung"
```

**Parameter für setup.ps1:**

| Parameter | Pflicht | Beschreibung |
|---|---|---|
| `-PCName` | Nein | Computername (Standard: automatisch vom Zaehler-Server, `1002011-XXXX`) |
| `-PCPurpose` | Nein | Einsatzzweck, z.B. `Buero`, `Schulung` (Standard: aus `pc.cfg` vom Server) |
| `-AdminPassword` | Ja* | Admin-Passwort (*wird interaktiv abgefragt wenn nicht angegeben) |
| `-UserPassword` | Nein | DLRG-Benutzerpasswort (Standard: `DLRG2024`) |
| `-DeploymentServer` | Nein | Basis-URL des windeployment-Servers (Standard: `http://192.168.178.94:30090`) |
| `-NonInteractive` | Nein | Alle Abfragen unterdrücken |

### Methode B2: WinRM aktivieren → Ansible

Für mehrere PCs ist Ansible effizienter (einmal konfigurieren, alle PCs auf einmal einrichten).

**Schritt 1: WinRM auf jedem PC aktivieren**
```powershell
# Als Administrator ausführen (einmalig pro PC):
powershell.exe -ExecutionPolicy Bypass -File D:\winrm-enable.ps1
# oder vom Server:
powershell.exe -ExecutionPolicy Bypass -Command "
    Invoke-WebRequest 'http://192.168.178.94:30090/scripts/winrm-enable.ps1' `
        -OutFile C:\Windows\Temp\winrm-enable.ps1 -UseBasicParsing
    & C:\Windows\Temp\winrm-enable.ps1
"
```

**Schritt 2: PC ins Ansible-Inventory eintragen**

`ansible/inventory/hosts.yml` bearbeiten:
```yaml
windows_pcs:
  vars:
    ansible_connection: winrm
    ansible_winrm_transport: basic
    ansible_port: 5985
    ansible_user: Admin
  hosts:
    buero-01:
      ansible_host: 192.168.178.101
      # windows_pc_name/windows_pc_purpose leer lassen = automatisch vom
      # windeployment-Server (Zaehler + pc.cfg). Optional ueberschreiben:
      windows_pc_purpose: Buero
    schulung-01:
      ansible_host: 192.168.178.102
      windows_pc_purpose: Schulung
```

**Schritt 3: Ansible ausführen**

```bash
# Verbindung testen
ansible windows_pcs -i ansible/inventory/hosts.yml -m win_ping \
    -e "ansible_password=Admin-Passwort"

# Vollständige Einrichtung
make windows VAULT_OPTS="-e ansible_password=Admin-Passwort"

# Nur bestimmte Aufgaben
make windows-users    VAULT_OPTS="-e ansible_password=Admin-Passwort"
make windows-software VAULT_OPTS="-e ansible_password=Admin-Passwort"
make windows-settings VAULT_OPTS="-e ansible_password=Admin-Passwort"
```

> **Tipp:** Admin-Passwort besser mit Ansible Vault verschlüsseln:
> ```bash
> ansible-vault encrypt_string 'Admin-Passwort' --name 'ansible_password'
> # Ausgabe in ansible/group_vars/windows.yml einfügen
> ```

---

## Kubernetes-Infrastruktur (windeployment)

Die ArgoCD-App `windeployment` stellt alle Deployment-Ressourcen bereit.

### Komponenten

```
argocd/apps/windeployment/
├── namespace.yaml           # Namespace "windeployment"
├── pvc.yaml                 # 500 GiB PVC für WinPE/ISO-Dateien + Zaehlerstand
├── configmap-nginx.yaml     # nginx-Konfiguration
├── configmap-autounattend.yaml  # autounattend.xml (Netzwerk + USB-Variante)
├── configmap-scripts.yaml   # setup.ps1, winrm-enable.ps1
├── configmap-ipxe.yaml      # iPXE-Bootmenü + dnsmasq-PXE-Config
├── configmap-pccfg.yaml     # pc.cfg: Einsatzzweck fuer den naechsten PC
├── configmap-counter.yaml   # counter.py: vergibt fortlaufende PC-Nummern
├── deployment.yaml          # nginx (HTTP) + counter-Sidecar + dnsmasq-pxe (TFTP/proxyDHCP)
└── service.yaml             # NodePort 30090 für HTTP
```

### Zugriff auf den HTTP-Server

```
http://192.168.178.94:30090/              → Verzeichnisindex
http://192.168.178.94:30090/autounattend.xml
http://192.168.178.94:30090/scripts/setup.ps1
http://192.168.178.94:30090/scripts/winrm-enable.ps1
http://192.168.178.94:30090/ipxe/menu.ipxe
http://192.168.178.94:30090/winpe/        → WinPE-Dateien (manuell hochladen)
http://192.168.178.94:30090/pc.cfg        → Einsatzzweck für den nächsten PC
http://192.168.178.94:30090/api/next-number → vergibt + erhöht die PC-Nummer
```

### WinPE-Dateien in den PVC laden

```bash
ssh ubuntu@192.168.178.94

# PVC-Pfad auf dem Knoten ermitteln
PVC=$(sudo kubectl -n windeployment get pvc windeployment-files \
  -o jsonpath='{.spec.volumeName}')
PVC_DIR="/var/lib/rancher/k3s/storage/${PVC}_windeployment_windeployment-files"

sudo mkdir -p "${PVC_DIR}/winpe" "${PVC_DIR}/iso"
echo "WinPE nach ${PVC_DIR}/winpe/ kopieren"
```

### Pods prüfen

```bash
kubectl -n windeployment get pods
kubectl -n windeployment logs deploy/windeployment-http
kubectl -n windeployment logs deploy/windeployment-pxe
```

---

## Ansible-Verwaltung bestehender PCs

### Collections installieren

```bash
make deps
# oder direkt:
ansible-galaxy collection install -r ansible/requirements.yml
```

### Einzelnen PC konfigurieren

```bash
# Nur einen bestimmten PC ansprechen:
ansible-playbook ansible/windows.yml -i ansible/inventory/hosts.yml \
    --limit buero-01 \
    -e "ansible_password=MeinPasswort"
```

### Passwörter per Vault verschlüsseln

```bash
# Windows-Passwörter verschlüsseln
ansible-vault encrypt_string 'DLRG-Admin-2024!' --name 'windows_admin_password'
ansible-vault encrypt_string 'MeinSicheresPasswort' --name 'ansible_password'
```

Diese verschlüsselten Blöcke in `ansible/group_vars/windows.yml` einfügen:
```yaml
---
ansible_password: !vault |
  $ANSIBLE_VAULT;1.1;AES256
  ...
windows_admin_password: !vault |
  $ANSIBLE_VAULT;1.1;AES256
  ...
```

---

## Benutzer & Passwörter

### Standardpasswörter (sofort nach Einrichtung ändern!)

| Konto | Standardpasswort | Ändern mit |
|---|---|---|
| `dlrg` (Benutzer) | `DLRG2024` | `net user dlrg NeuPasswort` |
| `Admin` (Admin) | `DLRG-Admin-2024!` | `net user Admin NeuPasswort` |

### Admin-Passwort nach Einrichtung ändern

```powershell
# Als Admin auf dem PC oder per Ansible:
net user Admin "MeinNeuesS1cheresPasswort!"

# Per Ansible (alle PCs gleichzeitig):
ansible windows_pcs -i ansible/inventory/hosts.yml \
    -m ansible.windows.win_user \
    -a "name=Admin password=NeuesPasswort password_never_expires=true" \
    -e "ansible_password=AltesDlrgPasswort" \
    -b
```

### Anzeigenamen anpassen

Der Anzeigename des `dlrg`-Kontos ist immer `<Computername> <Einsatzzweck>`:
- Büro-PC: **"1002011-0001 Buero"**
- Schulungs-PC: **"1002011-0002 Schulung"**
- Empfang: **"1002011-0003 Empfang"**

Der Einsatzzweck kommt standardmäßig aus `pc.cfg` (siehe
[Namenskonvention](#namenskonvention-1002011-xxxx)), kann aber überschrieben werden über:
- `setup.ps1 -PCPurpose "Buero"` (direkt)
- `windows_pc_purpose: Buero` (Ansible-Inventory)

---

## Namenskonvention: 1002011-XXXX

Alle PCs bekommen denselben Namen, egal ob Neuinstallation (PXE/USB) oder
bereits installiertes Windows (Ansible/manueller `setup.ps1`-Lauf):

- **Computername:** `1002011-XXXX` mit fortlaufender, vierstelliger Nummer.
  Die Nummer wird vom `counter`-Sidecar im `windeployment-http`-Pod vergeben
  (`GET /api/next-number`, persistiert auf der PVC unter
  `pc-counter.txt`) und bei jedem Aufruf um 1 erhöht.
- **Benutzeranzeigename** des `dlrg`-Kontos: `1002011-XXXX Einsatzzweck`
  (z.B. `1002011-0007 Buero`).
- **Einsatzzweck:** kommt aus `pc.cfg` auf dem windeployment-Server
  (`Einsatzzweck=Buero`). Vor jedem Deployment in
  `argocd/apps/windeployment/configmap-pccfg.yaml` anpassen und
  synchronisieren (ArgoCD-Sync oder `kubectl apply -n windeployment -f
  argocd/apps/windeployment/configmap-pccfg.yaml`).

`setup.ps1` holt Nummer und Einsatzzweck automatisch, sobald `-PCName`/
`-PCPurpose` nicht explizit angegeben sind — das gilt für PXE, USB, direkten
Aufruf und den Ansible-Pfad (Rolle `windows_setup` fragt dieselben Endpunkte
über `windows_deployment_server` ab). Ist der Zaehler-Server nicht
erreichbar (z.B. PC ohne Netzwerk), fällt `setup.ps1` auf eine Zufallsnummer
zurück, damit die Installation nicht blockiert.

> **Hinweis:** Da der Zähler nur einen einzigen, globalen Zustand führt,
> immer nur einen PC gleichzeitig fertigstellen (Aufruf von `setup.ps1`),
> sonst können zwei PCs zeitgleich denselben `pc.cfg`-Einsatzzweck erhalten.

---

## Anpassungen

### Andere Software hinzufügen

In `scripts/windows/setup.ps1` oder `argocd/apps/windeployment/configmap-scripts.yaml`
das `$packages`-Array erweitern:

```powershell
$packages = @(
    @{ Name = "googlechrome";    Description = "Google Chrome" },
    @{ Name = "teamviewer";      Description = "TeamViewer" },
    @{ Name = "microsoft-teams"; Description = "Microsoft Teams" },
    @{ Name = "vlc";             Description = "VLC Media Player" },  # Beispiel
    @{ Name = "7zip";            Description = "7-Zip" }               # Beispiel
)
```

Verfügbare Pakete: [community.chocolatey.org/packages](https://community.chocolatey.org/packages)

### Office 365 Edition ändern

In `setup.ps1` die Product-ID anpassen:

| Edition | Product ID |
|---|---|
| Microsoft 365 Business Standard | `O365BusinessRetail` |
| Microsoft 365 Apps for Enterprise | `O365ProPlusRetail` |
| Microsoft 365 Business Basic (kein Desktop-Office) | `O365BusinessRetail` |

### Mehrere PC-Typen definieren

Für unterschiedliche Konfigurationen (z.B. Büro vs. Schulung) verschiedene
`autounattend.xml`-Varianten anlegen:

```bash
cp scripts/windows/autounattend.xml scripts/windows/autounattend-schulung.xml
# In autounattend-schulung.xml: ComputerName und PCPurpose anpassen
```

Oder per Ansible-Inventory verschiedene Variablen je Host setzen:
```yaml
windows_pcs:
  hosts:
    schulung-01:
      ansible_host: 192.168.178.102
      windows_pc_purpose: Schulung
      windows_choco_packages:
        - googlechrome
        - teamviewer
        # Kein Microsoft Teams für Schulungsräume
```

---

## Fehlerbehebung

### setup.ps1 schlägt fehl (Chocolatey)

```powershell
# Chocolatey manuell installieren:
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Dann einzeln installieren:
choco install googlechrome -y
choco install teamviewer -y
choco install microsoft-teams -y
```

### Ansible-Verbindung schlägt fehl

```bash
# Verbindung debuggen:
ansible buero-01 -i ansible/inventory/hosts.yml -m win_ping -vvv \
    -e "ansible_password=MeinPasswort"

# WinRM-Status auf dem PC prüfen:
winrm get winrm/config/service
netstat -an | findstr 5985

# WinRM neu starten:
Restart-Service WinRM
```

### Windows 11 TPM/SecureBoot-Fehler

Die `autounattend.xml` enthält bereits die nötigen Registry-Einträge zum Bypass.
Falls die Installation trotzdem auf TPM-Fehler besteht:

```powershell
# In WinPE (Shift+F10 öffnet CMD):
reg add "HKLM\SYSTEM\Setup\LabConfig" /v BypassTPMCheck /t REG_DWORD /d 1 /f
reg add "HKLM\SYSTEM\Setup\LabConfig" /v BypassSecureBootCheck /t REG_DWORD /d 1 /f
reg add "HKLM\SYSTEM\Setup\LabConfig" /v BypassRAMCheck /t REG_DWORD /d 1 /f
```

### PXE: PC bootet nicht aus dem Netz

1. BIOS/UEFI: PXE/Netzwerk-Boot aktivieren
2. BIOS/UEFI: SecureBoot deaktivieren (für iPXE)
3. Fritz!Box: DHCP-Option 66/67 prüfen oder dnsmasq-pxe-Pod läuft?
   ```bash
   kubectl -n windeployment get pods
   kubectl -n windeployment logs deploy/windeployment-pxe
   ```
4. TFTP erreichbar?
   ```bash
   # Von einem Linux-PC im selben Netz testen:
   tftp 192.168.178.94 -c get undionly.kpxe /tmp/test.kpxe
   ```

### Microsoft 365 nicht aktiviert

Office lädt und installiert automatisch, benötigt aber eine gültige Lizenz zur Aktivierung:

1. PC einloggen als `dlrg`-Benutzer
2. Word/Excel/Outlook öffnen
3. Anmelden mit dem DLRG-Microsoft-Konto (`@dlrg.de` oder der DLRG-365-Lizenz)
4. Office aktiviert sich automatisch

> **DLRG-Tipp:** Als gemeinnützige Organisation kann die DLRG
> [Microsoft 365 für Nonprofits](https://www.microsoft.com/de-de/microsoft-365/nonprofits/microsoft-365-nonprofit)
> zu stark vergünstigten Konditionen beziehen.

### Log-Datei prüfen

```powershell
# Auf dem Windows-PC:
notepad C:\Windows\Logs\dlrg-setup.log
# oder:
Get-Content C:\Windows\Logs\dlrg-setup.log -Tail 50
```

---

## Schnellübersicht: Neuen PC einrichten

```
1. pc.cfg auf dem Server auf den Einsatzzweck des nächsten PCs setzen
   (configmap-pccfg.yaml anpassen + ArgoCD-Sync)
2. USB-Stick mit Windows 11 ISO + autounattend.xml + setup.ps1 erstellen
3. USB-Stick in PC → Einschalten → warten (~60 Minuten)
   → Computername (1002011-XXXX) und Einsatzzweck werden automatisch vergeben
4. Nach Neustart: Admin-Passwort ändern
5. Bei Bedarf: ans Inventory eintragen für zukünftige Ansible-Verwaltung
```
