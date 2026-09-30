@echo off
setlocal
rem Riichi score app - server on/off switch (double-click to toggle)
rem NOTE: keep this file ASCII-only. Chinese path is resolved via %~dp0.

set "NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
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
  if not exist "%NODE%" (
    echo [ERROR] node.exe not found: %NODE%
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
