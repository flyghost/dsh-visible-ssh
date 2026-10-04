// A browser the agent drives and the human WATCHES — the same window.
//
// Why this shape: "how does my browser auto-refresh?" has a better answer than
// a refresh button.  One headful Chromium is launched here, the agent drives it
// over a tiny loopback control channel (plain HTTP, so any tool that can make a
// request can drive it), and a file watcher reloads the page when the plugin's
// source changes.  The human does nothing: the window on their desktop follows
// every edit and every navigation.
//
//   node test/tools/driver.mjs                       # prints its control URL
//   node test/tools/driver.mjs --goto http://127.0.0.1:PORT/?token=…
//   node test/tools/driver.mjs --watch plugin/lib/client/index.js
//   VISIBLE_SSH_BROWSER="C:\path\to\chrome.exe" node test/tools/driver.mjs   # skip the guessing
//
// Control channel (all on http://127.0.0.1:<port>, JSON in and out):
//   GET  /status                     page url/title, counters, recent events
//   GET  /events                     the event log (navigations, reloads, errors)
//   POST /goto    {url}              navigate and wait for load
//   POST /reload                     reload the page (the human sees it at once)
//   POST /eval    {js}               evaluate in the page, return the value
//   POST /click   {selector}
//   POST /type    {selector, text}
//   POST /wait    {selector, timeoutMs}
//   POST /shot    {name}             screenshot to test/env/evidence/shots/<name>.png
//   POST /watch   {paths:[...]}      watch files; reload the page when one changes
//
// Deliberately unauthenticated and loopback-only: this is a dev tool that lives in
// test/tools/ with the rest of the harness, and the alternative (a token dance) buys
// nothing.  It does mean any local process can drive it — do not leave it
// running unattended for days.
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Generated state of the whole harness: test/env (gitignored except the manifests). */
const ENV = join(HERE, '..', 'env')
const PROFILE = join(ENV, 'browser', '.chromium-profile')
/**
 * Screenshots land with the harness's other generated state (test/env/evidence),
 * beside the suite sandboxes in test/env/tmp: gitignored, and the same place every
 * time — no walking up the tree, which is how the old scratch/ lookup broke twice.
 */
const SHOTS = join(ENV, 'evidence', 'shots')

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1]
}

const events = []
const consoleErrors = []
const pageErrors = []
const failedRequests = []
let page = null
let context = null
/** The DevTools endpoint to re-attach to after the browser goes away. */
let cdpTarget = 'http://127.0.0.1:9222'
let watched = []
let watcher = null

