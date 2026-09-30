# Scans the built installer and the unpacked app with Microsoft Defender on
# the Windows runner and reports detections (CI only; never shipped).
#
#   defender-scan.ps1 -Paths <installer.exe>,<win-unpacked dir>
#
# Updates the signatures first, runs a CustomScan per path, then lists every
# detection Defender recorded under those paths since the scan began. Exits 1
# on any detection, so a flagged build is never published.
param([Parameter(Mandatory = $true)][string[]]$Paths)
$ErrorActionPreference = "Stop"
$summary = if ($env:GITHUB_STEP_SUMMARY) { $env:GITHUB_STEP_SUMMARY } else { "NUL" }

$status = Get-MpComputerStatus
Write-Host ("Defender: AMService={0} Antivirus={1} RealTime={2}" -f $status.AMServiceEnabled, $status.AntivirusEnabled, $status.RealTimeProtectionEnabled)
try {
  Update-MpSignature -ErrorAction Stop
} catch {
  Write-Host "Update-MpSignature failed ($($_.Exception.Message)); trying MpCmdRun -SignatureUpdate"
  & "$env:ProgramFiles\Windows Defender\MpCmdRun.exe" -SignatureUpdate | Out-Host
}
$status = Get-MpComputerStatus
$versions = "engine $($status.AMEngineVersion), antivirus signatures $($status.AntivirusSignatureVersion) ($($status.AntivirusSignatureLastUpdated))"
Write-Host "Defender $versions"

$started = Get-Date
$resolved = @()
$mpThreats = @()
foreach ($path in $Paths) {
  $full = (Resolve-Path $path).Path
  $resolved += $full
  Write-Host "== Start-MpScan -ScanType CustomScan -ScanPath $full"
  Start-MpScan -ScanType CustomScan -ScanPath $full
  # MpCmdRun reports per path without remediating, so a detection stays on
  # disk for the report instead of being quarantined mid-run.
  $mp = & "$env:ProgramFiles\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File $full -DisableRemediation 2>&1 | Out-String
  Write-Host $mp.Trim()
  if ($LASTEXITCODE -eq 2) { $mpThreats += $full }
}

$detections = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object {
  $_.InitialDetectionTime -ge $started.AddMinutes(-1) -and
  ($_.Resources | Where-Object { $r = $_; $resolved | Where-Object { $r -like "*$_*" } })
})

Add-Content -Path $summary -Value "### Microsoft Defender scan`nDefender $versions. Scanned: $($resolved -join ', ')."
if ($detections.Count -eq 0 -and $mpThreats.Count -eq 0) {
  Write-Host "No detections."
  Add-Content -Path $summary -Value "Result: **no detections**."
  exit 0
}
foreach ($d in $detections) {
  $threat = Get-MpThreat -ThreatID $d.ThreatID -ErrorAction SilentlyContinue
  $line = "DETECTION: $($threat.ThreatName) (id $($d.ThreatID)) in $($d.Resources -join ', ')"
  Write-Host "::error::$line"
  Add-Content -Path $summary -Value "- $line"
}
foreach ($t in $mpThreats) {
  Write-Host "::error::MpCmdRun reported a threat in $t"
  Add-Content -Path $summary -Value "- MpCmdRun reported a threat in $t"
}
exit 1
