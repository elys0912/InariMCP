<#
.SYNOPSIS
  KitsuneMCP uninstaller for Windows.

.DESCRIPTION
  1. Offers to stop a running KitsuneMCP daemon (only after /health confirms
     that the process on the port is a kitsune-mcp daemon)
  2. Removes HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp
  3. Removes %USERPROFILE%\.kitsune-mcp\native-host\
  4. Offers to remove the Claude Code registration (claude mcp remove)
  5. With -Purge, removes the rest of %USERPROFILE%\.kitsune-mcp\
     (api_token, safety.json, logs, screenshots); otherwise lists what is left

  The repository itself (node_modules, dist) is not touched, and the Firefox
  extension has to be removed from Firefox by hand.

  This file is intentionally ASCII-only so Windows PowerShell 5.1 reads it
  correctly without a BOM.

.PARAMETER Purge
  Also delete everything else under %USERPROFILE%\.kitsune-mcp\.

.PARAMETER StopDaemon
  Stop a running KitsuneMCP daemon without asking.

.PARAMETER NoStopDaemon
  Leave a running daemon alone.

.PARAMETER UnregisterClaude
  Remove the Claude Code registration without asking.

.PARAMETER NoUnregisterClaude
  Leave the Claude Code registration alone.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Purge -StopDaemon -UnregisterClaude
#>
[CmdletBinding()]
param(
    [switch]$Purge,
    [switch]$StopDaemon,
    [switch]$NoStopDaemon,
    [switch]$UnregisterClaude,
    [switch]$NoUnregisterClaude
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$HostName   = 'kitsune_mcp'
$ClaudeName = 'kitsune-mcp'
$RegKey     = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"

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

function Find-Exe([string]$name) {
    $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $cmd) { return $null }
    return $cmd.Source
}

# Detects symlinks / junctions (reparse points) inside a directory tree
# without following them. Windows PowerShell 5.1's Get-ChildItem -Recurse
# walks into a directory junction/symlink as if it were a normal folder,
# which would make a later Remove-Item -Recurse delete the link's target
# instead of just the link. This walks the tree by hand and never recurses
# past a reparse point. Returns the reparse points found (the root itself,
# if it is one, is returned alone).
function Find-ReparsePoints([string]$Path) {
    $found = New-Object System.Collections.Generic.List[string]
    $root = Get-Item -LiteralPath $Path -Force
    if ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $found.Add($root.FullName)
        return $found
    }
    $pending = New-Object System.Collections.Generic.Queue[string]
    $pending.Enqueue($Path)
    while ($pending.Count -gt 0) {
        $current = $pending.Dequeue()
        $children = @(Get-ChildItem -LiteralPath $current -Force -ErrorAction SilentlyContinue)
        foreach ($child in $children) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                $found.Add($child.FullName)
            } elseif ($child.PSIsContainer) {
                $pending.Enqueue($child.FullName)
            }
        }
    }
    return $found
}

# Deletes a directory tree, but refuses (and reports) if the directory
# itself, or anything inside it, is a symlink/junction - see
# Find-ReparsePoints above. Returns $true if the directory is gone
# (or was already absent), $false if it was left in place for manual review.
function Remove-DirectoryTree([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }

    $links = @(Find-ReparsePoints $Path)
    if ($links.Count -gt 0) {
        Write-Warn2 "$Label contains a symlink or junction - not deleting automatically:"
        foreach ($link in $links) { Write-Warn2 "  $link" }
        Write-Warn2 'Remove the link(s) by hand first (rmdir "<path>", without /s), then run this script again.'
        return $false
    }

    Get-ChildItem -LiteralPath $Path -Force | ForEach-Object { Write-Info "delete: $($_.FullName)" }
    Remove-Item -LiteralPath $Path -Recurse -Force
    return $true
}

if ($StopDaemon -and $NoStopDaemon) { Fail '-StopDaemon and -NoStopDaemon cannot be used together.' }
if ($UnregisterClaude -and $NoUnregisterClaude) { Fail '-UnregisterClaude and -NoUnregisterClaude cannot be used together.' }

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DataDir    = Join-Path $env:USERPROFILE '.kitsune-mcp'
$InstallDir = Join-Path $DataDir 'native-host'

# Same resolution as the daemon: FOX_HTTP_PORT, legacy CLAUDE_BROWSER_HTTP_PORT, 8765
$Port = 8765
foreach ($name in @('FOX_HTTP_PORT', 'CLAUDE_BROWSER_HTTP_PORT')) {
    $raw = [Environment]::GetEnvironmentVariable($name)
    $parsed = 0
    if ($raw -and [int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) { $Port = $parsed; break }
}

Write-Host "KitsuneMCP uninstaller (Windows)"

# ---------------------------------------------------------------------------
Write-Step "Checking for a running daemon (127.0.0.1:$Port)"

$health = $null
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
} catch {
    $health = $null
}

$isKitsune = $false
if ($null -ne $health -and $health.PSObject.Properties['service'] -and $health.service -eq 'kitsune-mcp') {
    $isKitsune = $true
}

