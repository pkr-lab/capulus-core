#Requires -RunAsAdministrator
<#
.SYNOPSIS
    DLRG OG Andernach - Windows-PC Einrichtungsskript
.DESCRIPTION
    Vollautomatische Einrichtung eines Windows-PCs fuer die DLRG OG Andernach.
    Installiert Software, legt Benutzer an, konfiguriert System-Einstellungen.

    Parameter koennen interaktiv abgefragt oder per -NonInteractive uebergeben werden.

.PARAMETER PCName
    Computername (Standard: automatisch vom Zaehler-Server, Schema 1002011-XXXX)

.PARAMETER PCPurpose
    Einsatzzweck des PCs, erscheint im Anzeigenamen des dlrg-Benutzers als
    "<PCName> <Einsatzzweck>", z.B. "1002011-0007 Buero"
    (Standard: aus pc.cfg vom windeployment-Server gelesen)

.PARAMETER AdminPassword
    Passwort fuer den Admin-Account (Pflicht, kein Standard)

.PARAMETER UserPassword
    Passwort fuer den dlrg-Benutzer (Standard: DLRG2024)

.PARAMETER DeploymentServer
    Basis-URL des windeployment-Servers fuer Zaehler (/api/next-number)
    und pc.cfg (Standard: http://192.168.178.94:30090)

.PARAMETER NonInteractive
    Unterdrückt alle Abfragen, nutzt Standardwerte

.EXAMPLE
    .\setup.ps1 -PCPurpose "Buero" -AdminPassword "S3cur3P@ss!" -NonInteractive
#>
param(
    [string]$PCName = "",
    [string]$PCPurpose = "",
    [string]$AdminPassword = "",
    [string]$UserPassword = "DLRG2024",
    [string]$DeploymentServer = "http://192.168.178.94:30090",
    [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ─── Logging ─────────────────────────────────────────────────────────────────
$LogFile = "C:\Windows\Logs\dlrg-setup.log"
New-Item -ItemType Directory -Force -Path "C:\Windows\Logs" | Out-Null

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] [$Level] $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

function Exit-WithError {
    param([string]$Message)
    Write-Log $Message "ERROR"
    if (-not $NonInteractive) {
        Read-Host "Fehler aufgetreten. Druecken Sie Enter zum Beenden"
    }
    exit 1
}

Write-Log "=== DLRG OG Andernach - Windows Einrichtung gestartet ==="
Write-Log "Skript-Version: 2024-06-16"

# ─── Parameter einsammeln ─────────────────────────────────────────────────────
if (-not $NonInteractive) {
    if ($PCName -eq "") {
        $PCName = Read-Host "Computername (z.B. 1002011-0007) [Leer = automatisch vom Zaehler-Server]"
    }
    if ($PCPurpose -eq "") {
        $PCPurpose = Read-Host "Einsatzzweck (z.B. Buero, Schulung, Empfang) [Leer = aus pc.cfg vom Server]"
    }
    if ($AdminPassword -eq "") {
        $adminPwSecure = Read-Host "Admin-Passwort" -AsSecureString
        $AdminPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminPwSecure)
        )
    }
}

# PC-Nummer vom Zaehler-Server holen: Namensschema 1002011-XXXX
if ($PCName -eq "") {
    try {
        $nr = (Invoke-WebRequest -Uri "$DeploymentServer/api/next-number" -UseBasicParsing -TimeoutSec 10).Content.Trim()
        $PCName = "1002011-$nr"
    } catch {
        $PCName = "1002011-" + (Get-Random -Maximum 9999).ToString("0000")
        Write-Log "Zaehler-Server nicht erreichbar, nutze Zufallsnummer: $_" "WARN"
    }
}

# Einsatzzweck aus pc.cfg vom Server holen (vom Techniker vor dem Deployment gepflegt)
if ($PCPurpose -eq "") {
    try {
        $cfg = (Invoke-WebRequest -Uri "$DeploymentServer/pc.cfg" -UseBasicParsing -TimeoutSec 10).Content
        foreach ($cfgLine in ($cfg -split "`r?`n")) {
            if ($cfgLine -match '^\s*Einsatzzweck\s*=\s*(.+?)\s*$') { $PCPurpose = $matches[1]; break }
        }
    } catch {
        Write-Log "pc.cfg nicht erreichbar: $_" "WARN"
    }
    if ($PCPurpose -eq "") { $PCPurpose = "PC" }
}

$DlrgDisplayName = "$PCName $PCPurpose"

Write-Log "Computername:    $PCName"
Write-Log "Anwendungszweck: $PCPurpose"
Write-Log "Benutzeranzeige: $DlrgDisplayName"

