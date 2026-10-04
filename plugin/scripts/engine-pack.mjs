#!/usr/bin/env node
/**
 * 把平台包打成一个 tarball —— 也就是"发出去"这件事在本仓的样子。
 *
 * 产物不进 git（见 `packages/engine-win32-x64/README.md`），所以"给别的机器一份引擎"只有
 * 两种走法：从引擎项目整组拷三个 exe，或者装这个包。这里做后者：`npm pack` 会把包清单
 * 里 `files` 列的东西一起装进去（exe 虽然在 `.gitignore` 里，但清单是权威的），装出来的
 * tarball 落到 gitignore 的 `scratch/dist/`。
 *
 *   node plugin/scripts/engine-pack.mjs               # 打进 scratch/dist/
 *   node plugin/scripts/engine-pack.mjs --dry-run     # 只列会装进 tarball 的文件
 *   node plugin/scripts/engine-pack.mjs --out <dir>   # 换个落地目录
 *
 * 这条路**不是**必需的：安装方 `npm install` 时插件把它当 `optionalDependencies` 去取，
 * 开发期由仓根工作区把它链接进来（`npm install` 之后 `node_modules/dsh-visible-ssh-engine-win32-x64`
 * 就指向 `packages/engine-win32-x64/`）。本脚本是给"要发一个 tarball"的人用的。
 *
 * 注意：npm 的输出是**继承**过来的，不捕获 —— 受限宿主里捕获子进程输出会被拒（见 test/run.mjs）。
 * 所以 tarball 的名字由本脚本自己按 `name-version.tgz` 推出来，不解析 npm 的输出。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const PKG_DIR = join(REPO, 'packages', 'engine-win32-x64')

const argv = process.argv.slice(2)
let outDir = join(REPO, 'scratch', 'dist')
let dryRun = false
for (let index = 0; index < argv.length; index += 1) {
  const word = argv[index]
  if (word === '--dry-run') { dryRun = true; continue }
  if (word === '--out') {
    const value = argv[index + 1]
    if (value === undefined) { process.stderr.write('engine-pack: --out needs a directory\n'); process.exit(2) }
    outDir = resolve(value)
    index += 1
    continue
  }
  if (word === '--help' || word === '-h') {
    process.stdout.write('usage: node plugin/scripts/engine-pack.mjs [--dry-run] [--out <dir>]\n')
    process.exit(0)
  }
  process.stderr.write(`engine-pack: unknown argument ${word}\n`)
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
if (manifest.name === undefined || manifest.version === undefined) {
  process.stderr.write(`engine-pack: ${PKG_DIR}/package.json has no name/version\n`)
  process.exit(1)
}
const tarball = join(outDir, `${manifest.name}-${manifest.version}.tgz`)

if (!dryRun) mkdirSync(outDir, { recursive: true })

// npm 的缓存必须落在工作区内：默认缓存目录在 workspace 之外，会被沙箱拒（EPERM）。
const cache = join(REPO, 'scratch', 'cache', 'npm')
mkdirSync(cache, { recursive: true })

// `--ignore-scripts`：这个包里本来没有脚本，但仓根/工作区的生命周期脚本不该因为"打个包"
// 而被触发（本仓每次 `npm install` 都要显式加它，理由见 AGENTS.md）。
const npmArgs = ['pack', PKG_DIR, '--cache', cache, '--ignore-scripts', '--loglevel', 'notice',
  ...(dryRun ? ['--dry-run'] : ['--pack-destination', outDir])]
// Node 24 起 `spawnSync('npm.cmd', …)` 直接失败（status: null）：`.cmd` 必须经 cmd /c 起。
const [program, args] = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'cmd.exe', ['/c', 'npm', ...npmArgs]]
  : ['npm', npmArgs]

process.stdout.write(`${dryRun ? '[dry-run] ' : ''}npm ${npmArgs.join(' ')}\n`)
if (!dryRun) process.stdout.write(`(the tarball lands in ${outDir})\n`)
const ran = spawnSync(program, args, { stdio: 'inherit', cwd: REPO })
if (ran.error !== undefined) {
  process.stderr.write(`engine-pack: could not run npm: ${ran.error.message}\n`)
  process.exit(1)
}
if (ran.status !== 0) {
  process.stderr.write(`engine-pack: npm pack exited ${ran.status}\n`)
  process.exit(ran.status ?? 1)
}

if (dryRun) {
  process.stdout.write('dry run: nothing was written\n')
  process.exit(0)
}

if (!existsSync(tarball)) {
  process.stderr.write(`engine-pack: npm pack reported success but ${tarball} is not there — `
    + 'check the package name/version, or pass --out\n')
  process.exit(1)
}
const bytes = statSync(tarball).size
const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
process.stdout.write(`\ntarball: ${tarball}\n`)
process.stdout.write(`  ${bytes} bytes  sha256 ${digest}\n`)
process.stdout.write(`  contents are listed above; installing it needs the plugin as well:\n`)
process.stdout.write(`    npm install ${tarball}\n`)
