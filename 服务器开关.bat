@echo off
setlocal
rem Riichi score app - server on/off switch (double-click to toggle)
rem NOTE: keep this file ASCII-only. Project path is resolved via %~dp0.
rem
rem Node.js resolution order:
rem   1) set NODE=<full path to node.exe> before running this script
rem   2) node.exe found on PATH
rem Install Node.js from https://nodejs.org/ if neither works.

if not defined NODE set "NODE=node"
set "PORT=8765"

set "PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do set "PID=%%a"

if defined PID (
  echo [OFF] Server is running on port %PORT% ^(PID %PID%^). Stopping...
  taskkill /F /PID %PID% >nul 2>&1
  %SystemRoot%\System32\ping.exe -n 3 127.0.0.1 >nul
  netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul
  if errorlevel 1 (
    echo [OK] Server stopped.
  ) else (
    echo [WARN] Port %PORT% still busy - close the server window manually.
  )
) else (
  echo [ON] Starting server on port %PORT% ...
  where %NODE% >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] node.exe not found on PATH.
    echo         Install Node.js ^(https://nodejs.org/^) or run: set NODE=^<full path^> ^&^& "%~nx0"
    pause
    exit /b 1
  )
  cd /d "%~dp0prototype"
  start "Riichi Server 8765" "%NODE%" serve.js
  %SystemRoot%\System32\ping.exe -n 3 127.0.0.1 >nul
  netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul
  if errorlevel 1 (
    echo [ERROR] Server failed to start - check the new window for details.
  ) else (
    echo [OK] Server is UP.
    echo   host page : http://127.0.0.1:8765/?host=1
    echo   tag board : http://127.0.0.1:8765/tag.html
    echo   LAN  page : http://^(LAN IP^):8765/  for member phones
    echo A black server window is open - closing it also stops the server.
  )
)
pause