# ─── 1. Benutzer anlegen ─────────────────────────────────────────────────────
Write-Log "--- Benutzer anlegen ---"

function New-LocalUserSafe {
    param($Name, $Password, $FullName, $Description, $Group)
    try {
        $existing = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Log "Benutzer '$Name' existiert bereits, aktualisiere..."
            Set-LocalUser -Name $Name -FullName $FullName -Description $Description
            $secPw = ConvertTo-SecureString $Password -AsPlainText -Force
            Set-LocalUser -Name $Name -Password $secPw -PasswordNeverExpires $true
        } else {
            $secPw = ConvertTo-SecureString $Password -AsPlainText -Force
            New-LocalUser -Name $Name -Password $secPw -FullName $FullName `
                -Description $Description -PasswordNeverExpires $true | Out-Null
            Write-Log "Benutzer '$Name' erstellt"
        }
        # Gruppe zuweisen
        $groupMembers = Get-LocalGroupMember -Group $Group -ErrorAction SilentlyContinue
        if ($groupMembers -and ($groupMembers.Name -like "*\$Name")) {
            Write-Log "Benutzer '$Name' ist bereits in Gruppe '$Group'"
        } else {
            Add-LocalGroupMember -Group $Group -Member $Name -ErrorAction SilentlyContinue
            Write-Log "Benutzer '$Name' zu Gruppe '$Group' hinzugefuegt"
        }
    } catch {
        Write-Log "Fehler bei Benutzer '$Name': $_" "WARN"
    }
}

# Admin-Konto (falls AdminPassword angegeben)
if ($AdminPassword -ne "") {
    New-LocalUserSafe `
        -Name "Admin" `
        -Password $AdminPassword `
        -FullName "Administrator" `
        -Description "DLRG OG Andernach - lokaler Administrator" `
        -Group "Administrators"

    # Eingebautes Administrator-Konto deaktivieren (eigenes Admin-Konto verwenden)
    Disable-LocalUser -Name "Administrator" -ErrorAction SilentlyContinue
    Write-Log "Eingebautes Administrator-Konto deaktiviert"
}

# DLRG-Standardbenutzer
New-LocalUserSafe `
    -Name "dlrg" `
    -Password $UserPassword `
    -FullName $DlrgDisplayName `
    -Description "DLRG OG Andernach - Standardbenutzer" `
    -Group "Users"

# Gast-Konto sicherstellen (deaktiviert)
Disable-LocalUser -Name "Guest" -ErrorAction SilentlyContinue
Write-Log "Gast-Konto deaktiviert"

# ─── 2. Computername setzen ───────────────────────────────────────────────────
Write-Log "--- Computername setzen ---"
$currentName = $env:COMPUTERNAME
if ($currentName -ne $PCName) {
    Rename-Computer -NewName $PCName -Force -ErrorAction SilentlyContinue
    Write-Log "Computername geaendert: $currentName -> $PCName (wirksam nach Neustart)"
} else {
    Write-Log "Computername bereits korrekt: $PCName"
}

# ─── 3. Chocolatey installieren ───────────────────────────────────────────────
Write-Log "--- Chocolatey installieren ---"
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Write-Log "Chocolatey wird installiert..."
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    Set-ExecutionPolicy Bypass -Scope Process -Force
    Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    Write-Log "Chocolatey installiert"
} else {
    Write-Log "Chocolatey bereits installiert: $(choco --version)"
}

# ─── 4. Software installieren ─────────────────────────────────────────────────
Write-Log "--- Software installieren ---"

$packages = @(
    @{ Name = "googlechrome";      Description = "Google Chrome" },
    @{ Name = "teamviewer";        Description = "TeamViewer" },
    @{ Name = "microsoft-teams";   Description = "Microsoft Teams" }
)

foreach ($pkg in $packages) {
    Write-Log "Installiere $($pkg.Description)..."
    try {
        choco install $pkg.Name --yes --no-progress --limit-output 2>&1 | ForEach-Object {
            if ($_ -match "(Installing|Installed|already installed|Error)") { Write-Log "  choco: $_" }
        }
        Write-Log "$($pkg.Description) - OK"
    } catch {
        Write-Log "$($pkg.Description) - FEHLER: $_" "WARN"
    }
}

# ─── 5. Microsoft 365 / Office installieren ───────────────────────────────────
Write-Log "--- Microsoft 365 installieren ---"
$odtDir = "C:\Windows\Temp\M365"
New-Item -ItemType Directory -Force -Path $odtDir | Out-Null

$odtConfig = @"
<Configuration>
  <Add OfficeClientEdition="64" Channel="Current">
    <Product ID="O365BusinessRetail">
      <Language ID="de-de"/>
      <ExcludeApp ID="Access"/>
      <ExcludeApp ID="Groove"/>
      <ExcludeApp ID="Lync"/>
      <ExcludeApp ID="Publisher"/>
    </Product>
  </Add>
  <Updates Enabled="TRUE" Channel="Current"/>
  <Display Level="None" AcceptEULA="TRUE"/>
  <Logging Level="Standard" Path="C:\Windows\Logs"/>
  <Property Name="AUTOACTIVATE" Value="0"/>
</Configuration>
"@
$odtConfig | Out-File -FilePath "$odtDir\configuration.xml" -Encoding UTF8

Write-Log "Office Deployment Tool (ODT) herunterladen..."
try {
    $odtUrl = "https://download.microsoft.com/download/2/7/A/27AF1BE6-DD20-4CB4-B154-EBAB8A7D4A7E/officedeploymenttool_17531-20046.exe"
    $odtExe = "$odtDir\officedeploymenttool.exe"
    Invoke-WebRequest -Uri $odtUrl -OutFile $odtExe -UseBasicParsing -TimeoutSec 120
    # ODT entpacken
    Start-Process -FilePath $odtExe -ArgumentList "/quiet /extract:$odtDir" -Wait
    Write-Log "ODT entpackt, starte Office-Installation (kann 20-45 Minuten dauern)..."
    Start-Process -FilePath "$odtDir\setup.exe" -ArgumentList "/configure $odtDir\configuration.xml" -Wait
    Write-Log "Microsoft 365 - Installation abgeschlossen (Aktivierung erfordert Microsoft-Konto)"
} catch {
    Write-Log "Microsoft 365 konnte nicht automatisch installiert werden: $_" "WARN"
    Write-Log "Bitte Microsoft 365 manuell unter https://www.office.com installieren" "WARN"
}

# ─── 6. Windows-Einstellungen konfigurieren ───────────────────────────────────
Write-Log "--- Windows-Einstellungen ---"

# Zeitzone
try {
    Set-TimeZone -Id "W. Europe Standard Time"
    Write-Log "Zeitzone: W. Europe Standard Time (Europa/Berlin)"
} catch { Write-Log "Zeitzone-Fehler: $_" "WARN" }

# Standorteinstellungen (Deutschland)
Set-WinUILanguageOverride -Language de-DE -ErrorAction SilentlyContinue
Set-Culture de-DE -ErrorAction SilentlyContinue
Set-WinUserLanguageList -LanguageList de-DE -Force -ErrorAction SilentlyContinue

# Energieoptionen: kein Ruhezustand, Bildschirm nach 30 Min
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 30
Write-Log "Energieoptionen: Ruhezustand deaktiviert, Monitor nach 30min"

# Windows Update: automatisch
$wuKey = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"
New-Item -Path $wuKey -Force | Out-Null
Set-ItemProperty -Path $wuKey -Name "AUOptions" -Value 4 -ErrorAction SilentlyContinue
Set-ItemProperty -Path $wuKey -Name "NoAutoUpdate" -Value 0 -ErrorAction SilentlyContinue
Write-Log "Windows Update: automatische Installation aktiviert"

# Telemetrie minimieren (DSGVO-relevant fuer Organisationen)
$telKey = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection"
New-Item -Path $telKey -Force | Out-Null
Set-ItemProperty -Path $telKey -Name "AllowTelemetry" -Value 0 -ErrorAction SilentlyContinue
Write-Log "Telemetrie auf Mindestniveau gesetzt"

# Cortana deaktivieren
$cortanaKey = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search"
New-Item -Path $cortanaKey -Force | Out-Null
Set-ItemProperty -Path $cortanaKey -Name "AllowCortana" -Value 0 -ErrorAction SilentlyContinue

# Schnellstart (Fast Startup) deaktivieren fuer sauberere Shutdowns
$fastStartKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power"
Set-ItemProperty -Path $fastStartKey -Name "HiberbootEnabled" -Value 0 -ErrorAction SilentlyContinue
Write-Log "Fast Startup deaktiviert"

# Papierkorb-Groesse: 5 GB
$shell = New-Object -ComObject Shell.Application -ErrorAction SilentlyContinue

# Firewall: alle Profile aktiv
netsh advfirewall set allprofiles state on | Out-Null
Write-Log "Windows Firewall: alle Profile aktiv"

# Remote Desktop aktivieren (fuer Fernwartung via TeamViewer als Fallback)
Set-ItemProperty -Path "HKLM:\System\CurrentControlSet\Control\Terminal Server" `
    -Name "fDenyTSConnections" -Value 0 -ErrorAction SilentlyContinue
Enable-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue
Write-Log "Remote Desktop aktiviert"

# Netzwerkprofil auf Privat setzen (verhindert Aufforderung bei erstem Login)
$netProfiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue
foreach ($p in $netProfiles) {
    Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private -ErrorAction SilentlyContinue
}
Write-Log "Netzwerkprofil: Privat"

# ─── 7. WinRM fuer Ansible aktivieren (optional) ──────────────────────────────
Write-Log "--- WinRM fuer Ansible-Verwaltung aktivieren ---"
try {
    Enable-PSRemoting -Force -SkipNetworkProfileCheck
    winrm set winrm/config/service/auth '@{Basic="true"}' | Out-Null
    winrm set winrm/config/service '@{AllowUnencrypted="true"}' | Out-Null
    New-NetFirewallRule -DisplayName "WinRM HTTP" -Direction Inbound `
        -Protocol TCP -LocalPort 5985 -Action Allow `
        -RemoteAddress "192.168.178.0/24" -ErrorAction SilentlyContinue | Out-Null
    Write-Log "WinRM aktiviert (HTTP, nur LAN 192.168.178.0/24)"
} catch {
    Write-Log "WinRM-Aktivierung fehlgeschlagen: $_" "WARN"
}

# ─── 8. Desktop-Einstellungen fuer alle neuen Benutzer ───────────────────────
Write-Log "--- Standardprofil konfigurieren ---"

# Default-Benutzer-Registry laden und anpassen
reg load "HKU\DefaultUser" "C:\Users\Default\NTUSER.DAT" 2>$null

# Desktop-Hintergrund (einfarbig dunkelblau - DLRG-Farbe)
reg add "HKU\DefaultUser\Control Panel\Desktop" /v "Wallpaper" /t REG_SZ /d "" /f | Out-Null
reg add "HKU\DefaultUser\Control Panel\Colors" /v "Background" /t REG_SZ /d "0 38 100" /f | Out-Null

# Taskleiste: kleine Icons, Suchleiste ausblenden
reg add "HKU\DefaultUser\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Advanced" `
    /v "TaskbarSmallIcons" /t REG_DWORD /d 0 /f | Out-Null
reg add "HKU\DefaultUser\SOFTWARE\Microsoft\Windows\CurrentVersion\Search" `
    /v "SearchboxTaskbarMode" /t REG_DWORD /d 0 /f | Out-Null

# Dateiendungen anzeigen
reg add "HKU\DefaultUser\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Advanced" `
    /v "HideFileExt" /t REG_DWORD /d 0 /f | Out-Null

# News und Interessen deaktivieren
reg add "HKU\DefaultUser\SOFTWARE\Microsoft\Windows\CurrentVersion\Feeds" `
    /v "ShellFeedsTaskbarViewMode" /t REG_DWORD /d 2 /f | Out-Null

reg unload "HKU\DefaultUser" 2>$null
Write-Log "Standardprofil konfiguriert"

# ─── 9. Windows Defender Ausschlüsse fuer Chocolatey ─────────────────────────
try {
    Add-MpPreference -ExclusionPath "C:\ProgramData\chocolatey" -ErrorAction SilentlyContinue
} catch {}

# ─── 10. Logoff-Skript fuer dlrg-Benutzer (Sitzungsbereinigung) ──────────────
# (optional, kein Pflichtbestandteil)

# ─── Abschluss ────────────────────────────────────────────────────────────────
Write-Log "=== Einrichtung abgeschlossen ==="
Write-Log "Zusammenfassung:"
Write-Log "  Computername:  $PCName"
Write-Log "  Benutzer dlrg: $DlrgDisplayName (Passwort: $UserPassword)"
Write-Log "  Admin-Konto:   Admin (Passwort selbst festgelegt)"
Write-Log "  Log-Datei:     $LogFile"
Write-Log ""
Write-Log "WICHTIG: Admin-Passwort nach der Einrichtung aendern!"
Write-Log "WICHTIG: Microsoft 365 muss noch mit Ihrer Lizenz aktiviert werden."
Write-Log ""
Write-Log "PC wird in 30 Sekunden neu gestartet..."

if (-not $NonInteractive) {
    Write-Host ""
    Write-Host "Einrichtung abgeschlossen! Druecken Sie Enter fuer Neustart oder Ctrl+C zum Abbrechen."
    Read-Host
}

Start-Sleep -Seconds 30
Restart-Computer -Force
