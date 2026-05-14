# restart-server.ps1
# Laufenden Ethernal Cosmos Server stoppen, neu bauen und neu starten.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$pidFile = Join-Path $root "server.pid"

# Alten Prozess beenden
if (Test-Path $pidFile) {
    $oldPid = [int](Get-Content $pidFile -Raw)
    $old = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($old) {
        Write-Output "Stoppe Server (PID $oldPid)..."
        Stop-Process -Id $oldPid -Force
        Start-Sleep -Milliseconds 500
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
} else {
    # Fallback: suche node-Prozess mit server/dist/index.js
    Get-WmiObject Win32_Process -Filter "name='node.exe'" |
        Where-Object { $_.CommandLine -like "*server/dist/index.js*" -or $_.CommandLine -like "*server\dist\index.js*" } |
        ForEach-Object {
            Write-Output "Stoppe Server (PID $($_.ProcessId))..."
            Stop-Process -Id $_.ProcessId -Force
        }
    Start-Sleep -Milliseconds 500
}

Write-Output "Baue Server..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "Build fehlgeschlagen"; exit 1 }

$scriptPath = "`"$(Join-Path $root 'server\dist\index.js')`""
$proc = Start-Process -FilePath "node" `
    -ArgumentList $scriptPath `
    -PassThru -NoNewWindow -WorkingDirectory (Join-Path $root 'server')
$proc.Id | Out-File $pidFile -Encoding ascii

Write-Output "Server neu gestartet (PID: $($proc.Id))"
Write-Output "  Intern:  http://localhost:12348"
Write-Output "  Extern:  https://mea-sama.duckdns.org:12346"
$proc.WaitForExit()
