@echo off
rem ============================================================================
rem  Install this repo's visible-ssh plugin into a DSH profile on THIS machine.
rem
rem  Double-click this file.  It only checks that Node is present and then hands
rem  over to scripts\install-local.mjs, which does the real work:
rem    1. lists every dsh CLI on this machine (the ones on PATH plus the ones each
rem       product generated under host-commands), grouped by the DSH_HOME it uses,
rem    2. asks you which one to install into -- only when there is more than one,
rem    3. builds the workspace, fetches the engine binaries if they are missing,
rem    4. installs into <DSH_HOME>\profiles\<profile> and verifies it.
rem
rem  Nothing here is tied to a product name: the home is read out of the selected
rem  dsh.cmd itself, so a community edition living in a differently named folder
rem  is found too.  If two editions share one DSH_HOME they are ONE choice, not
rem  two -- the script cannot install into "the wrong one" of a shared home.
rem
rem  Arguments are passed straight through, e.g.
rem    "%~nx0" --list-dsh        just list the targets, install nothing
rem    "%~nx0" --profile web    profile to install into (this is the default)
rem    "%~nx0" --tarball        pack tarballs and install those instead of link:
rem    "%~nx0" --check          only verify what is already installed
rem    "%~nx0" --dry-run        print the commands, change nothing
rem
rem  This file is deliberately pure ASCII: cmd.exe parses a batch file using the
rem  console code page, so Chinese text in here would be mojibake before the
rem  chcp below takes effect.  Node prints the Chinese output, and chcp 65001
rem  makes that render correctly.
rem
rem  Set VISIBLE_SSH_NO_PAUSE=1 to never wait for a key at the end.
rem ============================================================================
setlocal
chcp 65001 >nul
title visible-ssh - install into this machine

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] node.exe not found in PATH.
  echo         Node.js 20 or newer is required: https://nodejs.org/
  echo.
  pause
  endlocal
  exit /b 1
)

rem Wait for a key only when started WITHOUT arguments -- that is the
rem double-click case, where the window would otherwise close and hide the
rem result.  A script calling this with arguments (--check and friends) must
rem not block, so it does not wait.
set "WAIT_AT_END=1"
if not "%~1"=="" set "WAIT_AT_END="
if defined VISIBLE_SSH_NO_PAUSE set "WAIT_AT_END="

node "%~dp0install-local.mjs" %*
set "RC=%ERRORLEVEL%"

rem Only report here when something went wrong: on success install-local.mjs
rem has already printed its own verdict (which differs for --check / --list-dsh,
rem so a blanket "installed" line from this file would be wrong).
if not "%RC%"=="0" echo [!] install-local.mjs exited with code %RC%.

if defined WAIT_AT_END (
  echo.
  echo Press any key to close this window . . .
  pause >nul
)
endlocal
exit /b %RC%
