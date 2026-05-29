#Requires -Version 5
<#
.SYNOPSIS
    Easy by zCHG.org — Windows zero-dependency bootstrap
    Called by INSTALL.bat. Do not run directly.

    What this does:
      1. Installs Node.js LTS if not present (tries winget, then direct MSI download)
      2. Hands off to install.mjs which does everything else:
         LM Studio install → model download → server start → MCP stack launch
#>

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Pretty output ─────────────────────────────────────────────────────────────
function ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green  }
function inf($m)  { Write-Host "  --> $m" -ForegroundColor Cyan   }
function wrn($m)  { Write-Host "  [!] $m" -ForegroundColor Yellow }
function err($m)  { Write-Host "  [X] $m" -ForegroundColor Red    }
function hdr($m)  { Write-Host "`n$m" -ForegroundColor White      }

Write-Host ""
Write-Host " ======================================================" -ForegroundColor Cyan
Write-Host "   Easy by zCHG.org  |  One-Click Installer"            -ForegroundColor Cyan
Write-Host "   (Windows Zero-Dependency Bootstrap)"                  -ForegroundColor DarkCyan
Write-Host " ======================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Node.js ──────────────────────────────────────────────────────────
hdr "Step 1/2 -- Node.js"

function Test-NodeOk {
    try {
        $v = & node --version 2>$null
        if ($v -match '^v(\d+)') { return [int]$Matches[1] -ge 18 }
    } catch {}
    return $false
}

