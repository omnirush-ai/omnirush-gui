# Verifies Authenticode signatures of the Windows build (CI only; never shipped).
#
#   verify-windows-signing.ps1 -Dist apps/desktop/dist-electron -Signed true|false [-InstallCheck]
#
# Signed=true: the installer and every .exe/.dll/.node in win-unpacked must
# pass `signtool verify /pa` and carry an RFC 3161 timestamp. With
# -InstallCheck the installer is run silently (per-user), the installed app
# exe and uninstaller are verified the same way, and the app is uninstalled.
# Signed=false (no signing secrets): the checks are skipped with a notice.
# Either way the version-info resources of the app exe and the installer are
# printed and must name OmniRush.ai.
param(
  [Parameter(Mandatory = $true)][string]$Dist,
  [Parameter(Mandatory = $true)][string]$Signed,
  [switch]$InstallCheck
)
$ErrorActionPreference = "Stop"
$summary = if ($env:GITHUB_STEP_SUMMARY) { $env:GITHUB_STEP_SUMMARY } else { "NUL" }

$installers = @(Get-ChildItem -Path $Dist -Filter "*.exe" -File | Where-Object { $_.Name -notlike "*__uninstaller*" })
$unpacked = Get-ChildItem -Path $Dist -Directory | Where-Object { $_.Name -like "win*-unpacked" } | Select-Object -First 1
if ($installers.Count -eq 0 -or -not $unpacked) { throw "No installer or win-unpacked directory under $Dist" }
$appExe = Get-ChildItem -Path $unpacked.FullName -Filter "*.exe" -File | Where-Object { $_.Name -notlike "Uninstall*" } | Select-Object -First 1
# The opencode sidecar's per-triple metadata is JSON named `versions.json-<triple>.exe`,
# not a PE, so it is never signed; exclude it from the verification set.
$peFiles = @(Get-ChildItem -Path $unpacked.FullName -Recurse -File -Include *.exe, *.dll, *.node |
  Where-Object { $_.Name -notlike "versions.json-*.exe" })

Write-Host "== Version info"
$versionProblems = @()
foreach ($file in @($appExe) + $installers) {
  $vi = (Get-Item $file.FullName).VersionInfo
  Write-Host ("{0}: CompanyName='{1}' ProductName='{2}' FileDescription='{3}' LegalCopyright='{4}' FileVersion='{5}'" -f $file.Name, $vi.CompanyName, $vi.ProductName, $vi.FileDescription, $vi.LegalCopyright, $vi.FileVersion)
  foreach ($field in "CompanyName", "ProductName", "FileDescription", "LegalCopyright") {
    if (-not ($vi.$field -match "OmniRush")) { $versionProblems += "$($file.Name) $field='$($vi.$field)'" }
  }
}
if ($versionProblems.Count -gt 0) { throw "Version info does not name OmniRush.ai: $($versionProblems -join '; ')" }

if ($Signed -ne "true") {
  $unsignedCount = @($peFiles | Where-Object { (Get-AuthenticodeSignature $_.FullName).Status -ne "Valid" }).Count
  $msg = "Skipped signtool verification: no Windows signing secrets (AZURE_* for Trusted Signing or WIN_CSC_LINK), so this build is unsigned ($unsignedCount of $($peFiles.Count) PE files in win-unpacked carry no valid signature; files Microsoft or upstream signed keep theirs)."
  Write-Host "::notice title=Windows signing verification skipped::$msg"
  Add-Content -Path $summary -Value "### Windows signing: skipped`n$msg"
  exit 0
}

$sdkBin = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^10\.' } | Sort-Object { [version]$_.Name } -Descending |
  ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sdkBin) { throw "signtool.exe not found in the Windows SDK" }
Write-Host "signtool: $sdkBin"

function Test-Signed([string]$Path, [switch]$Verbose) {
  $vargs = @("verify", "/pa")
  if ($Verbose) { $vargs += "/v" }
  $out = & $sdkBin @vargs $Path 2>&1 | Out-String
  $ok = $LASTEXITCODE -eq 0
  $sig = Get-AuthenticodeSignature $Path
  $stamped = $null -ne $sig.TimeStamperCertificate
  if ($Verbose -or -not $ok) { Write-Host $out }
  [pscustomobject]@{ File = $Path; Ok = $ok; Timestamped = $stamped; Signer = $sig.SignerCertificate.Subject }
}

$results = @()
Write-Host "== signtool verify /pa /v (installer, app exe, sidecar)"
$primary = @($installers.FullName) + @($appExe.FullName) + @($peFiles | Where-Object { $_.Name -like "opencode*.exe" } | ForEach-Object FullName)
foreach ($path in $primary) { $results += Test-Signed $path -Verbose }
Write-Host "== signtool verify /pa (every .exe/.dll/.node in $($unpacked.Name))"
foreach ($file in $peFiles) { if ($primary -notcontains $file.FullName) { $results += Test-Signed $file.FullName } }

if ($InstallCheck) {
  Write-Host "== silent per-user install"
  $installer = $installers | Select-Object -First 1
  $p = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Installer exited with $($p.ExitCode)" }
  $uninstaller = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "Uninstall *.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $uninstaller) { throw "No uninstaller under $env:LOCALAPPDATA\Programs after install" }
  Write-Host "Installed to $($uninstaller.DirectoryName) (standard per-user location)"
  $results += Test-Signed $uninstaller.FullName -Verbose
  $results += Test-Signed (Join-Path $uninstaller.DirectoryName $appExe.Name)
  $u = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
  Write-Host "Uninstaller exited with $($u.ExitCode)"
}

$bad = @($results | Where-Object { -not $_.Ok -or -not $_.Timestamped })
$results | ForEach-Object { "{0} {1} {2}" -f ($(if ($_.Ok -and $_.Timestamped) { "OK  " } else { "FAIL" })), $_.File, $_.Signer } | Write-Host
Add-Content -Path $summary -Value "### Windows signing: $($results.Count - $bad.Count)/$($results.Count) files verified (signtool /pa, RFC 3161 timestamp)"
if ($bad.Count -gt 0) {
  $bad | ForEach-Object { Add-Content -Path $summary -Value "- FAIL $($_.File) (verified=$($_.Ok), timestamped=$($_.Timestamped))" }
  throw "$($bad.Count) file(s) are unsigned, untrusted or not timestamped"
}
