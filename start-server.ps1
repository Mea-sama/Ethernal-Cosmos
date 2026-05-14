# start-server.ps1
# Ethernal Cosmos Server starten (inkl. Build).
# Läuft im Vordergrund — Ctrl+C zum Beenden.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Output "Baue Server..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "Build fehlgeschlagen"; exit 1 }

# PID für restart-server.ps1 speichern
$pidFile = Join-Path $root "server.pid"
$scriptPath = "`"$(Join-Path $root 'server\dist\index.js')`""
$proc = Start-Process -FilePath "node" `
    -ArgumentList $scriptPath `
    -PassThru -NoNewWindow -WorkingDirectory (Join-Path $root 'server')
$proc.Id | Out-File $pidFile -Encoding ascii

Write-Output ""
Write-Output "Server gestartet (PID: $($proc.Id))"
Write-Output "  Intern:  http://localhost:12348"
Write-Output "  Extern:  https://mea-sama.duckdns.org:12346"
Write-Output ""
Write-Output "Warte auf Server... (Ctrl+C zum Beenden)"
$proc.WaitForExit()
