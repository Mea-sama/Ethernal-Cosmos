# start-server.ps1
# Ethernal Cosmos Server starten (inkl. Build).
# Läuft im Vordergrund — Ctrl+C zum Beenden.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Runtime-Defaults fuer die neue Sicherheitskonfiguration.
if (-not $env:NODE_ENV) {
    $env:NODE_ENV = "development"
}
if (-not $env:JWT_SECRET) {
    $env:JWT_SECRET = "dev-local-only-change-me"
}
if (-not $env:ALLOWED_ORIGINS) {
    $origins = @(
        "https://mea-sama.duckdns.org:12346",
        "http://localhost:12348",
        "http://127.0.0.1:12348",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:3002",
        "http://127.0.0.1:3002"
    )
    $env:ALLOWED_ORIGINS = ($origins -join ',')
}

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
Write-Output "  NODE_ENV: $($env:NODE_ENV)"
Write-Output "  ALLOWED_ORIGINS: $($env:ALLOWED_ORIGINS)"
Write-Output "  Intern:  http://localhost:12348"
Write-Output "  Extern:  https://mea-sama.duckdns.org:12346"
Write-Output ""
Write-Output "Warte auf Server... (Ctrl+C zum Beenden)"
$proc.WaitForExit()
