@echo off
setlocal
if exist "%~dp0runtime\.dafeiyu-ready.json" if exist "%~dp0runtime\electron.exe" goto runtime_ready
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0prepare-runtime.ps1" <nul 1>nul
if errorlevel 1 exit /b 1
:runtime_ready
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0runtime\electron.exe" "%~dp0src\plugin-server.cjs"
exit /b %errorlevel%
