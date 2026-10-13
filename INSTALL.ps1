# ============================================================
# AI Studio installer for Windows
#
# Checks this computer and installs what's missing:
#   Node.js -> studio files -> opencode -> Git -> ComfyUI
#   -> ComfyUI add-on packs -> the AI model -> Ollama (optional)
#
# Everything is optional: press N to skip any step and run it
# later by double-clicking INSTALL.bat again.
# ============================================================

$ErrorActionPreference = "Continue"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path

function Heading($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  [ok]      $m" -ForegroundColor Green }
function Missing($m) { Write-Host "  [missing] $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "  $m" }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [failed] $m" -ForegroundColor Red }

function Ask($q) {
  $a = Read-Host "  $q (y/N)"
  return ($a -match '^(y|yes)$')
}

function RefreshPath {
  $env:PATH = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
}

function WingetInstall($id) {
  & winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent 2>&1 |
    ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  RefreshPath
}

# --- where is ComfyUI? (same logic as studio/config.js) ---
function DetectComfyRoot {
  if ($env:COMFY_ROOT -and (Test-Path (Join-Path $env:COMFY_ROOT "ComfyUI"))) { return $env:COMFY_ROOT }
  $candidates = @(
    "D:\ComfyUI_windows_portable",
    "C:\ComfyUI_windows_portable",
    "D:\ComfyUI",
    "C:\ComfyUI",
    (Join-Path (Split-Path -Parent $ROOT) "ComfyUI_windows_portable"),
    (Join-Path $ROOT "ComfyUI_windows_portable")
  )
  foreach ($c in $candidates) { if (Test-Path (Join-Path $c "ComfyUI")) { return $c } }
  return $null
}

Write-Host ""
Write-Host "  AI Studio installer" -ForegroundColor Cyan
Write-Host "  Folder: $ROOT"

# ------------------------------------------------------------
Heading "1 of 8 - Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Ok "Node.js found: $(& node --version 2>$null)"
} else {
  Missing "Node.js is not installed (the studio runs on it - it is free)"
  if (Ask "Install Node.js now (via winget)?") {
    WingetInstall "OpenJS.NodeJS.LTS"
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { Ok "Node.js installed: $(& node --version 2>$null)" }
    else { Fail "Could not install Node.js automatically."; Info "Install it manually from https://nodejs.org then run INSTALL.bat again." }
  } else {
    Info "Get it from https://nodejs.org, install it, then run INSTALL.bat again."
  }
}

# ------------------------------------------------------------
Heading "2 of 8 - Studio files"
if (Get-Command node -ErrorAction SilentlyContinue) {
  if (Test-Path (Join-Path $ROOT "node_modules")) {
    Ok "Studio dependencies already installed"
  } else {
    Info "Downloading studio dependencies (about a minute)..."
    Push-Location $ROOT
    & npm.cmd install --no-fund --no-audit 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -eq 0) { Ok "Studio dependencies installed" } else { Fail "npm install failed - check your internet connection and run INSTALL.bat again" }
  }
} else {
  Missing "Skipped (Node.js is needed first)"
}

# ------------------------------------------------------------
Heading "3 of 8 - opencode (the AI assistant)"
$oc = "$env:APPDATA\npm\opencode.cmd"
if ((Test-Path $oc) -or (Get-Command opencode -ErrorAction SilentlyContinue)) {
  Ok "opencode installed"
  Info "If you have not used it before, once: opencode auth login"
} else {
  Missing "opencode is not installed (the chat AI in the studio)"
  if (Ask "Install opencode now?") {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
      & npm.cmd install -g opencode-ai --no-fund --no-audit 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
      RefreshPath
      if ((Test-Path $oc) -or (Get-Command opencode -ErrorAction SilentlyContinue)) {
        Ok "opencode installed"
        Info "First-time setup: run 'opencode auth login' in a terminal (sign in with GitHub)."
      } else { Fail "Install failed - run INSTALL.bat again, or see README.md" }
    } else { Fail "npm not available yet" }
  }
}

# ------------------------------------------------------------
Heading "4 of 8 - Git (for ComfyUI add-ons)"
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) { Ok "Git found" }
else {
  Missing "Git is not installed"
  if (Ask "Install Git now (via winget)?") {
    WingetInstall "Git.Git"
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) { Ok "Git installed" } else { Fail "Could not install Git automatically - get it from https://git-scm.com" }
  }
}

