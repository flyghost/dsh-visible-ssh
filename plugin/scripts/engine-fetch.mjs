#!/usr/bin/env node
/**
 * 从上游 GitHub Release 取一版引擎产物，装进 `packages/engine-win32-x64/`。
 *
 * 为什么有这条脚本
 * ----------------
 * 三个 exe 是上游（omnibus 仓）编的，本仓**不进 git**（见 `packages/engine-win32-x64/README.md`）。
 * 在此之前"投放"就是人手拷：拷的是哪次构建、有没有被换掉，只能靠 `engine.lock` 里手填的
 * `upstream.commit` 说个大概。v0.0.1 起上游把整组打进 Release 附件，于是投放可以是一条命令：
 * 取附件 → 校验附件 sha256 → 解开 → 改名 → 装进平台包 → 刷锁。
 *
 * 信任链
 * ------
 * - **传输**：附件字节的 sha256 与两处比对 —— `engine.lock` 里 `release.sha256`（受版本管理，
 *   同一个 tag 重取必须一致）与 Release API 自带的 `digest`；`--asset-sha256` 可再钉一道。
 * - **解包**：每个条目的 CRC32 由本文件末尾的读取器自己核，坏字节不会静默通过。
 * - **落地**：三个 exe 的字节数/sha256 由 `engine-lock.mjs` 写进 `engine.lock`，插件启动前
 *   `verifyPayload()` 逐个核（S4 的运行时校验）。
 * - **自证**：v0.0.1 起 exe 会自报 `version`/`commit`（构建期注入）。`--lock` 会把它读出来
 *   写进锁 —— 于是"锁里那条 commit"从**手填的传闻**变成**产物的自述**。
 *
 * 默认只报告：不加 `--install` 不落盘，不加 `--lock` 不改锁。
 *
 * 用法
 * ----
 *   node plugin/scripts/engine-fetch.mjs --tag v0.0.1 --dry-run          # 只说计划（不联网）
 *   node plugin/scripts/engine-fetch.mjs --tag v0.0.1                    # 取＋校验＋解开，报告
 *   node plugin/scripts/engine-fetch.mjs --tag v0.0.1 --install --lock   # 真装，并刷新锁
 *   node plugin/scripts/engine-fetch.mjs --from-zip E:\...-lite.zip --install --lock
 *
 * 旗标
 * ----
 *   --tag <vX.Y.Z>        要取哪一版（不给则用 `engine.lock` 里 `release.tag`）
 *   --repo <owner/name>   上游仓（默认 `engine.lock` 的 `release.repo`，否则 flyghost/omnibus）
 *   --flavor lite|full    附件档位（默认沿用锁里的，首次为 lite：full 多 25 MB 的 vc_redist）
 *   --asset <name>        直接点名附件（默认按 `omnibus-vssh-<tag>-win64[-lite].zip` 约定）
 *   --from-zip <path>     不联网，用本机一个 zip（仍会比对 `release.sha256`）
 *   --asset-sha256 <hex>  再钉一道附件的 sha256
 *   --install             把三个 exe 装进平台包（改名见下方 RENAME）
 *   --lock                装完顺手刷 `engine.lock`（必须与 `--install` 同用）
 *   --repin               同一 tag 的附件字节变了也接受（会大声警告；默认拒绝）
 *   --dry-run             连附件都不取，只打印计划
 *   -h, --help            这份说明
 *
 * 私有仓要凭据：脚本读 `GITHUB_TOKEN` / `GH_TOKEN` / `VISIBLE_SSH_GH_TOKEN` 三个环境变量之一
 * （只读 Release 权限就够）。它**从不打印 token**，也从不把它写进任何文件。没有 token 时，
 * 用 `--from-zip` 喂一个手工下好的附件即可。
 *
 * 上游把主 exe 叫 `visible-ssh-c.exe`，本仓的运行时名字是 `visible-ssh.exe` —— 改名只发生在这
 * 一步（引擎按"自己 exe 所在目录"找两个助手，所以主 exe 叫什么不影响它）。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const PKG_DIR = join(REPO, 'packages', 'engine-win32-x64')
const LOCK = join(PKG_DIR, 'engine.lock')
const CACHE = join(REPO, 'scratch', 'cache', 'engine')

/** 装进平台包后的三个文件名（与 `engine-lock.mjs` 的 REQUIRED 是一对，改要一起改）。 */
const REQUIRED = ['visible-ssh.exe', 'visible-ssh-askpass.exe', 'visible-ssh-launch.exe']

