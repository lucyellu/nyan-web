@echo off
title Nyan Cat: Lost in Space
cd /d "%~dp0"

:: ── Free port 8080 if something is already on it ──────────────────────────
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8080 " ^| findstr "LISTENING"') do (
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
echo    Nyan Cat: Lost in Space  ^|  Alpaca Paper Trading
echo  =====================================================
echo.
echo    Desktop :  http://localhost:8080
if defined LOCAL_IP (
echo    Mobile  :  http://%LOCAL_IP%:8080  ^(same WiFi^)
)
echo.
echo    Data source defaults to Alpaca — BTC/USD 24/7.
echo    Close this window to stop the server.
echo  =====================================================
echo.

:: ── Open browser after 1 s ────────────────────────────────────────────────
start "" cmd /c "timeout /t 1 /nobreak >nul && start http://localhost:8080"

:: ── Try python, then python3 ──────────────────────────────────────────────
python --version >nul 2>&1
if not errorlevel 1 (
    python -m http.server 8080
    goto :done
)

python3 --version >nul 2>&1
if not errorlevel 1 (
    python3 -m http.server 8080
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