# ------------------------------------------------------------
Heading "5 of 8 - ComfyUI (the image/video generator)"
$COMFY = DetectComfyRoot
if ($COMFY) {
  Ok "ComfyUI found at $COMFY"
} else {
  Missing "ComfyUI is not installed (about 6 GB with everything)"
  Info "The installer can download the official NVIDIA portable build and unpack it to C:\"
  if (Ask "Download ComfyUI now? (large download, 10-30 min)") {
    try {
      $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest" -TimeoutSec 30
      $asset = $rel.assets | Where-Object { $_.name -eq "ComfyUI_windows_portable_nvidia.7z" } | Select-Object -First 1
      if (-not $asset) { throw "release asset not found" }
      Info "Latest release: $($rel.tag_name)"

      # 7-Zip is needed to unpack the .7z
      $sz = "C:\Program Files\7-Zip\7z.exe"
      if (-not (Test-Path $sz)) {
        Info "Installing 7-Zip (needed to unpack)..."
        WingetInstall "7zip.7zip"
      }
      if (-not (Test-Path $sz)) { throw "7-Zip not available - install it from https://7-zip.org and run INSTALL.bat again" }

      $zip = Join-Path $env:TEMP "ComfyUI_windows_portable_nvidia.7z"
      Info "Downloading $($asset.name) ($([math]::Round($asset.size/1GB,1)) GB)..."
      & curl.exe -L --retry 3 --progress-bar -o $zip $asset.browser_download_url
      if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 100MB) { throw "download failed or incomplete" }

      Info "Unpacking (this takes a few minutes)..."
      & $sz x -y -o"C:\" $zip | Out-Null
      Remove-Item $zip -ErrorAction SilentlyContinue

      $COMFY = DetectComfyRoot
      if ($COMFY) { Ok "ComfyUI installed at $COMFY" }
      else { throw "unpack did not produce a ComfyUI folder" }
    } catch {
      Fail "Automatic install failed: $($_.Exception.Message)"
      Info "Manual steps:"
      Info "  1. Open https://github.com/comfyanonymous/ComfyUI/releases"
      Info "  2. Download ComfyUI_windows_portable_nvidia.7z"
      Info "  3. Install 7-Zip from https://7-zip.org and unpack the file to C:\"
      Info "  4. You should end up with C:\ComfyUI_windows_portable\ComfyUI\"
      Info "  5. Run INSTALL.bat again"
    }
  } else {
    Info "Manual: https://github.com/comfyanonymous/ComfyUI/releases -> ComfyUI_windows_portable_nvidia.7z"
    Info "Unpack it with 7-Zip to C:\ so it becomes C:\ComfyUI_windows_portable\"
  }
  $COMFY = DetectComfyRoot
}

# ------------------------------------------------------------
Heading "6 of 8 - ComfyUI add-on packs (audio, pose, video)"
if ($COMFY -and $git) {
  $packs = @(
    @{ dir = "audio-separation-nodes-comfyui"; repo = "https://github.com/christian-byrne/audio-separation-nodes-comfyui.git"; why = "song editing / stems" },
    @{ dir = "ComfyUI-VideoHelperSuite";       repo = "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git";       why = "video export" },
    @{ dir = "ComfyUI-FramePackWrapper";       repo = "https://github.com/kijai/ComfyUI-FramePackWrapper.git";            why = "longer videos" },
    @{ dir = "comfyui_controlnet_aux";         repo = "https://github.com/Fannovel16/comfyui_controlnet_aux.git";         why = "pose from photos" }
  )
  $custom = Join-Path $COMFY "ComfyUI\custom_nodes"
  $todo = $packs | Where-Object { -not (Test-Path (Join-Path $custom $_.dir)) }
  if (-not $todo) {
    Ok "All add-on packs already installed"
  } elseif (Ask "Install $($todo.Count) add-on pack(s) ($(($todo | ForEach-Object { $_.why }) -join ', '))?") {
    $py = Join-Path $COMFY "python_embeded\python.exe"
    foreach ($p in $todo) {
      $dest = Join-Path $custom $p.dir
      Info "Downloading $($p.dir)..."
      & git clone --depth 1 $p.repo $dest 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
      if (Test-Path $dest) { Ok "$($p.dir) downloaded" } else { Fail "$($p.dir) clone failed" }
      $req = Join-Path $dest "requirements.txt"
      if ((Test-Path $req) -and (Test-Path $py)) {
        Info "    Installing its dependencies (a few minutes)..."
        & $py -m pip install -r $req --no-warn-script-location 2>&1 |
          Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
      }
    }
    Info "Restart ComfyUI later to load the new packs."
  } else {
    Missing "Skipped - audio/pose/video workflows won't work until installed"
  }
} else {
  Missing "Skipped (needs ComfyUI and Git first)"
}

