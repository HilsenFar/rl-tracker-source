@echo off
rem Closes the overlay. (The tray icon's "Luk overlay" does the same thing.)
rem To keep it closed for good, create the file overlay-fra.txt next to RLTracker.exe.
taskkill /IM RLOverlay.exe /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq RL Live Tracker overlay" /F >nul 2>&1
