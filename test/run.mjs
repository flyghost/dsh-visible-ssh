/**
 * 本插件密闭测试套件的唯一入口命令：
 *
 *   node test/run.mjs                  （或：cd plugin && npm test）
 *
 * 只有「除了 node 和本仓库什么都不需要」的套件才进这道门禁，所以它对每次改动
 * 都安全。它们读的是 `plugin/lib/`（构建产物），所以门禁会先确认产物不比 `src/`
 * 旧，必要时调用插件自己的构建；那一步需要仓库根的 `node_modules`，缺了会打印
 * 一句清楚的失败而不是让套件去啃半棵源码树。那些需要跑着的 DSH、应用 checkout
 * 或可达远端主机的选择性检查，在这里只被登记，**不会**被运行。
 *
 * 门禁跑两段：先是 `test/unit/**` 的单元层（vitest，毫秒级，只碰纯函数与内存端口），
 * 然后是下面 7 个顶层套件。两段都绿才算绿色。
 *
 * **台账才是重点。** 两个清单都没列的套件文件，会让门禁**按名字**失败——因为它
 * 要防的那种失败是静默的：有人加了 `widget-check.mjs`，门禁照旧打印绿色，而它
 * 从来没被跑过。同一份台账也驱动打印出来的报告，所以「这里没跑什么」不可能与
 * 决定它的那张清单漂移。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 门禁会跑的套件：只依赖 node 和本仓库——不需要网络，也不需要 DSH。 */
const HERMETIC = [
  'manifest-check.mjs',
  'engine-check.mjs',
  'artifact-check.mjs',
  'connection-check.mjs',
  'settings-check.mjs',
  'route-check.mjs',
  'client-half-check.mjs',
]

/**
 * 门禁**刻意不跑**的套件，每条附上它需要什么、以及它回答了哪个密闭层回答不了
 * 的问题——密闭层恰恰**伪造**了这些套件要检验的那件东西。
 */
const OPT_IN = [
  {
    file: 'live-route.mjs',
    needs: 'the in-repo DSH runtime (test/env/host, from setup-env.mjs; DSH_APP can point at another install) + a reachable remote host, given explicitly (SSH_HOST/SSH_USER[/SSH_PORT/SSH_PASSWORD], or VISIBLE_SSH_USE_REPO_CONFIG=1 to use this repo\'s own scripts/config/host.toml on purpose — nothing is read from your home)',
    what: 'the three routes on a REAL carrier and REAL SSH: the cold burst collapsing into one capture, the TTL, the engine\'s own words on a failure, and the proof that a panel-chosen profile\'s SSH_* environment reaches the engine',
  },
  {
    file: 'live-late-carrier.mjs',
    needs: 'the in-repo DSH runtime (test/env/host; DSH_APP can point at another install)',
    what: 'register-before-carrier on the real framework: the routes wait, mount when the carrier appears, and leave the table when the waiting fiber unloads',
  },
  {
    file: 'own-host-check.mjs',
    needs: 'the DSH runtime in test/env/host + a web profile that mounts this plugin (the isolated dev home test/env/home, or DSH_OWN_HOST_HOME; the operator\'s real ~/.dsh is deliberately refused) + a reachable remote host (the list action really SSHes), given explicitly (SSH_HOST/SSH_USER[/SSH_PORT/SSH_PASSWORD], or VISIBLE_SSH_USE_REPO_CONFIG=1) — the engine is pointed at that same explicit config, never at one discovered by walking up from the executable; the browser half additionally needs the shared browser and its driver',
    what: 'the two gates side by side: that the shipped web host\'s own token fence is what protects our routes (401 without it, 303 + dsh-auth cookie with it), that the routes are really mounted on a real host, that the list action closes the loop over real SSH, and — when the shared browser is up — that the panel renders one row per enumerated session',
  },
  {
    file: 'boot-graph.mjs',
    needs: 'a Chromium user-data dir (DSH_USERDATA, or argv[2])',
    what: 'whether this plugin is in the client graph the renderer was ACTUALLY served, answered by reading that cache; with a drivable GUI, reading __DSH_BOOT__.entries is the cheaper equivalent',
  },
]

// --- 守卫 -----------------------------------------------------------------
// 在任何别的事情**之前**运行：台账一旦过期，后面每一个「绿色」都成了对一组
// 没人核实过是否完整的套件的主张。
const present = readdirSync(HERE).filter((name) => name.endsWith('.mjs') && name !== 'run.mjs')
const listed = new Set([...HERMETIC, ...OPT_IN.map((entry) => entry.file)])
const unlisted = present.filter((name) => !listed.has(name))
const missing = [...listed].filter((name) => !present.includes(name))
const ledger = {
  hermetic: HERMETIC,
  optIn: OPT_IN.map(({ file, needs }) => ({ file, needs })),
}

