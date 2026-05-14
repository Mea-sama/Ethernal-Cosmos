# DuckDNS IP-Update Skript
# Wird stündlich über den Windows Task Scheduler ausgeführt.
# Aktualisiert den DNS-Eintrag nur, wenn sich die öffentliche IP tatsächlich geändert hat.

$token  = $env:DUCKDNS_TOKEN
$domain = "mea-sama"
$logFile = "$PSScriptRoot\update.log"
$lastIpFile = "$PSScriptRoot\last-ip.txt"

if (-not $token) {
    Add-Content $logFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm') FEHLER: DUCKDNS_TOKEN nicht gesetzt"
    exit 1
}

try {
    $ip = (Invoke-WebRequest -Uri "https://api.ipify.org" -UseBasicParsing -TimeoutSec 10).Content.Trim()
} catch {
    Add-Content $logFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm') FEHLER beim Abrufen der IP: $_"
    exit 1
}

$last = Get-Content $lastIpFile -ErrorAction SilentlyContinue

if ($ip -eq $last) {
    # Keine Änderung – kein Update nötig
    exit 0
}

try {
    $url = "https://www.duckdns.org/update?domains=$domain&token=$token&ip=$ip"
    $res = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10).Content.Trim()
} catch {
    Add-Content $logFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm') FEHLER beim DuckDNS-Update: $_"
    exit 1
}

if ($res -eq "OK") {
    $ip | Set-Content $lastIpFile
    Add-Content $logFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm') OK: IP aktualisiert $last -> $ip"
} else {
    Add-Content $logFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm') FEHLER: DuckDNS antwortete '$res'"
    exit 1
}
