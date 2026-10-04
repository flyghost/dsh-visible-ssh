@echo off
rem Start a browser the AGENT can drive and YOU can watch.
rem
rem Why you have to start it (and the agent cannot): Chromium's multi-process
rem architecture talks Mojo IPC over NAMED PIPES, and the agent's confined
rem sandbox denies named pipes — the browser dies with
rem   FATAL:mojo/public/cpp/platform/platform_channel.cc: Check failed: 拒绝访问 (0x5)
rem before it can even open a page.  A browser started OUTSIDE that sandbox is
rem fine, and the agent then attaches over TCP (`--remote-debugging-port`), which
rem is a plain loopback socket: measured reachable from the agent's side.
rem
rem Double-click this once per session (or after closing the window).  The agent
rem drives this exact window; you watch it live.  The dedicated --user-data-dir
rem means your own browser profile is never touched.
setlocal
rem The profile lives with the rest of the generated state: test/env/browser (gitignored).
set "PROFILE=%~dp0..\env\browser\.agent-browser-profile"
set "EXE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EXE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EXE if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined EXE (
  echo [ERROR] no Edge or Chrome found.
  pause
  exit /b 1
)

echo starting %EXE%
echo   debugging port : 9222  (the agent attaches here)
echo   profile        : %PROFILE%
start "" "%EXE%" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --window-size=1440,960 ^
  --window-position=80,60 ^
  about:blank

endlocal
