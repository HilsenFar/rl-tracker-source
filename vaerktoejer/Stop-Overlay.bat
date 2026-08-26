@echo off
rem Closes the overlay. (The tray icon's "Luk overlay" does the same thing.)
taskkill /IM RLOverlay.exe /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq RL Live Tracker overlay" /F >nul 2>&1