/** 上游附件里的名字 → 本仓的名字。只有主 exe 不同。 */
const RENAME = { 'visible-ssh-c.exe': 'visible-ssh.exe' }

const DEFAULT_REPO = 'flyghost/omnibus'
const TOKEN_VARS = ['GITHUB_TOKEN', 'GH_TOKEN', 'VISIBLE_SSH_GH_TOKEN']

function fail(message, code = 1) {
  process.stderr.write(`engine-fetch: ${message}\n`)
  process.exit(code)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 打印文件头上那一段块注释（只那一段，别把后面每个函数的注释也倒出来）。 */
function usage() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const block = /^#![^\n]*\n\/\*\*([\s\S]*?)\*\//.exec(source)
  const lines = (block === null ? '' : block[1])
    .split('\n')
    .map((line) => line.replace(/^ \* ?/, '').replace(/\s+$/, ''))
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  process.stdout.write(`${lines.join('\n')}\n`)
}

// --- 参数 ---------------------------------------------------------------

const flags = {
  tag: null, repo: null, flavor: null, asset: null, fromZip: null, assetSha256: null,
  install: false, lock: false, repin: false, dryRun: false,
}

const VALUE_FLAGS = new Map([
  ['--tag', 'tag'], ['--repo', 'repo'], ['--flavor', 'flavor'], ['--asset', 'asset'],
  ['--from-zip', 'fromZip'], ['--asset-sha256', 'assetSha256'],
])
const BOOL_FLAGS = new Map([
  ['--install', 'install'], ['--lock', 'lock'], ['--repin', 'repin'], ['--dry-run', 'dryRun'],
])

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const word = argv[i]
  if (word === '--help' || word === '-h') {
    usage()
    process.exit(0)
  }
  if (VALUE_FLAGS.has(word)) {
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) fail(`${word} needs a value`, 2)
    flags[VALUE_FLAGS.get(word)] = value
    i += 1
    continue
  }
  if (BOOL_FLAGS.has(word)) {
    flags[BOOL_FLAGS.get(word)] = true
    continue
  }
  fail(`unknown argument ${word} (try --help)`, 2)
}

if (flags.flavor !== null && flags.flavor !== 'lite' && flags.flavor !== 'full') {
  fail(`--flavor takes lite or full, not ${flags.flavor}`, 2)
}
if (flags.lock && !flags.install) {
  fail('--lock needs --install: the lock describes what is on disk', 2)
}
if (flags.assetSha256 !== null && !/^[0-9a-f]{64}$/i.test(flags.assetSha256)) {
  fail('--asset-sha256 takes a 64-character hex sha256', 2)
}

// --- 现状：锁里的钉与已装的三个 exe ---------------------------------------

let previousLock = null
if (existsSync(LOCK)) {
  try {
    previousLock = JSON.parse(readFileSync(LOCK, 'utf8'))
  } catch (error) {
    fail(`${LOCK} is not readable JSON: ${error.message}`)
  }
}
const pin = previousLock?.release ?? null

const tag = flags.tag ?? pin?.tag ?? null
if (tag === null) fail('which version? pass --tag vX.Y.Z (the lock has no release.tag either)', 2)

const repo = flags.repo ?? pin?.repo ?? DEFAULT_REPO
const flavor = flags.flavor ?? (flags.fromZip !== null ? 'lite' : pin?.flavor) ?? 'lite'
const assetName = flags.asset
  ?? (pin !== null && pin.tag === tag && typeof pin.asset === 'string'
    ? pin.asset
    : `omnibus-vssh-${tag}-win64${flavor === 'lite' ? '-lite' : ''}.zip`)

const sameTag = pin !== null && pin.tag === tag
if (sameTag && flags.repin) {
  process.stdout.write(`engine-fetch: --repin: ignoring the pinned asset sha256 for ${tag}\n`)
}

process.stdout.write(`repo:   ${repo}\n`)
process.stdout.write(`tag:    ${tag}${sameTag ? ' (pinned in engine.lock)' : ' (new to engine.lock)'}\n`)
process.stdout.write(`asset:  ${assetName}\n`)
process.stdout.write(`flavor: ${flavor}${flavor === 'full' ? ' (carries the 24 MB vc_redist)' : ''}\n`)
process.stdout.write(`into:   ${PKG_DIR}\n`)

