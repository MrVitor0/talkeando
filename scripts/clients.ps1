# Opens Talkeando client windows (one per profile) pointed at whatever
# client\native\Talkeando.Client\talkeando.settings.json says - the hosted/prod
# API by default. No local server, no Postgres, no env overrides.
# Use scripts\dev.ps1 instead for the full LOCAL stack.
#
#   -Profiles alice,bob   which profiles to open (default: alice, bob)
#   -SkipBuild            skip "dotnet build" (no C# changes since last run)
param(
    [string[]] $Profiles = @('alice', 'bob'),
    [switch]   $SkipBuild
)

$ErrorActionPreference = 'Continue'

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$ClientDir = Join-Path $RepoRoot 'client\native\Talkeando.Client'
$Settings  = Join-Path $ClientDir 'talkeando.settings.json'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Info($msg) { Write-Host "    $msg" -ForegroundColor DarkGray }

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "Required tool 'dotnet' not found on PATH."
}

Step 'Endpoint (from talkeando.settings.json)'
if (Test-Path $Settings) {
    $cfg = Get-Content $Settings -Raw | ConvertFrom-Json
    Info ("apiBaseUrl   " + $cfg.apiBaseUrl)
    Info ("webSocketUrl " + $cfg.webSocketUrl)
} else {
    Info 'no talkeando.settings.json - client uses its built-in default'
}
Info 'TALKEANDO_API_BASE_URL / TALKEANDO_WS_URL are NOT set by this script'

if (-not $SkipBuild) {
    Step 'Building the native client'
    & dotnet build $ClientDir -v quiet --nologo
    if ($LASTEXITCODE -ne 0) { throw 'dotnet build failed.' }
}

Step ('Launching ' + $Profiles.Count + ' client window(s)')
foreach ($name in $Profiles) {
    $cmd = "`$host.UI.RawUI.WindowTitle='talkeando-client:$name'; Set-Location '$ClientDir'; `$env:TALKEANDO_PROFILE='$name'; dotnet run --no-build --no-restore"
    Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $cmd) | Out-Null
    Info "window 'talkeando-client:$name'"
    Start-Sleep -Seconds 2
}

Write-Host "`nAll set. Log in with your hosted account in each window." -ForegroundColor Green
