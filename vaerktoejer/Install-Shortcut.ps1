# Laver skrivebordsgenveje til RL Live Tracker, lobby-boardet og overlayet.
# Koeres af Install-Shortcut.bat ved siden af.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = $PSScriptRoot
$desk = [Environment]::GetFolderPath('Desktop')
$ico = Join-Path $root 'icon.ico'
$ws = New-Object -ComObject WScript.Shell

function Ny-Genvej($navn, $maal, $beskrivelse) {
  if (-not (Test-Path $maal)) { Write-Host ("  - " + $navn + ": springes over (findes ikke endnu)"); return }
  $l = $ws.CreateShortcut((Join-Path $desk ($navn + '.lnk')))
  $l.TargetPath = $maal
  $l.WorkingDirectory = $root
  if (Test-Path $ico) { $l.IconLocation = $ico }
  $l.Description = $beskrivelse
  $l.Save()
  Write-Host ("  + " + $navn)
}

Write-Host 'Skrivebordsgenveje:'
Ny-Genvej 'RL Live Tracker' (Join-Path $root 'Start-RL-Tracker.bat') 'Rocket League Live Stats Tracker'
Ny-Genvej 'RL Lobby Board'  (Join-Path $tools 'Start-Lobby-Board.bat') 'Lobby-boardet (stor skaerm)'
Ny-Genvej 'RL Overlay'      (Join-Path $tools 'Start-Overlay.bat') 'Kortene oven paa spillet'
Write-Host ''
Write-Host 'Faerdig. Overlayet starter i oevrigt selv sammen med trackeren.'
