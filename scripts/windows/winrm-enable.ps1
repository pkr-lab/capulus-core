#Requires -RunAsAdministrator
<#
.SYNOPSIS
    WinRM fuer Ansible-Verwaltung aktivieren
.DESCRIPTION
    Aktiviert Windows Remote Management (WinRM) auf dem PC,
    sodass Ansible Konfigurationen fernsteuern kann.
    Nur aus dem LAN (192.168.178.0/24) erreichbar.

    Aufruf: powershell.exe -ExecutionPolicy Bypass -File winrm-enable.ps1
#>
param(
    [string]$AllowedSubnet = "192.168.178.0/24"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "WinRM wird fuer Ansible aktiviert..."

# WinRM-Dienst konfigurieren
Enable-PSRemoting -Force -SkipNetworkProfileCheck

# Basis-Authentifizierung (Ansible-Standard mit HTTP)
winrm set winrm/config/service/auth '@{Basic="true"}'
winrm set winrm/config/service '@{AllowUnencrypted="true"}'

# Listener auf allen Interfaces
winrm set winrm/config/listener?Address=*+Transport=HTTP '@{Port="5985"}'

# Firewall: WinRM nur aus dem LAN erlauben
Remove-NetFirewallRule -DisplayName "WinRM HTTP - DLRG" -ErrorAction SilentlyContinue
New-NetFirewallRule `
    -DisplayName "WinRM HTTP - DLRG" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 5985 `
    -Action Allow `
    -RemoteAddress $AllowedSubnet

# TrustedHosts auf gesamtes LAN-Subnetz setzen
Set-Item WSMan:\localhost\Client\TrustedHosts -Value "192.168.178.*" -Force

# WinRM-Dienst starten und auf automatisch setzen
Set-Service WinRM -StartupType Automatic
Start-Service WinRM

Write-Host ""
Write-Host "WinRM aktiviert. Verbindungstest:"
Write-Host "  ansible windows_pcs -m win_ping -i hosts.yml"
Write-Host ""
Write-Host "Ansible-Inventory-Eintrag fuer diesen PC:"
Write-Host "  ansible_host: $((Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' } | Select-Object -First 1).IPAddress)"
Write-Host "  ansible_user: Admin"
Write-Host "  ansible_password: <Admin-Passwort>"
Write-Host "  ansible_connection: winrm"
Write-Host "  ansible_winrm_transport: basic"
Write-Host "  ansible_port: 5985"
