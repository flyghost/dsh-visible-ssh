/**
 * 浏览器级端到端检查：起一个**真的** DSH web 宿主 —— 本仓库自带的那份
 * （`test/env/host/node_modules/@deepseek-ai/dsh`）—— 在**真的 HTTP** 上过它自己的
 * token 栅栏，再读回我们插件真挂在上面的那几条路由；如果共享浏览器正跑着，
 * 最后让**真的**浏览器把面板渲染出来，从 DOM 里读回每一行会话。
 *
 *   SSH_HOST=… SSH_USER=… [SSH_PORT=…] [SSH_PASSWORD=…] node test/own-host-check.mjs
 *   VISIBLE_SSH_USE_REPO_CONFIG=1 node test/own-host-check.mjs   （明说就用本仓那份配置）
 *   DSH_HOME=… DSH_DRIVER=http://127.0.0.1:7743 node test/own-host-check.mjs
 *
 * **宿主只对着隔离的 development home 起**（默认 `test/env/home`）。指着
 * 操作者真实的 `~/.dsh` 会被**拒绝运行**：那里面有他的工作区、会话历史、设置与
 * 凭据，测试宿主读它已经越界，而面板一加载就还会往里写 —— 这正是第一次跑这一套
 * 时发生的事（浏览器里看到的是**桌面应用的历史会话**，因为 `DSH_HOME` 默认成了
 * `~/.dsh`）。规矩在根 AGENTS.md「起宿主做测试」一节。
 *
 * 连接与主机凭据同理，**没有隐式来源**：凭据只从 `SSH_HOST`/`SSH_USER`（可选
 * `SSH_PORT`/`SSH_PASSWORD`）或 `VISIBLE_SSH_USE_REPO_CONFIG=1` 来（见
 * `test/lib/live-credentials.mjs`），profile 只从当场给的那份凭据或隔离 home 里已有的
 * 那条来。都没有就 skip 并说出怎么给 —— 而不是顺手读一次操作者真实的连接存储，
 * 也不是让引擎自己"向上找"到仓里那份 `scripts/config/host.toml`。
 *
 * 需要手动开启，不属于 `npm test`：它要 `test/env/host` 里真的装着那套
 * DSH、要一个把本插件挂进去的 web profile（隔离 home 的
 * `profiles/web/package.json`）、要一台可达的远端主机（`list` 动作真的去 SSH）；
 * 浏览器那一半还要共享浏览器和它的 driver 在跑 —— 见 `plugin/AGENTS.md`（这一层的规矩都在那儿）。
 *
 * 它买到的东西正是密闭套件伪造掉的那一层：
 *   * 密闭层拿假的 req/res 证明路由会答什么；这里证明它们真的挂在**宿主**的
 *     HTTP 面上，而且宿主的 token 栅栏真的挡在它们前面。
 *   * 密闭层拿假的 fetch/hook 证明面板会渲染成什么；这里让真浏览器渲染。
 *   * 还有一件两者都答不了的：**桌面宿主的门和自带 web 宿主的门不是一道门**
 *     —— 桌面宿主对外部浏览器一律 403（`x-dsh-desktop-renderer`），自带 web
 *     宿主只要求它自己打印的那个 token。这一条曾经花掉一整个会话。
 *
 * 只调只读动作：`open` 会在操作者屏幕上弹终端窗口，`kill` 会毁掉正在被照着的
 * pane —— 两个都**故意**不调。这几条读路由也都不写操作者的连接存储。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { CONNECTION_ROUTE_PATH, SESSIONS_ROUTE_PATH } from '../plugin/lib/routes/index.js'

import { liveCredentials } from './lib/live-credentials.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BIN = join(HERE, 'env', 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
// `DSH_HOME` 常常是**别人替我们设好的**：桌面宿主把自己的家透给子进程，于是天真的
// `process.env.DSH_HOME ?? DEV_HOME` 会一声不响地对着操作者真实的家起宿主 —— 那正是
// 第一次跑这一套时发生的事（浏览器里出现的是**桌面应用的历史会话**）。所以这里只把
// 继承来的值当线索、不当命令：真实的家永远被忽略；要另指一个隔离 home，用
// `DSH_OWN_HOST_HOME`（或一个**不是**真实家的 `DSH_HOME`）。
const REAL_HOME = resolve(join(homedir(), '.dsh'))
const DEV_HOME = join(HERE, 'env', 'home')
const INHERITED_HOME = process.env.DSH_HOME === undefined || process.env.DSH_HOME === '' ? null : resolve(process.env.DSH_HOME)
const ASKED_HOME = process.env.DSH_OWN_HOST_HOME !== undefined && process.env.DSH_OWN_HOST_HOME !== ''
  ? resolve(process.env.DSH_OWN_HOST_HOME)
  : (INHERITED_HOME !== null && INHERITED_HOME !== REAL_HOME ? INHERITED_HOME : null)
const DSH_HOME = ASKED_HOME ?? resolve(DEV_HOME)
const IGNORED_HOME = ASKED_HOME === null && INHERITED_HOME !== null ? INHERITED_HOME : null
const TMP = join(HERE, 'env', 'tmp', 'own-host')
const LOG = join(TMP, 'host.log')

// 前提条件缺失时**说出来并停下**（像 boot-graph.mjs 那样），而不是崩掉：在别的
// 机器上没装东西是环境的事实，不是这个插件的失败。
if (!existsSync(BIN)) {
  console.log(JSON.stringify({ skipped: `no DSH checkout at ${BIN} — build the test environment first: node test/tools/setup-env.mjs (see test/README.md)` }, null, 2))
  process.exit(0)
}
if (DSH_HOME === REAL_HOME || DSH_HOME.startsWith(REAL_HOME + sep)) {
  console.log(JSON.stringify({
    skipped: `DSH_OWN_HOST_HOME points at the operator's real ${REAL_HOME} — this check boots a host inside it, which would read his workspaces, session history, settings and credentials and write to his storages. Point it at an isolated development home instead (default: ${DEV_HOME}; recipe: AGENTS.md「起宿主做测试」).`,
  }, null, 2))
  process.exit(0)
}
const PROFILE = join(DSH_HOME, 'profiles', 'web', 'package.json')
if (!existsSync(PROFILE) || !readFileSync(PROFILE, 'utf8').includes('dsh-visible-ssh')) {
  console.log(JSON.stringify({ skipped: `the web profile at ${PROFILE} does not mount dsh-visible-ssh, so the host would boot without our routes (recipe: AGENTS.md「起宿主做测试」— rebuild the dev home with: node test/tools/setup-env.mjs --force)` }, null, 2))
  process.exit(0)
}

/**
 * 这条检查必须有一条**激活的** profile 才谈得上（面板的 `{action:'list'}` 只在有
 * 激活 profile 时才肯去 SSH），而且引擎得知道往哪儿连。两样都**只认显式来源**：
 *
 *   1. `SSH_HOST` ＋ `SSH_USER`（可选 `SSH_PORT` / `SSH_PASSWORD`）—— 操作者当场给的：
 *      既用来种 profile，也用来生成引擎读的那份配置（`test/lib/live-credentials.mjs`）；
 *   2. 隔离 home 里已有的那一条 profile（`setup-env.mjs` 从 `test/env/home.seed/`
 *      复制来的样本，或上一次运行种下的）＋ `VISIBLE_SSH_USE_REPO_CONFIG=1` 明说就用
 *      本仓那份 `scripts/config/host.toml`。
 *
 * 两样都没有就**不种**，套件随它说的理由 skip。这里刻意不默认读真实的家（那等于让
 * 「跑一次测试」顺手读一次操作者的连接存储），也不让引擎"向上找"到仓里那份带真密码的
 * `scripts/config/host.toml`。
 *
 * 密码那条路是引擎自己接上的：`envFor()` 只在隔离 home 真的存过密码时才注入
 * `SSH_PASSWORD`，否则该键不注入。所以走第 1 条时密码在进程环境里（生成的配置里
 * 不写密码），走第 2 条时靠那份配置里的密码。
 */
