# reset-test-accounts.ps1
# Loescht alle Nutzer-Accounts aus der Datenbank AUSSER denen auf der
# Rate-Limit-Whitelist (server/config/rate-limit-whitelist.json).
#
# Standardmaessig ein Dry-Run (zeigt nur an, was geloescht wuerde).
# Fuer den echten Loeschvorgang: .\reset-test-accounts.ps1 -Confirm

param(
  [switch]$Confirm
)

$root = $PSScriptRoot
Push-Location (Join-Path $root "server")
try {
  if ($Confirm) {
    node scripts/reset-test-accounts.js --yes
  } else {
    node scripts/reset-test-accounts.js
  }
} finally {
  Pop-Location
}
