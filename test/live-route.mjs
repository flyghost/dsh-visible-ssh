/**
 * 针对浏览器路由与连接层的在线检查：真的 cordis、真的 dsh-host-webserver、
 * 真的 SSH、真的 HTTP —— 经过**真的** bridge，也就是默认那个编译出来的
 * 引擎（平台包 `packages/engine-win32-x64/visible-ssh.exe`，位置由
 * `plugin/src/engine/locate.ts` 解析）。
 *
 *   SSH_HOST=<host> SSH_USER=<user> [SSH_PORT=<port>] [SSH_PASSWORD=<password>] \
 *     node test/live-route.mjs
 *   VISIBLE_SSH_USE_REPO_CONFIG=1 node test/live-route.mjs   # 就用本仓那份配置
 *   DSH_ENGINE=python node test/live-route.mjs               # 备用引擎
 *   DSH_APP=<another DSH install> node test/live-route.mjs
 *
 * 需要手动开启，不属于 `npm test`：它需要一份带 `dsh-host-webserver` 的 DSH
 * 运行时 —— 默认就是**仓内**那份 `test/env/host`，所以本机没装过 DSH 也能跑 ——
 * 还需要一台可达的远端主机。凭据**只从上面那两行显式来源来**（见
 * `test/lib/live-credentials.mjs`）：本仓的检查不读你的家目录，也不借用哪个
 * 既有 profile；没给就跳过。它会为了其中两项检查**故意**打断那条连接，所以
 * 远端主机必须能容忍一次认证失败。
 *
 * `DSH_ENGINE` 的存在，是为了让同一个套件能证明**两个**引擎等价：M5 那次
 * 切换就是这么验证的（它也确实挣得了自己的位置 —— 第一次跑 `go` 就暴露出
 * 一个 python 那次看不见的 config 路径 bug）。
 *
 * 相比那些离线套件，它买到的东西正是它们伪造掉的那一层：
 *
 *   * 三条路由都坐在真的载体上（**三条**全在），冷突发收敛成**一次**带真实
 *     TTL 的 SSH capture，而 panel 路由在任何 SSH 连接都不开的情况下就能
 *     作答；
 *   * `test` 动作真的去连接（是状态，不是 mock）；
 *   * 以及**panel 选定的连接确实抵达引擎的证明**。保存一个指向闭端口的
 *     profile 必须让 mirror 变成 502 —— 如果注入的 `SSH_*` 环境被忽略，
 *     引擎就会用 host.toml 并回答 200。删掉这个 profile 必须让它恢复。
 *
 * 有两个 panel 动作在这里被**故意**不调用：`open` 会在操作者的屏幕上弹出
 * 终端窗口，`kill` 则会毁掉这个检查其余部分正照着的那个 pane。它们的校验
 * 路径（坏名字、未知动作）**是**被覆盖的 —— 那些根本不抵达引擎。
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

import { liveCredentials } from './lib/live-credentials.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * 这份 DSH 运行时从哪儿来：默认是装在**本仓**里的那一份（`test/env/host`，
 * 由 `test/tools/setup-env.mjs` 装上，`dsh-host-webserver` 是它的依赖），所以
 * 这个检查不要求本机装过 DSH。`DSH_APP` 仍然可以指向别的安装树 —— `mod()` 只
 * 用到它的 `node_modules`。
 */
const APP = process.env.DSH_APP ?? join(HERE, 'env', 'host')
if (!existsSync(APP)) {
  console.log(JSON.stringify({ skipped: `no DSH runtime at ${APP} — build the test environment first: node test/tools/setup-env.mjs (or point DSH_APP at another install)` }, null, 2))
  process.exit(0)
}

/**
 * 凭据：只认显式给的那两种来源（见 `test/lib/live-credentials.mjs`）。给的是
 * 环境变量那一路时，这里会把 host/port/user 现写成一份**不含密码**的配置，
 * 并把 `HOSTCFG_ENV_CONFIG`（引擎）与 `SSH_CONFIG`（插件的
 * `connections.source()`）都指过去 —— 于是这个检查既不读操作者的家目录，
 * 也不碰仓里那份带真密码的 `scripts/config/host.toml`。没给凭据就跳过。
 */
const CREDS = liveCredentials({ name: 'live-route' })
if (!CREDS.ok) {
  console.log(JSON.stringify({ skipped: CREDS.why }, null, 2))
  process.exit(0)
}
process.env.SSH_CONFIG = CREDS.env.SSH_CONFIG
process.env.HOSTCFG_ENV_CONFIG = CREDS.env.HOSTCFG_ENV_CONFIG

const mod = (relative) => pathToFileURL(join(APP, 'node_modules', relative)).href

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
}

