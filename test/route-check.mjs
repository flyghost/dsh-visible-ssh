// 宿主半的浏览器镜像（src/routes/index.js）的离线检查：不需要 DSH、不需要 SSH、
// 不需要目标主机。整条请求路径都由假的 req/res 对象、一个注入的 `load` 和一个
// 内存引擎端口（engine/fake.js）驱动 —— 这也正是 createScreenHandler 把抓屏
// 函数作为参数收进来、而不是自己去够引擎端口的原因。
//
// 这里值得证明的东西，以及为什么：
//   * TTL 确实复用了抓屏结果，并且会过期                   （SSH 开销）
//   * 两个并发读只跑一次抓屏                               （SSH 开销）
//   * 失败不会被缓存，所以下一个 tick 会重试               （面板体验）
//   * 每个状态码都可达：200 / 400 / 405 / 403 / 500 / 502
//   * session 校验在 `load` 被调用之前就拒绝
//   * 注册打在确切的路径上，并且在 dispose 之后仍然成立
//   * 面板路由**不**读任何远端事实（一次轮询绝不该花掉一条 SSH
//     连接），并把 open/kill 原样转发给引擎自己的 verb
import {
  CONNECTION_ROUTE_PATH,
  MAX_SESSION_LENGTH,
  SCREEN_ROUTE_PATH,
  SESSIONS_ROUTE_PATH,
  createScreenCache,
  createScreenHandler,
  createSessionsHandler,
  parseSession,
  registerWebRoutes,
} from '../plugin/lib/routes/index.js'
import { projectCapture } from '../plugin/lib/engine/project.js'
import { createFakeEngine } from '../plugin/lib/engine/fake.js'

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// --- 测试夹具 -------------------------------------------------------------
const CFG = Object.freeze({
  defaultSession: 'default',
  screenTtlMs: 300,
  screenTimeoutMs: 20_000,
})

/** CLI 的 `capture --json` 打印出来的信封，字段最少但形状忠实。 */
function envelope(session, lines) {
  return {
    ok: true,
    session,
    exists: true,
    lines,
    width: 80,
    height: 24,
    cursor_x: 12,
    cursor_y: 3,
    last_line: lines[lines.length - 1],
  }
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    ended: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    end(body) { this.body = body ?? ''; this.ended = true },
    json() { return this.body === '' ? null : JSON.parse(this.body) },
  }
}
const req = (method, url) => ({ method, url, headers: { host: '127.0.0.1:43120' } })

// --- session 校验 ---------------------------------------------------------
eq('session: default when absent', parseSession(null, 'default'), { ok: true, session: 'default' })
eq('session: plain name', parseSession('proj-a', 'default'), { ok: true, session: 'proj-a' })
eq('session: tmux punctuation allowed', parseSession('a.b:c@d+e-f_1', 'default').ok, true)
check('session: leading dash refused', parseSession('-rf', 'default').ok === false)
check('session: spaces refused', parseSession('a b', 'default').ok === false)
check('session: shell metacharacters refused', parseSession('a;rm -rf /', 'default').ok === false)
check('session: over-long refused', parseSession('a'.repeat(MAX_SESSION_LENGTH + 1), 'default').ok === false)
check('session: max length accepted', parseSession('a'.repeat(MAX_SESSION_LENGTH), 'default').ok === true)
const badFallback = parseSession(null, 'bad name')
check('session: bad configured default is flagged as config', badFallback.ok === false && badFallback.fromConfig === true, badFallback)

// --- TTL 缓存 -------------------------------------------------------------
{
  let clock = 1_000
  let loads = 0
  const cache = createScreenCache({
    ttlMs: 300,
    now: () => clock,
    load: async (session) => { loads += 1; return { session, mark: loads } },
  })

  const first = await cache.read('default')
  eq('cache: first read is a live capture', [first.cached, first.shared, loads], [false, false, 1])

  clock += 100
  const hit = await cache.read('default')
  eq('cache: inside TTL is a cache hit', [hit.cached, hit.ageMs, loads], [true, 100, 1])
  eq('cache: hit returns the same value', hit.value.mark, 1)

  clock += 300
  const expired = await cache.read('default')
  eq('cache: at TTL the capture runs again', [expired.cached, loads], [false, 2])

  const other = await cache.read('proj-a')
  eq('cache: keys are per session', [other.value.session, loads], ['proj-a', 3])
}