// 现在就装的那组算个摘要，好让下面逐文件说 unchanged/CHANGED。
const installed = new Map()
for (const name of REQUIRED) {
  const path = join(PKG_DIR, name)
  if (!existsSync(path)) continue
  const bytes = readFileSync(path)
  installed.set(name, { bytes: bytes.length, sha256: sha256(bytes) })
}

if (flags.dryRun) {
  process.stdout.write('dry run: nothing was fetched, nothing was written.\n')
  if (installed.size > 0) {
    for (const [name, got] of installed) {
      process.stdout.write(`  installed: ${name} ${got.bytes} bytes ${got.sha256.slice(0, 12)}…\n`)
    }
  }
  process.exit(0)
}

// --- 取附件 -------------------------------------------------------------

/**
 * 一次 GitHub API 调用。私有仓必须带 token；不带 token 时 API 只会回 404。
 * @param {string} url
 * @param {string | null} token
 * @param {string} accept
 * @returns {Promise<Response>}
 */
async function github(url, token, accept) {
  /** @type {Record<string, string>} */
  const headers = { accept, 'user-agent': 'dsh-visible-ssh-engine-fetch' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  try {
    return await fetch(url, { headers, redirect: 'follow' })
  } catch (error) {
    fail(`could not reach ${url}: ${error.message}`)
  }
}

function findToken() {
  for (const name of TOKEN_VARS) {
    const value = process.env[name]
    if (typeof value === 'string' && value.length > 0) return { name, value }
  }
  return null
}

let zipBytes
let zipSource
let apiAsset = null
// Release 对外的时间（`published_at`，退而求其次 `created_at`）：锁里的 upstream.built 用它 ——
// 上游的包只自报 version/commit，没有构建时间。留在顶层是因为 --from-zip 时不联网，这里就是 null。
let apiPublished = null

if (flags.fromZip !== null) {
  const path = resolve(flags.fromZip)
  if (!existsSync(path)) fail(`--from-zip ${path} does not exist`)
  zipBytes = readFileSync(path)
  zipSource = `local file ${path}`
  process.stdout.write(`zip:    ${zipSource}\n`)
} else {
  const token = findToken()
  const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`
  const response = await github(url, token?.value ?? null, 'application/vnd.github+json')
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300)
    if (response.status === 404 && token === null) {
      fail(`GitHub says 404 for ${repo} release ${tag} — a private repo answers 404 without a token.\n`
        + `  give one of ${TOKEN_VARS.join(' / ')} a read-only token, or use --from-zip <path>.`)
    }
    fail(`GitHub API ${response.status} on ${url}: ${body}`)
  }
  const release = await response.json()
  apiPublished = release.published_at ?? release.created_at ?? null
  process.stdout.write(`token:  ${token === null ? 'none (public repo)' : `${token.name} (${token.value.length} chars, not printed)`}\n`)
  process.stdout.write(`publish: ${release.published_at ?? '?'}${release.draft === true ? ' [DRAFT]' : ''}`)
  process.stdout.write(`${release.prerelease === true ? ' [PRERELEASE]' : ''}\n`)

  const assets = Array.isArray(release.assets) ? release.assets : []
  apiAsset = assets.find((asset) => asset.name === assetName) ?? null
  if (apiAsset === null) {
    fail(`release ${tag} has no asset named ${assetName}\n  it has: ${assets.map((a) => a.name).join(', ') || '(none)'}`)
  }
  process.stdout.write(`size:   ${apiAsset.size} bytes (API)\n`)

  const digest = typeof apiAsset.digest === 'string' ? apiAsset.digest.replace(/^sha256:/, '') : null
  const cachedPath = join(CACHE, assetName)
  if (existsSync(cachedPath)) {
    const cached = readFileSync(cachedPath)
    const cachedSha = sha256(cached)
    const trust = [digest, sameTag && !flags.repin ? pin?.sha256 ?? null : null, flags.assetSha256]
      .filter((value) => typeof value === 'string')
    if (trust.includes(cachedSha)) {
      zipBytes = cached
      zipSource = `cache ${cachedPath}`
      process.stdout.write(`zip:    ${zipSource} (sha256 matches, not re-downloading)\n`)
    }
  }
  if (zipBytes === undefined) {
    const download = await github(apiAsset.url, token?.value ?? null, 'application/octet-stream')
    if (!download.ok) fail(`downloading the asset: HTTP ${download.status}: ${(await download.text()).slice(0, 300)}`)
    zipBytes = Buffer.from(await download.arrayBuffer())
    zipSource = `api.github.com asset ${apiAsset.id}`
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(cachedPath, zipBytes)
    process.stdout.write(`zip:    ${zipSource}\n`)
    process.stdout.write(`cache:  ${cachedPath}\n`)
  }
  if (zipBytes.length !== apiAsset.size) {
    fail(`the downloaded asset is ${zipBytes.length} bytes, the API says ${apiAsset.size}`)
  }
}

// --- 校验传输 -----------------------------------------------------------

const gotZipSha = sha256(zipBytes)
process.stdout.write(`\nasset sha256: ${gotZipSha}\n`)
process.stdout.write(`              ${zipBytes.length} bytes\n`)

/** @type {{ what: string, value: string, fatal: boolean }[]} */
const expectations = []
if (sameTag && typeof pin?.sha256 === 'string') {
  expectations.push({ what: 'engine.lock release.sha256', value: pin.sha256, fatal: !flags.repin })
}
if (typeof flags.assetSha256 === 'string') {
  expectations.push({ what: '--asset-sha256', value: flags.assetSha256.toLowerCase(), fatal: true })
}
if (apiAsset !== null && typeof apiAsset.digest === 'string') {
  expectations.push({ what: 'GitHub API digest', value: apiAsset.digest.replace(/^sha256:/, ''), fatal: true })
}

let mismatched = false
for (const expected of expectations) {
  const ok = expected.value.toLowerCase() === gotZipSha
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${expected.what}: ${expected.value}\n`)
  if (!ok) {
    mismatched = true
    if (expected.fatal) {
      fail(`the asset does not match ${expected.what}.\n`
        + '  same tag + different bytes means somebody re-uploaded the asset; do not install it.\n'
        + `  if you know why, re-run with --repin (only relaxes the engine.lock pin).`)
    }
  }
}
if (expectations.length === 0) {
  process.stdout.write('  NO PIN: first pull of this tag — the sha256 lands in engine.lock with --lock.\n')
  mismatched = false
}

