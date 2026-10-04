// Can this sandbox run a browser at all?
//
// Playwright cannot LAUNCH one here: it speaks CDP over `--remote-debugging-pipe`,
// and a piped-stdio child is denied in this sandbox (measured: `spawn EPERM`,
// call log shows `--remote-debugging-pipe`).  The way around it is to launch the
// browser OURSELVES with `stdio: 'ignore'` and `--remote-debugging-port`, then
// ATTACH over TCP — `connectOverCDP` is a WebSocket client, not a child process.
//
// This probe answers the only two questions that matter before rewriting the
// driver: does the spawn succeed, and does the DevTools endpoint answer?
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The throwaway profile lives with the other generated state: test/env/browser. */
const PROFILE = join(HERE, '..', 'env', 'browser', '.probe-profile')
const PORT = 9333

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]

const { existsSync } = await import('node:fs')
const exe = CANDIDATES.find((path) => existsSync(path))
if (exe === undefined) {
  console.log(JSON.stringify({ ok: false, reason: 'no chromium-family browser found', CANDIDATES }, null, 2))
  process.exit(1)
}

mkdirSync(PROFILE, { recursive: true })
console.log(`launching ${exe} with stdio:ignore and --remote-debugging-port=${PORT}`)
const child = spawn(exe, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1200,800',
  '--window-position=100,80',
  'about:blank',
], { stdio: 'ignore', detached: false })

let spawnError = null
child.on('error', (error) => { spawnError = error })

/** Poll the DevTools endpoint until it answers or the deadline passes. */
async function waitForDevTools(deadlineMs) {
  const until = Date.now() + deadlineMs
  let last = null
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return await response.json()
      last = `HTTP ${response.status}`
    } catch (error) {
      last = String(error?.message ?? error)
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  return { error: last }
}

const version = await waitForDevTools(15_000)
const ok = version !== null && typeof version === 'object' && typeof version.webSocketDebuggerUrl === 'string'
console.log(JSON.stringify({
  ok,
  exe,
  spawnError: spawnError === null ? null : String(spawnError.message),
  childPid: child.pid,
  devTools: version,
}, null, 2))

// Leave the browser running when it works (the driver will attach to it); kill
// it when it did not, so a failed probe leaves nothing behind.
if (!ok) {
  try { child.kill() } catch { /* already gone */ }
}
process.exit(ok ? 0 : 1)
