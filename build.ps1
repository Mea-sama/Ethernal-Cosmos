# build.ps1
# Baut den gesamten Monorepo-Stack (shared -> server -> sdk)
# und anschliessend alle Spiele im games/-Ordner, die ein "build"-Script besitzen.

$root  = $PSScriptRoot
$games = Join-Path $root "games"

# Hilfsfunktion

function Invoke-Build {
  param([string]$Label, [string]$WorkDir, [string]$Command = "npm run build")
  Write-Host ""
  Write-Host "--- $Label ---" -ForegroundColor Cyan
  Push-Location $WorkDir
  try {
    Invoke-Expression $Command
    if ($LASTEXITCODE -ne 0) {
      Write-Host "FEHLER beim Bauen von $Label (Exit $LASTEXITCODE)" -ForegroundColor Red
      exit $LASTEXITCODE
    }
    Write-Host "OK  $Label fertig" -ForegroundColor Green
  } finally {
    Pop-Location
  }
}

# Monorepo (Reihenfolge wichtig)

Invoke-Build "shared"  $root "npm run build:shared"
Invoke-Build "server"  $root "npm run build:server"
Invoke-Build "sdk"     $root "npm run build:sdk"

# Spiele im games/-Ordner (dynamisch)

if (Test-Path $games) {
  $gameDirs = Get-ChildItem -Path $games -Directory
  foreach ($dir in $gameDirs) {
    $pkg = Join-Path $dir.FullName "package.json"
    if (Test-Path $pkg) {
      $json = Get-Content $pkg -Raw | ConvertFrom-Json
      if ($json.scripts -and $json.scripts.build) {
        Invoke-Build "games/$($dir.Name)" $dir.FullName
      } else {
        Write-Host ""
        Write-Host "    games/$($dir.Name): kein build-Script, uebersprungen" -ForegroundColor DarkGray
      }
    }
  }
}

Write-Host ""
Write-Host "=== Alle Builds erfolgreich abgeschlossen ===" -ForegroundColor Green
