/**
 * 注册契约的另一半，跑在**真的**框架上：当这个插件比浏览器载体**先**被组合
 * 出来时会发生什么。
 *
 *   node test/live-late-carrier.mjs
 *   DSH_APP=<another DSH install> node test/live-late-carrier.mjs
 *
 * 在一个 DSH profile 里，插件与 web server 是两条独立的 fiber，所以「载体还
 * 不存在」是常态，不是边缘情况。Cordis 在这里无法用一个静态 `inject` 表达
 * 这件事 —— 那会把整个插件都停住，连面向模型的工具一起 —— 所以路由改为通过
 * `ctx.inject` 等待。微妙之处在于：那个 callback yield 出来的**每一个**
 * disposer 都必须被当作 inject fiber 的清理动作接住；否则路由会挂上去，然后
 * 永远作答，却没有任何东西拥有它们。两半都在这里被断言。
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

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

const mod = (relative) => pathToFileURL(join(APP, 'node_modules', relative)).href

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
}

const { Context } = await import(mod('@deepseek-ai/cordis/lib/index.js'))
const WebServer = (await import(mod('@deepseek-ai/dsh-host-webserver/lib/index.js'))).default
const { CONNECTION_ROUTE_PATH, SCREEN_ROUTE_PATH, registerWebRoutes } = await import('../plugin/lib/routes/index.js')
const { createConnections } = await import('../plugin/lib/connection/connections.js')
const { resolveConfig } = await import('../plugin/lib/engine/config.js')
const { createEnginePort } = await import('../plugin/lib/engine/exec.js')

const STORE_DIR = join(HERE, 'env', 'tmp', 'late-carrier')
rmSync(STORE_DIR, { recursive: true, force: true })

const cfg = resolveConfig({})
const connections = createConnections({ file: join(STORE_DIR, 'connections.json'), env: process.env, configPath: cfg.configPath })

const report = { paths: [SCREEN_ROUTE_PATH, CONNECTION_ROUTE_PATH] }
const ctx = new Context()
report.carrierBeforeRegister = ctx.get('webServer') !== undefined
check('the carrier really is absent when registration runs', report.carrierBeforeRegister === false)

// 1. 在完全看不到载体的情况下注册。这一步绝不能抛，也不能生成任何东西：
//    路由就是还没有被挂上而已。
try {
  registerWebRoutes(ctx, cfg, connections, createEnginePort(cfg))
  report.registerWithoutCarrier = 'ok'
} catch (error) {
  report.registerWithoutCarrier = `THREW: ${error?.message ?? error}`
}
check('registering without a carrier does not throw', report.registerWithoutCarrier === 'ok', report.registerWithoutCarrier)

// 2. 把载体组合出来。停在那里的 inject fiber 应该自己激活，并把每条路由都
//    挂上，不需要任何人手动重新注册。
await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
const server = ctx.get('webServer')
report.mountedAfterCarrier = [...server.exact.keys()]
check(
  'the parked row mounts every route as soon as the carrier appears',
  server.exact.has(SCREEN_ROUTE_PATH) && server.exact.has(CONNECTION_ROUTE_PATH),
  report.mountedAfterCarrier,
)

// 3. 两条都打一下。不可用的 session 名会在 bridge 跑起来之前就回答 400，而
//    overview 是一次本地文件读，所以两者都不需要 SSH capture。
const bad = await fetch(`http://127.0.0.1:${server.port}${SCREEN_ROUTE_PATH}?session=${encodeURIComponent('a b')}`)
const badBody = await bad.json()
const overview = await fetch(`http://127.0.0.1:${server.port}${CONNECTION_ROUTE_PATH}`, { headers: { accept: 'application/json' } })
const overviewBody = await overview.json()
report.probe = { screen: { status: bad.status, kind: badBody?.error?.kind }, connection: { status: overview.status, source: overviewBody?.source } }
check('the mounted mirror handler answers', bad.status === 400 && badBody?.error?.kind === 'bad-session', report.probe.screen)
check('the mounted connection handler answers', overview.status === 200 && typeof overviewBody?.source === 'string', report.probe.connection)

// 4. 卸载那个等待中的 fiber —— 插件被禁用、HMR、切 profile —— 每条路由都必须
//    离开载体的路由表。
const waiting = [...ctx.registry.values()]
  .flatMap((runtime) => [...runtime.fibers])
  .find((fiber) => fiber.inject?.webServer !== undefined)
report.waitingFiberFound = waiting !== undefined
check('the waiting fiber is discoverable for unload', report.waitingFiberFound === true)
if (waiting !== undefined) {
  await waiting.dispose()
  report.routesAfterUnload = [...server.exact.keys()]
}
check(
  'unloading that fiber removes every route from the carrier',
  Array.isArray(report.routesAfterUnload) && report.routesAfterUnload.length === 0,
  report.routesAfterUnload,
)

await new Promise((resolve) => { server.server.close(() => resolve()) })
rmSync(STORE_DIR, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed,
  report,
  verdict: failed.length === 0 ? 'OK: the registration lifecycle holds on real cordis' : 'FAILURES above',
}, null, 2))
process.exitCode = failed.length === 0 ? 0 : 1
