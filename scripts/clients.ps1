# Opens Talkeando client windows (one per profile) pointed at whatever
# client\native\Talkeando.Client\tupi.settings.json says - the hosted/prod
# API by default. No local server, no Postgres, no env overrides.
# Use scripts\dev.ps1 instead for the full LOCAL stack.
#
#   -Profiles alice,bob   which profiles to open (default: alice, bob)
#   -SkipBuild            reuse both UI and native build outputs
param(
    [string[]] $Profiles = @('alice', 'bob'),
    [switch]   $SkipBuild
)

$ErrorActionPreference = 'Continue'

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$UiDir     = Join-Path $RepoRoot 'client\ui'
$ClientDir = Join-Path $RepoRoot 'client\native\Talkeando.Client'
$Settings  = Join-Path $ClientDir 'tupi.settings.json'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Info($msg) { Write-Host "    $msg" -ForegroundColor DarkGray }

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "Required tool 'dotnet' not found on PATH."
}

Step 'Endpoint (from tupi.settings.json)'
if (Test-Path $Settings) {
    $cfg = Get-Content $Settings -Raw | ConvertFrom-Json
    Info ("apiBaseUrl   " + $cfg.apiBaseUrl)
    Info ("webSocketUrl " + $cfg.webSocketUrl)
} else {
    Info 'no tupi.settings.json - client uses its built-in default'
}
Info 'TUPI_API_BASE_URL / TUPI_WS_URL are NOT set by this script'

if (-not $SkipBuild) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "Required tool 'npm' not found on PATH."
    }

    # The native project embeds client/ui/dist. Building only C# can otherwise
    # launch a new host against stale JavaScript with an incompatible IPC API.
    Step 'Building the React UI'
    Push-Location $UiDir
    try {
        if (-not (Test-Path (Join-Path $UiDir 'node_modules'))) { & npm install }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
    }
    finally { Pop-Location }

    Step 'Building the native client'
    & dotnet build $ClientDir -v quiet --nologo
    if ($LASTEXITCODE -ne 0) { throw 'dotnet build failed.' }
}

Step ('Launching ' + $Profiles.Count + ' client window(s)')
foreach ($name in $Profiles) {
    $cmd = "`$host.UI.RawUI.WindowTitle='tupi-client:$name'; Set-Location '$ClientDir'; `$env:TUPI_PROFILE='$name'; dotnet run --no-build --no-restore"
    Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $cmd) | Out-Null
    Info "window 'tupi-client:$name'"
    Start-Sleep -Seconds 2
}

Write-Host "`nAll set. Log in with your hosted account in each window." -ForegroundColor Green
