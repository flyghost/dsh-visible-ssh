#!/usr/bin/env node
/**
 * 把本仓的插件装进**这台机器上**的 DSH 桌面版 profile（默认 `web`）。
 *
 * 为什么需要它：桌面版的 profile 是一个独立的 pnpm 工程（`<DSH_HOME>/profiles/<name>/`），
 * 「装插件」在那边就是一次 `pnpm add`（`dsh plugin` 只是把参数转给 pnpm）。这个脚本
 * 把两头接起来：找到 dsh、问出它用的 home、构建本仓产物、必要时取引擎产物、按你选的
 * 形式装进去、最后按**运行时同一条路**复验一遍。
 *
 * 三种形式：
 *   （默认）`link:`  —— 指向本仓 `plugin/` 的 junction。改完 `npm run build` 就热更，
 *                       开发用这个。
 *   `--file`       —— 把本仓 `plugin/` 与 `packages/engine-win32-x64/` 拷进 profile。
 *                       不需要打包、不碰网络，但改完源码要重跑一次这个脚本。
 *   `--tarball`    —— `npm pack` 出两个 tgz 再装。这就是**第三方**拿到本仓之后走的路，
 *                       与上架后市场那条路（npm 发预构建产物）同构。
 *
 * ⚠ 一个踩过的坑（2026-10-05，本脚本的第一版就是被它吃掉的）：
 *   profile 里用 `link:` 装过之后，**任何一次把这条依赖换成别的形式的安装**，都会让
 *   pnpm 在 Windows 上顺着那个 junction 删光**链接目标里的一切**。目标目录本身还在
 *   （所以 `.git` 活着、`git checkout -- <目录>` 能救回已跟踪的文件），但里面**未跟踪的
 *   新文件就没了**。本脚本因此在动手之前先把 junction 那一层自己摘掉 —— `rmdir` 只摘
 *   reparse point、不递归 —— 实测这样能挡住。
 *
 * 用法：
 *   node plugin/scripts/install-local.mjs                     # 按 link 装进 web
 *   node plugin/scripts/install-local.mjs --profile web --tarball
 *   node plugin/scripts/install-local.mjs --check             # 只看装没装、能不能用
 *   node plugin/scripts/install-local.mjs --dry-run           # 只打印要跑的命令
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // plugin/scripts
const PLUGIN = resolve(HERE, '..') // plugin/
const REPO = resolve(PLUGIN, '..') // 仓库根
const ENGINE_DIR = join(REPO, 'packages', 'engine-win32-x64')
const PLUGIN_NAME = 'dsh-visible-ssh'
const ENGINE_NAME = 'dsh-visible-ssh-engine-win32-x64'
const EXES = ['visible-ssh.exe', 'visible-ssh-askpass.exe', 'visible-ssh-launch.exe']

const flags = {
  profile: 'web',
  dsh: null,
  mode: 'link',
  check: false,
  dryRun: false,
  skipBuild: false,
  skipEngine: false,
}

function fail(text) {
  console.error(`install-local: 失败：${text}`)
  process.exit(1)
}

function note(text) {
  console.log(text)
}

function step(number, text) {
  console.log(`\n[${number}/6] ${text}`)
}

function quote(arg) {
  return /\s/.test(arg) ? `"${arg}"` : arg
}

function slash(path) {
  return path.replaceAll('\\', '/')
}

function inside(child, parent) {
  const a = resolve(child).toLowerCase()
  const b = resolve(parent).toLowerCase()
  return a === b || a.startsWith(b.endsWith('\\') ? b : `${b}\\`)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return fail(`读不懂 ${file}：${error.message}`)
  }
}

function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function usage() {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const block = /\/\*\*([\s\S]*?)\*\//.exec(text)
  console.log(block === null ? 'install-local.mjs' : block[1].replace(/^\s*\* ?/gm, '').trim())
}

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  const value = () => {
    const next = argv[i + 1]
    if (next === undefined) fail(`${arg} 后面要给一个值`)
    i += 1
    return next
  }
  switch (arg) {
    case '-h':
    case '--help':
      usage()
      process.exit(0)
      break
    case '--profile':
      flags.profile = value()
      break
    case '--dsh':
      flags.dsh = value()
      break
    case '--tarball':
      flags.mode = 'tarball'
      break
    case '--file':
      flags.mode = 'file'
      break
    case '--link':
      flags.mode = 'link'
      break
    case '--check':
      flags.check = true
      break
    case '--dry-run':
      flags.dryRun = true
      break
    case '--skip-build':
      flags.skipBuild = true
      break
    case '--skip-engine':
      flags.skipEngine = true
      break
    default:
      fail(`不认识这个参数：${arg}（--help 看用法）`)
  }
}

// 一律经 cmd.exe 起：Node 24 在 Windows 上直接 spawn 一个 .cmd 会失败
// （`spawnSync('npm.cmd')` 拿到的是 status:null），而 `dsh` 就是个 .cmd。
function shell(line, options = {}) {
  const { cwd = REPO, capture = false } = options
  if (!capture) note(`  $ ${line}`)
  const cmd = process.env.ComSpec ?? 'cmd.exe'
  const result = spawnSync(cmd, ['/d', '/s', '/c', `"${line}"`], {
    cwd,
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    stdio: capture ? 'pipe' : 'inherit',
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function run(line, options = {}) {
  if (flags.dryRun) {
    note(`  $ ${line}`)
    return { status: 0, stdout: '', stderr: '' }
  }
  const result = shell(line, options)
  if (result.status !== 0) fail(`命令没跑过（退出码 ${result.status}）：${line}`)
  if (options.capture === true && result.stdout.trim() !== '') {
    for (const row of result.stdout.trimEnd().split('\n')) note(`    ${row}`)
  }
  return result
}

// ---------------------------------------------------------------------------
// 找 dsh、问出它用的 home
// ---------------------------------------------------------------------------

function findDsh() {
  const found = spawnSync('where.exe', ['dsh'], { encoding: 'utf8' })
  const lines = (found.stdout ?? '')
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== '')
  const preferred = lines.find((row) => /\.cmd$/i.test(row)) ?? lines[0]
  if (preferred !== undefined && existsSync(preferred)) return preferred

  // 桌面版把 CLI 生成在 host-commands/<profile>/generations/<hash>/bin/ 下，取最新的一代
  const root = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DSH Desktop', 'host-commands')
  if (!existsSync(root)) return null
  let best = null
  for (const bucket of readdirSync(root)) {
    const generations = join(root, bucket, 'generations')
    if (!existsSync(generations)) continue
    for (const generation of readdirSync(generations)) {
      const candidate = join(generations, generation, 'bin', 'dsh.cmd')
      if (!existsSync(candidate)) continue
      const when = statSync(candidate).mtimeMs
      if (best === null || when > best.when) best = { when, path: candidate }
    }
  }
  return best === null ? null : best.path
}

// 桌面版的 `dsh.cmd` 里写死了 `set "DSH_HOME=…"`，所以这个值只能从它身上问出来。
function dshHome(dsh) {
  const text = readFileSync(dsh, 'utf8')
  const match = /set "DSH_HOME=([^"]+)"/i.exec(text)
  if (match !== null) return match[1]
  return join(homedir(), '.dsh')
}

// ---------------------------------------------------------------------------
// junction：pnpm 会顺着它删目标，所以在把依赖换形式之前先自己摘掉
// ---------------------------------------------------------------------------

function unlinkJunction(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return false
  }
  if (!stat.isSymbolicLink()) return false
  rmdirSync(path) // 只摘 reparse point，绝不递归
  return true
}

function guardPluginTree() {
  if (existsSync(join(PLUGIN, 'src', 'index.ts'))) return
  console.error('')
  console.error('⚠ plugin/src/index.ts 不见了 —— 本仓的 plugin/ 像是被删空了。')
  console.error('  .git 在仓库根、没被动过：先 `git checkout -- plugin` 找回已跟踪的文件，')
  console.error('  再想想有没有未跟踪的新文件丢了。')
  console.error('  （pnpm 在换掉一条 link: 依赖时会顺着 junction 删掉目标里的内容。）')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

step(1, '找 dsh 与它的 profile')
const dsh = flags.dsh ?? findDsh()
if (dsh === null) {
  fail('PATH 上没有 dsh，也没找到桌面版的 host-commands。先装一次 DSH Desktop，或用 --dsh <dsh.cmd 路径> 指定。')
}
if (!existsSync(dsh)) fail(`找不到 ${dsh}`)
const home = dshHome(dsh)
if (inside(home, REPO)) {
  fail(`dsh 的 home 落在本仓里（${home}）—— 那是测试用的隔离家，不是桌面版的家。用 --dsh 指定真的那个。`)
}
const profileDir = join(home, 'profiles', flags.profile)
if (!existsSync(join(profileDir, 'package.json'))) {
  fail(`没有 ${join(profileDir, 'package.json')}。先启动一次 DSH Desktop（它会生成 profile），再来装。`)
}
note(`  dsh      ${dsh}`)
note(`  home     ${home}`)
note(`  profile  ${profileDir}`)
note(`  形式     ${flags.mode}`)

function enginePackageDir(anchor) {
  // 必须从 realpath 建：从 junction 的字面路径建 createRequire 解不到仓里的引擎，
  // 而宿主加载链接里的模块时会解成真实路径（实测过，见 plugin/README.md）。
  const requireFromHere = createRequire(join(anchor, 'lib', 'engine', 'locate.ts'))
  try {
    return dirname(requireFromHere.resolve(`${ENGINE_NAME}/package.json`))
  } catch (error) {
    return { error: error.message }
  }
}

function verify() {
  const failures = []
  const installed = join(profileDir, 'node_modules', PLUGIN_NAME)
  const manifest = readJson(join(profileDir, 'package.json'))

  const spec = manifest.dependencies?.[PLUGIN_NAME]
  if (typeof spec === 'string') note(`清单里写成 ${spec}`)
  else failures.push(`profile 的 dependencies 里没有 ${PLUGIN_NAME}`)

  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(PLUGIN_NAME)) note('bundles 里有它')
  else failures.push(`profile 的 dsh.profile.bundles 里没有 ${PLUGIN_NAME}`)

  if (!existsSync(installed)) {
    failures.push(`没有 ${installed}`)
  } else {
    const real = safeRealpath(installed)
    note(`装在哪 ${real}${real === installed ? '' : '（链接）'}`)
    const client = join(real, 'lib', 'client', 'index.js')
    if (existsSync(client)) note(`客户端 ${statSync(client).size} B`)
    else failures.push(`没有客户端产物 ${client}（先 npm run build）`)

    const engine = enginePackageDir(real)
    if (typeof engine === 'string') {
      const exe = join(engine, 'visible-ssh.exe')
      if (!existsSync(exe)) {
        failures.push(`引擎里没有 ${exe}`)
      } else {
        const result = shell(`${quote(exe)} version`, { capture: true })
        if (/"ok"\s*:\s*true/.test(result.stdout)) {
          const version = /"version"\s*:\s*"([^"]+)"/.exec(result.stdout)
          const commit = /"commit"\s*:\s*"([^"]+)"/.exec(result.stdout)
          note(`引擎 ${version === null ? '?' : version[1]} ${commit === null ? '' : `(commit ${commit[1]})`}`)
        } else {
          failures.push(`引擎自报异常：${result.stdout.trim()}${result.stderr.trim()}`)
        }
      }
    } else {
      failures.push(`引擎包解析不到：${engine.error}`)
    }
  }

  console.log('')
  for (const text of failures) console.error(`  ✗ ${text}`)
  if (failures.length > 0) {
    console.error(`\nverdict: FAILED（${failures.length} 条）`)
    process.exit(1)
  }
  console.log('  ✓ 装好了')
  console.log('  宿主现在加载的是内存里那份：完全退出 DSH Desktop 再打开才生效。')
  process.exit(0)
}

if (flags.check) verify()

if (flags.skipBuild) {
  step(2, '跳过构建（--skip-build）')
} else {
  step(2, '确认工作区依赖')
  if (existsSync(join(REPO, 'node_modules', 'typescript', 'bin', 'tsc')) && existsSync(join(REPO, 'node_modules', PLUGIN_NAME))) {
    note('  已就绪')
  } else {
    run('npm install --ignore-scripts', { cwd: REPO })
  }

  step(3, '构建产物（plugin/lib）')
  run('npm run build', { cwd: REPO })
  if (!flags.dryRun) {
    for (const file of [join(PLUGIN, 'lib', 'index.js'), join(PLUGIN, 'lib', 'client', 'index.js')]) {
      if (!existsSync(file)) fail(`构建完还是没有 ${file}`)
    }
    note(`  客户端产物 ${statSync(join(PLUGIN, 'lib', 'client', 'index.js')).size} B`)
  }
}

if (flags.skipEngine) {
  step(4, '跳过引擎产物（--skip-engine）')
} else {
  step(4, '确认引擎产物（三个 exe）')
  const missing = EXES.filter((name) => !existsSync(join(ENGINE_DIR, name)))
  if (missing.length === 0) {
    note('  三个 exe 都在')
  } else {
    note(`  缺 ${missing.join('、')} —— 从上游 Release 取一组`)
    const lock = readJson(join(ENGINE_DIR, 'engine.lock'))
    const tag = typeof lock?.release?.tag === 'string' ? lock.release.tag : 'v0.0.1'
    run(`node plugin/scripts/engine-fetch.mjs --tag ${tag} --install --lock`, { cwd: REPO })
  }
}

function packTarballs() {
  const out = join(REPO, 'scratch', 'dist')
  mkdirSync(out, { recursive: true })
  const tarballs = []
  for (const dir of [PLUGIN, ENGINE_DIR]) {
    // npm pack 会跑 prepare（我们的构建），构建的 stdout 会混进 --json 里，
    // 所以不解析它的输出，按清单自己推文件名。
    const manifest = readJson(join(dir, 'package.json'))
    const name = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`
    const file = join(out, name)
    if (flags.dryRun) {
      note(`  $ npm pack --pack-destination ${quote(out)}   （在 ${dir}）`)
    } else {
      rmSync(file, { force: true })
      run(`npm pack --pack-destination ${quote(out)}`, { cwd: dir, capture: true })
      if (!existsSync(file)) fail(`npm pack 没在 ${out} 里落下 ${name}`)
      note(`  ${name} ${statSync(file).size} B`)
    }
    tarballs.push(file)
  }
  return tarballs
}

step(5, `装进 ${flags.profile}（${flags.mode}）`)
const specs =
  flags.mode === 'link'
    ? [`link:${slash(PLUGIN)}`]
    : flags.mode === 'file'
      ? [`file:${slash(PLUGIN)}`, `file:${slash(ENGINE_DIR)}`]
      : packTarballs()

const nodeModules = join(profileDir, 'node_modules')
for (const name of [PLUGIN_NAME, ENGINE_NAME]) {
  if (flags.dryRun) continue
  if (unlinkJunction(join(nodeModules, name))) {
    note(`  先摘掉 ${name} 的 junction（pnpm 换依赖时会顺着它删空链接目标）`)
  }
}

const manifestFile = join(profileDir, 'package.json')
const manifestBefore = readFileSync(manifestFile, 'utf8')
const installLine = `${quote(dsh)} plugin --profile ${flags.profile} add ${specs.map(quote).join(' ')}`
if (flags.dryRun) {
  note(`  $ ${installLine}`)
} else {
  // 这一步不借 run()：它会在非零退出码上直接 process.exit，而这里失败时还要
  // 先把 profile 清单还原回去（pnpm 半途出事时清单可能被改坏）。
  const result = shell(installLine, { cwd: profileDir })
  const after = existsSync(manifestFile) ? readFileSync(manifestFile, 'utf8') : ''
  if (after.trim() === '' || !after.includes(PLUGIN_NAME)) {
    writeFileSync(manifestFile, manifestBefore)
    note(`  ！安装没把 ${PLUGIN_NAME} 写进清单，已把清单还原成装之前那份`)
  }
  if (result.status !== 0) fail(`安装没跑过（退出码 ${result.status}）：${installLine}`)

  // link 模式下引擎是从仓里解析的（插件经 junction 解回本仓，本仓 node_modules 里就有
  // 那个平台包），profile 里不必再留一份 file:/tarball 拷贝 —— 而且 scratch/dist 一清，
  // 那条依赖就成了断链。remove 实测不会顺着 junction 删东西。
  const engineSpec = readJson(manifestFile).dependencies?.[ENGINE_NAME]
  if (flags.mode === 'link' && typeof engineSpec === 'string') {
    note(`  link 模式用不到 profile 里那份引擎拷贝（${engineSpec}），顺手摘掉`)
    const removed = shell(`${quote(dsh)} plugin --profile ${flags.profile} remove ${ENGINE_NAME}`, { cwd: profileDir })
    if (removed.status !== 0) note('  ！没摘掉（不影响使用，留着也只是多一份拷贝）')
  }
}
guardPluginTree()

step(6, '复验')
verify()
