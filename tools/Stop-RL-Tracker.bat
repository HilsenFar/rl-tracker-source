@echo off
rem Stops the tracker and the overlay (same as Start menu > Stop RL Tracker).
start "" /wait "%~dp0..\RLTracker.exe" stop
