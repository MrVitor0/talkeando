#Requires -Version 5.1
<#
.SYNOPSIS
  One command to bring up the whole Talkeando local dev stack and open two
  client windows (alice + bob) for P2P / two-account testing on one machine.

.DESCRIPTION
  Does, in order, everything the README's "manual" steps 1-5 describe:
    1. Start the compose Postgres (infra/docker-compose.yml), wait for healthy.
    2. Create server/.env from the example if it does not exist yet.
    3. Build the Rust server, run bootstrap-owner once (idempotent - fine if
       the community already exists), then start the server in its own window
       unless something is already listening on port 8080.
    4. Make sure the second account (bob) exists: mints an invite as the
       owner and registers bob if a login check for him fails.
    5. Build the React UI (client/ui) unless -SkipUiBuild - the native client
       only ever loads the built dist/, never live source.
    6. Build the native client once, then launch two instances with
       TUPI_PROFILE=alice and =bob, each in its own titled window.

  Everything talks to the same local backend, so a call / screen share
  between the two windows is a real P2P connection over loopback.

.PARAMETER Reset
  Tear the Postgres volume down first (docker compose down -v) and wipe the
  local per-profile session + WebView2 folders, so you start from a clean DB
  with no stale bearer tokens. bootstrap-owner then runs fresh.

.PARAMETER SkipUiBuild
  Skip `npm install` / `npm run build` for client/ui. Use when you have not
  touched client/ui/src since the last run.

.PARAMETER NoClients
  Bring the backend up (and ensure both accounts) but do not open the two
  client windows.

.EXAMPLE
  .\dev.cmd
.EXAMPLE
  .\dev.cmd -Reset
.EXAMPLE
  powershell -File scripts\dev.ps1 -SkipUiBuild
#>
[CmdletBinding()]
param(
    [switch]$Reset,
    [switch]$SkipUiBuild,
    [switch]$NoClients
)

# 'Continue', not 'Stop': several of the tools this script drives (docker,
# cargo, npm) legitimately write warnings to stderr, and under 'Stop'
# Windows PowerShell turns any native-command stderr line into a
# terminating NativeCommandError. Failure is detected explicitly via
# $LASTEXITCODE / output checks and `throw` below instead.
$ErrorActionPreference = 'Continue'

# --- accounts wired up for local two-window testing -------------------------
# Throwaway local-only credentials (same ones the README uses). alice is the
# community owner created by bootstrap-owner; bob joins via an invite alice
# mints. Change the display names if you like; keep passwords >= 8 chars.
$Owner  = @{ Username = 'alice'; Password = 'alicepass123'; Display = 'Alice' }
$Member = @{ Username = 'bob';   Password = 'bobpass123';   Display = 'Bob'   }

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$ServerDir = Join-Path $RepoRoot 'server'
$UiDir     = Join-Path $RepoRoot 'client\ui'
$ClientDir = Join-Path $RepoRoot 'client\native\Talkeando.Client'
$Compose   = Join-Path $RepoRoot 'infra\docker-compose.yml'
# Port 8080 collides with other Node/dev servers people commonly leave
# running (it did on the machine this was written on). Talkeando's local
# stack uses 8090 instead; server/.env's BIND_ADDR is rewritten to match
# below, and both client windows are pointed here explicitly.
$BindPort  = 8090
$ApiBase   = "http://127.0.0.1:$BindPort/api"
$WsUrl     = "ws://127.0.0.1:$BindPort/ws"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Info($msg) { Write-Host "    $msg" -ForegroundColor DarkGray }
function Need($exe) {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        throw "Required tool '$exe' not found on PATH."
    }
}
function Test-Port($port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $port); return $true }
    catch { return $false }
    finally { $client.Dispose() }
}
function Invoke-Api($method, $path, $body, $token) {
    $headers = @{}
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    $params = @{
        Uri         = "$ApiBase/$path"
        Method      = $method
        Headers     = $headers
        ContentType = 'application/json'
        TimeoutSec  = 10
        UseBasicParsing = $true
    }
    if ($null -ne $body) { $params['Body'] = ($body | ConvertTo-Json -Compress) }
    return Invoke-RestMethod @params
}
function Start-InWindow($title, $workDir, $command) {
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-NoProfile', '-Command',
        "`$host.UI.RawUI.WindowTitle = '$title'; Set-Location '$workDir'; $command"
    ) | Out-Null
}

