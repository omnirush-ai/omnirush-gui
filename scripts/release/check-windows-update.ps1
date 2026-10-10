# Installs the latest published Windows release, then installs a new build over
# it the way the in-app updater does (`/S --updated`), and checks the result is
# one app in the same folder with its data kept and its shortcuts renamed.
# Usage: pwsh scripts/release/check-windows-update.ps1 <new-installer.exe>
param([Parameter(Mandatory = $true)][string]$NewInstaller)
$ErrorActionPreference = "Stop"

function Get-Installs {
  Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match "omnirush" }
}
# electron-builder leaves InstallLocation empty in the uninstall entry; the
# uninstaller sits in the install folder.
function Get-Folder($entry) {
  Split-Path ([regex]::Match($entry.UninstallString, '^"([^"]+)"').Groups[1].Value)
}
function Get-Shortcuts {
  $places = @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", [Environment]::GetFolderPath("Desktop"))
  Get-ChildItem $places -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "omnirush" } | ForEach-Object { $_.FullName }
}
function Show-State($label) {
  Write-Host "== $label"
  Get-Installs | ForEach-Object { Write-Host "uninstall entry: $($_.DisplayName) in $(Get-Folder $_)" }
  Get-Shortcuts | ForEach-Object { Write-Host "shortcut: $_" }
}

$manifestFile = Join-Path $env:RUNNER_TEMP "latest.yml"
Invoke-WebRequest -UseBasicParsing "https://github.com/omnirush-ai/omnirush-gui/releases/latest/download/latest.yml" -OutFile $manifestFile
$manifest = Get-Content -Raw $manifestFile
$latest = [regex]::Match($manifest, "(?m)^version:\s*(\S+)").Groups[1].Value
if (-not $latest) { throw "no version in latest.yml" }
$old = Join-Path $env:RUNNER_TEMP "omnirush-$latest.exe"
Invoke-WebRequest -UseBasicParsing "https://github.com/omnirush-ai/omnirush-gui/releases/download/v$latest/omnirush-win-x64-$latest.exe" -OutFile $old
Start-Process -Wait -FilePath $old -ArgumentList "/S"
Show-State "installed v$latest"
$before = @(Get-Installs)
if ($before.Count -ne 1) { throw "expected one install of v$latest" }
$folder = Get-Folder $before[0]

# A file in the app's data folder (keyed by the app id) must survive the update.
$data = Join-Path $env:APPDATA "ai.omnirush.desktop"
New-Item -ItemType Directory -Force $data | Out-Null
Set-Content (Join-Path $data "update-check-marker.txt") "kept"

Start-Process -Wait -FilePath (Resolve-Path $NewInstaller) -ArgumentList "/S", "--updated"
Show-State "after the update"
$after = @(Get-Installs)
if ($after.Count -ne 1) { throw "expected one install after the update, found $($after.Count)" }
if ((Get-Folder $after[0]) -ne $folder) { throw "the update moved the app from $folder to $(Get-Folder $after[0])" }
$exe = Get-ChildItem $folder -Filter *.exe | Where-Object { $_.Name -notmatch "^Uninstall" }
$exe | ForEach-Object { Write-Host "executable: $($_.Name) $($_.VersionInfo.ProductVersion)" }
if (@($exe).Count -ne 1) { throw "expected one app executable in $folder" }
$shortcuts = @(Get-Shortcuts)
$stale = $shortcuts | Where-Object { (Split-Path $_ -Leaf) -cmatch "OmniRush\.ai" }
if ($stale) { throw "old shortcuts left behind: $stale" }
if (-not ($shortcuts | Where-Object { (Split-Path $_ -Leaf) -eq "omnirush.lnk" })) { throw "no omnirush shortcut" }
if ((Get-Content (Join-Path $data "update-check-marker.txt")) -ne "kept") { throw "app data was lost" }
Write-Host "update in place: one install in $folder, data kept, shortcuts renamed"
