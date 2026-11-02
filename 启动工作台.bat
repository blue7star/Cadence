@echo off
chcp 65001 >nul
title Cadence MVP - Service Window (keep it open)
cd /d "%~dp0"
cls
echo.
echo   ==========================================================
echo      Cadence MVP   -   service window
echo   ==========================================================
echo.
echo    Keep this window open. Minimizing is fine.
echo    If you close it, the service stops for everyone.
echo.

if not exist "server.js" goto NOFILE
where node >nul 2>nul
if errorlevel 1 goto NONODE

echo    Starting up, about 1-2 seconds. Browser opens by itself.
echo.
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:8788"
node --no-warnings server.js
set RC=%ERRORLEVEL%

echo.
echo   ----------------------------------------------------------
if "%RC%"=="0" goto STOPPED
echo    Failed to start. Read the message above.
echo    If it says the port is in use, the service is ALREADY running:
echo    just open  http://localhost:8788  in your browser.
goto END
:STOPPED
echo    Service stopped. Your data is safe on disk.
:END
echo   ----------------------------------------------------------
echo.
pause
exit /b

:NOFILE
echo   [!] server.js not found in this folder.
echo       Extract the zip first, then double-click this file again.
echo.
echo       Current folder: %CD%
echo.
pause
exit /b 1

:NONODE
type "%~dp0readme-no-node.txt"
echo.
pause
exit /b 1