const CONNECTIONS_FILE = join(DSH_HOME, 'dsh-visible-ssh', 'connections.json')

/** 读已有 store 里那条激活 profile（与它的 secrets），坏文件当空的。 */
function readStore() {
  if (!existsSync(CONNECTIONS_FILE)) return { profile: null, secrets: {} }
  try {
    const state = JSON.parse(readFileSync(CONNECTIONS_FILE, 'utf8'))
    const active = state.profiles?.find((candidate) => candidate.id === state.active) ?? state.profiles?.[0]
    const secrets = state.secrets !== null && typeof state.secrets === 'object' ? state.secrets : {}
    if (active === undefined || typeof active.host !== 'string') return { profile: null, secrets }
    return {
      profile: {
        id: active.id,
        label: active.label,
        host: active.host,
        port: active.port ?? 22,
        user: active.user,
        session: active.session ?? 'default',
      },
      secrets,
    }
  } catch {
    return { profile: null, secrets: {} }
  }
}

/** 操作者当场给的凭据 —— 有 `SSH_HOST` 和 `SSH_USER` 就算给了。 */
function connectionFromEnv() {
  if (process.env.SSH_HOST === undefined || process.env.SSH_HOST === '') return null
  if (process.env.SSH_USER === undefined || process.env.SSH_USER === '') return null
  return {
    id: 'own-host-check',
    label: 'own-host-check',
    host: process.env.SSH_HOST,
    port: Number(process.env.SSH_PORT ?? 22),
    user: process.env.SSH_USER,
    session: process.env.SSH_SESSION ?? 'default',
  }
}

