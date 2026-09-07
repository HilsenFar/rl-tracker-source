@echo off
cd /d "%~dp0"
rem Exe'en aabner selv browseren ved direkte dobbeltklik (onboarding 15/8) —
rem men DENNE launcher ejer sin egen aabne-logik (fallbacks + noopen-arg),
rem saa serveren maa ikke ogsaa aabne en.
set "RL_NO_OPEN=1"
rem Foerste koersel: vis de tre kritiske trin KLART, midt paa skaermen
if not exist profile.json (
  echo.
  echo   +=============================================================+
  echo   ^|            WELCOME - THREE STEPS MUST BE IN PLACE           ^|
  echo   ^|                                                             ^|
  echo   ^|  1. DefaultStatsAPI.ini:  PacketSendRate=120                ^|
  echo   ^|     ...\rocketleague\TAGame\Config\  - restart the game     ^|
  echo   ^|  2. This launcher opens  http://localhost:8341              ^|
  echo   ^|  3. CLICK YOUR OWN NAME in the player list - once           ^|
  echo   ^|                                                             ^|
  echo   ^|  More: README.txt  -  documentation in the docs folder      ^|
  echo   +=============================================================+
  echo.
)
netstat -an | findstr ":8341" | findstr LISTENING >nul
if not errorlevel 1 (
  echo RL Tracker koerer allerede.
  goto open
)
rem Loggen (29/8): serveren startede minimeret UDEN omdirigering, saa dens
rem linjer levede kun i et konsolvindue og var vaek efter en genstart. Netop de
rem linjer er sporet: "[feed] hovedtraaden var blokeret i N ms" navngiver hver
rem blokering over 250 ms, og det er saadan de dyre kald findes. Fejlbeskeden
rem nedenfor har i forvejen peget paa server.log — nu findes filen ogsaa.
rem Forrige koersel gemmes, saa en genstart ikke sletter det man leder efter.
if exist server.log move /y server.log server.prev.log >nul 2>nul
if exist RLTrackerServer.exe (
  start "" /min cmd /c ".\RLTrackerServer.exe > server.log 2>&1"
  goto wait
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found - opening tracker in offline mode (demo/history only).
  start "" "%~dp0RLLiveTracker.html"
  exit /b
)
start "" /min cmd /c "node server.js > server.log 2>&1"
:wait
echo Starter RL Tracker...
for /l %%i in (1,1,60) do (
  netstat -an | findstr ":8341" | findstr LISTENING >nul
  if not errorlevel 1 goto open
  rem ping, not timeout: timeout aborts with "Input redirection is not
  rem supported" the moment stdin is not a console, and then the whole loop
  rem spins through in two seconds and gives up exactly when the machine is
  rem slowest. ping always waits.
  ping -n 2 127.0.0.1 >nul
)
echo RL Tracker svarede ikke paa port 8341 - se server.log.
:open
rem Overlayet foelger med (24/8): RLOverlay.exe viser sig foerst, naar Rocket
rem League koerer, og skjuler sig igen naar spillet lukkes - saa det ligger
rem stille indtil da. Slaa det fra ved at oprette filen overlay-fra.txt.
rem En kopi mere er ufarlig: overlayet er single-instance.
if exist "%~dp0RLOverlay.exe" if not exist "%~dp0overlay-fra.txt" start "" "%~dp0RLOverlay.exe"
if /i "%~1"=="noopen" exit /b
start "" http://localhost:8341/
