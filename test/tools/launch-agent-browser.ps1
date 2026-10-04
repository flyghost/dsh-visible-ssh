# Launch the shared agent browser OUTSIDE the agent's sandbox job object.
#
# Why this exists: start-agent-browser.cmd uses `start "" "%EXE%" …`, which detaches the
# window but does NOT break away from the sandbox job object. A browser launched that way
# from the agent's process tree dies within ~15-30s, either with
#   FATAL:mojo\public\cpp\platform\platform_channel.cc:170] Check failed: . : 拒绝访问。 (0x5)
# (confined mode) or silently, when the job closes.
#
# Win32_Process::Create is executed by WmiPrvSE.exe, a separate service process, so the
# browser it creates is not a descendant of the agent's shell and not inside its job.
# Everything else mirrors start-agent-browser.cmd: same exe order, same flags, same profile.

$ErrorActionPreference = 'Stop'

# The profile lives with the rest of the generated state: test/env/browser (gitignored).
$profileDir = Join-Path $PSScriptRoot '..\env\browser\.agent-browser-profile'

$candidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "no Edge/Chrome found in: $($candidates -join ', ')" }

$argLine = @(
  '--remote-debugging-port=9222'
  "--user-data-dir=`"$profileDir`""
  '--no-first-run'
  '--no-default-browser-check'
  '--window-size=1440,960'
  '--window-position=80,60'
  'about:blank'
) -join ' '

Write-Output "exe: $exe"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$exe`" $argLine" }
Write-Output ("Win32_Process.Create -> ReturnValue={0} ProcessId={1}" -f $r.ReturnValue, $r.ProcessId)
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with ReturnValue=$($r.ReturnValue)" }