// --- 解开 -----------------------------------------------------------------

const entries = unzip(zipBytes)
process.stdout.write(`\nentries in the zip: ${entries.length}\n`)

/** @type {Map<string, Buffer>} srcName → bytes */
const members = new Map()
for (const entry of entries) {
  if (entry.name.endsWith('/')) continue
  const wanted = entry.name in RENAME || REQUIRED.includes(entry.name)
  if (!wanted) {
    process.stdout.write(`  skip     ${entry.name}\n`)
    continue
  }
  members.set(entry.name, readZipEntry(zipBytes, entry))
}

const payload = new Map()
for (const [srcName, bytes] of members) {
  payload.set(RENAME[srcName] ?? srcName, { srcName, bytes })
}
for (const name of REQUIRED) {
  if (!payload.has(name)) {
    fail(`the zip has no payload named ${name} (it has: ${[...members.keys()].join(', ') || '(none)'})`)
  }
}

process.stdout.write('\npayload:\n')
let changed = 0
for (const name of REQUIRED) {
  const { srcName, bytes } = payload.get(name)
  const now = { bytes: bytes.length, sha256: sha256(bytes) }
  const was = installed.get(name)
  const locked = previousLock?.files?.[name] ?? null
  let verdict = was === undefined ? 'new' : (was.sha256 === now.sha256 ? 'unchanged' : 'CHANGED')
  if (verdict === 'CHANGED') changed += 1
  process.stdout.write(`  ${name} ${now.bytes} bytes ${now.sha256}\n`)
  process.stdout.write(`    ${verdict === 'unchanged' ? 'unchanged' : `${verdict} (was ${was?.bytes ?? '?'} bytes ${String(was?.sha256 ?? '').slice(0, 12)}…)`}`)
  process.stdout.write(`  from ${srcName}\n`)
  if (locked !== null && locked.sha256 !== now.sha256) {
    process.stdout.write(`    engine.lock currently says ${locked.bytes} bytes ${String(locked.sha256).slice(0, 12)}… (stale)\n`)
  }
}

if (changed === 0) process.stdout.write('\nall three exes are already the ones on disk\n')
else process.stdout.write(`\n${changed} of ${REQUIRED.length} exes differ from what is on disk\n`)

