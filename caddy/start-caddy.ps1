# start-caddy.ps1
# Caddy manuell starten (bis Windows-Dienst via Admin installiert wird).
# Immer als normaler User ausfuehrbar.

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir "caddy_windows_amd64_custom.exe"
$cfg = Join-Path $dir "Caddyfile"

# System-Env-Var in aktuelle Session laden
$env:DUCKDNS_TOKEN = [System.Environment]::GetEnvironmentVariable("DUCKDNS_TOKEN", "Machine")
if (-not $env:DUCKDNS_TOKEN) {
    Write-Error "DUCKDNS_TOKEN ist nicht als Windows System-Umgebungsvariable gesetzt!"
    exit 1
}

# Alten Prozess stoppen (falls noch läuft)
Get-Process -Name "caddy*" -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Output "Starte Caddy..."
Write-Output "Logdateien: $dir\caddy.log + caddy-err.log"
Write-Output "Ctrl+C zum Stoppen"

# Im Vordergrund starten
& $exe run --config $cfg --adapter caddyfile
