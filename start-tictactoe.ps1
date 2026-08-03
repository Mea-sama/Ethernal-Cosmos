# start-tictactoe.ps1
# Startet zwei TicTacToe-Instanzen auf Port 3001 und 3002.
# Beide sind von anderen Geräten im lokalen Netzwerk erreichbar.
# Ctrl+C oder Enter beendet beide Prozesse.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root "games\tictactoe\serve.js"
$hubUrl = if ($env:ETHERNAL_HUB_URL) { $env:ETHERNAL_HUB_URL } else { "https://mea-sama.duckdns.org:12346" }

# Lokale IP ermitteln (Netzwerk-Interface)
$localIp = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } |
    Select-Object -First 1).IPAddress

Write-Output ""
Write-Output "TicTacToe wird gestartet..."
Write-Output ""
Write-Output "  PC  → Spieler 1:  http://localhost:3001/?hub=$hubUrl"
Write-Output "  PC  → Spieler 2:  http://localhost:3002/?hub=$hubUrl"
if ($localIp) {
    Write-Output ""
    Write-Output "  Handy / anderer PC:"
    Write-Output "  Spieler 1:  http://${localIp}:3001/?hub=$hubUrl"
    Write-Output "  Spieler 2:  http://${localIp}:3002/?hub=$hubUrl"
}
Write-Output ""
Write-Output "Hub-Server fuer beide Instanzen: $hubUrl"
Write-Output ""

$p1 = Start-Process -FilePath "node" -ArgumentList "`"$script`" 3001" -PassThru -NoNewWindow
$p2 = Start-Process -FilePath "node" -ArgumentList "`"$script`" 3002" -PassThru -NoNewWindow

Write-Output "Prozesse gestartet (PID: $($p1.Id), $($p2.Id))"
Write-Output "Enter drücken zum Beenden..."
$null = Read-Host

Stop-Process -Id $p1.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $p2.Id -Force -ErrorAction SilentlyContinue
Write-Output "Gestoppt."