if (!flags.install) {
  process.stdout.write('\nnothing installed (that is the default). add --install to write the three exes')
  process.stdout.write(`${flags.lock ? '' : ', --lock to refresh engine.lock'}, then: node test/run.mjs\n`)
  process.exit(mismatched && sameTag ? 1 : 0)
}

// --- 落地 -----------------------------------------------------------------

process.stdout.write(`\ninstalling into ${PKG_DIR}\n`)
mkdirSync(PKG_DIR, { recursive: true })
for (const name of REQUIRED) {
  const { bytes } = payload.get(name)
  const target = join(PKG_DIR, name)
  const staging = `${target}.fetching-${process.pid}`
  writeFileSync(staging, bytes)
  renameSync(staging, target)
  process.stdout.write(`  wrote ${name} (${bytes.length} bytes)\n`)
}

const strays = readdirSync(PKG_DIR)
  .filter((name) => /\.exe$/i.test(name) && !REQUIRED.includes(name))
if (strays.length > 0) {
  process.stdout.write(`\nWARNING: ${PKG_DIR} still holds exes the lock does not name: ${strays.join(', ')}\n`)
  process.stdout.write('  test/artifact-check.mjs will fail on them — delete the leftovers.\n')
}

// --- 刷锁 -----------------------------------------------------------------

if (!flags.lock) {
  process.stdout.write('\nengine.lock not touched. add --lock to refresh it (it is the version-controlled record)\n')
  process.stdout.write('next: node plugin/scripts/engine-lock.mjs   (then node test/run.mjs)\n')
  process.exit(0)
}

const program = join(PKG_DIR, 'visible-ssh.exe')
const report = readSelfReport(program)
if (!report.ok) {
  fail(`installed the payload but could not read its self-reported identity: ${report.why}\n`
    + '  run engine-lock.mjs by hand and pass --commit/--version yourself.')
}
process.stdout.write(`\nself-report: version ${report.version ?? '?'} commit ${report.commit ?? '?'}\n`)
if (report.commit === 'no-vcs') {
  process.stdout.write('  note: this build carries no git identity (built without a tag) — the release tag is all we have.\n')
}

// 锁里的 upstream.built 记的是"这份产物什么时候对外发布"：上游的发布包只自报 version/commit，
// 没有构建时间，所以取 Release 的发布时间，并在标签里把这件事说清楚（别让人以为是构建时刻）。
const built = apiPublished !== null
  ? `${apiPublished} (release published; no build time is recorded)`
  : `${statSync(resolve(flags.fromZip)).mtime.toISOString()} (zip file mtime; no build time is recorded)`

const release = {
  repo,
  tag,
  asset: assetName,
  flavor,
  bytes: zipBytes.length,
  sha256: gotZipSha,
  ...(apiPublished !== null ? { published: apiPublished } : {}),
  renames: { ...RENAME },
}

process.stdout.write('\nrefreshing engine.lock\n')
const lockRun = spawnSync(process.execPath, [
  join(HERE, 'engine-lock.mjs'),
  '--commit', report.commit ?? 'unknown',
  '--built', built,
  '--version', report.version ?? 'unknown',
  '--release', JSON.stringify(release),
], { stdio: 'inherit', windowsHide: true })
if (lockRun.status !== 0) fail(`engine-lock.mjs exited ${lockRun.status ?? '?'}`)

process.stdout.write('\nnext: node test/run.mjs   (25 + 23 checks read the lock)\n')
process.stdout.write('      git add packages/engine-win32-x64/engine.lock packages/engine-win32-x64/package.json\n')

// --- 小工具 ---------------------------------------------------------------

/**
 * 读 exe 的自报身份。
 *
 * **刻意不接管道**：受限宿主里捕获子进程的管道会被拒（见 `test/run.mjs` 的说明），所以 stdout
 * 直接落到一个临时文件再读回来。stderr 也落在同一个文件里 —— 引擎的失败也会打 JSON。
 * @param {string} program
 * @returns {{ ok: boolean, version?: string | null, commit?: string | null, why?: string }}
 */
