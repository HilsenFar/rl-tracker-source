@echo off
rem Opens the always-on-top overlay (single-screen play). It normally starts by
rem itself with the tracker - this is for when you closed it from the tray.
rem RLOverlay.exe is the transparent window: ONLY the cards are drawn, and every
rem other pixel is the game behind them. Chrome cannot do that (measured 23/8 —
rem see overlay-host\Program.cs), so the Chrome bar is only the fallback for a
rem machine without the WebView2 runtime.
rem Optional args pass through, e.g.: Start-Overlay.bat -X 380 -Y 960
cd /d "%~dp0.."
if exist "%~dp0..\RLOverlay.exe" (
  start "" /wait "%~dp0..\RLTracker.exe" noopen
  start "" "%~dp0..\RLOverlay.exe" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-overlay.ps1" %*
  start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch-overlay.ps1" -Watch
)
