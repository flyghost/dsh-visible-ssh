@echo off
rem ---------------------------------------------------------------------------
rem Try to give the agent YOUR OWN Chrome profile (its logins, its tabs).
rem
rem Two conditions must both hold, and this script checks them honestly:
rem   1. Chrome must NOT already be running. A new chrome.exe started while one
rem      is running just hands the request to the running instance, and the
rem      debugging flag is silently ignored.
rem   2. Chrome 136+ must not refuse the DEFAULT user-data-dir. It usually DOES
rem      (that is the security change), in which case the browser opens fine but
rem      the port never listens - which is what this script detects and reports.
rem
rem If this fails, use start-chrome-agent.cmd instead: a dedicated profile always
rem works, at the cost of not having your existing logins.
rem
rem Port 9223 on purpose, so it can never be confused with the dedicated-profile
rem browser on 9222.
rem ---------------------------------------------------------------------------
setlocal
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" ( echo [ERROR] chrome.exe was not found. & pause & exit /b 1 )

tasklist /fi "imagename eq chrome.exe" 2>nul | find /i "chrome.exe" >nul
if not errorlevel 1 (
  echo [STOP] Chrome is already running.
  echo        Close EVERY Chrome window first ^(check the notification area too^),
  echo        then run this script again. Attaching afterwards is impossible.
  pause
  exit /b 1
)

set "UD=%LOCALAPPDATA%\Google\Chrome\User Data"
echo starting Chrome on your real profile with remote debugging on 127.0.0.1:9223 ...
start "" "%CHROME%" ^
  --remote-debugging-port=9223 ^
  --user-data-dir="%UD%" ^
  --no-first-run ^
  about:blank

for /l %%i in (1,1,20) do (
  powershell -NoProfile -Command "try{ if((Invoke-WebRequest 'http://127.0.0.1:9223/json/version' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200){exit 0} }catch{}; exit 1" >nul 2>nul
  if not errorlevel 1 goto :ready
  timeout /t 1 /nobreak >nul
)
echo [FAIL] Chrome is running but 127.0.0.1:9223 is NOT listening.
echo        That is Chrome 136+ refusing remote debugging on the default
echo        profile directory. Use start-chrome-agent.cmd instead.
echo        ^(Your Chrome window was opened normally and is fine to keep using.^)
pause
exit /b 1

:ready
echo [OK] Your own profile is listening on 127.0.0.1:9223 - the agent can attach.
timeout /t 4 /nobreak >nul
exit /b 0
