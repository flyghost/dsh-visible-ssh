@echo off
rem ============================================================================
rem  SSH monitor - double-click to watch the AI work on the remote host.
rem
rem  This attaches your terminal to the tmux session named "default".  The AI sends
rem  its commands into that same session, so you see every keystroke and every
rem  line of output live, and you can type into the window or press Ctrl-C at
rem  any time to take over.
rem
rem  -A means: attach if the session exists, create it if not.  So it does not
rem  matter whether you or the AI started first.
rem
rem  Closing this window only DETACHES.  The session and its scrollback stay
rem  alive on the remote host, and the AI keeps working; reopen this file to re-attach.
rem
rem  Connection details are read from config\host.toml.  The password is never
rem  read into this script, so it cannot leak through it.
rem
rem  Set TMUX_MONITOR_DRYRUN=1 to print the command instead of running it.
rem ============================================================================
setlocal
chcp 65001 >nul
title AI session - close window to detach

set "ROOT=%~dp0"
set "CFG=%ROOT%config\host.toml"
set "SESSION=default"

rem --- defaults, used only if the config file is missing ----------------------
set "SSH_HOST="
set "SSH_PORT=22"
set "SSH_USER="
set "CFG_FOUND="

rem --- read host / port / user from the TOML, ignoring comments and [host] ------
if exist "%CFG%" (
  set "CFG_FOUND=1"
  for /f "usebackq tokens=1,2 delims== " %%a in ("%CFG%") do (
    if /i "%%a"=="host"  set "SSH_HOST=%%b"
    if /i "%%a"=="port"  set "SSH_PORT=%%b"
    if /i "%%a"=="user"  set "SSH_USER=%%b"
  )
)

rem --- strip the quotes TOML requires, and any stray spaces -------------------
set "SSH_HOST=%SSH_HOST:"=%"
set "SSH_PORT=%SSH_PORT:"=%"
set "SSH_USER=%SSH_USER:"=%"
set "SSH_HOST=%SSH_HOST: =%"
set "SSH_PORT=%SSH_PORT: =%"
set "SSH_USER=%SSH_USER: =%"

if not defined CFG_FOUND (
  echo.
  echo [WARN] config not found: %CFG%
  echo        Falling back to built-in defaults ^(%SSH_USER%@%SSH_HOST%:%SSH_PORT%^).
  echo        To set your own, copy the template:
  echo          copy "%ROOT%config\host.toml.example" "%ROOT%config\host.toml"
  echo.
)

if not defined SSH_HOST goto :noconfig
if not defined SSH_USER goto :noconfig

rem --- build the ssh command --------------------------------------------------
rem UserKnownHostsFile is kept inside this folder so the script is self-contained
rem and never blocks on an interactive "are you sure you want to continue
rem connecting?" prompt.  accept-new records the key on first use and still
rem refuses if the key later CHANGES (which would mean a real MITM risk).
set "KNOWN=%ROOT%config\known_hosts"
set "SSHARGS=-t -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=%KNOWN%" -p %SSH_PORT% %SSH_USER%@%SSH_HOST%"
rem Options MUST ride along in the SAME tmux invocation as new-session (`\;`
rem separators).  A separate set-option is silently lost: with no session alive
rem the tmux server exits immediately, and `-f conf` is ignored on a live
rem server.  history-limit in particular only affects panes created AFTER it is
rem set, so it has to be in effect before the session exists.
set "REMOTECMD=tmux set-option -g history-limit 50000 \; set-option -g mouse on \; set-option -g remain-on-exit on \; set-option -g window-size largest \; new-session -A -s %SESSION%"

if defined TMUX_MONITOR_DRYRUN (
  echo [dry-run] config : %CFG%
  echo [dry-run] target : %SSH_USER%@%SSH_HOST%:%SSH_PORT%
  echo [dry-run] session: %SESSION%
  echo [dry-run] command: ssh %SSHARGS% "%REMOTECMD%"
  endlocal
  exit /b 0
)

where ssh >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] ssh.exe not found in PATH.
  echo         Windows OpenSSH Client is required ^(Settings ^> Optional Features^).
  echo.
  pause
  endlocal
  exit /b 1
)

echo Connecting to %SSH_USER%@%SSH_HOST%:%SSH_PORT% ...
echo Session: %SESSION%   ^(Ctrl-C interrupts, closing this window only detaches^)
echo.

ssh %SSHARGS% "%REMOTECMD%"

set "RC=%ERRORLEVEL%"
echo.
rem NOTE: ssh reports 255 for a transport failure AND for a remote command that
rem simply exited.  A normal detach (Ctrl-b d) ends with tmux printing "[exited]"
rem and closes the connection -- that is EXPECTED and the session survives.
rem remain-on-exit is enabled server-side, so even a shell that dies from `exit`
rem leaves the session intact.  So do not claim failure here; just report and let
rem the user verify with `status`.
if "%RC%"=="255" (
  echo Connection closed.
  echo   A normal detach ^(Ctrl-b d^) also closes the connection - that is fine.
  echo   The session survives on the remote host either way.
  echo.
  echo   To confirm it is still there:
  echo     packages\engine-win32-x64\visible-ssh.exe status
  echo.
  echo   If it is genuinely gone ^(the host rebooted, or the shell was exited^):
  echo     packages\engine-win32-x64\visible-ssh.exe up
  echo.
  pause
) else (
  echo Detached. The session is still running on the remote host.
  echo   Reopen this file to attach again.
  timeout /t 3 >nul
)
endlocal
exit /b %RC%

:noconfig
echo.
echo [ERROR] Could not determine host/user from:
echo         %CFG%
echo.
echo   Copy the template and fill it in:
echo     copy "%ROOT%config\host.toml.example" "%ROOT%config\host.toml"
echo.
pause
endlocal
exit /b 2