const { Context } = await import(mod('@deepseek-ai/cordis/lib/index.js'))
const WebServer = (await import(mod('@deepseek-ai/dsh-host-webserver/lib/index.js'))).default
const { CONNECTION_ROUTE_PATH, SCREEN_ROUTE_PATH, SESSIONS_ROUTE_PATH, registerWebRoutes } = await import('../plugin/lib/routes/index.js')
const { createConnections } = await import('../plugin/lib/connection/connections.js')
const { resolveConfig } = await import('../plugin/lib/engine/config.js')
const { createEnginePort } = await import('../plugin/lib/engine/exec.js')
const { resolveEngine } = await import('../plugin/lib/engine/locate.js')

// 插件测试目录里的一次性存储：这个检查绝不能碰到操作者实际配置的那些连接。
const STORE_DIR = join(HERE, 'env', 'tmp', 'live')
const STORE = join(STORE_DIR, 'connections.json')
rmSync(STORE_DIR, { recursive: true, force: true })

const ctx = new Context()
await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
const server = ctx.get('webServer')
const origin = `http://127.0.0.1:${server.port}`
const cfg = resolveConfig({ engine: process.env.DSH_ENGINE ?? 'go' })
const connections = createConnections({ file: STORE, env: process.env, configPath: cfg.configPath })
registerWebRoutes(ctx, cfg, connections, createEnginePort(cfg))

const report = { origin, store: STORE, defaultSession: cfg.defaultSession, engine: cfg.engine, program: cfg.engine === 'python' ? cfg.pythonEntry : resolveEngine(cfg).program, credentials: { how: CREDS.how, config: CREDS.configPath } }

async function get(path, query = '') {
  const started = Date.now()
  const res = await fetch(origin + path + query, { headers: { accept: 'application/json' } })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text.slice(0, 300) }
  return { status: res.status, ms: Date.now() - started, body }
}
async function postTo(path, payload) {
  const res = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text.slice(0, 300) }
  return { status: res.status, body }
}
const post = (payload) => postTo(CONNECTION_ROUTE_PATH, payload)
/** panel 自己的动作走它自己的那条路由。 */
const panel = (payload) => postTo(SESSIONS_ROUTE_PATH, payload)
const mirror = (query = '') => get(SCREEN_ROUTE_PATH, query)

check('all three routes are registered on a real webServer', server.exact.has(SCREEN_ROUTE_PATH) && server.exact.has(CONNECTION_ROUTE_PATH) && server.exact.has(SESSIONS_ROUTE_PATH), [...server.exact.keys()])

// (a) 没有存任何 profile 时，出面服务的是 CLI 自己的 host.toml。
const overview = await get(CONNECTION_ROUTE_PATH)
report.overview = { status: overview.status, source: overview.body?.source, profiles: overview.body?.profiles }
check('the connection route reports the CLI config as the source', overview.status === 200 && overview.body.source === 'cli-config', report.overview)

// (a2) panel 路由是**本地**读：一次轮询必须不花掉任何 SSH 连接。
const panelView = await get(SESSIONS_ROUTE_PATH)
report.panel = { status: panelView.status, ms: panelView.ms, source: panelView.body?.source, sessions: panelView.body?.sessions, file: panelView.body?.file }
check('the panel route answers on the real carrier', panelView.status === 200, report.panel)
check('it names the same source the mirror does', panelView.body?.source === 'cli-config', report.panel)
check('its row carries the active session and claims nothing about it', panelView.body?.sessions?.length === 1 && panelView.body.sessions[0].name === cfg.defaultSession && panelView.body.sessions[0].exists === null, report.panel)
check('and it answers fast enough to prove no SSH happened', panelView.ms < 250, report.panel)

const panelBadSession = await panel({ action: 'open', session: 'a b' })
check('a panel action with an unusable session name is a 400', panelBadSession.status === 400 && panelBadSession.body?.error?.kind === 'bad-session', panelBadSession)
const panelGhost = await panel({ action: 'activate', id: 'ghost' })
check('activating a profile that does not exist is a 404', panelGhost.status === 404, panelGhost)
const panelBadAction = await panel({ action: 'explode' })
check('an unknown panel action is a 400', panelBadAction.status === 400 && panelBadAction.body?.error?.kind === 'bad-action', panelBadAction)

// (b) 冷突发：三个并发读者，背后只有一次 SSH capture。
const burst = await Promise.all([mirror(), mirror(), mirror()])
report.coldBurst = {
  statuses: burst.map((r) => r.status),
  ms: burst.map((r) => r.ms),
  shared: burst.map((r) => r.body?.shared),
  connection: burst[0].body?.connection,
  // 失败的原因必须进报告：没有它，这里的 502 就是一个要花掉一整场调试才
  // 解得开的谜（切引擎时吃过这个亏）。
  errorKinds: burst.map((r) => r.body?.error?.kind),
  error: burst[0].body?.error,
}
check('every reader in the cold burst got a 200', burst.every((r) => r.status === 200), report.coldBurst)
check('the burst ran exactly one live capture', burst.filter((r) => r.body?.cached !== true && r.body?.shared !== true).length === 1, report.coldBurst)
check('the other readers shared that capture', burst.filter((r) => r.body?.shared === true).length === 2, report.coldBurst)
check('the mirror names the connection it mirrors (the CLI config)', burst[0].body?.connection?.source === 'cli-config', report.coldBurst.connection)

