@echo off
rem Opens the always-on lobby rank board (big-screen view) in an app window.
rem Optional args: X Y WIDTH HEIGHT for window placement (e.g. on a side monitor).
rem One click from a cold machine: starts the server, waits for it, opens the board.
cd /d "%~dp0.."
call "%~dp0..\Start-RL-Tracker.bat" noopen
set POS=
if not "%~1"=="" set POS=--window-position=%~1,%~2 --window-size=%~3,%~4
start "" chrome --app=http://localhost:8341/?board %POS% 2>nul || start "" msedge --app=http://localhost:8341/?board %POS%
