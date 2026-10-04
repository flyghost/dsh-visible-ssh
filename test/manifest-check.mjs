/**
 * 守住 DSH 模块系统依赖、却永远不会替你校验的那份 manifest 与客户端半契约。
 *
 *   node test/manifest-check.mjs
 *
 * 为什么每项检查都存在（全部在 DSH 0.1.5-rc.2 / Desktop 2.0.13 上实测）：
 *
 *   * **宿主**半通过 `exports["."]` 解析这个包，而**客户端行**扫描是用
 *     `require.resolve("<pkg>/package.json")` 去定位 manifest 的。一份漏掉
 *     "./package.json" 的 exports 映射，会让所有面向模型的工具照常工作，
 *     而浏览器永远拿不到那个客户端 bundle：`locatePkgJson` 抛
 *     ERR_PACKAGE_PATH_NOT_EXPORTED，`resolveMeta` 返回 null，那一行被丢掉，
 *     **没有**任何 warning，**也没有**任何 error。唯一的症状是一个消失的 tab
 *     类型，看起来跟客户端半坏掉一模一样。
 *   * `__ModuleLoader__.load({ id })` 必须注册**包名**：shell 会拒绝那个行
 *     从未落地成形的 bundle（"loaded without registering \"<id>\" via
 *     __ModuleLoader__.load"）。
 *   * mirror 路径在 routes/index.js 与 client/index.js 之间是**故意**重复的（浏览器
 *     bundle 无法 import 宿主模块），所以两者一旦漂移，每次轮询都会落到 SPA
 *     fallback 上，panel 也只会一直显示一个错误。
 *   * 客户端半里的 `require(...)` 只允许点名 shell 那份冻结的 seed 表；别的
 *     一律需要 provider，否则会在落地成形时失败。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `.../test/manifest-check.mjs` -> `.../plugin`。 */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin')
const read = (relative) => readFileSync(join(PLUGIN_DIR, relative), 'utf8')

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
}

/** 一个 `exports` 条目要么是字符串，要么是一层条件对象。 */
function exportTarget(field) {
  if (typeof field === 'string') return field
  if (field !== null && typeof field === 'object' && typeof field.default === 'string') return field.default
  return null
}

const pkg = JSON.parse(read('package.json'))
check('the package name is a non-empty string', typeof pkg.name === 'string' && pkg.name.length > 0, pkg.name)

// **那个**陷阱。少了它，客户端行会被静默丢掉。
check(
  'exports declares "./package.json" (the client-row scan resolves it)',
  exportTarget(pkg.exports?.['./package.json']) === './package.json',
  pkg.exports?.['./package.json'],
)

const hostEntry = exportTarget(pkg.exports?.['.'])
check('exports["."] points at an existing host entry', hostEntry !== null && existsSync(join(PLUGIN_DIR, hostEntry)), hostEntry)

const clientEntry = exportTarget(pkg.exports?.['./client'])
check('exports["./client"] points at an existing bundle', clientEntry !== null && existsSync(join(PLUGIN_DIR, clientEntry)), clientEntry)

check('dsh.client.platform is "web"', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client)

const patch = pkg.dsh?.bundle?.patch
check('dsh.bundle.patch points at an existing patch file', typeof patch === 'string' && existsSync(join(PLUGIN_DIR, patch)), patch)

const clientSource = clientEntry === null ? '' : read(clientEntry)

const registered = /__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/.exec(clientSource)
check(
  'the client bundle registers the package name as its module id',
  registered !== null && registered[1] === pkg.name,
  registered === null ? 'no __ModuleLoader__.load({ id }) found' : registered[1],
)

// shell 那份冻结的平台表（seed 由 dsh-web-frontend 的 boot 构建：
// react、react/jsx-runtime、react-dom、react-dom/client、cordis、client-store、
// ui-slots、ui-primitives、ui-dockkit）。裸的 `cordis` 也被接受，因为插件开发
// 指南就是这么列的。
const FROZEN_BASE = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
const required = [...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
const outsideBase = [...new Set(required.filter((name) => !FROZEN_BASE.has(name)))]
check('the client bundle requires nothing outside the frozen base', outsideBase.length === 0, outsideBase)

// 路径字面量在两个半之间是重复的；一旦漂移，每次轮询要么 404（mirror），
// 要么让表单变得不可达（connection）。
const screenSource = read(join('lib', 'routes', 'index.js'))
for (const [label, hostPattern, clientPattern] of [
  ['mirror', /SCREEN_ROUTE_PATH\s*=\s*'([^']+)'/, /SCREEN_ENDPOINT\s*=\s*'([^']+)'/],
  ['connection', /CONNECTION_ROUTE_PATH\s*=\s*'([^']+)'/, /CONNECTION_ENDPOINT\s*=\s*'([^']+)'/],
  ['panel', /SESSIONS_ROUTE_PATH\s*=\s*'([^']+)'/, /SESSIONS_ENDPOINT\s*=\s*'([^']+)'/],
]) {
  const host = hostPattern.exec(screenSource)
  const client = clientPattern.exec(clientSource)
  check(
    `both halves agree on the ${label} path`,
    host !== null && client !== null && host[1] === client[1],
    { host: host?.[1], client: client?.[1] },
  )
}

const failed = results.filter((entry) => !entry.ok)
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed,
  verdict: failed.length === 0 ? 'OK: the manifest satisfies the client-row scan' : 'FAILURES above',
}, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