if ($null -eq $health) {
    Write-Ok 'no daemon is answering'
} elseif (-not $isKitsune) {
    Write-Warn2 "port $Port answers /health but is not a kitsune-mcp daemon - leaving it alone"
} else {
    $browsers = if ($health.PSObject.Properties['browsers_connected']) { $health.browsers_connected } else { '?' }
    Write-Info "kitsune-mcp daemon is running (browsers connected: $browsers)"

    $pids = @()
    try {
        $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        $pids = @()
    }

    if ($pids.Count -eq 0) {
        Write-Warn2 "could not find the process listening on port $Port; stop it manually if needed"
    } elseif ($NoStopDaemon) {
        Write-Info "left running (-NoStopDaemon). PID(s): $($pids -join ', ')"
    } else {
        $doStop = $StopDaemon -or (Confirm-YesNo "Stop the daemon (PID $($pids -join ', '))? Claude Code sessions using it lose the browser tools." $true)
        if ($doStop) {
            foreach ($procId in $pids) {
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($null -eq $proc) { continue }
                if ($proc.ProcessName -ne 'node') {
                    Write-Warn2 "PID $procId is '$($proc.ProcessName)', not node - not stopping it"
                    continue
                }
                Stop-Process -Id $procId -Force
                Write-Ok "stopped daemon (PID $procId)"
            }
        } else {
            Write-Info 'left running'
        }
    }
}

# A Native Host still running (Firefox with the extension loaded) restarts
# the daemon on its own; tell the user.
try {
    $hosts = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'native-host[\\/]+dist[\\/]+index\.js' })
    if ($hosts.Count -gt 0) {
        Write-Warn2 ("a KitsuneMCP Native Host is still running (PID {0})." -f (($hosts | ForEach-Object { $_.ProcessId }) -join ', '))
        Write-Warn2 'Remove the extension in Firefox (or restart Firefox); otherwise it may start the daemon again.'
    }
} catch {
    # CIM unavailable - skip the hint
}

# ---------------------------------------------------------------------------
Write-Step 'Removing the Firefox registration'

if (Test-Path -LiteralPath $RegKey) {
    $value = (Get-Item -LiteralPath $RegKey).GetValue('')
    Remove-Item -LiteralPath $RegKey -Recurse -Force
    Write-Ok "removed $($RegKey -replace '^HKCU:', 'HKCU') (was: $value)"
} else {
    Write-Ok 'registry key not present'
}

# ---------------------------------------------------------------------------
Write-Step "Removing $InstallDir"

if (-not (Test-Path -LiteralPath $InstallDir)) {
    Write-Ok 'not present'
} elseif (Remove-DirectoryTree $InstallDir $InstallDir) {
    Write-Ok 'removed'
}

# ---------------------------------------------------------------------------
Write-Step 'Claude Code'

$ClaudeExe = Find-Exe 'claude'
if ($null -eq $ClaudeExe) {
    $candidate = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path -LiteralPath $candidate) { $ClaudeExe = $candidate }
}

Push-Location $RepoRoot   # so local/project scopes refer to this repository
try {
    if ($null -eq $ClaudeExe) {
        Write-Info "'claude' was not found. If you registered KitsuneMCP, remove it with:"
        Write-Info "  claude mcp remove $ClaudeName"
    } elseif ($NoUnregisterClaude) {
        Write-Info "Skipped (-NoUnregisterClaude). To remove it: claude mcp remove $ClaudeName"
    } else {
        $getExit = Invoke-Quiet $ClaudeExe @('mcp', 'get', $ClaudeName)
        if ($getExit -ne 0) {
            Write-Ok "'$ClaudeName' is not registered (as seen from $RepoRoot)"
            Write-Info "If it was added with scope local in another directory, run 'claude mcp remove $ClaudeName' there."
        } else {
            $doRemove = $UnregisterClaude -or (Confirm-YesNo "Remove '$ClaudeName' from Claude Code?" $true)
            if ($doRemove) {
                & $ClaudeExe mcp remove $ClaudeName
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "removed '$ClaudeName'"
                } else {
                    Write-Warn2 "claude mcp remove failed (exit code $LASTEXITCODE)."
                    Write-Info "If it exists in several scopes, run: claude mcp remove $ClaudeName --scope <user|local|project>"
                }
            } else {
                Write-Info 'left registered'
            }
        }
    }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
Write-Step "Data directory $DataDir"

if (-not (Test-Path -LiteralPath $DataDir)) {
    Write-Ok 'not present'
} elseif ($Purge) {
    try {
        if (Remove-DirectoryTree $DataDir $DataDir) {
            Write-Ok 'removed (-Purge)'
        }
    } catch {
        Write-Warn2 "could not remove everything: $($_.Exception.Message)"
        Write-Warn2 'A running daemon / Native Host may still hold a log file open. Stop it and run again.'
    }
} else {
    $left = @(Get-ChildItem -LiteralPath $DataDir -Force)
    if ($left.Count -eq 0) {
        Remove-Item -LiteralPath $DataDir -Force
        Write-Ok 'empty - removed'
    } else {
        Write-Info 'kept (run with -Purge to delete):'
        $left | ForEach-Object { Write-Info "  $($_.Name)" }
    }
}

Write-Host ""
Write-Host "Uninstall complete." -ForegroundColor Green
Write-Host "Remove the extension in Firefox as well (about:addons, or about:debugging for a temporary add-on)."
Write-Host "The repository ($RepoRoot) was not modified."