// --- 单飞（并发合并）+ 失败如实上报 ---------------------------------------
{
  let loads = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const cache = createScreenCache({
    ttlMs: 300,
    load: async (session) => { loads += 1; await gate; return { session } },
  })
  // 两次读都在抓屏可能结束之前就发起了，所以第二次**必须**找到第一次那个
  // 尚在飞行中的 promise，而不是自己再起一次。
  const first = cache.read('default')
  const second = cache.read('default')
  await Promise.resolve()
  eq('single-flight: two concurrent reads run one capture', loads, 1)
  release()
  const [a, b] = await Promise.all([first, second])
  eq('single-flight: the loader is not cached, the joiner is shared', [[a.cached, a.shared], [b.cached, b.shared]], [[false, false], [false, true]])
  const later = await cache.read('default')
  eq('single-flight: once it lands, the TTL serves it without the CLI', [later.cached, later.shared, loads], [true, false, 1])
}
{
  let loads = 0
  const cache = createScreenCache({
    ttlMs: 300,
    load: async () => { loads += 1; throw Object.assign(new Error('ssh refused'), { kind: 'spawn' }) },
  })
  let kind = null
  try { await cache.read('default') } catch (error) { kind = error.kind }
  eq('failure: propagates with its kind', kind, 'spawn')
  try { await cache.read('default') } catch { /* 预期内 */ }
  eq('failure: is not cached', loads, 2)
}

// --- handler：完整请求路径 ------------------------------------------------
function handlerFor({ load, connection, cfg = CFG }) {
  return createScreenHandler({ cfg, load, connection })
}

{
  const seen = []
  const { handle } = handlerFor({
    load: async (session) => { seen.push(session); return projectCapture(envelope(session, ['me@lan-box:/opt $ ls', 'docs  plugin'])) },
  })

  const ok = fakeRes()
  await handle(req('GET', SCREEN_ROUTE_PATH), ok)
  eq('route: GET with no query answers 200', ok.statusCode, 200)
  const body = ok.json()
  eq('route: body is the canonical capture value', [body.ok, body.session, body.lineCount, body.cursorX], [true, 'default', 2, 12])
  eq('route: screen is the joined lines', body.screen, 'me@lan-box:/opt $ ls\ndocs  plugin')
  eq('route: the CLI was asked for the configured default', seen, ['default'])
  eq('route: headers are JSON and no-store', [ok.headers['content-type'], ok.headers['cache-control']], ['application/json; charset=utf-8', 'no-store'])

  const named = fakeRes()
  await handle(req('GET', `${SCREEN_ROUTE_PATH}?session=proj-a`), named)
  eq('route: ?session is honoured', named.json().session, 'proj-a')

  const missing = fakeRes()
  await handle(req('GET', SCREEN_ROUTE_PATH), missing)
  eq('route: a second call inside the TTL is a cache hit', missing.json().cached, true)
}

{
  // 两台主机可以各有一个 `default` session，所以切换连接之后**绝不能**把
  // 另一台机器的画面从 TTL 缓存里端出来。
  const envs = []
  let activeId = 'alpha'
  const connections = {
    file: 'connections.json',
    active: async () => ({ id: activeId, label: activeId, host: activeId + '.local', port: 22, user: 'u', session: 'default' }),
    activeId: async () => activeId,
    envFor: async (id) => ({ SSH_HOST: (id ?? activeId) + '.local' }),
    source: async () => 'profile',
    list: async () => ({ active: activeId, profiles: [] }),
  }
  const handler = createScreenHandler({
    cfg: CFG,
    connections,
    load: async (session, env) => { envs.push(env.SSH_HOST); return projectCapture(envelope(session, ['x'])) },
  })
  const first = fakeRes()
  await handler.handle(req('GET', SCREEN_ROUTE_PATH), first)
  const second = fakeRes()
  await handler.handle(req('GET', SCREEN_ROUTE_PATH), second)
  eq('cache: one connection and session is a cache hit', second.json().cached, true)

  activeId = 'beta'
  const third = fakeRes()
  await handler.handle(req('GET', SCREEN_ROUTE_PATH), third)
  eq('cache: another connection with the same session name is NOT a hit', third.json().cached, false)
  eq('cache: each capture went to the connection it was keyed for', envs, ['alpha.local', 'beta.local'])
  eq('cache: the answer names the connection it came from', [first.json().connection.id, third.json().connection.id], ['alpha', 'beta'])
}

