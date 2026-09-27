<#
.SYNOPSIS
  KitsuneMCP installer for Windows.

.DESCRIPTION
  1. Checks prerequisites (Node.js >= 18, npm; Firefox is optional - warning only)
  2. npm install + npm run build (skip with -SkipBuild)
  3. Generates the Native Messaging host wrapper (run-host.cmd) and manifest
     (kitsune_mcp.json) in %USERPROFILE%\.kitsune-mcp\native-host\
  4. Registers the manifest for Firefox under
     HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp (no admin rights)
  5. Optionally registers the MCP server with Claude Code (claude mcp add)

  Safe to run repeatedly: existing files / registry values are overwritten
  and reported. Nothing is written inside the repository except the build
  output (dist/, node_modules/).

  This file is intentionally ASCII-only so Windows PowerShell 5.1 reads it
  correctly without a BOM.

.PARAMETER SkipBuild
  Skip "npm install" and "npm run build" (dist/ must already exist).

.PARAMETER RegisterClaude
  Register with Claude Code without asking.

.PARAMETER NoRegisterClaude
  Do not register with Claude Code (the manual command is printed instead).

.PARAMETER ClaudeScope
  Scope for "claude mcp add": user (default, all projects), local or project.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipBuild -NoRegisterClaude
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$RegisterClaude,
    [switch]$NoRegisterClaude,
    [ValidateSet('user', 'local', 'project')]
    [string]$ClaudeScope = 'user'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$HostName       = 'kitsune_mcp'
$ClaudeName     = 'kitsune-mcp'
$MinNodeMajor   = 18
$RegKey         = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"

function Write-Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Info([string]$msg) { Write-Host "    $msg" }
function Write-Warn2([string]$msg) { Write-Host "    [warn] $msg" -ForegroundColor Yellow }
function Fail([string]$msg) {
    Write-Host ""
    Write-Host "[error] $msg" -ForegroundColor Red
    exit 1
}

function Confirm-YesNo([string]$question, [bool]$default) {
    $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
    try {
        $answer = Read-Host "    $question $hint"
    } catch {
        return $default
    }
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim().ToLowerInvariant().StartsWith('y')
}

# Runs a native command with its output discarded and returns the exit code.
# (Windows PowerShell 5.1 turns redirected native stderr into a terminating
# error under ErrorActionPreference=Stop, so relax it for the call.)
function Invoke-Quiet([string]$exe, [string[]]$arguments) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $exe @arguments 2>&1 | Out-Null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
}

# Returns the first executable (not a .ps1 shim) for a command name, or $null.
function Find-Exe([string]$name) {
    $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $cmd) { return $null }
    return $cmd.Source
}

function Write-Utf8NoBom([string]$path, [string]$content) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $content, $enc)
}

if ($RegisterClaude -and $NoRegisterClaude) {
    Fail '-RegisterClaude and -NoRegisterClaude cannot be used together.'
}

$RepoRoot      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$NativeHostPkg = Join-Path $RepoRoot 'packages\native-host'
$HostEntry     = Join-Path $NativeHostPkg 'dist\index.js'
$ServerEntry   = Join-Path $RepoRoot 'packages\mcp-server\dist\index.js'
$ExtManifest   = Join-Path $RepoRoot 'packages\extension\manifest.json'
$DataDir       = Join-Path $env:USERPROFILE '.kitsune-mcp'
$InstallDir    = Join-Path $DataDir 'native-host'
$WrapperPath   = Join-Path $InstallDir 'run-host.cmd'
$ManifestPath  = Join-Path $InstallDir "$HostName.json"

Write-Host "KitsuneMCP installer (Windows)"
Write-Host "Repository: $RepoRoot"

# ---------------------------------------------------------------------------
Write-Step 'Checking prerequisites'

$NodeExe = Find-Exe 'node'
if ($null -eq $NodeExe) {
    Fail "Node.js was not found in PATH. Install Node.js $MinNodeMajor or later: https://nodejs.org/"
}
$nodeVersion = (& $NodeExe --version | Out-String).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.') {
    Fail "Could not determine the Node.js version ('$nodeVersion' from $NodeExe)."
}
if ([int]$Matches[1] -lt $MinNodeMajor) {
    Fail "Node.js $nodeVersion is too old (need >= $MinNodeMajor): $NodeExe"
}
Write-Ok "Node.js $nodeVersion ($NodeExe)"