function readSelfReport(program) {
  const dir = join(CACHE, 'probe')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `version-${process.pid}.json`)
  const fd = openSync(out, 'w')
  let run
  try {
    // 只给 `version`：go 版引擎**没有** `--json` 旗标（它的输出本来就是 JSON，
    // `plugin/src/engine/locate.ts` 的 go 分支也是这么做的 —— 见那里的注释）。
    // 实测 v0.0.1：`--json version` → exit 2 `unknown flag`；`version --json` → exit 2 `unexpected argument(s) after the verb`。
    run = spawnSync(program, ['version'], {
      stdio: ['ignore', fd, fd], windowsHide: true, timeout: 30_000,
    })
  } finally {
    closeSync(fd)
  }
  let text = ''
  try {
    text = readFileSync(out, 'utf8')
  } catch {
    // 读不回来就走下面的"什么都没打印"
  }
  rmSync(out, { force: true })
  if (text.trim() === '') {
    const why = run.error !== undefined && run.error !== null
      ? `could not run it: ${run.error.message}`
      : `it printed nothing (exit ${run.status ?? '?'})`
    return { ok: false, why }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed.ok === false) return { ok: false, why: `it answered ok:false: ${text.trim().slice(0, 200)}` }
    return {
      ok: true,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      commit: typeof parsed.commit === 'string' ? parsed.commit : null,
    }
  } catch {
    return { ok: false, why: `it printed something other than JSON: ${text.trim().slice(0, 200)}` }
  }
}

// --- 极简 zip 读取器 ------------------------------------------------------

/**
 * 列出 zip 的中央目录。
 *
 * 只够读上游那两张附件：不认 zip64、不认加密、不认 data descriptor（那些我们在中央目录里读得到）。
 * 够用就好 —— 多一个依赖（或依赖系统 `tar`/`Expand-Archive`）不值当，而这份读取器能自己核 CRC。
 * @param {Buffer} buffer
 * @returns {{ name: string, method: number, crc: number, compressed: number, uncompressed: number, localOffset: number }[]}
 */
function unzip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) fail('that file is not a zip: no end-of-central-directory record')
  const count = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    fail('that zip is zip64, which this reader does not do (use a smaller archive)')
  }
  if (cdOffset + cdSize > buffer.length) fail('that zip has a central directory past the end of the file')
  const entries = []
  let at = cdOffset
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) fail(`zip central directory entry ${index} is malformed`)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    entries.push({
      name: buffer.toString('utf8', at + 46, at + 46 + nameLength),
      method: buffer.readUInt16LE(at + 10),
      crc: buffer.readUInt32LE(at + 16),
      compressed: buffer.readUInt32LE(at + 20),
      uncompressed: buffer.readUInt32LE(at + 24),
      localOffset: buffer.readUInt32LE(at + 42),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * 解一个条目，并核 CRC32 与长度。
 *
 * 我们只按中央目录里的名字挑条目、从不用它当路径写盘，所以路径穿越在这里没有着力点。
 * @param {Buffer} buffer
 * @param {{ name: string, method: number, crc: number, compressed: number, uncompressed: number, localOffset: number }} entry
 * @returns {Buffer}
 */
function readZipEntry(buffer, entry) {
  const at = entry.localOffset
  if (buffer.readUInt32LE(at) !== 0x04034b50) fail(`zip entry ${entry.name}: bad local header`)
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28)
  const raw = buffer.subarray(start, start + entry.compressed)
  let data
  if (entry.method === 0) data = Buffer.from(raw)
  else if (entry.method === 8) data = inflateRawSync(raw)
  else fail(`zip entry ${entry.name}: compression method ${entry.method} is not supported`)
  if (data.length !== entry.uncompressed) {
    fail(`zip entry ${entry.name}: ${data.length} bytes out of the archive, ${entry.uncompressed} expected`)
  }
  if (crc32(data) !== entry.crc) fail(`zip entry ${entry.name}: CRC32 does not match the archive`)
  return data
}

/** @param {Buffer} buffer @returns {number} */
function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let at = buffer.length - 22; at >= earliest; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) return at
  }
  return -1
}

/**
 * CRC32。
 *
 * 表挂在函数自己身上**懒建**：这个文件是"先执行、后声明"的（最上面那串模块体在解包时就调到这里
 * 了），模块级的 `const`/`let` 此刻还在 TDZ 里，`var` 又只会静默是 undefined。
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  const table = crc32.table ?? (crc32.table = (() => {
    const built = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      built[n] = c
    }
    return built
  })())
  let c = -1
  for (let index = 0; index < buffer.length; index += 1) {
    c = table[(c ^ buffer[index]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ -1) >>> 0
}
