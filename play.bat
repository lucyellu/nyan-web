@echo off
title Nyan Web
cd /d "%~dp0"

:: ── Free port 9100 if something is already on it ──────────────────────────
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":9100 " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: ── Find local network IP (for phone / tablet) ────────────────────────────
set LOCAL_IP=
for /f "tokens=2 delims=:" %%a in ('ipconfig 2^>nul ^| findstr /c:"IPv4 Address"') do (
    if not defined LOCAL_IP (
        set LOCAL_IP=%%a
        set LOCAL_IP=!LOCAL_IP: =!
    )
)
setlocal enabledelayedexpansion

:: Redo with delayed expansion so the strip-spaces works
set LOCAL_IP=
for /f "tokens=2 delims=:" %%a in ('ipconfig 2^>nul ^| findstr /c:"IPv4 Address"') do (
    if not defined LOCAL_IP set "LOCAL_IP=%%a"
)
set LOCAL_IP=%LOCAL_IP: =%

cls
echo.
echo  =====================================================
echo    Nyan Web  ^|  Virtual Paper Trading
echo  =====================================================
echo.
echo    Desktop :  http://localhost:9100
if defined LOCAL_IP (
echo    Mobile  :  http://%LOCAL_IP%:9100  ^(same WiFi^)
)
echo.
echo    Default ticker SPY. Type any Yahoo symbol in-game.
echo    Last hour replays at 60x. $1M virtual portfolio.
echo    Close this window to stop the server.
echo  =====================================================
echo.

:: ── Open browser after 1 s ────────────────────────────────────────────────
start "" cmd /c "timeout /t 1 /nobreak >nul && start http://localhost:9100"

:: ── Try python, then python3 ──────────────────────────────────────────────
python --version >nul 2>&1
if not errorlevel 1 (
    python -m http.server 9100
    goto :done
)

python3 --version >nul 2>&1
if not errorlevel 1 (
    python3 -m http.server 9100
    goto :done
)

echo.
echo  ERROR: Python not found. Install Python from https://python.org
echo  Make sure "Add Python to PATH" is checked during install.
echo.
pause
exit /b 1

:done
pause
