@echo off
chcp 65001 >nul
title Cadence MVP - Stop
cd /d "%~dp0"
echo.
echo   Looking for the service on port 8788 ...
set FOUND=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8788" ^| findstr LISTENING') do (
  taskkill /PID %%p /F >nul 2>nul
  if not errorlevel 1 set FOUND=1
)
echo.
if defined FOUND (
  echo   Stopped. Data is kept on disk.
  echo   Next time just double-click the start file again.
) else (
  echo   Nothing is running on port 8788 - it may already be closed.
)
echo.
echo   You can also just close the black server window.
echo.
pause
exit /b
