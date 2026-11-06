# start-score-rush-server.ps1
# Starts the Score Rush authoritative game server against the configured Ethernal hub.
# Uses .secrets/score-rush-server.json when present; env vars override the config file.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$configPath = Join-Path $root ".secrets/score-rush-server.json"
$config = $null
if (Test-Path $configPath) {
    $config = Get-Content -Raw -Path $configPath | ConvertFrom-Json
}

$hubUrl = if ($env:ETHERNAL_HUB_URL) { $env:ETHERNAL_HUB_URL } elseif ($config -and $config.serverUrl) { $config.serverUrl } else { "http://127.0.0.1:12348" }
$serverKey = if ($env:SCORE_RUSH_SERVER_KEY) { $env:SCORE_RUSH_SERVER_KEY } elseif ($config -and $config.serverKey) { $config.serverKey } else { Read-Host "Game server key (esk_...)" }

if ([string]::IsNullOrWhiteSpace($serverKey)) {
    Write-Error "A valid SCORE_RUSH_SERVER_KEY is required. Create it via the admin API or the helper script."
    exit 1
}

Write-Output "Starting Score Rush server against hub: $hubUrl"
Write-Output "Using config: $configPath"
Write-Output "Press Ctrl+C to stop the game server."

& dotnet run --project "$root/csharp-sdk/EthernalCosmos.ScoreRush.Server" -- --configPath $configPath --serverUrl $hubUrl --serverKey $serverKey --serverId score-rush-srv-1 --region eu --capacity 24