{
  const { handle } = handlerFor({ load: async () => { throw new Error('must not run') } })

  const bad = fakeRes()
  await handle(req('GET', `${SCREEN_ROUTE_PATH}?session=${encodeURIComponent('a b')}`), bad)
  eq('route: an unusable session is 400', [bad.statusCode, bad.json().error.kind], [400, 'bad-session'])

  const posted = fakeRes()
  await handle(req('POST', SCREEN_ROUTE_PATH), posted)
  eq('route: POST is 405 with an Allow header', [posted.statusCode, posted.headers.allow, posted.body], [405, 'GET', ''])

  const configWrong = createScreenHandler({
    cfg: { ...CFG, defaultSession: 'not a name' },
    load: async () => { throw new Error('must not run') },
  })
  const broken = fakeRes()
  await configWrong.handle(req('GET', SCREEN_ROUTE_PATH), broken)
  eq('route: a bad configured default is 500, not the client\'s fault', [broken.statusCode, broken.json().error.kind], [500, 'bad-config'])
}

{
  const { handle } = handlerFor({
    load: async (session) => projectCapture({ ok: true, session, exists: false, lines: [] }),
  })
  const gone = fakeRes()
  await handle(req('GET', SCREEN_ROUTE_PATH), gone)
  const body = gone.json()
  eq('route: a missing session is still 200 with exists=false', [gone.statusCode, body.ok, body.exists, body.screen], [200, true, false, ''])
}

{
  let loads = 0
  const { handle } = handlerFor({
    load: async () => {
      loads += 1
      throw Object.assign(new Error('the CLI printed no JSON (exit 1)'), { kind: 'protocol' })
    },
  })
  const failed = fakeRes()
  await handle(req('GET', SCREEN_ROUTE_PATH), failed)
  eq('route: a capture failure is 502 with the bridge kind', [failed.statusCode, failed.json().error.kind, loads], [502, 'protocol', 1])
  const retry = fakeRes()
  await handle(req('GET', SCREEN_ROUTE_PATH), retry)
  eq('route: the panel\'s next tick retries', loads, 2)
}

{
  // Host/Origin 这道栅栏归 composition 的 connection 服务管；它缺席时
  // （那些偏 headless 的 composition）路由**仍然**必须作答，而它一旦拒绝，
  // 就绝不能让任何东西到达 CLI。
  let loads = 0
  const rejecting = handlerFor({
    load: async () => { loads += 1; return projectCapture(envelope('default', ['x'])) },
    connection: () => ({ requestRejection: () => 403 }),
  })
  const fenced = fakeRes()
  await rejecting.handle(req('GET', SCREEN_ROUTE_PATH), fenced)
  eq('route: the connection fence answers first', [fenced.statusCode, fenced.body, loads], [403, '', 0])

  const allowing = handlerFor({
    load: async () => { loads += 1; return projectCapture(envelope('default', ['x'])) },
    connection: () => ({ requestRejection: () => undefined }),
  })
  const passed = fakeRes()
  await allowing.handle(req('GET', SCREEN_ROUTE_PATH), passed)
  eq('route: an accepting fence lets the capture through', [passed.statusCode, loads], [200, 1])
}

// --- 注册 -----------------------------------------------------------------
function fakeCtx({ withWebServer }) {
  const calls = { effects: [], injected: [], registered: [], disposed: [], collected: [] }
  const webServer = {
    register(route) {
      calls.registered.push({ kind: route.kind, path: route.path, handler: typeof route.handler })
      return () => calls.disposed.push(route.path)
    },
  }
  // `effect` 在这里模拟的是真正要紧的那条契约：函数体现在就执行，它 yield 出
  // 的每个值都被收集起来，当作日后卸载时的 disposer。mount 是个生成器
  // （每 yield 一次给一条路由），真实的 fiber 就是这么收下它们的。
  const effect = (fn, label) => {
    calls.effects.push(label)
    const produced = fn()
    if (typeof produced === 'function') {
      calls.collected.push(produced)
    } else if (produced !== null && typeof produced === 'object' && Symbol.iterator in produced) {
      for (const dispose of produced) calls.collected.push(dispose)
    } else {
      throw new TypeError('Invalid effect')
    }
    return () => { for (const dispose of calls.collected.splice(0).reverse()) dispose() }
  }
  const scope = { webServer, effect }
  const ctx = {
    get(name) { return withWebServer === true && name === 'webServer' ? webServer : undefined },
    effect,
    inject(deps, callback) { calls.injected.push(deps.join(',')); callback(scope) },
  }
  // 真实的 ctx 会把注入进来的服务暴露成属性；这个假货也必须如此，否则
  // `mount` 在直连那条路径上会把 `ctx.webServer` 读成 undefined。
  if (withWebServer === true) ctx.webServer = webServer
  ctx.calls = calls
  return ctx
}