const EMPTY_HOME_HINT = `no connection profile for the isolated dev home (${CONNECTIONS_FILE}), and none given on the command line. The list action only SSHs when a profile is active. Give one explicitly: SSH_HOST=<host> SSH_USER=<user> [SSH_PORT=<port>] [SSH_PASSWORD=<password>] node test/own-host-check.mjs (this also writes the config the engine reads, under test/env/tmp/) — or, to use this repository's own scripts/config/host.toml on purpose, VISIBLE_SSH_USE_REPO_CONFIG=1 (then the profile has to come from the isolated dev home).`

/** @returns 种了什么、从哪来，供报告与断言使用。 */
function seedConnection() {
  const explicit = connectionFromEnv()
  const existing = readStore()
  if (explicit === null) {
    if (existing.profile !== null) {
      return { file: CONNECTIONS_FILE, source: 'the isolated dev home', seeded: false, id: existing.profile.id, host: existing.profile.host }
    }
    return { file: null, source: null, seeded: false, id: null, host: null, why: EMPTY_HOME_HINT }
  }
  // 显式给的覆盖盘上的那一条；已经存过的密码留着，除非这次也给了 SSH_PASSWORD。
  const secrets = { ...existing.secrets }
  const password = process.env.SSH_PASSWORD
  if (typeof password === 'string' && password !== '') secrets[explicit.id] = password
  mkdirSync(dirname(CONNECTIONS_FILE), { recursive: true })
  writeFileSync(CONNECTIONS_FILE, JSON.stringify({ version: 1, active: explicit.id, profiles: [explicit], secrets }, null, 2) + '\n', 'utf8')
  return {
    file: CONNECTIONS_FILE,
    source: `SSH_HOST/SSH_USER${typeof password === 'string' && password !== '' ? '/SSH_PASSWORD' : ''}`,
    seeded: true,
    id: explicit.id,
    host: explicit.host,
  }
}
/**
 * 引擎读的那份配置：同样只认显式来源（见 `test/lib/live-credentials.mjs`）。当场给了
 * 凭据就现写一份**不含密码**的配置到 `test/env/tmp/own-host-check/`，明说用本仓那份就
 * 指过去 —— 两种都把 `HOSTCFG_ENV_CONFIG`（引擎）与 `SSH_CONFIG`（插件的
 * `connections.source()`）指向它，于是这个套件不碰操作者家目录，也不靠引擎"向上找"
 * 发现仓里那份带真密码的文件。
 */
const CREDS = liveCredentials({ name: 'own-host-check' })
if (!CREDS.ok) {
  console.log(JSON.stringify({ skipped: CREDS.why }, null, 2))
  process.exit(0)
}

const CONNECTION = seedConnection()

if (CONNECTION.id === null) {
  console.log(JSON.stringify({ skipped: CONNECTION.why }, null, 2))
  process.exit(0)
}

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
  console.log(`${condition === true ? 'ok  ' : 'FAIL'} ${name}${condition === true ? '' : ` — ${detail}`}`)
}

