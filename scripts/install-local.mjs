#!/usr/bin/env node
/**
 * 把本仓的插件装进**这台机器上**的 DSH 桌面版 profile（默认 `web`）。
 *
 * 为什么需要它：桌面版的 profile 是一个独立的 pnpm 工程（`<DSH_HOME>/profiles/<name>/`），
 * 「装插件」在那边就是一次 `pnpm add`（`dsh plugin` 只是把参数转给 pnpm）。这个脚本
 * 把两头接起来：找到 dsh、问出它用的 home、构建本仓产物、必要时取引擎产物、按你选的
 * 形式装进去、最后按**运行时同一条路**复验一遍。
 *
 * 它认得两种 dsh：PATH 上的（`where dsh`）与各个 DSH 产品生成在
 * `<APPDATA>\<产品>\host-commands\<bucket>\generations\<代>\bin\dsh.cmd` 的 —— 产品目录名
 * 用通配，不写死 "DSH Desktop"，所以社区版/别的壳换个名字也照样找得到。装到哪儿**只由选中
 * 的那个 dsh.cmd 里 `set "DSH_HOME=…"` 决定**，脚本不认产品名、也不认安装目录。
 *
 * 桌面版自带一份 pnpm（`<APPDATA>\<产品>\runtime-commands\generations\<代>\bin\pnpm.cmd`），
 * 宿主会把它注入**自己起的**子进程的 PATH。双击 `安装到本机.bat` 时没有那层注入，所以本脚本
 * 自己去找那份 pnpm 并把它的目录放到 PATH 最前面 —— 这一步发生在**摘 junction 之前**，免得
 * 装到一半才发现（2026-10-05 用户双击时踩到：`'pnpm' is not recognized`，而 junction 已经摘了）。
 *
 * 装的那一步**默认带 `--offline`**：这一步只是把一条 `link:`／`file:`／tarball 依赖写进
 * profile，别的依赖早就装好了（锁文件里记着、store 里躺着），本来不需要联网 —— 联网反而
 * 会：① 网络不通时对着 registry 一路重试到超时（2026-10-05 实测这台机器上
 * registry.npmjs.org 被解析到别处，pnpm 报 `ERR_TLS_CERT_ALTNAME_INVALID`）；② 顺手把别的
 * 插件按 range 升到最新。离线跑不动（store 里确实缺东西）才退回联网重试一次。
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
 * 这个脚本是**人运行的安装入口**，住在仓根 `scripts/`，与测试环境分开：测试那套住在仓内的
 * 测试目录里，入口是那个目录下的 `run.mjs`；这里只认真实桌面家 —— 家落在本仓里（不管哪个
 * 目录）一律拒绝。两边各扫各的：那套的静态守卫查"测试层不许认识这台机器"，那边还有一道反
 * 过来的，查"安装入口的源码里不许出现指向测试树的路径写法" —— 所以**本文件里连那种写法都
 * 不写**（拒绝整棵树，本来就不需要点名任何一个目录）。
 *
 * 用法：
 *   node scripts/install-local.mjs                     # 按 link 装进 web（有多个 dsh 时会问你）
 *   node scripts/install-local.mjs --profile web --tarball
 *   node scripts/install-local.mjs --list-dsh          # 只列出这台机器上的 dsh 和它们的家
 *   node scripts/install-local.mjs --pick 2            # 不问，直接选第 2 个目标
 *   node scripts/install-local.mjs --check             # 只看装没装、能不能用
 *   node scripts/install-local.mjs --dry-run           # 只打印要跑的命令
 *
 * 「装到哪个 DSH」＝「装到哪个家」：`DSH_HOME` 相同的多个 CLI 只算**一个**目标（取那一代
 * 最新的当代表），所以同一台机器上装了桌面版又装了社区版、但两者共用一个家时，你只会看到
 * 一项、也不会装错。想完全绕开选择就用 `--dsh <dsh.cmd 路径>`。
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
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // scripts（仓根）
const REPO = resolve(HERE, '..') // 仓库根
const PLUGIN = join(REPO, 'plugin') // plugin/
const ENGINE_DIR = join(REPO, 'packages', 'engine-win32-x64')
const PLUGIN_NAME = 'dsh-visible-ssh'
const ENGINE_NAME = 'dsh-visible-ssh-engine-win32-x64'
const EXES = ['visible-ssh.exe', 'visible-ssh-askpass.exe', 'visible-ssh-launch.exe']

const flags = {
  profile: 'web',
  dsh: null,
  pick: null,
  listDsh: false,
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
    case '--pick':
      flags.pick = value()
      break
    case '--list-dsh':
      flags.listDsh = true
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

// 桌面版把 CLI 生成在 <产品目录>\host-commands\<bucket>\generations\<代>\bin\dsh.cmd。
// 产品目录名不写死（社区版/别的壳可能叫别的名字），所以这一层用通配扫。
const HOST_COMMANDS = /^(.*)[\\/]host-commands[\\/]([^\\/]+)[\\/]generations[\\/]([^\\/]+)[\\/]bin[\\/]dsh\.cmd$/i
const APPDATA = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')

function describeDsh(path) {
  const match = HOST_COMMANDS.exec(path)
  if (match === null) return basename(path)
  const product = name(match[1].split(/[\\/]/).pop())
  return `${product} · ${match[2]} 代`
}

function name(text) {
  return typeof text === 'string' && text !== '' ? text : '?'
}

function isCmd(candidate) {
  return /\.cmd$/i.test(candidate.path) ? 1 : 0
}

function formatWhen(ms) {
  const at = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

// `dsh.cmd` 最后一行起的是产品自己的 Electron/Node 可执行文件；顺着它能问到产品版本，
// 方便在多产品并存时分辨谁是谁（`.generation.json` 里只有 contentHash，没有版本）。
function appVersionOf(dsh) {
  let text
  try {
    text = readFileSync(dsh, 'utf8')
  } catch {
    return null
  }
  const exe = /^\s*"([^"]+\.exe)"/im.exec(text)
  if (exe === null) return null
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(exe[1]), 'resources', 'app', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

// 这台机器上所有能当 CLI 用的 dsh。两条来源：PATH 上的，以及各产品 host-commands 里的代。
function scanDsh() {
  const found = []
  const seen = new Set()
  const add = (path, source) => {
    if (typeof path !== 'string' || path === '') return
    const key = resolve(path).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    if (!existsSync(path)) return
    found.push({ path, source, when: statSync(path).mtimeMs })
  }

  // ① PATH 上的（`where` 按 PATHEXT 把 dsh.cmd / dsh.exe / dsh.bat / dsh.ps1 都列出来）
  const onPath = spawnSync('where.exe', ['dsh'], { encoding: 'utf8' })
  for (const row of (onPath.stdout ?? '').split(/\r?\n/)) {
    const line = row.trim()
    if (line !== '') add(line, 'PATH')
  }

  // ② 各产品 host-commands 下的代目录
  if (existsSync(APPDATA)) {
    for (const product of readdirSync(APPDATA)) {
      const root = join(APPDATA, product, 'host-commands')
      if (!existsSync(root)) continue
      for (const bucket of readdirSync(root)) {
        const generations = join(root, bucket, 'generations')
        if (!existsSync(generations)) continue
        for (const generation of readdirSync(generations)) {
          add(join(generations, generation, 'bin', 'dsh.cmd'), '扫描')
        }
      }
    }
    // ③ npm 全局 bin（`npm i -g dsh` 会落在这儿；它同时在 PATH 上时 ① 已经收过）
    for (const file of ['dsh.cmd', 'dsh.exe', 'dsh']) add(join(APPDATA, 'npm', file), 'npm')
  }
  return found
}

// 把 CLI 按「家」归并：装到哪儿只看 DSH_HOME，所以同一个家的多个代只算一个目标。
function groupByHome(found) {
  const groups = new Map()
  for (const candidate of found) {
    const home = dshHome(candidate.path)
    const key = resolve(home).toLowerCase()
    if (!groups.has(key)) groups.set(key, { home, members: [] })
    groups.get(key).members.push({ ...candidate, home })
  }
  const list = [...groups.values()]
  for (const group of list) {
    // 代表取那一代最新的 `.cmd`：家只能从 .cmd 的文本里问出来，所以优先 .cmd。
    group.members.sort((a, b) => isCmd(b) - isCmd(a) || b.when - a.when)
    group.representative = group.members[0]
  }
  list.sort((a, b) => b.representative.when - a.representative.when)
  return list
}

function profileState(home, profile) {
  const manifest = join(home, 'profiles', profile, 'package.json')
  if (!existsSync(manifest)) return { ready: false, spec: null }
  try {
    const json = JSON.parse(readFileSync(manifest, 'utf8'))
    const spec = json?.dependencies?.[PLUGIN_NAME]
    return { ready: true, spec: typeof spec === 'string' ? spec : null }
  } catch {
    return { ready: true, spec: null }
  }
}

function printTargets(found, groups) {
  note(`本机找到 ${found.length} 个 dsh CLI，按「家」归并成 ${groups.length} 个可装的目标：`)
  groups.forEach((group, index) => {
    const head = group.representative
    const version = appVersionOf(head.path)
    const label = [describeDsh(head.path), formatWhen(head.when)]
    if (version !== null) label.push(`v${version}`)
    const state = profileState(group.home, flags.profile)
    note('')
    note(`  [${index + 1}] ${label.join(' · ')}`)
    note(`      CLI      ${head.path}   （${head.source}）`)
    note(`      家       ${group.home}`)
    note(`      profile  ${join(group.home, 'profiles', flags.profile)}${state.ready ? '   （就绪）' : '   （没有 package.json —— 先启动一次这个 DSH）'}`)
    if (state.spec !== null) note(`      已装过   ${PLUGIN_NAME} = ${state.spec}`)
    const others = group.members.slice(1)
    if (others.length > 0) {
      note(`      同一个家的另外 ${others.length} 个 CLI：${others.map((item) => `${describeDsh(item.path)} · ${formatWhen(item.when)}`).join('、')}`)
    }
  })
  note('')
}

async function chooseTarget(groups) {
  if (flags.pick !== null) {
    if (!/^[0-9]+$/.test(flags.pick)) fail(`--pick 只收序号数字，收到的是 ${flags.pick}`)
    const index = Number.parseInt(flags.pick, 10)
    if (index < 1 || index > groups.length) fail(`--pick ${flags.pick} 超出范围：本机有 ${groups.length} 个目标`)
    return groups[index - 1]
  }
  if (groups.length === 1) {
    note('只有一个目标，直接用它。')
    return groups[0]
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let answer
      try {
        answer = await rl.question(`装到哪一个？输入序号 [1-${groups.length}]，直接回车取消：`)
      } catch {
        break // stdin 里没有可读的行（管道空着、或控制台被关掉）
      }
      const text = answer.trim()
      if (text === '') break
      if (/^[0-9]+$/.test(text)) {
        const index = Number.parseInt(text, 10)
        if (index >= 1 && index <= groups.length) return groups[index - 1]
      }
      note(`  没有第 ${text} 个。`)
    }
  } finally {
    rl.close()
  }
  fail(`没选目标。指定一个用 --dsh <dsh.cmd 路径>，或 --pick <序号>；只想看看就用 --list-dsh。`)
}

// 桌面版的 `dsh.cmd` 里写死了 `set "DSH_HOME=…"`，所以这个值只能从它身上问出来。
function dshHome(dsh) {
  const text = readFileSync(dsh, 'utf8')
  const match = /set "DSH_HOME=([^"]+)"/i.exec(text)
  if (match !== null) return match[1]
  return join(homedir(), '.dsh')
}

// ---------------------------------------------------------------------------
// pnpm：桌面版自己带一份（<产品>\runtime-commands\<代>\bin\pnpm.cmd），
// 而 `dsh plugin add` 只是把参数转给 pnpm。宿主给子进程的 PATH 里有那条路径，
// 双击 bat 时没有那层注入 —— `'pnpm' is not recognized` 就是这么来的。
// ---------------------------------------------------------------------------

function newestPnpm(product) {
  const generations = join(product, 'runtime-commands', 'generations')
  if (!existsSync(generations)) return null
  const candidates = []
  for (const generation of readdirSync(generations)) {
    const file = join(generations, generation, 'bin', 'pnpm.cmd')
    if (existsSync(file)) candidates.push({ path: file, when: statSync(file).mtimeMs })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.when - a.when)
  return candidates[0].path
}

function findPnpm(dsh) {
  const where = spawnSync('where.exe', ['pnpm'], { encoding: 'utf8' })
  if (where.status === 0) {
    const line = String(where.stdout ?? '')
      .split(/\r?\n/u)
      .map((row) => row.trim())
      .find((row) => row !== '')
    if (line !== undefined && existsSync(line)) return { path: line, source: 'PATH' }
  }
  // 从选中的那个 dsh 反推产品目录 <APPDATA>\<产品>；它不在 host-commands 下
  // （npm 装的）就把 APPDATA 下每个带 runtime-commands 的产品都看一眼。
  const products = []
  const hit = HOST_COMMANDS.exec(dsh)
  if (hit !== null) products.push(hit[1])
  if (existsSync(APPDATA)) {
    for (const entry of readdirSync(APPDATA, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const product = join(APPDATA, entry.name)
      if (!products.includes(product) && existsSync(join(product, 'runtime-commands'))) products.push(product)
    }
  }
  const found = []
  for (const product of products) {
    const path = newestPnpm(product)
    if (path !== null) found.push({ path, when: statSync(path).mtimeMs, product })
  }
  if (found.length === 0) return null
  found.sort((a, b) => b.when - a.when)
  return { path: found[0].path, source: basename(found[0].product) }
}

// 把住着 pnpm 的那一代 bin 目录放到 PATH 最前面，后面所有子进程（npm、dsh、pnpm）
// 都看得见。返回它做了什么，好让调用方决定要不要说一句。
function usePnpm(dsh) {
  const pnpm = findPnpm(dsh)
  if (pnpm === null) return null
  if (pnpm.source === 'PATH') return { ...pnpm, added: false }
  process.env.PATH = `${dirname(pnpm.path)}${delimiter}${process.env.PATH ?? ''}`
  return { ...pnpm, added: true }
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

step(1, '找 dsh 与它的 profile（本机可能有多个 DSH）')
const found = scanDsh()
const groups = groupByHome(found)
if (flags.listDsh) {
  printTargets(found, groups)
  process.exit(0)
}
let dsh = flags.dsh
if (dsh === null) {
  if (groups.length === 0) {
    fail(`这台机器上没找到 dsh：PATH 里没有，${APPDATA} 下各产品的 host-commands 里也没有。先装一次 DSH Desktop，或用 --dsh <dsh.cmd 路径> 指定。`)
  }
  printTargets(found, groups)
  const target = await chooseTarget(groups)
  dsh = target.representative.path
  note(`选中的 CLI：${dsh}`)
}
if (!existsSync(dsh)) fail(`找不到 ${dsh}`)
const home = dshHome(dsh)
// 硬边界：仓内的「家」只可能是隔离/测试用的那一套，本脚本只认真实桌面家。这个判断不点名
// 任何目录 —— 它拒绝的是**整棵仓库**，所以测试家天然在里面。
if (inside(home, REPO)) {
  fail(`dsh 的 home 落在本仓里（${home}）—— 仓内的家只给隔离/测试用，不是桌面版的家。用 --dsh 指定真的那个（桌面版 dsh.cmd 里写着它）。`)
}
// 在 DSH 的壳里跑时，`DSH_HOME` 是宿主塞给子进程的（可能指着别的家）。真值只认 dsh.cmd。
const inherited = process.env.DSH_HOME
if (typeof inherited === 'string' && inherited.trim() !== ''
  && resolve(inherited).toLowerCase() !== resolve(home).toLowerCase()) {
  note(`  DSH_HOME=${inherited} 是继承来的，忽略；真值从 dsh.cmd 里读。`)
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

// 先确认 pnpm 找得到 —— 这一步必须在摘 junction 之前：`dsh plugin add` 只是把参数
// 转给 pnpm，双击 bat 时 PATH 上没有它（宿主只在它自己起的子进程里注入那条路径），
// 等装到一半才发现就晚了（junction 已摘掉，profile 会成断链）。
const pnpm = usePnpm(dsh)
if (pnpm === null) {
  fail(
    `找不到 pnpm —— dsh 装插件是把它转给 pnpm 的，而桌面版自带那份在 ` +
      `<APPDATA>\\<产品>\\runtime-commands\\generations\\<代>\\bin\\pnpm.cmd。` +
      `从 DSH 里开的终端跑就有；双击 bat 时请确认 DSH Desktop 装好且至少启动过一次。`,
  )
}
if (pnpm.added) note(`  PATH 上没有 pnpm，用 dsh 自带的那份：${pnpm.path}（${pnpm.source}）`)

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
  note(`  $ ${installLine} --offline`)
} else {
  // 这一步不借 run()：它会在非零退出码上直接 process.exit，而这里失败时还要
  // 先把 profile 清单还原回去（pnpm 半途出事时清单可能被改坏）。
  // 默认加 `--offline`：这一步只是把一条 link:/file:/tarball 依赖写进 profile，别的
  // 依赖早就装好了（锁文件里记着、store 里躺着），本来不需要联网。联网那条路有两处
  // 坏处：① 网络不通时 pnpm 会对着 registry 一路重试到超时（2026-10-05 实测这台机器
  // 上 registry.npmjs.org 被解析到别处，pnpm 报 ERR_TLS_CERT_ALTNAME_INVALID，
  // 重试要等好几分钟）；② `add` 会顺手把别的插件按 range 升到最新（实测把
  // billion-context 0.1.183 顶成 0.1.184）—— 装我们的插件不该动别人的版本。
  // 离线跑不动（store 里确实缺东西）才退回联网一次。
  let result = shell(`${installLine} --offline`, { cwd: profileDir })
  if (result.status !== 0) {
    note('  ！离线装没跑过（store 里可能缺东西），退回联网再试一次 —— 网络不好时这里会等很久')
    result = shell(installLine, { cwd: profileDir })
  }
  const after = existsSync(manifestFile) ? readFileSync(manifestFile, 'utf8') : ''
  if (after.trim() === '' || !after.includes(PLUGIN_NAME)) {
    writeFileSync(manifestFile, manifestBefore)
    note(`  ！安装没把 ${PLUGIN_NAME} 写进清单，已把清单还原成装之前那份`)
  }
  if (result.status !== 0) {
    note(`  ！profile 里的 node_modules\\${PLUGIN_NAME} 这会儿多半是空的（清单还留着那条依赖）：`)
    note('    把上面那个原因解决掉，再跑一次这个脚本就装回去了。')
    fail(`安装没跑过（退出码 ${result.status}）：${installLine}`)
  }

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