/** 交给这些路由的 connection 面；「什么都没配置」也是其中一种情况。 */
const CONNECTIONS = {
  file: 'connections.json',
  active: async () => null,
  activeId: async () => null,
  envFor: async () => ({}),
  source: async () => 'cli-config',
  list: async () => ({ active: null, profiles: [] }),
}

/** 交给这些路由的引擎端口：这些检查只碰路由，不碰真 CLI。 */
const ENGINE = createFakeEngine()

{
  const ctx = fakeCtx({ withWebServer: true })
  registerWebRoutes(ctx, CFG, CONNECTIONS, ENGINE)
  eq('register: the carrier is used directly when present', ctx.calls.injected, [])
  eq('register: one exact route per browser path', ctx.calls.registered.map((route) => route.path), [SCREEN_ROUTE_PATH, CONNECTION_ROUTE_PATH, SESSIONS_ROUTE_PATH])
  eq('register: both routes are exact', ctx.calls.registered.map((route) => route.kind), ['exact', 'exact', 'exact'])
  eq('register: the effect is labelled once', ctx.calls.effects, ['dsh-visible-ssh: browser routes'])
  eq('register: the effect yields one disposer per route', ctx.calls.collected.length, 3)
  for (const dispose of ctx.calls.collected) dispose()
  eq('register: unloading removes both routes', ctx.calls.disposed, [SCREEN_ROUTE_PATH, CONNECTION_ROUTE_PATH, SESSIONS_ROUTE_PATH])
}
{
  const ctx = fakeCtx({ withWebServer: false })
  registerWebRoutes(ctx, CFG, CONNECTIONS, ENGINE)
  eq('register: without a carrier it waits on webServer', ctx.calls.injected, ['webServer'])
  eq('register: and still registers every route once the carrier appears', ctx.calls.registered.length, 3)
  eq('register: through that fiber\'s own effect', ctx.calls.effects, ['dsh-visible-ssh: browser routes'])
}