/** 共享浏览器的控制口：显式给的最优先，其次读 driver 留下的上一次运行记录。 */
async function findDriver() {
  const explicit = process.env.DSH_DRIVER
  let url = explicit ?? null
  if (url === null) {
    const control = join(HERE, 'env', 'browser', '.driver-control.json')
    if (!existsSync(control)) return null
    try {
      const { port } = JSON.parse(readFileSync(control, 'utf8'))
      if (typeof port !== 'number') return null
      url = `http://127.0.0.1:${port}`
    } catch {
      return null
    }
  }
  try {
    const res = await fetch(`${url}/status`)
    if (!res.ok) return null
    await res.json()
    return url
  } catch {
    return null
  }
}

/** GET 那半边。**别**拿 drive() 去读 GET 路由：它只发 POST，而 driver 的读路由
 *  认的是 GET，于是回你一句 `no such endpoint` —— 第一次跑这一套时我就把它误读成
 *  "driver 太老"，白白重启了一次 driver。 */
async function getJson(driver, path) {
  const res = await fetch(driver + path)
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.ok !== true) {
    throw new Error(`${path} → HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  }
  return body
}

/** 那个端口还在不在答。收尾用它判断自己有没有把宿主留在别人的机器上。 */
async function answers(url) {
  try {
    await fetch(`${url}/`, { redirect: 'manual', signal: AbortSignal.timeout(1_500) })
    return true
  } catch {
    return false
  }
}

async function drive(driver, path, payload) {
  const res = await fetch(driver + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.ok !== true) {
    throw new Error(`${path} → HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  }
  return body
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

let child = null
let hostExit = null
// origin/token 声明在 try 之外：收尾的 finally 要用 origin 去探端口，看自己有没有
// 把宿主留在别人的机器上。
let origin = null
let token = null
let failed
const report = {
  dshHome: DSH_HOME,
  home: {
    dev: DSH_HOME !== REAL_HOME && !DSH_HOME.startsWith(REAL_HOME + sep),
    source: process.env.DSH_OWN_HOST_HOME !== undefined && process.env.DSH_OWN_HOST_HOME !== ''
      ? 'DSH_OWN_HOST_HOME'
      : ASKED_HOME !== null ? 'DSH_HOME' : 'default dev home',
    ignored: IGNORED_HOME,
    realHome: REAL_HOME,
    seeded: CONNECTION.seeded,
    connection: CONNECTION.id,
    connectionSource: CONNECTION.source,
    host: CONNECTION.host,
    credentials: { how: CREDS.how, config: CREDS.configPath },
  },
  host: BIN,
  driver: null,
  browser: { ran: false, reason: 'not attempted' },
  log: LOG,
  checks: results,
}

try {
  // 这一条放在最前面：它是"这是个新环境"的全部证据，而且**不需要宿主活着**也能
  // 判定 —— 宿主自己起不来时，最该看的就是它。
  check(
    'isolation: the host boots a development home, never the operator\'s ~/.dsh',
    DSH_HOME !== REAL_HOME && !DSH_HOME.startsWith(REAL_HOME + sep),
    `DSH_HOME=${DSH_HOME} (real home ${REAL_HOME}${IGNORED_HOME === null ? '' : `; ignored an inherited DSH_HOME=${IGNORED_HOME}`})`,
  )

  // stdio 走**文件描述符**而不是管道：受限宿主拒绝命名管道，而管道正是它的实现
  // 方式（run.mjs 用 inherit 是同一个理由）。
  const log = openSync(LOG, 'a')
  // 宿主塞给我们的 `DSH_*` 指针指着**它的**世界（会话 id、web 地址、shell…），
  // 一个要假装自己是新环境的宿主不该继承它们；`DSH_HOME` 显式指向隔离 home。
  // 凭据同理：宿主进程与它 spawn 的引擎只按我们显式指的那份配置走。
  const childEnv = { ...process.env, DSH_HOME, ...CREDS.env }
  for (const key of ['DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL', 'DSH_PATH_DIALECT']) delete childEnv[key]
  child = spawn(process.execPath, [BIN, 'web', '--port', '0', '--no-open'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', log, log],
  })
  // 等的是 'exit' 而不是 'close'：stdio 接的是文件描述符（不是 Node 自己的流），
  // 这种情况下 'close' 可能迟迟不来 —— 第一次跑这一套时宿主明明已经死了，`close`
  // 却没触发，于是收尾把它当成"还活着"。
  child.on('exit', (code) => { hostExit = code })
  child.on('error', (error) => { hostExit = `spawn failed: ${error.message}` })

  // 端口 0 让系统挑一个空闲端口，宿主再把**它挑中的**那个连着 token 一起打印出来
  // —— 所以套件不必猜端口，也不会和操作者自己开着的宿主撞车。
  if (origin !== null) {
    // 第二次跑（同一个进程）不该带着上一次的 origin 走，防的是"改了代码忘了它"。
    throw new Error('origin was already set before boot — the boot step ran twice?')
  }
  const bootDeadline = Date.now() + 120_000
  while (Date.now() < bootDeadline) {
    await sleep(250)
    const text = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(text)
    if (match !== null) {
      origin = match[1]
      token = match[2]
      break
    }
    if (hostExit !== null) {
      throw new Error(`the host exited (${hostExit}) before printing its URL; tail: ${text.split('\n').slice(-6).join(' | ')}`)
    }
  }
  if (origin === null) throw new Error('the host never printed its URL within 120s')
  report.origin = origin

  async function call(path, { cookie, ...options } = {}) {
    const res = await fetch(origin + path, {
      redirect: 'manual',
      ...options,
      headers: {
        accept: 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
        ...(options.headers ?? {}),
      },
    })
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return { status: res.status, headers: res.headers, text, body }
  }

  // --- 栅栏 -----------------------------------------------------------------
  // 宿主先认出「谁」再让「哪个路由」跑；所以没有 token 的请求根本到不了我们的
  // 代码 —— 这条断言证明的正是那件事，而不是「我们返回了 401」。
  const bare = await call(SESSIONS_ROUTE_PATH)
  check(
    'fence: without the token, the API fence answers before our route runs',
    bare.status === 401,
    `expected 401 from the host's own fence, got ${bare.status} ${JSON.stringify(bare.body).slice(0, 120)}`,
  )
  // 路由上那个 401 是**空 body**（栅栏先答，还没轮到我们），而给人看的那句话挂在
  // HTML 入口上。这是两件事，所以两条断言分开写 —— 把「谁说的话」记混过一次。
  const entry = await call('/')
  check(
    'fence: the HTML entry tells a human which URL to reopen',
    entry.status === 401 && entry.text.includes('authentication required'),
    `expected 401 + "authentication required" on /, got ${entry.status} ${JSON.stringify(entry.text).slice(0, 160)}`,
  )

  const trade = await call(`/?token=${token}`)
  const setCookie = typeof trade.headers.getSetCookie === 'function'
    ? trade.headers.getSetCookie()
    : [trade.headers.get('set-cookie')].filter(Boolean)
  const cookie = String(setCookie[0] ?? '').split(';')[0]
  // 目的是「303 → 应用根」，但宿主对根的表达法不稳定：见过 `/`，也见过相对的 `./`。
  // 两者都指向同一个地方，所以两个都收 —— 这条断言守的是「重定向到根 ＋ 带 HttpOnly 凭据」。
  const location = trade.headers.get('location')
  check(
    'fence: the printed token trades for an http-only dsh-auth cookie',
    trade.status === 303 && (location === '/' || location === './') && cookie.startsWith('dsh-auth-') && String(setCookie[0]).includes('HttpOnly'),
    `expected 303 → / (or ./) + dsh-auth cookie, got ${trade.status} location=${location} set-cookie=${JSON.stringify(setCookie[0]).slice(0, 160)}`,
  )

  const shell = await call('/', { cookie })
  check(
    'fence: the cookie is what the browser needs for the shell',
    shell.status === 200 && shell.text.includes('__DSH_BOOT__'),
    `expected 200 + __DSH_BOOT__, got ${shell.status} bytes=${shell.text.length}`,
  )

  // --- 路由 ------------------------------------------------------------------
  const listed = await call(SESSIONS_ROUTE_PATH, { cookie })
  const localRows = Array.isArray(listed.body?.sessions) ? listed.body.sessions : null
  check(
    'panel: the local read answers without touching SSH',
    listed.status === 200 && listed.body?.ok === true && localRows !== null && localRows.length >= 1 && localRows.every((row) => typeof row.name === 'string' && row.name !== ''),
    `expected 200 + ok + ≥1 named row, got ${listed.status} ${JSON.stringify(listed.body).slice(0, 200)}`,
  )
  report.panelRead = { source: listed.body?.source ?? null, profiles: listed.body?.profiles?.length ?? null, sessions: localRows?.map((row) => row.name) ?? null }

  const connection = await call(CONNECTION_ROUTE_PATH, { cookie })
  check(
    'panel: the connection store is readable by the browser half',
    connection.status === 200 && connection.body?.ok === true && Array.isArray(connection.body?.profiles),
    `expected 200 + ok + profiles[], got ${connection.status} ${JSON.stringify(connection.body).slice(0, 200)}`,
  )

  const enumerated = await call(SESSIONS_ROUTE_PATH, {
    cookie,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list' }),
  })
  const rows = Array.isArray(enumerated.body?.sessions) ? enumerated.body.sessions : []
  const current = rows.filter((row) => row.current === true)
  check(
    'engine: list closes the loop over real SSH',
    enumerated.status === 200 && enumerated.body?.ok === true && rows.length >= 1 && rows.every((row) => row.exists === true) && current.length === 1 && current[0].name === enumerated.body?.session,
    `expected 200 + ok + rows(all exists) + exactly one current==session, got ${enumerated.status} ${JSON.stringify(enumerated.body).slice(0, 240)}`,
  )
  report.enumerated = { session: enumerated.body?.session ?? null, names: rows.map((row) => row.name) }

  // --- 浏览器（可选：共享浏览器没在跑时，这一层只是没被检验，不是失败）-----------
  const driver = await findDriver()
  report.driver = driver
  if (driver === null) {
    report.browser = { ran: false, reason: 'no shared browser driver answered on /status (set DSH_DRIVER, or start test/tools/driver.mjs — see AGENTS.md)' }
  } else if (rows.length === 0) {
    report.browser = { ran: false, reason: 'nothing was enumerated, so there is no row to look for in the DOM' }
  } else {
    try {
      await drive(driver, '/attach', { cdp: process.env.DSH_CDP ?? 'http://127.0.0.1:9222' })
      // 先记基线：driver 的事件表是整页生命周期的累积，不记基线就会把上一次运行
      // 留下的错误算到这一次头上（换页前的连通性噪声尤其多）。
      const baseline = await getJson(driver, '/status')
      await drive(driver, '/goto', { url: `${origin}/?token=${token}` })
      // 面板的事都是异步的，而且**不是一起落地的**：会话行来自挂载时那一次
      // `{action:'list'}`（约一条 SSH 往返），镜像行要等抓屏回来（另一次往返 +
      // 一次 TTL）。所以这里等的条件是两个都在，只等行就会读到「读取中…」那一帧
      // —— 那正是第一次跑这一套时踩的坑。
      let dom = ''
      const domDeadline = Date.now() + 45_000
      while (Date.now() < domDeadline) {
        await sleep(1_000)
        const read = await drive(driver, '/eval', { js: 'document.body.innerText' })
        dom = typeof read.value === 'string' ? read.value : JSON.stringify(read.value)
        if (rows.every((row) => dom.includes(`会话 ${row.name}`)) && dom.includes('session "')) break
      }
      report.browser = { ran: true, chars: dom.length, head: dom.slice(0, 400) }
      const missing = rows.map((row) => row.name).filter((name) => !dom.includes(`会话 ${name}`))
      check(
        'browser: the panel renders one row per enumerated session',
        missing.length === 0,
        `the DOM never showed 会话 ${missing.join(' / ')} (rows=${JSON.stringify(rows.map((row) => row.name))}); head=${JSON.stringify(dom.slice(0, 300))}`,
      )
      check(
        'browser: the mirror line names the session the panel is watching',
        typeof enumerated.body?.session === 'string' && dom.includes(`session "${enumerated.body.session}"`),
        `expected session "${enumerated.body?.session}" in the DOM; head=${JSON.stringify(dom.slice(0, 300))}`,
      )
      check(
        'browser: a failed enumeration is not being shown',
        !dom.includes('列出远端会话失败'),
        'the panel is showing the enumeration-failed line, so the rows above are the fallback single row',
      )
      // 宿主自己的控制台本来就有噪声（favicon、websocket 重连之类），所以这里
      // 只对一件事下断言：**这一次换页之后，没有任何一条错误提到本插件**。
      // 把宿主自己的噪声当成本插件的失败，是那种最后只好把断言删掉的假阳性；
      // 而不记基线就会把上一次运行留下的错误算到这一次头上。
      try {
        const events = await getJson(driver, '/events')
        const fresh = {
          pageErrors: (events.pageErrors ?? []).slice(baseline.pageErrors ?? 0),
          consoleErrors: (events.consoleErrors ?? []).slice(baseline.consoleErrors ?? 0),
          failedRequests: (events.failedRequests ?? []).slice(baseline.failedRequests ?? 0),
        }
        const mine = [...fresh.pageErrors, ...fresh.consoleErrors, ...fresh.failedRequests]
          // 只算**这一次**这个宿主上的条目：换页那一刻，上一次运行留下的那个页面
          // 还在拿自己的端口轮询（它已经死了），那些 ERR_CONNECTION_REFUSED 会
          // 落在基线之后，看起来像这次的错。URL 里带 origin 的才算这次的。
          .filter((entry) => JSON.stringify(entry).includes('visible-ssh') && JSON.stringify(entry).includes(origin))
        report.events = {
          ran: true,
          fresh: { pageErrors: fresh.pageErrors.length, consoleErrors: fresh.consoleErrors.length, failedRequests: fresh.failedRequests.length },
        }
        check(
          'browser: nothing about this plugin is erroring on this host',
          mine.length === 0,
          `entries mentioning visible-ssh on ${origin}: ${JSON.stringify(mine).slice(0, 300)}`,
        )
      } catch (error) {
        report.events = { ran: false, reason: `the driver has no usable /events endpoint: ${error.message}` }
      }
    } catch (error) {
      report.browser = { ran: false, reason: `the shared browser could not be driven: ${error.message}` }
    }
  }
} catch (error) {
  check('setup: the host boots and prints its token URL', false, error.message)
} finally {
  if (child !== null && hostExit === null) {
    child.kill('SIGTERM')
    const killDeadline = Date.now() + 5_000
    while (hostExit === null && Date.now() < killDeadline) await sleep(100)
    // 万一 SIGTERM 没把它带走，补一刀 —— 别让一个宿主留在那儿占着端口。
    if (hostExit === null) {
      child.kill('SIGKILL')
      const forceDeadline = Date.now() + 3_000
      while (hostExit === null && Date.now() < forceDeadline) await sleep(100)
    }
  }
  report.hostExit = hostExit
  // 端口还在答，说明真正的服务器不是这个 pid（`dsh web` 会派子进程），所以按
  // **进程树**收：一个自己起服务器的套件不该把服务器留在别人的机器上。
  if (child !== null && origin !== null && await answers(origin)) {
    if (child.pid !== undefined && process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }).on('error', () => {})
    } else if (child.pid !== undefined) {
      child.kill('SIGKILL')
    }
    const reapDeadline = Date.now() + 5_000
    while (Date.now() < reapDeadline && await answers(origin)) await sleep(200)
    report.hostStopped = !(await answers(origin))
  } else {
    report.hostStopped = true
  }
}

failed = results.filter((result) => result.ok !== true).length
// 全绿就把日志清掉；失败时留下它 —— 那份日志是唯一能说出宿主当时说了什么的东西。
// 生成的那份配置（在 test/env/tmp/own-host-check/ 下）也一起清掉：它只属于这一场。
if (failed === 0) {
  rmSync(TMP, { recursive: true, force: true })
  rmSync(join(HERE, 'env', 'tmp', 'own-host-check'), { recursive: true, force: true })
}
console.log(JSON.stringify({
  ...report,
  checks: results,
  verdict: failed === 0
    ? `OK: ${results.length} browser-level checks green${report.browser.ran ? '' : ` (browser half skipped: ${report.browser.reason})`}`
    : `FAILED: ${failed} of ${results.length} checks`,
}, null, 2))
process.exitCode = failed === 0 ? 0 : 1
