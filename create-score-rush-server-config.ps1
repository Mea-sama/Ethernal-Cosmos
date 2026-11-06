# create-score-rush-server-config.ps1
# Requests a new game-server key from the hub and writes the exact JSON file format used by the Score Rush server.
# The generated raw key is stored in .secrets/score-rush-server.json and is excluded from Git.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$hubUrl = if ($env:ETHERNAL_HUB_URL) { $env:ETHERNAL_HUB_URL } else { "https://mea-sama.duckdns.org:12346" }
$adminToken = if ($env:ETHERNAL_ADMIN_TOKEN) { $env:ETHERNAL_ADMIN_TOKEN } else { Read-Host "Admin token for Ethernal Cosmos hub" }
$gameId = if ($env:SCORE_RUSH_GAME_ID) { $env:SCORE_RUSH_GAME_ID } else { "score-rush-2p" }
$serverId = if ($env:SCORE_RUSH_SERVER_ID) { $env:SCORE_RUSH_SERVER_ID } else { "score-rush-srv-1" }
$region = if ($env:SCORE_RUSH_REGION) { $env:SCORE_RUSH_REGION } else { "eu" }
$capacity = if ($env:SCORE_RUSH_CAPACITY) { [int]$env:SCORE_RUSH_CAPACITY } else { 24 }

if ([string]::IsNullOrWhiteSpace($adminToken)) {
    Write-Error "An admin token is required to mint a game-server key."
    exit 1
}

$secretsDir = Join-Path $root ".secrets"
$configPath = Join-Path $secretsDir "score-rush-server.json"
New-Item -Path $secretsDir -ItemType Directory -Force | Out-Null

$uri = "$hubUrl/admin/game-servers/$gameId/keys"
Write-Host "Requesting new server key for game '$gameId' on $hubUrl"
$response = Invoke-RestMethod -Method Post -Uri $uri -Headers @{ Authorization = "Bearer $adminToken" }

$key = if ($response.key) { $response.key } elseif ($response.serverKey) { $response.serverKey } else { $null }

if ([string]::IsNullOrWhiteSpace($key)) {
    Write-Error "Hub response did not contain a raw game-server key."
    $response | ConvertTo-Json -Depth 4
    exit 1
}

$config = [ordered]@{
    serverUrl = $hubUrl
    gameId = $gameId
    serverKey = $key
    serverId = $serverId
    region = $region
    capacity = $capacity
}

$configJson = $config | ConvertTo-Json -Depth 4
Set-Content -Path $configPath -Value $configJson -Encoding UTF8

Write-Host "Saved game server config to: $configPath"
Write-Host "Key preview: $($key.Substring(0, 12))..."
Write-Host ""
Write-Host "You can now start the server with: ./run-score-rush-server.ps1"