function log(kind, detail) {
  const entry = { at: new Date().toISOString(), kind, detail }
  events.push(entry)
  if (events.length > 400) events.shift()
  console.log(`[driver] ${kind} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

/** Every request body is a small JSON object; anything else is a caller bug. */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('body must be JSON')
  }
}

function send(res, code, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** Wire the page so a human-visible failure is also an assertable one. */
function attach(page) {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push({ at: new Date().toISOString(), text: message.text() })
      log('console-error', message.text())
    }
  })
  page.on('pageerror', (error) => {
    pageErrors.push({ at: new Date().toISOString(), text: String(error?.message ?? error) })
    log('pageerror', String(error?.message ?? error))
  })
  page.on('requestfailed', (request) => {
    failedRequests.push({ at: new Date().toISOString(), url: request.url(), reason: request.failure()?.errorText ?? 'unknown' })
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) log('navigated', frame.url())
  })
}

async function startWatcher(paths) {
  watched = paths.map((p) => resolve(p))
  if (watcher !== null) clearInterval(watcher)
  if (watched.length === 0) return
  const mtimes = new Map()
  const stamp = (file) => {
    try {
      return statSync(file).mtimeMs
    } catch {
      return -1
    }
  }
  for (const file of watched) mtimes.set(file, stamp(file))
  watcher = setInterval(async () => {
    const changed = watched.filter((file) => stamp(file) !== mtimes.get(file))
    if (changed.length === 0) return
    for (const file of changed) mtimes.set(file, stamp(file))
    log('reload-for-change', changed.map((file) => file.replace(`${resolve(HERE, '..', '..')}\\`, '')))
    try {
      await page.reload({ waitUntil: 'domcontentloaded' })
    } catch (error) {
      log('reload-failed', String(error?.message ?? error))
    }
  }, 700)
  log('watching', watched)
}

/**
 * The Chromium-family browsers already on this machine.
 *
 * Chrome is listed first because that is the browser the human here actually
 * uses; `--browser-name edge` flips the preference, and `--browser-name chrome`
 * refuses anything else (so a demo can never silently land in the wrong window).
 *
 * @param name - `auto` | `chrome` | `edge`.
 * @returns absolute paths to try, in order.
 */
function browserCandidates(name) {
  // 显式指定的路径最优先：`VISIBLE_SSH_BROWSER=<…>\chrome.exe`。它压过 `--browser-name`
  // —— 因为你直接点了文件，就不该再被"猜"覆盖。下面那些候选只是这台机器上常见的位置；
  // 其中靠 `LOCALAPPDATA` 的那条只在变量真的设了的时候才出现（没设时 `join('', …)` 会
  // 退化成一个相对路径，永远选不中，徒增困惑）。它找的只是一个可执行文件，不读隐私数据。
  const explicit = process.env.VISIBLE_SSH_BROWSER
  if (explicit !== undefined && explicit !== '') return [explicit]
  const chrome = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // 当前用户的 Chrome：写死某个用户名会让这台机器以外的人永远找不到它。
    ...(process.env.LOCALAPPDATA === undefined || process.env.LOCALAPPDATA === ''
      ? []
      : [join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')]),
  ]
  const edge = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  if (name === 'chrome') return chrome
  if (name === 'edge') return edge
  return [...chrome, ...edge]
}

/** Poll a DevTools HTTP endpoint until it answers, or give up. */
async function waitForDevTools(port, deadlineMs) {
  const until = Date.now() + deadlineMs
  let last = 'no attempt'
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
      last = `HTTP ${response.status}`
    } catch (error) {
      last = String(error?.message ?? error)
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  return { error: last }
}

/**
 * Start a browser OUTSIDE our process tree's pipes, then attach over CDP.
 *
 * `stdio: 'ignore'` is the whole trick: a piped child is denied here, an
 * ignored one is not.  The debugging port is TCP, which is also not a pipe, so
 * everything after the spawn is a socket conversation.
 *
 * @param cdpUrl - where the browser should listen.
 * @returns the connected Playwright browser.
 */
async function launchAndAttach(cdpUrl) {
  const { existsSync } = await import('node:fs')
  const { spawn } = await import('node:child_process')
  const candidates = browserCandidates(arg('browser-name', 'auto'))
  const exe = candidates.find((path) => existsSync(path))
  if (exe === undefined) throw new Error(`no browser found; looked at ${candidates.join(', ')}`)
  const port = Number(new URL(cdpUrl).port || 9222)
  mkdirSync(PROFILE, { recursive: true })
  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,960',
    '--window-position=80,60',
    'about:blank',
  ], { stdio: 'ignore' })
  log('spawned', { exe, pid: child.pid, port })
  const version = await waitForDevTools(port, 20_000)
  if (typeof version?.webSocketDebuggerUrl !== 'string') {
    throw new Error(`the browser never opened a DevTools endpoint on ${port} (${JSON.stringify(version)}) — in a confined sandbox Chromium dies at startup because Mojo IPC needs a named pipe; run this driver with wider permissions, or start test/tools/start-agent-browser.cmd yourself`)
  }
  log('devtools', { browser: version.Browser, port })
  return chromium.connectOverCDP(cdpUrl)
}

/**
 * Attach to a browser that is already listening, launching one only if asked.
 *
 * @param cdpUrl - the DevTools endpoint to attach to.
 * @param allowLaunch - whether this driver may start a browser itself.
 * @returns the connected Playwright browser.
 */
async function attachOrLaunch(cdpUrl, allowLaunch) {
  try {
    const browser = await chromium.connectOverCDP(cdpUrl)
    log('attached', cdpUrl)
    return browser
  } catch (error) {
    log('attach-failed', { cdpUrl, error: String(error?.message ?? error) })
    if (!allowLaunch) {
      throw new Error(`nothing is listening on ${cdpUrl}. Start a browser with test/tools/start-agent-browser.cmd (a browser started by the agent needs the wider sandbox: Mojo IPC uses a named pipe), then re-run this driver.`, { cause: error })
    }
    return launchAndAttach(cdpUrl)
  }
}

/**
 * Open a URL in the shared browser — reusing a tab when one already shows it.
 *
 * This is the behaviour a human expects from "show me that page over there":
 * an already-open tab is refreshed in place (so the window does not fill up with
 * duplicates and the reader keeps their tab order), and only a page that is not
 * open anywhere gets a new tab.
 *
 * `match` decides what "already shows it" means:
 *   - `exact`: the full URL including query (a token URL is a different page)
 *   - `path` (default): same origin and path, query ignored — so re-opening the
 *     same app with a fresh ?token= reuses the tab and navigates it
 *   - `origin`: same host and port only
 *
 * @param target - the URL to show.
 * @param match - one of `exact` | `path` | `origin`.
 * @returns `{ reused, action, tab, tabs }`.
 */
async function openOrReuse(target, match) {
  const key = (raw) => {
    const parsed = new URL(raw)
    if (match === 'origin') return parsed.origin
    if (match === 'exact') return parsed.href
    return `${parsed.origin}${parsed.pathname}`
  }
  const wantedKey = key(target)
  const existing = context.pages().find((candidate) => {
    try {
      return key(candidate.url()) === wantedKey
    } catch {
      return false
    }
  })
  if (existing !== undefined) {
    page = existing
    await page.bringToFront()
    // Same URL: a reload is what the human wants (a fresh render).  Different
    // query on the same path: navigating is required, or the new token is lost.
    const action = existing.url() === target ? 'reloaded' : 'navigated'
    if (action === 'reloaded') await page.reload({ waitUntil: 'domcontentloaded' })
    else await page.goto(target, { waitUntil: 'domcontentloaded' })
    log('open-reused', { url: target, action })
    return { reused: true, action, tab: { index: context.pages().indexOf(page), url: page.url() }, tabs: context.pages().length }
  }
  page = await context.newPage()
  await page.goto(target, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  log('open-created', { url: target })
  return { reused: false, action: 'created', tab: { index: context.pages().indexOf(page), url: page.url() }, tabs: context.pages().length }
}

/**
 * Notice when the browser goes away, instead of dying with it.
 *
 * The browser belongs to the HUMAN: they may close it, or restart it with their
 * own flags, at any moment.  Measured twice before this existed: the CDP socket
 * dropped, the next call threw, and the whole driver exited with a bare code 1
 * and no explanation — the log's last line was whatever had worked.  A logged
 * event plus a `page === null` state is diagnosable, and `/attach` brings the
 * SAME long-lived job (and its control port, and its file watch) back once the
 * browser returns.
 *
 * @param browser - the connected Playwright browser.
 */
function watchForDisconnect(browser) {
  browser.on('disconnected', () => {
    page = null
    context = null
    log('browser-disconnected', 'the browser went away; POST /attach {cdp} once it is back')
  })
}

/**
 * Refuse a page-dependent call clearly when there is no page.
 *
 * A silent hang or a stack trace from inside Playwright is what this replaces:
 * the caller gets 503 and a sentence saying what to do.
 *
 * @param res - the response to answer on when there is no page.
 * @returns true when the caller should stop.
 */
function needsPage(res) {
  if (page !== null) return false
  send(res, 503, {
    ok: false,
    error: 'no page: the browser was closed or restarted. POST /attach to reconnect, or start it again with test/tools/start-chrome-agent.cmd',
  })
  return true
}

async function main() {
  mkdirSync(PROFILE, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })

  // WHICH browser — and why there are two paths.
  //
  // Playwright cannot LAUNCH a browser from here: it speaks CDP over a pipe
  // (`--remote-debugging-pipe`), and a piped-stdio child is denied in this
  // sandbox (`spawn EPERM`, call log included the flag).  And Chromium cannot
  // even run CONFINED at all — its multi-process Mojo IPC needs a NAMED PIPE,
  // which the sandbox denies (measured:
  // `FATAL:mojo/public/cpp/platform/platform_channel.cc … 拒绝访问 (0x5)`), so
  // the browser dies before it can show a page.
  //
  // What works: let the browser run OUTSIDE the sandbox and attach over TCP.
  // `connectOverCDP` is a WebSocket client — no child process, no pipe — and
  // loopback is reachable from here (measured).  Two ways to get the browser:
  //   * the human double-clicks test/tools/start-agent-browser.cmd (no permissions needed)
  //   * this driver starts it (`--launch`) with stdio:'ignore' +
  //     --remote-debugging-port, which needs the wider sandbox mode.
  const cdpUrl = arg('cdp', 'http://127.0.0.1:9222')
  cdpTarget = cdpUrl
  const wantLaunch = process.argv.includes('--launch')
  const browser = await attachOrLaunch(cdpUrl, wantLaunch)
  context = browser.contexts()[0] ?? (await browser.newContext())
  page = context.pages()[0] ?? (await context.newPage())
  attach(page)
  watchForDisconnect(browser)
  log('ready', { via: cdpUrl, launched: wantLaunch, pages: context.pages().length })

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/status') {
        return send(res, 200, {
          ok: true,
          url: page.url(),
          title: await page.title(),
          consoleErrors: consoleErrors.length,
          pageErrors: pageErrors.length,
          failedRequests: failedRequests.length,
          watched,
          recent: events.slice(-12),
        })
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        return send(res, 200, { ok: true, events, consoleErrors, pageErrors, failedRequests })
      }
      if (req.method === 'GET' && url.pathname === '/tabs') {
        // A read, so it belongs above the POST-only guard below.  (It started
        // out below it and answered 405 — the sort of thing only a real call
        // catches.)
        const pages = context.pages()
        return send(res, 200, {
          ok: true,
          tracked: page === null ? null : pages.indexOf(page),
          tabs: await Promise.all(pages.map(async (candidate, index) => ({
            index, url: candidate.url(), title: await candidate.title().catch(() => ''),
          }))),
        })
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' })
        return res.end()
      }
      const body = await readBody(req)
      if (url.pathname === '/attach') {
        // Bring the SAME long-lived job back after the human's browser went away
        // (see watchForDisconnect): the control port, the file watch and the
        // event log all survive — only the page binding is rebuilt.
        const target = String(body.cdp ?? cdpTarget)
        try {
          const reconnected = await chromium.connectOverCDP(target)
          context = reconnected.contexts()[0] ?? (await reconnected.newContext())
          page = context.pages()[0] ?? (await context.newPage())
          attach(page)
          watchForDisconnect(reconnected)
          cdpTarget = target
          log('reattached', { cdp: target, pages: context.pages().length })
          return send(res, 200, { ok: true, url: page.url(), tabs: context.pages().length })
        } catch (error) {
          return send(res, 502, { ok: false, error: `could not attach to ${target}: ${String(error?.message ?? error)}` })
        }
      }
      if (needsPage(res)) return
      if (url.pathname === '/goto') {
        await page.goto(String(body.url), { waitUntil: 'domcontentloaded', timeout: body.timeoutMs ?? 30_000 })
        return send(res, 200, { ok: true, url: page.url(), title: await page.title() })
      }
      if (url.pathname === '/reload') {
        await page.reload({ waitUntil: 'domcontentloaded' })
        return send(res, 200, { ok: true, url: page.url() })
      }
      if (url.pathname === '/eval') {
        const value = await page.evaluate(String(body.js))
        return send(res, 200, { ok: true, value })
      }
      if (url.pathname === '/click') {
        await page.click(String(body.selector), { timeout: body.timeoutMs ?? 5_000 })
        return send(res, 200, { ok: true, url: page.url() })
      }
      if (url.pathname === '/type') {
        await page.fill(String(body.selector), String(body.text ?? ''))
        return send(res, 200, { ok: true })
      }
      if (url.pathname === '/wait') {
        await page.waitForSelector(String(body.selector), { timeout: body.timeoutMs ?? 10_000 })
        return send(res, 200, { ok: true })
      }
      if (url.pathname === '/shot') {
        const name = String(body.name ?? `shot-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_')
        const file = join(SHOTS, name.endsWith('.png') ? name : `${name}.png`)
        await page.screenshot({ path: file, fullPage: body.fullPage === true })
        log('shot', file)
        return send(res, 200, { ok: true, file })
      }
      if (url.pathname === '/open') {
        const wanted = String(body.url)
        const match = String(body.match ?? 'path')
        const result = await openOrReuse(wanted, match)
        return send(res, 200, { ok: true, ...result })
      }
      if (url.pathname === '/activate') {
        const index = Number(body.index)
        const pages = context.pages()
        if (!Number.isInteger(index) || pages[index] === undefined) {
          return send(res, 404, { ok: false, error: `no tab at index ${body.index}` })
        }
        page = pages[index]
        await page.bringToFront()
        return send(res, 200, { ok: true, tab: { index, url: page.url() } })
      }
      if (url.pathname === '/watch') {
        await startWatcher(Array.isArray(body.paths) ? body.paths : [])
        return send(res, 200, { ok: true, watched })
      }
      return send(res, 404, { ok: false, error: `no such endpoint: ${url.pathname}` })
    } catch (error) {
      log('control-error', String(error?.message ?? error))
      return send(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  console.log(`browser-driver: http://127.0.0.1:${port}/ (pid ${process.pid}, watching ${watched.length} file(s))`)

  const goTo = arg('goto')
  if (goTo !== undefined) {
    await page.goto(goTo, { waitUntil: 'domcontentloaded' }).catch((error) => log('goto-failed', String(error?.message ?? error)))
  }
  const watch = process.argv.filter((value, index) => process.argv[index - 1] === '--watch')
  if (watch.length > 0) await startWatcher(watch)

  // Nothing else to do: the window stays until the job is killed, and every
  // action arrives over the control channel.
  writeFileSync(join(ENV, 'browser', '.driver-control.json'), `${JSON.stringify({ port, pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
}

await main()
