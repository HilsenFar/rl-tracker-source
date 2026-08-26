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
if exist RLTrackerServer.exe (
  start "" /min RLTrackerServer.exe
  goto wait
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found - opening tracker in offline mode (demo/history only).
  start "" "%~dp0RLLiveTracker.html"
  exit /b
)
start "" /min cmd /c "node server.js"
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
