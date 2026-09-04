@echo off
rem TESTVERSION: pakker dine kamp-data til feedback (ingen noegler, intet sendes automatisk).
cd /d "%~dp0.."
echo.
echo  RL Tracker - feedback-eksport (testversion)
echo  Pakker: kampe, rapporter, profil og indstillinger.
echo  Pakker ALDRIG: API-noegler (rank/AI).
echo.
set INCL_LABELS=N
set /p INCL_LABELS="Inkluder dine egne kamp-maerker? De er personlige. [j/N] "
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm';" ^
 "$out = Join-Path ([Environment]::GetFolderPath('Desktop')) ('RL-Feedback-' + $stamp + '.zip');" ^
 "$stage = Join-Path $env:TEMP ('rl-feedback-' + $stamp);" ^
 "New-Item -ItemType Directory -Force $stage | Out-Null;" ^
 "foreach ($d in 'matches','reports'){ if (Test-Path $d){ Copy-Item $d (Join-Path $stage $d) -Recurse } };" ^
 "foreach ($f in 'profile.json','session-state.json','weekly-state.json','rank-history.json'){ if (Test-Path $f){ Copy-Item $f $stage } };" ^
 "if ('%INCL_LABELS%' -match '^[jJyY]'){ if (Test-Path 'labels.json'){ Copy-Item 'labels.json' $stage } };" ^
 "Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $out -Force;" ^
 "Remove-Item $stage -Recurse -Force;" ^
 "Write-Host ''; Write-Host ('Feedback-pakke lagt paa skrivebordet: ' + $out); Write-Host 'Send den selv til udvikleren - intet sendes automatisk.'"
pause