if (Test-NodeOk) {
    ok "Node.js $(node --version) detected"
} else {
    $installed = $false

    # ── Try winget (Windows 10 1809+ / Windows 11) ──────────────────────────
    if (-not $installed) {
        try {
            $null = Get-Command winget -ErrorAction Stop
            inf "Installing Node.js LTS via winget ..."
            $wingetArgs = @('install','OpenJS.NodeJS.LTS','--silent','--accept-package-agreements','--accept-source-agreements','--force')
            & winget @wingetArgs
            if ($LASTEXITCODE -eq 0) {
                ok "Node.js installed via winget"
                $installed = $true
            } else {
                wrn "winget returned $LASTEXITCODE — will try direct download"
            }
        } catch {
            wrn "winget not available — will try direct download"
        }
    }

    # ── Try direct MSI download from nodejs.org ──────────────────────────────
    if (-not $installed) {
        inf "Fetching Node.js LTS version info from nodejs.org ..."
        try {
            $index = Invoke-RestMethod "https://nodejs.org/dist/index.json" -TimeoutSec 30 -UseBasicParsing
            $lts  = $index | Where-Object { $_.lts -and $_.lts -ne $false } |
                    Select-Object -First 1
            $ver  = $lts.version   # e.g. "v22.14.0"
            $msi  = "node-$ver-x64.msi"
            $url  = "https://nodejs.org/dist/$ver/$msi"
            $tmp  = Join-Path $env:TEMP $msi

            if (Test-Path $tmp) {
                inf "Found cached installer at $tmp"
            } else {
                inf "Downloading Node.js $ver (~30 MB) ..."
                $wc = New-Object System.Net.WebClient
                $wc.DownloadFile($url, $tmp)
                ok "Downloaded $tmp"
            }

            inf "Installing Node.js $ver silently (this takes ~30 s) ..."
            $proc = Start-Process msiexec.exe -ArgumentList "/i `"$tmp`" /quiet /norestart ADDLOCAL=ALL" -Wait -PassThru -NoNewWindow
            if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 3010) {
                ok "Node.js $ver installed"
                $installed = $true
            } else {
                err "msiexec exited with code $($proc.ExitCode)"
            }
        } catch {
            err "Download/install failed: $_"
        }
    }

    if (-not $installed) {
        err "Could not install Node.js automatically."
        err "Please install it manually from: https://nodejs.org"
        err "Then double-click INSTALL.bat again."
        Write-Host ""
        Read-Host "Press Enter to exit"
        exit 1
    }

    # ── Refresh PATH so node.exe is visible in this session ──────────────────
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path    = "$machinePath;$userPath"

    # Belt-and-suspenders: also add the standard install dir explicitly
    foreach ($candidate in @(
        "C:\Program Files\nodejs",
        "$env:APPDATA\Local\Programs\nodejs",
        "$env:ProgramFiles\nodejs"
    )) {
        if (Test-Path "$candidate\node.exe") {
            $env:Path = "$candidate;$env:Path"
            break
        }
    }

    if (-not (Test-NodeOk)) {
        err "Node.js was installed but is still not on PATH."
        err "Please CLOSE this window, open a new terminal, and run:"
        err "   node install.mjs"
        Write-Host ""
        Read-Host "Press Enter to exit"
        exit 1
    }
    ok "Node.js $(node --version) is ready"
}

# ── Step 2: LM Studio GUI install (must happen here, before node) ────────────
hdr "Step 2/3 -- LM Studio"

$lmsAppPaths = @(
    "C:\Program Files\LM Studio\LM Studio.exe",
    "C:\Program Files (x86)\LM Studio\LM Studio.exe",
    "$env:LOCALAPPDATA\Programs\LM Studio\LM Studio.exe",
    "$env:LOCALAPPDATA\LM Studio\LM Studio.exe"
)
$lmsApp = $lmsAppPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

# A complete Electron install always has icudtl.dat next to the exe.
# If the exe is present but icudtl.dat is missing the install is partial/corrupt
# (NSIS self-elevation race left only ~9 files).  Wipe it and reinstall.
if ($lmsApp) {
    $lmsDir    = Split-Path $lmsApp
    $icudtlOk  = Test-Path (Join-Path $lmsDir "icudtl.dat")
    if ($icudtlOk) {
        ok "LM Studio already installed: $lmsApp"
    } else {
        wrn "Partial LM Studio install detected (icudtl.dat missing) — removing and reinstalling ..."
        Get-Process "LM Studio" -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Milliseconds 1000
        Start-Process powershell -Verb RunAs -Wait `
            -ArgumentList "-NoProfile -Command `"Remove-Item '$lmsDir' -Recurse -Force -ErrorAction SilentlyContinue`""
        $lmsApp = $null   # fall through to install block below
    }
}

if (-not $lmsApp) {
    # Find bundled installer
    $lmsInstaller = Get-ChildItem "$dir", "$dir\dist" -Filter "LM-Studio-*.exe" -ErrorAction SilentlyContinue |
                    Select-Object -First 1 -ExpandProperty FullName
    if (-not $lmsInstaller) {
        wrn "Bundled LM Studio installer not found — will download during install.mjs step"
    } else {
        inf "Installing LM Studio — complete the wizard to continue ..."
        inf "Installer: $lmsInstaller"
        # -Verb RunAs: bootstrap is non-elevated; NSIS would otherwise self-elevate
        # and spawn an elevated child, causing the non-elevated parent to exit early
        # and -Wait to return before files are written.  Running it explicitly as
        # admin means Start-Process -Wait tracks the correct (elevated) process.
        Start-Process -FilePath $lmsInstaller -Verb RunAs -Wait
        $lmsApp = $lmsAppPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($lmsApp) {
            $lmsDir   = Split-Path $lmsApp
            $icudtlOk = Test-Path (Join-Path $lmsDir "icudtl.dat")
            if ($icudtlOk) {
                ok "LM Studio installed: $lmsApp"
            } else {
                err "LM Studio installed but icudtl.dat still missing — install may be corrupt. Re-run INSTALL.bat."
                Read-Host "Press Enter to exit"
                exit 1
            }
        } else {
            err "LM Studio install did not complete. Please install manually from https://lmstudio.ai then re-run."
            Read-Host "Press Enter to exit"
            exit 1
        }
    }
}

# ── Step 3: Hand off to install.mjs ─────────────────────────────────────────
hdr "Step 3/3 -- MCP Stack (install.mjs)"
inf "Handing off to install.mjs ..."
Write-Host ""

Set-Location $dir
& node "$dir\install.mjs" @args
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Host ""
    err "Installer exited with error (code $code). See messages above."
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit $code
}
