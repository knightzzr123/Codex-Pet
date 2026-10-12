@echo off
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "installResult=%ERRORLEVEL%"
pause
exit /b %installResult%