# ------------------------------------------------------------
Heading "7 of 8 - The AI model (DreamShaper 8, about 2 GB)"
if ($COMFY) {
  $ckptDir = Join-Path $COMFY "ComfyUI\models\checkpoints"
  $model = Join-Path $ckptDir "dreamshaper_8.safetensors"
  $anyModel = if (Test-Path $ckptDir) { @(Get-ChildItem $ckptDir -Filter *.safetensors -ErrorAction SilentlyContinue).Count } else { 0 }
  if (Test-Path $model) {
    Ok "dreamshaper_8.safetensors already present"
  } elseif ($anyModel -gt 0) {
    Ok "$anyModel model(s) already installed - images can be generated"
    if (Ask "Also download DreamShaper 8 (the model this studio is tuned for)?") {
      & curl.exe -L --retry 3 --progress-bar -o $model "https://huggingface.co/KatarLegacy/dreamshaper_8/resolve/main/dreamshaper_8.safetensors"
      if ((Test-Path $model) -and (Get-Item $model).Length -gt 1GB) { Ok "DreamShaper 8 downloaded" } else { Fail "Download failed - try again later" }
    }
  } else {
    Missing "No image model found - the studio needs at least one"
    if (Ask "Download DreamShaper 8 now (about 2 GB)?") {
      New-Item -ItemType Directory -Force -Path $ckptDir | Out-Null
      Info "Downloading from Hugging Face (no account needed)..."
      & curl.exe -L --retry 3 --progress-bar -o $model "https://huggingface.co/KatarLegacy/dreamshaper_8/resolve/main/dreamshaper_8.safetensors"
      if ((Test-Path $model) -and (Get-Item $model).Length -gt 1GB) { Ok "DreamShaper 8 downloaded" }
      else {
        Fail "Download failed - deleting the partial file"
        Remove-Item $model -ErrorAction SilentlyContinue
        Info "You can also download dreamshaper_8.safetensors from CivitAI and drop it into:"
        Info "  $ckptDir"
      }
    } else {
      Info "Put any SD 1.5 .safetensors file into: $ckptDir"
    }
  }
} else {
  Missing "Skipped (ComfyUI first)"
}

# ------------------------------------------------------------
Heading "8 of 8 - Ollama (optional local chat / track naming)"
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollama) { Ok "Ollama installed" }
else {
  Missing "Ollama is not installed (optional - offline AI extras)"
  if (Ask "Install Ollama now (via winget)?") {
    WingetInstall "Ollama.Ollama"
    $ollama = Get-Command ollama -ErrorAction SilentlyContinue
    if ($ollama) {
      Ok "Ollama installed"
      Info "To get a small offline model: ollama pull llama3.2"
    } else { Fail "Could not install Ollama - get it from https://ollama.com" }
  }
}

# ------------------------------------------------------------
Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
$nodeOk = [bool](Get-Command node -ErrorAction SilentlyContinue)
$ocOk = (Test-Path "$env:APPDATA\npm\opencode.cmd") -or [bool](Get-Command opencode -ErrorAction SilentlyContinue)
$comfyOk = [bool](DetectComfyRoot)
$modelOk = $false
$cr = DetectComfyRoot
if ($cr) { $modelOk = (Test-Path (Join-Path $cr "ComfyUI\models\checkpoints\dreamshaper_8.safetensors")) -or (@(Get-ChildItem (Join-Path $cr "ComfyUI\models\checkpoints") -Filter *.safetensors -ErrorAction SilentlyContinue).Count -gt 0) }

function CheckLine($ok, $label) { if ($ok) { Write-Host "  [ok]      $label" -ForegroundColor Green } else { Write-Host "  [missing] $label" -ForegroundColor Yellow } }
CheckLine $nodeOk "Node.js"
CheckLine $ocOk "opencode (the chat AI)"
CheckLine $comfyOk "ComfyUI (the generator)"
CheckLine $modelOk "Image model"
Write-Host ""

if ($nodeOk -and $ocOk -and $comfyOk -and $modelOk) {
  Write-Host "  Everything is ready. Double-click START_STUDIO.bat to launch." -ForegroundColor Green
  Write-Host "  First time? In a terminal run:  opencode auth login" -ForegroundColor Green
} else {
  Write-Host "  Some pieces are still missing (see above)." -ForegroundColor Yellow
  Write-Host "  Run INSTALL.bat again once you've completed them."
}
Write-Host ""
