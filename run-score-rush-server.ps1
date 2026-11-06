# run-score-rush-server.ps1
# Starts the Score Rush authoritative game server using a local config file in .secrets.
# Default target: public production hub via Caddy at https://mea-sama.duckdns.org:12346

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$configPath = Join-Path $root ".secrets/score-rush-server.json"
$config = $null

if (Test-Path $configPath) {
    $config = Get-Content -Raw -Path $configPath | ConvertFrom-Json
}

$serverUrl = if ($config -and $config.serverUrl) { $config.serverUrl } else { "https://mea-sama.duckdns.org:12346" }
$gameId = if ($config -and $config.gameId) { $config.gameId } else { "score-rush-2p" }
$serverKey = if ($config -and $config.serverKey) { $config.serverKey } else { "" }
$serverId = if ($config -and $config.serverId) { $config.serverId } else { "score-rush-srv-1" }
$region = if ($config -and $config.region) { $config.region } else { "eu" }
$capacity = if ($config -and $config.capacity) { [int]$config.capacity } else { 24 }

if ([string]::IsNullOrWhiteSpace($serverKey)) {
    Write-Error "The Score Rush server key is missing. Create a config file in .secrets/score-rush-server.json first."
    Write-Host "Use the helper script: ./create-score-rush-server-config.ps1"
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Starting Score Rush server..."
Write-Host "  Config file: $configPath"
Write-Host "  Hub URL: $serverUrl"
Write-Host "  Game ID: $gameId"
Write-Host "  Server ID: $serverId"
Write-Host "  Region: $region"
Write-Host "  Capacity: $capacity"
Write-Host ""
Write-Host "Press Ctrl+C to stop the server."

& dotnet run --project "$root/csharp-sdk/EthernalCosmos.ScoreRush.Server" -- --configPath $configPath --serverUrl $serverUrl --gameId $gameId --serverKey $serverKey --serverId $serverId --region $region --capacity $capacity