const screen = typeof burst[0].body?.screen === 'string' ? burst[0].body.screen : ''
report.capture = { session: burst[0].body?.session, geometry: [burst[0].body?.width, burst[0].body?.height], lastLine: burst[0].body?.lastLine, tail: screen.split('\n').slice(-4) }
check('the answer carries a real pane from the engine', burst[0].body?.exists === true, report.capture)

// (c) TTL 确实在当缓存用，而且快到足以证明没有发生 SSH。
const warm = await mirror()
report.insideTtl = { status: warm.status, ms: warm.ms, cached: warm.body?.cached }
check('a second read inside the TTL is served from cache', warm.body?.cached === true, report.insideTtl)
check('and it is fast enough to prove no SSH happened', warm.ms < 250, report.insideTtl)

// (d) test 动作真的去连接。
const tested = await post({ action: 'test' })
report.test = { status: tested.status, test: tested.body?.test }
check('the test action connects for real', tested.status === 200 && tested.body?.test?.ok === true, report.test)

// (e) panel 选定的连接必须抵达引擎：把它指向一个闭端口。
const saved = await post({ action: 'save', profile: { id: 'bogus', host: '127.0.0.1', port: 1, user: 'nobody', session: 'default' }, password: 'not-the-real-one' })
report.saved = { status: saved.status, saved: saved.body?.saved, source: saved.body?.source, active: saved.body?.active, profiles: saved.body?.profiles }
check('a profile saves and becomes active', saved.status === 200 && saved.body.active === 'bogus' && saved.body.source === 'profile', report.saved)
check('the saved profile reports a stored password without revealing it', saved.body.profiles?.[0]?.hasPassword === true && !JSON.stringify(saved.body).includes('not-the-real-one'), report.saved)

const hijacked = await mirror()
report.hijacked = { status: hijacked.status, error: hijacked.body?.error, connection: hijacked.body?.connection }
check('the mirror now follows the profile, and fails to reach it', hijacked.status === 502, report.hijacked)
check('so the injected environment really did override host.toml', hijacked.status === 502 && typeof hijacked.body?.error?.message === 'string' && hijacked.body.error.message.length > 0, report.hijacked)
check('the failure names the profile it was pointed at', hijacked.body?.connection?.id === 'bogus', hijacked.body?.connection)

const bogusTest = await post({ action: 'test', id: 'bogus' })
report.bogusTest = { status: bogusTest.status, test: bogusTest.body?.test }
check('a failing test is still a 200 with the engine\'s words', bogusTest.status === 200 && bogusTest.body?.test?.ok === false, report.bogusTest)

// (f) 删掉它就恢复了 CLI config 那条路径。
const removed = await post({ action: 'remove', id: 'bogus' })
report.removed = { status: removed.status, source: removed.body?.source, profiles: removed.body?.profiles }
check('removing the profile returns to the CLI config', removed.status === 200 && removed.body.source === 'cli-config', report.removed)
const restored = await mirror()
report.restored = { status: restored.status, cached: restored.body?.cached, session: restored.body?.session, connection: restored.body?.connection }
check('and the mirror reaches the real host again', restored.status === 200, report.restored)
check('the cache did not carry the other host\'s answer over', restored.body?.connection?.source === 'cli-config', report.restored)

// (g) 绝不能生成任何进程的输入。
const badSession = await mirror('?session=' + encodeURIComponent('a b'))
const posted = await fetch(origin + SCREEN_ROUTE_PATH, { method: 'POST' })
const wrongMethod = { status: posted.status, allow: posted.headers.get('allow') }
const badAction = await post({ action: 'explode' })
report.rejections = { badSession: badSession.status, screenMethod: wrongMethod, badAction: badAction.status }
check('an unusable session name is a 400', badSession.status === 400 && badSession.body?.error?.kind === 'bad-session', report.rejections)
check('the mirror refuses another method with Allow: GET', wrongMethod.status === 405 && wrongMethod.allow === 'GET', report.rejections)
check('an unknown connection action is a 400', badAction.status === 400 && badAction.body?.error?.kind === 'bad-action', report.rejections)

// 关掉载体，让事件循环自己排空：在这里调用 `process.exit()` 会在监听 socket
// 正关到一半时打断 libuv 的异步收尾，于是一次本该成功的运行会被报成失败。
await new Promise((resolve) => { server.server.close(() => resolve()) })
rmSync(STORE_DIR, { recursive: true, force: true })
// 这次跑生成的那份配置也一起清掉：它只属于这一场。
rmSync(join(HERE, 'env', 'tmp', 'live-route'), { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed,
  report,
  verdict: failed.length === 0 ? 'OK: the live routes behave as documented' : 'FAILURES above',
}, null, 2))
process.exitCode = failed.length === 0 ? 0 : 1