if (unlisted.length > 0 || missing.length > 0) {
  console.log(JSON.stringify({
    ledger,
    unlisted,
    missing,
    verdict: 'FAILED: the suite ledger is out of date — a suite file is in neither list (so nothing would ever run it), or a listed suite is gone',
  }, null, 2))
  process.exit(1)
}

// --- 解耦 ------------------------------------------------------------------
// 密闭层的定义是「除了 node 和本仓库什么都不需要」，而一句定义必须**可执行**，否则
// 它会慢慢退化成祝愿：有人在套件里 `homedir()` 一下、借一份真实 profile、读一次
// `~/.dsh`，绿色照旧。所以这里用两道一起把它钉住：
//
//   * 静态：密闭套件（含 `test/unit/**`）的**源码**里不许出现本机状态的名字；
//   * 动态：跑它们时把 HOME/USERPROFILE/APPDATA/LOCALAPPDATA 与 TMP* 全都指到仓内的
//     空目录，并摘掉继承来的 DSH_*/SSH_* —— 于是"偷偷读一次家目录"只能读到空目录。
//
// 两者都不会夺走任何东西：真正需要那台机器（DSH 宿主、可达远端主机、浏览器）的检查
// 在 OPT_IN 里，本来就只能由人显式跑，而它们**自己声明**需要什么。
const unitDir = join(HERE, 'unit')
const unitSpecs = existsSync(unitDir)
  ? readdirSync(unitDir).filter((name) => name.endsWith('.test.mjs'))
  : []

/** 本机状态的名字 —— 出现在密闭层源码里就是耦合，不管它当时有没有被求值。 */
const COUPLING = [
  { token: 'homedir()', re: /homedir\s*\(/u, why: "asks the OS for the operator's home directory" },
  { token: 'USERPROFILE', re: /\bUSERPROFILE\b/u, why: "reads the operator's home out of the environment" },
  { token: 'APPDATA', re: /\bAPPDATA\b/u, why: 'reads a Windows per-user directory' },
  { token: 'LOCALAPPDATA', re: /\bLOCALAPPDATA\b/u, why: 'reads a Windows per-user directory' },
  { token: '~/.agents', re: /\.agents\b/u, why: "names the operator's skill install directory (outside the repository)" },
  { token: '~/.dsh', re: /\.dsh[\\/]/u, why: 'names the DSH home that lives outside the repository' },
]

const coupling = []
for (const [file, text] of [
  ...HERMETIC.map((name) => [name, readFileSync(join(HERE, name), 'utf8')]),
  ...unitSpecs.map((name) => [join('unit', name), readFileSync(join(unitDir, name), 'utf8')]),
]) {
  for (const { token, re, why } of COUPLING) {
    if (re.test(text)) coupling.push({ file, token, why })
  }
}

if (coupling.length > 0) {
  console.log(JSON.stringify({
    ledger,
    coupling,
    scanned: [...HERMETIC, ...unitSpecs.map((name) => join('unit', name))],
    verdict: 'FAILED: a hermetic suite touches this machine — a suite that only needs node and this repository may not read the operator\'s home, the skill install, or the DSH home; declare what you need in OPT_IN instead',
  }, null, 2))
  process.exit(1)
}

// 跑密闭层时用的环境：家目录与临时目录都在仓内，且是空的。
const DECOUPLED = join(HERE, 'env', 'tmp', 'decoupled')
const DECOUPLED_HOME = join(DECOUPLED, 'home')
const DECOUPLED_TMP = join(DECOUPLED, 'tmp')
/** 继承来的、会把这台机器带进套件的键 —— 一个都不留。 */
const DROPPED = [
  'DSH_HOME', 'DSH_OWN_HOST_HOME', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL',
  'DSH_PATH_DIALECT', 'DSH_APP', 'DSH_USERDATA',
  'SSH_HOST', 'SSH_PORT', 'SSH_USER', 'SSH_PASSWORD', 'SSH_CONFIG', 'HOSTCFG_ENV_CONFIG',
]

// 这两个目录是我们自己上一轮建的（普通目录，没有 junction），可以整棵重来，让"空"
// 这个前提每次都是真的。
rmSync(DECOUPLED_HOME, { recursive: true, force: true })
rmSync(DECOUPLED_TMP, { recursive: true, force: true })
mkdirSync(DECOUPLED_HOME, { recursive: true })
mkdirSync(DECOUPLED_TMP, { recursive: true })

const decoupled = {
  home: DECOUPLED_HOME,
  tmp: DECOUPLED_TMP,
  dropped: DROPPED,
  scanned: [...HERMETIC, ...unitSpecs.map((name) => join('unit', name))],
}

function decoupledEnv() {
  const env = { ...process.env }
  for (const key of DROPPED) delete env[key]
  env.HOME = DECOUPLED_HOME
  env.USERPROFILE = DECOUPLED_HOME
  env.APPDATA = DECOUPLED_HOME
  env.LOCALAPPDATA = DECOUPLED_HOME
  env.TMPDIR = DECOUPLED_TMP
  env.TMP = DECOUPLED_TMP
  env.TEMP = DECOUPLED_TMP
  return env
}

const CLEAN_ENV = decoupledEnv()

// --- 构建产物 --------------------------------------------------------------
// 套件读的都是 `plugin/lib/`（profile 与浏览器也按 package.json 的 exports 读那儿），
// 所以它必须比 `plugin/src/` 新。把这件事放在门禁里而不是文档里，是因为忘了构建的
// 后果不是报错，而是**拿旧产物跑出一片绿色**。
const PLUGIN = join(HERE, '..', 'plugin')
const LIB = join(PLUGIN, 'lib')
const BUILT = [join(LIB, 'index.js'), join(LIB, 'client', 'index.js')]

function newestMtime(target) {
  let newest = 0
  const walk = (path) => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) {
        const at = statSync(child).mtimeMs
        if (at > newest) newest = at
      }
    }
  }
  walk(target)
  return newest
}

