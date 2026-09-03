#Requires -Version 5.1
<#
.SYNOPSIS
  One command to run the Talkeando backend and desktop clients locally. It
  uses the configured database while running the backend, desktop clients, and
  LiveKit SFU locally before deployment.

.DESCRIPTION
  Does, in order, everything the README's "manual" steps 1-5 describe:
    1. Starts the local LiveKit SFU in Docker, plus Postgres only when
       DATABASE_URL explicitly points to it.
    2. Starts the Rust server locally on 127.0.0.1:8090, without rewriting
       server/.env.
    3. When using a local database only, seeds alice/bob for two-account tests.
       A remote database is never seeded, reset, or otherwise mutated by this
       launcher.
    4. Builds the React UI (client/ui) unless -SkipUiBuild - the native client
       only ever loads the built dist/, never live source.
    5. Builds the native client once, then launches two instances with
       TUPI_PROFILE=alice and =bob, each in its own titled window.

  Everything talks to the same local backend and local LiveKit SFU. The
  database may remain remote; the launcher never creates or resets remote
  data.

.PARAMETER Reset
  Wipe the local per-profile session + WebView2 folders. The Postgres volume
  is also removed only when DATABASE_URL selects the local Docker database.
  Remote data is never reset.

.PARAMETER SkipUiBuild
  Skip `npm install` / `npm run build` for client/ui. Use when you have not
  touched client/ui/src since the last run.

.PARAMETER NoClients
  Bring the backend up but do not open the two client windows.

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

# --- accounts wired up for local-database two-window testing ----------------
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
# stack uses 8090 instead; the local server process gets that bind address and
# both client windows are pointed here explicitly.
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
# DATABASE_URL decides whether we also manage a local Docker Postgres or use
# the remote database. Only the *shape* of the line is inspected here, never
# its value.
$dbLine = (Select-String -Path $envFile -Pattern '^DATABASE_URL=' -SimpleMatch:$false | Select-Object -First 1)
$LocalDb = $dbLine -and ($dbLine.Line -match '@(localhost|127\.0\.0\.1):5434')

Need docker
& docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is required for the local LiveKit SFU but is not responding. Start Docker Desktop and retry.' }
Info 'docker daemon is up'

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

# --- 1. local LiveKit SFU + optional Postgres ------------------------
Step 'Starting local LiveKit SFU (compose)'
& docker compose -f $Compose up -d livekit 2>&1 | ForEach-Object { Info $_ }
if ($LASTEXITCODE -ne 0) { throw 'docker compose up livekit failed.' }
$liveKitDeadline = (Get-Date).AddSeconds(60)
while (-not (Test-Port 7880) -and (Get-Date) -lt $liveKitDeadline) { Start-Sleep -Milliseconds 800 }
if (-not (Test-Port 7880)) { throw 'Local LiveKit did not start on :7880.' }
Info 'local LiveKit ready on ws://127.0.0.1:7880'

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
    Step 'Using remote database from server/.env'
    Info 'remote data is read/written only through the local backend; no seed or reset runs'
}

# --- 2. local server bind ------------------------------------------
# The local process overrides the bind address. Keep server/.env untouched so
# it can retain the remote-service settings used by deployments.
$ServerRuntimeEnv = "`$env:BIND_ADDR='127.0.0.1:$BindPort'; `$env:LIVEKIT_URL='ws://127.0.0.1:7880'; `$env:LIVEKIT_API_KEY='devkey'; `$env:LIVEKIT_API_SECRET='devsecret_at_least_32_chars_long'; `$env:MUSIC_BOT_TOKEN='local-dev-music-bot-token'; "
Info "local server bind -> 127.0.0.1:$BindPort"