# npm.cmd, not npm.ps1 (the .ps1 shim can be blocked by the execution policy)
$NpmExe = Find-Exe 'npm.cmd'
if ($null -eq $NpmExe) { $NpmExe = Find-Exe 'npm' }
if ($null -eq $NpmExe) {
    if (-not $SkipBuild) { Fail 'npm was not found in PATH (it normally ships with Node.js).' }
    Write-Warn2 'npm was not found (not needed with -SkipBuild).'
} else {
    Write-Ok "npm ($NpmExe)"
}

$firefoxCandidates = @(
    (Join-Path $env:ProgramFiles 'Mozilla Firefox\firefox.exe'),
    (Join-Path $env:LOCALAPPDATA 'Mozilla Firefox\firefox.exe')
)
if (${env:ProgramFiles(x86)}) {
    $firefoxCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Mozilla Firefox\firefox.exe')
}
$appPaths = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe'
)
foreach ($p in $appPaths) {
    $v = (Get-ItemProperty -Path $p -ErrorAction SilentlyContinue)
    if ($null -ne $v -and $v.PSObject.Properties['(default)']) { $firefoxCandidates += [string]$v.'(default)' }
}
$firefoxExe = $firefoxCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($firefoxExe) {
    Write-Ok "Firefox ($firefoxExe)"
} else {
    Write-Warn2 'Firefox was not found. Continuing; install Firefox before loading the extension.'
}

