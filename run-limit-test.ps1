# run-limit-test.ps1
# Startet den Binary-Limit-Test schnell aus dem Projekt-Root.
# Optionaler Parameter:
#   -ServerUrl "https://mea-sama.duckdns.org:12346"

param(
  [string]$ServerUrl = "https://mea-sama.duckdns.org:12346"
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Output "Starte Binary-Limit-Test..."
Write-Output "  Server: $ServerUrl"
Write-Output ""

npx ts-node --project test/tsconfig.json test/binary-limit-app/app.ts $ServerUrl
$exitCode = $LASTEXITCODE

Write-Output ""
if ($exitCode -eq 0) {
  Write-Output "Limit-Test erfolgreich abgeschlossen."
} else {
  Write-Output "Limit-Test fehlgeschlagen (Exit $exitCode)."
}

exit $exitCode