# --- 3. server -------------------------------------------------------
Step 'Building server (cargo build)'
Push-Location $ServerDir
try {
    cargo build --bin tupi-server
    if ($LASTEXITCODE -ne 0) { throw 'cargo build failed.' }

    if ($LocalDb) {
    Step 'Running bootstrap-owner for the local database'
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
    # A dev launch must use the freshly built server and its local LiveKit /
    # music-bot environment. Reusing a process from an earlier run silently
    # keeps stale tokens and makes the local bot fail authentication.
    $listener = Get-NetTCPConnection -LocalPort $BindPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $existing = if ($listener) { Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue } else { $null }
    if ($existing -and $existing.ProcessName -eq 'tupi-server') {
        Step 'Restarting the existing local tupi-server'
        Stop-Process -Id $existing.Id -Force
        $closeDeadline = (Get-Date).AddSeconds(10)
        while ((Test-Port $BindPort) -and (Get-Date) -lt $closeDeadline) { Start-Sleep -Milliseconds 200 }
        if (Test-Port $BindPort) { throw "The previous tupi-server did not release :$BindPort." }
        Start-InWindow 'tupi-server' $ServerDir "${ServerRuntimeEnv}cargo run --bin tupi-server"
    } else {
        throw "Port $BindPort is held by a Tupi endpoint, but its process could not be identified as the local tupi-server. Stop it and retry."
    }
} elseif ($portOwner -eq 'foreign') {
    throw "Port $BindPort is held by another process that is not tupi-server. Stop it (or change `$BindPort in scripts\dev.ps1) and retry."
} else {
    Step 'Starting the server in its own window'
    Start-InWindow 'tupi-server' $ServerDir "${ServerRuntimeEnv}cargo run --bin tupi-server"
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

Step 'Starting local music bot (compose)'
& docker compose -f $Compose up -d --build music-bot 2>&1 | ForEach-Object { Info $_ }
if ($LASTEXITCODE -ne 0) { throw 'docker compose up music-bot failed.' }
Info 'local music bot starting (use docker compose logs -f music-bot to follow it)'

# --- 4. ensure the second account (local DB only) -------------------
if ($LocalDb) {
Step "Ensuring second account '$($Member.Username)' exists in the local database"
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
} else {
    Step 'Using existing remote accounts'
    Info 'No accounts or invitations are created against the remote database.'
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
    if ($LocalDb) {
        Write-Host "`nAccounts:" -ForegroundColor Green
        Write-Host "  $($Owner.Username) / $($Owner.Password)   (community owner)"
        Write-Host "  $($Member.Username) / $($Member.Password)"
    } else {
        Write-Host "`nUse existing accounts from the configured remote database." -ForegroundColor Green
    }
    Write-Host "`nSFU integration runner (needs a local LiveKit + 2-3 accounts):" -ForegroundColor Green
    Write-Host "  node integration/sfu/run.cjs   # see integration/sfu/README.md"
    return
}

Step 'Launching two client windows'
$clientEnv = "`$env:TUPI_API_BASE_URL='$ApiBase'; `$env:TUPI_WS_URL='$WsUrl'; `$env:TUPI_DISABLE_AUTO_UPDATE='1'; "
Start-InWindow "tupi-client:$($Owner.Username)"  $ClientDir "$clientEnv`$env:TUPI_PROFILE='$($Owner.Username)'; dotnet run --no-build --no-restore"
Start-Sleep -Seconds 2
Start-InWindow "tupi-client:$($Member.Username)" $ClientDir "$clientEnv`$env:TUPI_PROFILE='$($Member.Username)'; dotnet run --no-build --no-restore"

Write-Host "`nAll set." -ForegroundColor Green
if ($LocalDb) {
    Write-Host "  window 'tupi-client:$($Owner.Username)'  -> log in as $($Owner.Username) / $($Owner.Password)  (community owner)"
    Write-Host "  window 'tupi-client:$($Member.Username)'    -> log in as $($Member.Username) / $($Member.Password)"
} else {
    Write-Host "  Log in with existing accounts from the configured remote database."
}
Write-Host "`nServer runs in the 'tupi-server' window (Ctrl+C there to stop it)."
if ($LocalDb) { Write-Host "Postgres stays up in Docker: 'docker compose -f infra/docker-compose.yml stop' to stop it." }