# ---------------------------------------------------------------------------
if ($SkipBuild) {
    Write-Step 'Skipping npm install / npm run build (-SkipBuild)'
} else {
    Write-Step 'Installing dependencies (npm install)'
    Push-Location $RepoRoot
    try {
        & $NpmExe install
        if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit code $LASTEXITCODE)." }
        Write-Step 'Building (npm run build)'
        & $NpmExe run build
        if ($LASTEXITCODE -ne 0) { Fail "npm run build failed (exit code $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
}

foreach ($f in @($HostEntry, $ServerEntry)) {
    if (-not (Test-Path -LiteralPath $f)) {
        Fail "Build output not found: $f (run without -SkipBuild)."
    }
}
Write-Ok 'Build output present'

# ---------------------------------------------------------------------------
Write-Step 'Reading the extension ID'

try {
    $ext = Get-Content -LiteralPath $ExtManifest -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Fail "Could not parse $ExtManifest : $($_.Exception.Message)"
}
$GeckoId = $null
if ($ext.PSObject.Properties['browser_specific_settings'] -and
    $ext.browser_specific_settings.PSObject.Properties['gecko'] -and
    $ext.browser_specific_settings.gecko.PSObject.Properties['id']) {
    $GeckoId = [string]$ext.browser_specific_settings.gecko.id
}
if ([string]::IsNullOrWhiteSpace($GeckoId)) {
    Fail "browser_specific_settings.gecko.id is missing in $ExtManifest"
}
Write-Ok "gecko ID: $GeckoId"

# ---------------------------------------------------------------------------
Write-Step "Writing the Native Messaging host to $InstallDir"

if (-not (Test-Path -LiteralPath $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Wrappers left by earlier manual setups (e.g. run-host-e2e.cmd) are no
# longer referenced by the manifest: remove them.
Get-ChildItem -LiteralPath $InstallDir -Filter 'run-host*.cmd' -File |
    Where-Object { $_.Name -ne 'run-host.cmd' } |
    ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force
        Write-Info "removed stale wrapper: $($_.FullName)"
    }

# Firefox on Windows can only launch .exe / .bat / .cmd, so a .cmd wrapper
# starts node. The absolute node path is embedded because Firefox may be
# started with a PATH that has no node in it. Logging is done by the host
# itself (FOX_NATIVE_HOST_LOG, default %USERPROFILE%\.kitsune-mcp\logs\).
# Nothing may be printed to stdout here: it is the Native Messaging channel.
function Escape-Cmd([string]$s) { return $s.Replace('%', '%%') }
$wrapper = @(
    '@echo off',
    'rem Generated by KitsuneMCP scripts\install.ps1. Re-run the installer to update.',
    ('cd /d "{0}"' -f (Escape-Cmd $NativeHostPkg)),
    ('"{0}" "{1}" %*' -f (Escape-Cmd $NodeExe), (Escape-Cmd $HostEntry))
) -join "`r`n"
$wrapper += "`r`n"

# cmd.exe reads batch files in the OEM code page.
$oemCp  = [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
$oemEnc = [System.Text.Encoding]::GetEncoding($oemCp)
if ($oemEnc.GetString($oemEnc.GetBytes($wrapper)) -ne $wrapper) {
    Write-Warn2 "A path contains characters that code page $oemCp cannot represent; run-host.cmd may not start."
    Write-Warn2 'Consider moving the repository / Node.js to an ASCII-only path.'
}
$existed = Test-Path -LiteralPath $WrapperPath
[System.IO.File]::WriteAllText($WrapperPath, $wrapper, $oemEnc)
Write-Ok ("{0} {1}" -f $(if ($existed) { 'overwrote' } else { 'created' }), $WrapperPath)

$manifest = [ordered]@{
    name               = $HostName
    description        = 'KitsuneMCP Native Messaging Host'
    path               = $WrapperPath
    type               = 'stdio'
    allowed_extensions = @($GeckoId)
}
$existed = Test-Path -LiteralPath $ManifestPath
Write-Utf8NoBom $ManifestPath (($manifest | ConvertTo-Json -Depth 4) + "`n")
Write-Ok ("{0} {1}" -f $(if ($existed) { 'overwrote' } else { 'created' }), $ManifestPath)

# ---------------------------------------------------------------------------
Write-Step "Registering with Firefox ($($RegKey -replace '^HKCU:', 'HKCU'))"

$previous = $null
if (Test-Path -LiteralPath $RegKey) {
    $previous = (Get-Item -LiteralPath $RegKey).GetValue('')
} else {
    New-Item -Path $RegKey -Force | Out-Null
}
Set-Item -LiteralPath $RegKey -Value $ManifestPath
if ($null -eq $previous) {
    Write-Ok "registered: $ManifestPath"
} elseif ($previous -eq $ManifestPath) {
    Write-Ok "already registered (unchanged): $ManifestPath"
} else {
    Write-Ok "overwrote previous value '$previous' with: $ManifestPath"
}

# ---------------------------------------------------------------------------
Write-Step 'Claude Code'

$manualCmd = "claude mcp add --scope $ClaudeScope $ClaudeName -- node `"$ServerEntry`""
$ClaudeExe = Find-Exe 'claude'
if ($null -eq $ClaudeExe) {
    # Default location of the native installer, often missing from PATH
    $candidate = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path -LiteralPath $candidate) { $ClaudeExe = $candidate }
}
# 'local' / 'project' scopes belong to the current directory: run claude
# from the repository so they refer to it.
Push-Location $RepoRoot
try {
    if ($null -eq $ClaudeExe) {
        Write-Warn2 "'claude' was not found in PATH. Register manually later:"
        Write-Info "  $manualCmd"
    } elseif ($NoRegisterClaude) {
        Write-Info 'Skipped (-NoRegisterClaude). To register manually:'
        Write-Info "  $manualCmd"
    } else {
        $getExit = Invoke-Quiet $ClaudeExe @('mcp', 'get', $ClaudeName)
        if ($getExit -eq 0) {
            Write-Ok "'$ClaudeName' is already registered with Claude Code (left unchanged)."
            Write-Info "Check it with: claude mcp get $ClaudeName"
        } else {
            $doRegister = $RegisterClaude -or (Confirm-YesNo "Register '$ClaudeName' with Claude Code (scope: $ClaudeScope)?" $true)
            if ($doRegister) {
                # '--' is quoted so PowerShell passes it through literally.
                & $ClaudeExe mcp add --scope $ClaudeScope $ClaudeName '--' node $ServerEntry
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "registered '$ClaudeName' (scope: $ClaudeScope)"
                } else {
                    Write-Warn2 "claude mcp add failed (exit code $LASTEXITCODE). Register manually:"
                    Write-Info "  $manualCmd"
                }
            } else {
                Write-Info 'Skipped. To register manually:'
                Write-Info "  $manualCmd"
            }
        }
    }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Load the extension in Firefox (temporary add-on):"
Write-Host "       about:debugging#/runtime/this-firefox -> 'Load Temporary Add-on...'"
Write-Host "       select: $ExtManifest"
Write-Host "     Until the extension is signed by AMO it cannot be installed permanently;"
Write-Host "     a temporary add-on is removed when Firefox restarts (load it again)."
Write-Host "  2. Restart Claude Code so it picks up the MCP server."
Write-Host "  3. Check the connection (browsers_connected should be 1):"
Write-Host "       Invoke-RestMethod http://127.0.0.1:8765/health"
Write-Host "  Logs: $DataDir\logs\native-host.log (Native Host), $DataDir\logs\daemon.log (daemon)"
Write-Host "  Uninstall: powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1"
