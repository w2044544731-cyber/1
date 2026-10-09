@echo off
cd /d "%~dp0"
node scripts/windows-launcher.js
if errorlevel 1 pause
