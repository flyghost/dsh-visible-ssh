// 产物身份门禁：`plugin/src/engine/locate.ts` 回答「去哪找引擎」，这个套件回答
// 「那儿的东西**是不是我们记录过的那一组**」。
//
// 为什么非要有它：`engine-check.mjs` 只比较**字符串拼接**（它连 exe 都不需要，
// 见那边的首行注释），所以把产物目录整个删掉或改名、或者把某个 exe 换成另一个
// 版本，密闭层**照样全绿** —— 而插件的运行时会当场失败（`no such file (engine
// 'go')`，见 `src/engine/locate.ts`）。假绿在这里的代价是：一次目录重组能在满屏绿色的
// 测试下把插件改坏，或者悄悄换掉一个没人发现的引擎版本。
//
// 产物 2026-10-02 起住在**平台包** `packages/engine-win32-x64/`（包名
// `dsh-visible-ssh-engine-win32-x64`），插件通过 `optionalDependencies` 拿它，位置由
// `require.resolve()` 决定 —— 所以这个套件的第一件事是走一遍**插件真正走的那条解析路**，
// 而不是自己拼一个路径。
//
// 这里**不执行** exe（受限宿主里捕获子进程管道会被拒，见 run.mjs 的说明），只做
// 三件不需要运行任何东西的事：解析路对不对、包清单齐不齐、字节数 + sha256 与
// 包里的 `engine.lock` 一致。三个 exe 本身不受版本管理（`.gitignore` 忽略
// `packages/engine-win32-x64/visible-ssh*.exe`），所以 `engine.lock` 是「这一组产物
// 是什么」唯一受版本管理的记录。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../plugin/lib/engine/config.js'
import { enginePackageName, resolveEngine } from '../plugin/lib/engine/locate.js'
import { hashFile, lockPath, readLock, unlistedPayload, verifyPayload } from '../plugin/lib/engine/verify.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PKG_DIR = join(REPO, 'packages', 'engine-win32-x64')
const PKG_NAME = 'dsh-visible-ssh-engine-win32-x64'

// 交付单元：三个 exe 必须同目录（`transport_ssh.c` 的 `resolve_askpass()` 只认
// `<exe_dir>\visible-ssh-askpass.exe`，没有退路），所以三个一起校验。
const REQUIRED = ['visible-ssh.exe', 'visible-ssh-askpass.exe', 'visible-ssh-launch.exe']

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const cfg = resolveConfig()
const target = resolveEngine(cfg)
const dir = target.packageDir ?? dirname(target.program)
const LOCK = lockPath(dir)

// --- 解析路：默认没有 exeEntry，产物由平台包解析出来 --------------------------
// 这条断言是"布局被改对了"的唯一硬检查：换布局时，这里与 `src/engine/locate.ts`
// 的 `enginePackageName()` 必须同批改。
eq('config: the compiled exe is the default engine', cfg.engine, 'go')
eq('config: exeEntry is unset, so the payload comes from the platform package', cfg.exeEntry, null)
eq('locate: the package name follows platform-arch',
  enginePackageName('win32', 'x64'), PKG_NAME)
eq('locate: it resolves to the workspace directory (not a copied one)', target.packageDir, PKG_DIR)
eq('locate: and the program is the exe inside it',
  target.program, join(PKG_DIR, 'visible-ssh.exe'))

// --- 清单：这个目录是一个**可发布的包**，不是一个散件目录 ----------------------
const manifestPath = join(PKG_DIR, 'package.json')
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  eq('manifest: the package name is the one the plugin resolves', manifest.name, PKG_NAME)
  eq('manifest: it announces the platform it works on', manifest.os, ['win32'])
  eq('manifest: and the architecture', manifest.cpu, ['x64'])
  check('manifest: it is publishable (not private)', manifest.private !== true,
    'private: true would make `npm pack` refuse to produce a tarball')
  eq('manifest: the three exes and the lock ship with it',
    (manifest.files ?? []).filter((name) => /\.exe$|engine\.lock/.test(name)).sort(),
    [...REQUIRED, 'engine.lock'].sort())
} else {
  check('manifest: the platform package has a package.json', false, `${manifestPath} is missing`)
}

// --- 身份锁本身 --------------------------------------------------------------
let lock = null
if (existsSync(LOCK)) {
  check('lock: engine.lock is present in the package', true)
  try {
    lock = readLock(PKG_DIR)
    check('lock: it parses as JSON', true)
  } catch (error) {
    check('lock: it parses as JSON', false, error.message)
  }
} else {
  check('lock: engine.lock is present in the package', false,
    `${LOCK} is missing — it records which artifacts this repo consumes (see docs/test-baseline.md)`)
}

// --- 存在性 ------------------------------------------------------------------
const missing = REQUIRED.filter((name) => !existsSync(join(dir, name)))
check('artifacts: the three exes are all present next to each other',
  missing.length === 0,
  missing.length === 0
    ? undefined
    : `${dir} is missing ${missing.join(', ')} — copy all three from the engine project (omnibus/vssh), see engine.lock`)

// --- 身份：字节数 + sha256 与 engine.lock 一致 -------------------------------
// 两条独立的路：`verifyPayload()` 是插件运行时真正跑的那段（必须接受这份产物），
// 下面这圈逐文件的对账则是为了让失败信息落到**具体哪个 exe**。
try {
  const report = verifyPayload(PKG_DIR)
  check('verify: the payload is exactly what the lock records', true)
  eq('verify: and it checked all three exes', [...report.checked].sort(), [...REQUIRED].sort())
} catch (error) {
  check('verify: the payload is exactly what the lock records', false, error.message)
}
if (lock && lock.files) {
  eq('lock: it records exactly the three deliverable exes',
    Object.keys(lock.files).sort(), [...REQUIRED].sort())
  eq('lock: no unlisted exe is sitting in the package', unlistedPayload(PKG_DIR, lock), [])
  for (const name of REQUIRED) {
    const entry = lock.files[name]
    const file = join(dir, name)
    if (!entry) {
      check(`identity: ${name} is recorded in engine.lock`, false, 'no entry in engine.lock')
      continue
    }
    if (!existsSync(file)) {
      check(`identity: ${name} matches engine.lock`, false, `${file} does not exist`)
      continue
    }
    const bytes = statSync(file).size
    check(`identity: ${name} has the recorded size`, bytes === entry.bytes,
      `expected ${entry.bytes} bytes, got ${bytes}`)
    const digest = hashFile(file)
    check(`identity: ${name} has the recorded sha256`, digest === entry.sha256,
      `expected ${entry.sha256}, got ${digest} — the artifact was replaced without updating engine.lock (see docs/test-baseline.md)`)
  }
}

const failed = results.filter((entry) => !entry.ok)
console.log(JSON.stringify({
  package: PKG_NAME,
  packageDir: dir,
  source: target.source,
  exeEntry: cfg.exeEntry,
  program: target.program,
  lock: LOCK,
  total: results.length,
  passed: results.length - failed.length,
  failed,
  verdict: failed.length === 0
    ? 'OK: the engine artifacts are the ones engine.lock records'
    : 'FAILURES above',
}, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
