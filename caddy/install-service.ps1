# install-service.ps1
# Dieses Skript muss einmalig als Administrator ausgeführt werden.
# Rechtsklick auf PowerShell -> "Als Administrator ausführen"
# Dann: cd "e:\Ethernal Cosmos\caddy" ; .\install-service.ps1

$exe = "e:\Ethernal Cosmos\caddy\caddy_windows_amd64_custom.exe"
$cfg = "e:\Ethernal Cosmos\caddy\Caddyfile"

# Laufende Caddy-Prozesse beenden (Name enthält "caddy")
Get-Process -Name "caddy*" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# Alten Dienst entfernen falls vorhanden (sc.exe delete — läuft auf PS 5.1 und PS 7)
$existing = Get-Service CaddyServer -ErrorAction SilentlyContinue
if ($existing) {
    Stop-Service CaddyServer -Force -ErrorAction SilentlyContinue
    sc.exe delete CaddyServer | Out-Null
    Start-Sleep -Seconds 2
    Write-Output "Alter Dienst entfernt."
}

# Storage-Ordner anlegen (damit LocalSystem schreiben kann)
New-Item -ItemType Directory -Force "e:\Ethernal Cosmos\caddy\data" | Out-Null

# Dienst neu registrieren
$binPath = "`"$exe`" run --config `"$cfg`" --adapter caddyfile"
New-Service -Name "CaddyServer" `
    -BinaryPathName $binPath `
    -StartupType Automatic `
    -DisplayName "Caddy Reverse Proxy" `
    -Description "Caddy HTTPS reverse proxy (DuckDNS TLS) for Ethernal Cosmos"

Write-Output "DUCKDNS_TOKEN ist gesetzt: $( [bool]([System.Environment]::GetEnvironmentVariable('DUCKDNS_TOKEN','Machine')) )"

# Dienst starten
Start-Service CaddyServer
Get-Service CaddyServer | Select-Object Name, Status, StartType

# Geplante Aufgabe für IP-Update registrieren
$script  = "e:\Ethernal Cosmos\caddy\update-duckdns.ps1"
$action  = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 1) -Once -At (Get-Date)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable
Register-ScheduledTask -TaskName "DuckDNS-IP-Update" `
    -Action $action -Trigger $trigger -Settings $settings `
    -RunLevel Highest -Force | Out-Null

# Sofort einmal ausführen (aktuellen IP-Stand setzen)
Start-ScheduledTask -TaskName "DuckDNS-IP-Update"
Write-Output "Geplante Aufgabe 'DuckDNS-IP-Update' registriert (stündlich)."
