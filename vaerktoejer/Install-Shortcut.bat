@echo off
rem Laver genveje til alle tre flader paa skrivebordet.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Shortcut.ps1"
pause