function freshness() {
  const sources = [
    join(PLUGIN, 'src'),
    join(PLUGIN, 'scripts'),
    join(PLUGIN, 'tsconfig.json'),
  ]
  const sourceAt = Math.max(...sources.map(newestMtime))
  const builtAt = Math.min(...BUILT.map((file) => (existsSync(file) ? statSync(file).mtimeMs : 0)))
  if (builtAt === 0) return { needsBuild: true, why: 'plugin/lib/ is missing' }
  if (builtAt < sourceAt) return { needsBuild: true, why: 'plugin/src/ is newer than plugin/lib/' }
  return { needsBuild: false, why: '' }
}

const state = freshness()
if (state.needsBuild) {
  console.log(`building the plugin (${state.why})…`)
  const built = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'build.mjs')], { stdio: 'inherit' })
  if (built.status !== 0) {
    console.log(JSON.stringify({
      ledger,
      build: { ran: true, why: state.why, code: built.status ?? 1 },
      verdict: 'FAILED: the plugin could not be built — the suites read plugin/lib/, so there is nothing to test',
    }, null, 2))
    process.exit(1)
  }
}

// --- 单元层 -----------------------------------------------------------------
// S3 拆出来的那一层：specs 住 `test/unit/*.test.mjs`，只碰 `plugin/lib/` 里**纯**的部分
// （信封解析、CLI 定位、内存端口、路由处理器与工具注册表）。它们毫秒级、不 spawn 子进程、
// 不碰 SSH、也不需要 DSH —— 真 CLI 与真宿主留给那些 opt-in 套件。
// 台账守卫只比对 `test/*.mjs` 这一层，所以 `test/unit/` 里的文件不进 HERMETIC/OPT_IN。
const VITEST = join(HERE, '..', 'node_modules', 'vitest', 'vitest.mjs')

function runUnit() {
  if (!existsSync(VITEST)) {
    console.log(`unit: no vitest at ${VITEST} — install the workspace first: npm install`)
    return 1
  }
  console.log('running the unit specs (test/unit/**):')
  const ran = spawnSync(process.execPath, [VITEST, 'run', '--root', HERE], { stdio: 'inherit', env: CLEAN_ENV })
  return ran.status ?? 1
}

const unitCode = runUnit()

// --- 运行 ------------------------------------------------------------------
/**
 * 在一个独立进程里跑一个套件。stdio **刻意**用 inherit：在某些受限宿主里捕获
 * 管道会被拒（而且那样会吞掉套件自己打印的 JSON）。
 */
function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], { stdio: 'inherit', env: CLEAN_ENV })
    child.on('error', (error) => {
      console.log(`${file}: could not start: ${error.message}`)
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

const outcomes = []
for (const suite of HERMETIC) outcomes.push({ suite, code: await runSuite(suite) })
const failed = outcomes.filter((outcome) => outcome.code !== 0)
const green = unitCode === 0 && failed.length === 0
console.log(JSON.stringify({
  ledger,
  decoupled,
  unit: { specs: 'test/unit/**', code: unitCode },
  suites: outcomes,
  notRun: OPT_IN,
  verdict: green
    ? `OK: ${outcomes.length} hermetic suites green, unit specs green`
    : `FAILED: ${[
      ...(unitCode === 0 ? [] : ['unit specs']),
      ...failed.map((outcome) => outcome.suite),
    ].join(', ')}`,
}, null, 2))
process.exitCode = green ? 0 : 1