# ---------------------------------------------------------------------------
Step 'Checking prerequisites'
Need cargo; Need dotnet; Need npm
Info 'cargo, dotnet, npm all present'

# --- server/.env + which database ------------------------------------
$envFile = Join-Path $ServerDir '.env'
if (-not (Test-Path $envFile)) {
    Step 'Creating server/.env from .env.example'
    Copy-Item (Join-Path $ServerDir '.env.example') $envFile
}
# DATABASE_URL decides whether we manage a local Docker Postgres or just
# point at a remote one (the checked-in default is a managed/prod DB). Only
# the *shape* of the line is inspected here, never its value.
$dbLine = (Select-String -Path $envFile -Pattern '^DATABASE_URL=' -SimpleMatch:$false | Select-Object -First 1)
$LocalDb = $dbLine -and ($dbLine.Line -match '@(localhost|127\.0\.0\.1):5434')

if ($LocalDb) {
    Need docker
    & docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'DATABASE_URL points at the local Docker Postgres but the Docker daemon is not responding. Start Docker Desktop, or point DATABASE_URL at the remote DB.' }
    Info 'docker daemon is up'
}

if ($Reset) {
    Step 'Reset: wiping local per-profile session state'
    if ($LocalDb) { docker compose -f $Compose down -v }
    $appData = Join-Path $env:LOCALAPPDATA 'Talkeando'
    foreach ($name in @($Owner.Username, $Member.Username)) {
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $appData "session-$name.bin")
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $appData "WebView2-$name")
    }
    Info 'clean slate'
}

# --- 1. Postgres (only when using the local one) ---------------------
if ($LocalDb) {
    Step 'Starting Postgres (compose)'
    & docker compose -f $Compose up -d postgres 2>&1 | ForEach-Object { Info $_ }
    if ($LASTEXITCODE -ne 0) { throw 'docker compose up postgres failed (is Docker Desktop fully started?).' }
    $pgId = (& docker compose -f $Compose ps -q postgres 2>$null | Out-String).Trim()
    if (-not $pgId) { throw 'Could not resolve the postgres container id.' }
    $deadline = (Get-Date).AddSeconds(60)
    $health = ''
    do {
        $health = (& docker inspect --format '{{.State.Health.Status}}' $pgId 2>$null | Out-String).Trim()
        if ($health -eq 'healthy') { break }
        Start-Sleep -Milliseconds 800
    } while ((Get-Date) -lt $deadline)
    if ($health -ne 'healthy') { throw "Postgres did not become healthy in time (last status: '$health')." }
    Info 'postgres healthy'
} else {
    Step 'Using the DATABASE_URL from server/.env (remote database)'
}

# --- 2. server/.env BIND_ADDR --------------------------------------
# Keep BIND_ADDR in sync with $BindPort without echoing the file's contents.
$envLines = Get-Content $envFile
if ($envLines -match '^BIND_ADDR=') {
    $patched = $envLines -replace '^BIND_ADDR=.*', "BIND_ADDR=127.0.0.1:$BindPort"
} else {
    $patched = $envLines + "BIND_ADDR=127.0.0.1:$BindPort"
}
Set-Content -Path $envFile -Value $patched
Info "server/.env BIND_ADDR -> 127.0.0.1:$BindPort"

# --- 3. server -------------------------------------------------------
Step 'Building server (cargo build)'
Push-Location $ServerDir
try {
    cargo build --bin tupi-server
    if ($LASTEXITCODE -ne 0) { throw 'cargo build failed.' }

    Step 'Running bootstrap-owner (idempotent - fine if the community already exists)'
    # Redirect every stream to a file so a stderr line can never be turned
    # into a terminating error under $ErrorActionPreference = 'Stop'.
    $bootstrapLog = New-TemporaryFile
    & cargo run --quiet --bin tupi-server -- bootstrap-owner `
        --username $Owner.Username --password $Owner.Password --display-name $Owner.Display *> $bootstrapLog.FullName
    $bootstrapExit = $LASTEXITCODE
    $bootstrap = Get-Content $bootstrapLog.FullName -Raw
    Remove-Item $bootstrapLog.FullName -Force -ErrorAction SilentlyContinue
    ($bootstrap -split "`r?`n") | Where-Object { $_ } | ForEach-Object { Info $_ }
    if ($bootstrapExit -ne 0 -and ($bootstrap -notmatch 'already exists')) {
        throw 'bootstrap-owner failed unexpectedly (see output above).'
    }
}
finally { Pop-Location }

$portOwner = 'free'
if (Test-Port $BindPort) {
    $portOwner = 'foreign'
    try {
        # An endpoint that should 401 without a token. Only Tupi answers 401.
        Invoke-WebRequest -Uri "$ApiBase/community" -Method GET -UseBasicParsing -TimeoutSec 3 | Out-Null
    } catch {
        $response = $_.Exception.Response
        if ($response -and [int]$response.StatusCode -eq 401) { $portOwner = 'tupi' }
    }
}
if ($portOwner -eq 'tupi') {
    Info "A tupi-server is already running on :$BindPort - reusing it."
} elseif ($portOwner -eq 'foreign') {
    throw "Port $BindPort is held by another process that is not tupi-server. Stop it (or change `$BindPort in scripts\dev.ps1) and retry."
} else {
    Step 'Starting the server in its own window'
    Start-InWindow 'tupi-server' $ServerDir 'cargo run --bin tupi-server'
}

