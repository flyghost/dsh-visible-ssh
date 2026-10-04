@echo off
rem ---------------------------------------------------------------------------
rem Start Google Chrome so the AGENT can drive it and YOU can watch it.
rem
rem Why YOU have to start it (and the agent cannot):
rem   * remote debugging only exists when the browser is STARTED with the flag --
rem     a Chrome that is already running can never be attached to afterwards;
rem   * Chrome 136+ ADDITIONALLY refuses remote debugging on the DEFAULT
rem     user-data-dir (a security change), so "just restart Chrome normally with
rem     --remote-debugging-port" does not work either.
rem   * and on this machine the agent's OWN SANDBOX kills the browser it starts:
rem     Chrome gets as far as reading policy and probing the displays, then dies on
rem     its first IPC channel --
rem        FATAL:mojo/public/cpp/platform/platform_channel.cc:108
rem        Check failed: . : 拒绝访问。 (0x5)                 exit code -36863
rem     That is Chrome's named-pipe creation being refused -- not a Chrome setting,
rem     and not something a different launcher fixes: a .cmd `start`, a .NET
rem     Start-Process and Playwright all die on that same line, because the child
rem     inherits the sandbox token whatever started it.  A PLAIN named pipe CAN be
rem     created inside the sandbox (measured, two levels of child), and
rem     --single-process / --no-sandbox do NOT avoid it (measured, same line).
rem A DEDICATED profile (below) sidesteps the two Chrome rules, and your own Chrome
rem window and profile are never touched.
rem
rem That sandbox limit IS liftable: launching this very command from a wider
rem (unconfined) permission mode starts Chrome normally -- measured, 127.0.0.1:9222
rem answered 200 and the driver attached.  The split matters, so keep it in mind:
rem STARTING the browser needs that wider mode (or this double-click), while
rem ATTACHING to it needs nothing special -- the driver runs with ordinary
rem permissions.
rem
rem Drag the window wherever you like (second screen): Chrome remembers its
rem position per profile, so one drag is enough.
rem ---------------------------------------------------------------------------
setlocal
rem The profile lives with the rest of the generated state: test/env/browser (gitignored).
set "PROFILE=%~dp0..\env\browser\.chrome-agent-profile"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo [ERROR] chrome.exe was not found.
  pause
  exit /b 1
)

echo starting Chrome with remote debugging on 127.0.0.1:9222 ...
start "" "%CHROME%" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run ^
  --no-default-browser-check ^
  about:blank

rem Verify instead of claiming: the listening port IS the whole contract.
rem
rem The delay is `ping`, NOT `timeout`.  `timeout` refuses to sleep when stdin is
rem redirected ("ERROR: Input redirection is not supported, exiting the process
rem immediately"), so it returns at once and these 20 attempts burn through in
rem milliseconds -- measured: the script cried "[WARN] 9222 never answered" while
rem Chrome was still starting, which is worse than having no check at all.
for /l %%i in (1,1,20) do (
  powershell -NoProfile -Command "try{ if((Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200){exit 0} }catch{}; exit 1" >nul 2>nul
  if not errorlevel 1 goto :ready
  ping -n 2 127.0.0.1 >nul
)
echo [WARN] Chrome started, but 127.0.0.1:9222 never answered.
echo        Tell the agent; do not retry blindly.
pause
exit /b 1

:ready
echo [OK] Chrome is listening on 127.0.0.1:9222 - the agent can attach now.
echo      You may close this console window; the browser stays.
rem `ping` rather than `timeout`, same reason as the loop above.  This one only
rem gives the human time to read the line, so when nobody is watching it is moot.
ping -n 5 127.0.0.1 >nul
exit /b 0