// --- 面板的 session 路由 --------------------------------------------------
{
  // 这个假门面自己记住"当前那条 profile 干活用的 session"，好让 `action: 'session'`
  // 之后的刷新是真的刷新过（而不是路由把请求原样回显）。
  let currentSession = 'default'
  const faces = {
    file: '/tmp/connections.json',
    source: async () => 'profile',
    activeId: async () => 'me',
    active: async () => ({ id: 'me', label: 'LAN box', host: 'lan-box.local', port: 22, user: 'me', session: currentSession }),
    envFor: async () => ({ SSH_HOST: 'lan-box.local' }),
    activate: async (id) => ({ ok: id === 'me', active: id }),
    setSession: async (session) => {
      if (typeof session !== 'string' || session === '') return { ok: false, message: 'session must be a non-empty string' }
      if (session === 'rejected') return { ok: false, message: 'the store said no' }
      currentSession = session
      return { ok: true, session }
    },
    list: async () => ({
      active: 'me',
      profiles: [{ id: 'me', label: 'LAN box', host: 'lan-box.local', port: 22, user: 'me', session: currentSession }],
    }),
  }
  const cli = []
  const runCli = async (argv, env) => {
    cli.push({ argv, env })
    if (argv.includes('watch')) {
      return { ok: true, session: 'default', target: 'me@lan-box.local', title: 'LAN box · AI session', tmux_command: 'tmux …' }
    }
    if (argv.includes('list')) {
      return {
        ok: true, session: 'default', exists: true,
        sessions: [{ name: 'default', attached: 1, windows: 1, current: true }],
      }
    }
    return { ok: true, session: 'default', killed: true }
  }
  const handler = createSessionsHandler({ cfg: CFG, connections: faces, runCli })
  const post = (payload, extra = {}) => ({
    method: 'POST',
    url: SESSIONS_ROUTE_PATH,
    headers: { host: '127.0.0.1:43120', 'content-type': 'application/json', ...extra },
    async *[Symbol.asyncIterator]() { yield Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)) },
  })

  const listed = fakeRes()
  await handler.handle(req('GET', SESSIONS_ROUTE_PATH), listed)
  const view = listed.json()
  eq('panel: GET answers 200 with the active host', [listed.statusCode, view.active], [200, { id: 'me', label: 'LAN box', target: 'me@lan-box.local:22', session: 'default' }])
  eq('panel: it offers the profiles the selector renders', view.profiles, [{ id: 'me', label: 'LAN box', target: 'me@lan-box.local:22', session: 'default', active: true }])
  eq('panel: the row carries the name and NO existence claim', view.sessions, [{ name: 'default', exists: null }])
  eq('panel: it names the file an unconfigured panel would edit', view.file, '/tmp/connections.json')
  // 拆开这两件事的全部意义就在这里：一次轮询**绝不**该打开一条 SSH 连接。
  eq('panel: GET runs no CLI verb at all', cli.length, 0)

  const opened = fakeRes()
  await handler.handle(post({ action: 'open', session: 'default' }), opened)
  eq('panel: open answers 200 with the engine\'s own window facts', [opened.statusCode, opened.json().opened], [200, { session: 'default', target: 'me@lan-box.local', title: 'LAN box · AI session', tmuxCommand: 'tmux …' }])
  eq('panel: open is the engine\'s watch verb, with the profile env', cli.at(-1), { argv: ['--session', 'default', 'watch', '--json'], env: { SSH_HOST: 'lan-box.local' } })

  const killed = fakeRes()
  await handler.handle(post({ action: 'kill', session: 'default' }), killed)
  eq('panel: kill answers 200 with the engine\'s own result', [killed.statusCode, killed.json().killed], [200, { session: 'default', killed: true }])
  eq('panel: kill is the engine\'s down verb', cli.at(-1).argv, ['--session', 'default', 'down', '--json'])

  const unnamed = fakeRes()
  await handler.handle(post({ action: 'open' }), unnamed)
  eq('panel: a nameless open uses the active host\'s session', [unnamed.statusCode, cli.at(-1).argv[1]], [200, 'default'])

  const badName = fakeRes()
  await handler.handle(post({ action: 'kill', session: 'a;rm -rf /' }), badName)
  eq('panel: a rejected session never reaches the engine', [badName.statusCode, badName.json().error.kind, cli.length], [400, 'bad-session', 3])

  const activated = fakeRes()
  await handler.handle(post({ action: 'activate', id: 'me' }), activated)
  eq('panel: activate answers with the refreshed payload', [activated.statusCode, activated.json().active.id], [200, 'me'])

  const ghost = fakeRes()
  await handler.handle(post({ action: 'activate', id: 'ghost' }), ghost)
  eq('panel: activating an unknown profile is a 404', ghost.statusCode, 404)

  const unknown = fakeRes()
  await handler.handle(post({ action: 'explode' }), unknown)
  eq('panel: an unknown action is a 400 that names the alternatives', [unknown.statusCode, unknown.json().error.kind], [400, 'bad-action'])
  eq('panel: and that message lists every action the route really serves',
    unknown.json().error.message,
    'unknown action "explode"; expected list, open, kill, activate or session')

  const noType = fakeRes()
  const noTypeReq = post({ action: 'open' }, { 'content-type': 'text/plain' })
  await handler.handle(noTypeReq, noType)
  eq('panel: a wrong content-type is refused before anything runs', [noType.statusCode, cli.length], [415, 3])

  const malformed = fakeRes()
  await handler.handle(post('{oops'), malformed)
  eq('panel: malformed JSON is a 400', malformed.statusCode, 400)

  const wrongMethod = fakeRes()
  await handler.handle({ method: 'PUT', url: SESSIONS_ROUTE_PATH, headers: {} }, wrongMethod)
  eq('panel: another method is a 405 that advertises GET, POST', [wrongMethod.statusCode, wrongMethod.headers.allow], [405, 'GET, POST'])

  const fenced = fakeRes()
  await createSessionsHandler({
    cfg: CFG,
    connections: faces,
    runCli,
    connection: () => ({ requestRejection: () => 403 }),
  }).handle(req('GET', SESSIONS_ROUTE_PATH), fenced)
  eq('panel: the composition\'s fence is honoured', [fenced.statusCode, fenced.body], [403, ''])

  const failed = fakeRes()
  await createSessionsHandler({
    cfg: CFG,
    connections: faces,
    runCli: async () => { const error = new Error('cannot launch a terminal window: wt.exe not found'); error.kind = 'spawn'; throw error },
  }).handle(post({ action: 'open' }), failed)
  eq('panel: a failing verb is a 502 carrying the engine\'s own words', [failed.statusCode, failed.json().error.kind, failed.json().error.message], [502, 'spawn', 'cannot launch a terminal window: wt.exe not found'])

  // 放在最后：上面几条断言拿 cli.length 当"有没有多跑一次引擎"的证据，而枚举本身
  // 就要跑一次 —— 排在它们后面才不会去动那些数字。
  const enumerated = fakeRes()
  await handler.handle(post({ action: 'list' }), enumerated)
  eq('panel: list is the engine\'s own enumerate verb, on the active host', cli.at(-1), { argv: ['--session', 'default', 'list', '--json'], env: { SSH_HOST: 'lan-box.local' } })
  eq('panel: every enumerated session is handed over marked as existing',
    [enumerated.statusCode, enumerated.json().session, enumerated.json().sessions],
    [200, 'default', [{ name: 'default', attached: 1, windows: 1, current: true, exists: true }]])

  // 换「当前连接」干活用的会话。放在 list 之后：它会改掉当前那条 profile 的 session，
  // 而上面那条 list 断言正需要它还是 'default'（先改名，argv 就会变成新名字）。
  const switched = fakeRes()
  await handler.handle(post({ action: 'session', session: 'logs' }), switched)
  eq('panel: switching the session answers 200 with a freshly refreshed payload',
    [switched.statusCode, switched.json().active, switched.json().sessions],
    [200, { id: 'me', label: 'LAN box', target: 'me@lan-box.local:22', session: 'logs' }, [{ name: 'logs', exists: null }]])
  eq('panel: and the rows carry the new session too — the client repaints from this one answer',
    switched.json().profiles,
    [{ id: 'me', label: 'LAN box', target: 'me@lan-box.local:22', session: 'logs', active: true }])
  eq('panel: switching the session runs no CLI verb at all', cli.length, 4)

  const refusedSwitch = fakeRes()
  await handler.handle(post({ action: 'session', session: 'rejected' }), refusedSwitch)
  eq('panel: a refused switch is a 400 carrying the store\'s own words',
    [refusedSwitch.statusCode, refusedSwitch.json().error.kind, refusedSwitch.json().error.message],
    [400, 'bad-session', 'the store said no'])

  // 「根本没给名字」必须在这里就停住：`parseSessionName` 走 `String(value)`，
  // 所以一个漏了字段的请求本来会被认成字面量会话名 `'undefined'`。
  const namelessSwitch = fakeRes()
  await handler.handle(post({ action: 'session' }), namelessSwitch)
  eq('panel: a switch with no session field is a 400, not a silent switch',
    [namelessSwitch.statusCode, namelessSwitch.json().error.kind], [400, 'bad-session'])
  eq('panel: and the refused switches left the current session alone',
    (await faces.active()).session, 'logs')

  const noHost = fakeRes()
  await createSessionsHandler({
    cfg: CFG,
    connections: { ...faces, source: async () => 'none', activeId: async () => null, active: async () => null, list: async () => ({ active: null, profiles: [] }) },
    runCli,
  }).handle(req('GET', SESSIONS_ROUTE_PATH), noHost)
  eq('panel: an unconfigured host offers no rows and no hosts', [noHost.json().source, noHost.json().sessions, noHost.json().profiles], ['none', [], []])
}

// --- 汇报 -----------------------------------------------------------------
const failed = results.filter((entry) => !entry.ok)
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed,
  verdict: failed.length === 0 ? 'OK: the mirror route behaves as documented' : 'FAILURES above',
}, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