Step 'Waiting for the server to answer'
$deadline = (Get-Date).AddSeconds(90)
$up = $false
while ((Get-Date) -lt $deadline) {
    try {
        Invoke-WebRequest -Uri "$ApiBase/me" -Method GET -UseBasicParsing -TimeoutSec 3 | Out-Null
        $up = $true; break
    } catch {
        $resp = $_.Exception.Response
        if ($resp -and ([int]$resp.StatusCode) -ge 400) { $up = $true; break }  # 401 => router is up
        Start-Sleep -Milliseconds 800
    }
}
if (-not $up) { throw "Server never answered on :$BindPort." }
Info 'server responding'

# --- 4. ensure the second account ------------------------------------
Step "Ensuring second account '$($Member.Username)' exists"
$memberExists = $false
try {
    Invoke-Api POST 'auth/login' @{ username = $Member.Username; password = $Member.Password } $null | Out-Null
    $memberExists = $true
} catch { }

if ($memberExists) {
    Info "$($Member.Username) already registered"
} else {
    $ownerToken = (Invoke-Api POST 'auth/login' @{ username = $Owner.Username; password = $Owner.Password } $null).token
    $code = (Invoke-Api POST 'invites' @{} $ownerToken).code
    Info "minted invite $code"
    Invoke-Api POST 'auth/register' @{
        invite_code  = $code
        username     = $Member.Username
        password     = $Member.Password
        display_name = $Member.Display
    } $null | Out-Null
    Info "registered $($Member.Username)"
}

# --- 5. React UI ---------------------------------------------------
if ($SkipUiBuild) {
    Step 'Skipping UI build (-SkipUiBuild)'
} else {
    Step 'Building the React UI'
    Push-Location $UiDir
    try {
        if (-not (Test-Path (Join-Path $UiDir 'node_modules'))) { npm install }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
    }
    finally { Pop-Location }
}

# --- 6. native clients -------------------------------------------
Step 'Building the native client'
dotnet build $ClientDir -v quiet --nologo
if ($LASTEXITCODE -ne 0) { throw 'dotnet build failed.' }

if ($NoClients) {
    Step 'Backend ready. Skipping the client windows (-NoClients).'
    Write-Host "`nAccounts:" -ForegroundColor Green
    Write-Host "  $($Owner.Username) / $($Owner.Password)   (community owner)"
    Write-Host "  $($Member.Username) / $($Member.Password)"
    return
}

Step 'Launching two client windows'
$clientEnv = "`$env:TUPI_API_BASE_URL='$ApiBase'; `$env:TUPI_WS_URL='$WsUrl'; "
Start-InWindow "tupi-client:$($Owner.Username)"  $ClientDir "$clientEnv`$env:TUPI_PROFILE='$($Owner.Username)'; dotnet run --no-build --no-restore"
Start-Sleep -Seconds 2
Start-InWindow "tupi-client:$($Member.Username)" $ClientDir "$clientEnv`$env:TUPI_PROFILE='$($Member.Username)'; dotnet run --no-build --no-restore"

Write-Host "`nAll set." -ForegroundColor Green
Write-Host "  window 'tupi-client:$($Owner.Username)'  -> log in as $($Owner.Username) / $($Owner.Password)  (community owner)"
Write-Host "  window 'tupi-client:$($Member.Username)'    -> log in as $($Member.Username) / $($Member.Password)"
Write-Host "`nServer runs in the 'tupi-server' window (Ctrl+C there to stop it)."
Write-Host "Postgres stays up in Docker: 'docker compose -f infra/docker-compose.yml stop' to stop it."
