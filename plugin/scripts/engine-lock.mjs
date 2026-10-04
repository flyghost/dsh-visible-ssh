#!/usr/bin/env node
/**
 * 刷新 `packages/engine-win32-x64/engine.lock` 的 `files` 段 —— 三个 exe 的字节数与 sha256。
 *
 * 为什么要有这个脚本：exe **不进 git**（`.gitignore` 忽略 `packages/engine-win32-x64/visible-ssh*.exe`），
 * 所以"现在这一组产物是什么"只能记在同目录的锁里，而手抄 sha256 是会抄错的 —— 那正是
 * `test/artifact-check.mjs` 存在的理由。这里把"抄写"变成"计算"。
 *
 *   node plugin/scripts/engine-lock.mjs            # 重算 files，写回锁
 *   node plugin/scripts/engine-lock.mjs --check     # 只比对，不写（CI 用）
 *   node plugin/scripts/engine-lock.mjs --commit 4d729fe --built "2026-10-03T06:24:53Z (release published)"
 *   node plugin/scripts/engine-lock.mjs --version v0.0.1 --release '{"repo":"flyghost/omnibus",…}'
 *
 * **只有 `files` 是算出来的。** `upstream`（产物来自哪个 commit、什么时候构建）、`release`
 * （这一版从哪个 Release 附件来、附件 sha256）与 `reported_version` 是**引擎项目与那次发布的
 * 事实**，脚本从旧锁里沿用，或用上面那几个 flag 覆盖 —— 那些值由 `engine-fetch.mjs --lock`
 * 从 Release API 与产物的自报身份里读出来传进来。这条脚本刻意**不自己执行** exe（受限宿主里
 * 捕获子进程输出会被拒，见 `test/run.mjs`），也不联网：它必须能在人手里直接跑通。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const PKG_DIR = join(REPO, 'packages', 'engine-win32-x64')
const LOCK = join(PKG_DIR, 'engine.lock')

/** 交付单元：三个 exe 必须同目录，所以三个一起记。 */
const REQUIRED = ['visible-ssh.exe', 'visible-ssh-askpass.exe', 'visible-ssh-launch.exe']

const COMMENT = [
  '引擎产物的身份锁。三个 exe 被 .gitignore 忽略（产物不提交），所以',
  "'这一组 exe 到底是什么' 唯一受版本管理的记录就在这里：files 是本目录里那份字节的",
  'sha256，release 说它们来自哪个 Release 附件（含附件自己的 sha256），upstream 与',
  'reported_version 是产物与那次发布的自述 —— 换版本时三处一起变。upstream.built 记的是',
  '那次发布对外的时间（上游的包只自报 version/commit，没有构建时间）。刷新产物跑',
  '`node plugin/scripts/engine-fetch.mjs --install --lock`，再跑 `node test/run.mjs`',
  '让 artifact-check 重新校验身份。流程见 docs/engine-artifacts.md。',
]

function usage(stream = process.stdout) {
  stream.write('usage: node plugin/scripts/engine-lock.mjs [--check] [--commit <sha>] [--built <when>] '
    + '[--version <ver>] [--release <json>]\n')
}

const argv = process.argv.slice(2)
const flags = { check: false, commit: null, built: null, version: null, release: null }
for (let index = 0; index < argv.length; index += 1) {
  const word = argv[index]
  if (word === '--check') { flags.check = true; continue }
  if (word === '--commit' || word === '--built' || word === '--version' || word === '--release') {
    const value = argv[index + 1]
    if (value === undefined) { usage(process.stderr); process.exit(2) }
    flags[word.slice(2)] = value
    index += 1
    continue
  }
  if (word === '--help' || word === '-h') { usage(); process.exit(0) }
  usage(process.stderr)
  process.exit(2)
}

/** `--release` 收一个 JSON 对象（`engine-fetch.mjs --lock` 就是这么传的）。 */
let releaseFlag = null
if (flags.release !== null) {
  try {
    const parsed = JSON.parse(flags.release)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('it is not a JSON object')
    }
    releaseFlag = parsed
  } catch (error) {
    process.stderr.write(`engine-lock: --release takes one JSON object: ${error.message}\n`)
    process.exit(2)
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// --- 产物必须在 -------------------------------------------------------------
const missing = REQUIRED.filter((name) => !existsSync(join(PKG_DIR, name)))
if (missing.length > 0) {
  process.stderr.write(
    `engine-lock: ${PKG_DIR} is missing ${missing.join(', ')}\n`
    + '             fetch a published release instead of copying by hand:\n'
    + '             node plugin/scripts/engine-fetch.mjs --install --lock\n'
    + '             (they are not in git — see docs/engine-artifacts.md).\n')
  process.exit(1)
}

let previous = null
if (existsSync(LOCK)) {
  try {
    previous = JSON.parse(readFileSync(LOCK, 'utf8'))
  } catch {
    process.stderr.write(`engine-lock: ${LOCK} is not JSON — refusing to guess what it meant, writing it afresh\n`)
  }
}

const files = {}
for (const name of REQUIRED) {
  const file = join(PKG_DIR, name)
  files[name] = { bytes: statSync(file).size, sha256: sha256(file) }
}

const release = releaseFlag ?? previous?.release ?? null
const lock = {
  _comment: COMMENT,
  engine: previous?.engine ?? 'visible-ssh',
  upstream: {
    project: previous?.upstream?.project ?? 'omnibus',
    product: previous?.upstream?.product ?? 'vssh',
    commit: flags.commit ?? previous?.upstream?.commit ?? 'unknown',
    built: flags.built ?? previous?.upstream?.built ?? 'unknown',
  },
  ...(release === null ? {} : { release }),
  reported_version: flags.version ?? previous?.reported_version ?? 'unknown',
  files,
}

// --- --check：只比对 ---------------------------------------------------------
if (flags.check) {
  if (previous === null) {
    process.stderr.write(`engine-lock: no usable ${LOCK} — run the script without --check to write one\n`)
    process.exit(1)
  }
  const same = JSON.stringify(previous) === JSON.stringify(lock)
  let filesSame = true
  for (const name of REQUIRED) {
    const before = previous?.files?.[name]
    const after = files[name]
    const verdict = before === undefined ? 'new'
      : before.sha256 === after.sha256 && before.bytes === after.bytes ? 'unchanged'
        : 'CHANGED'
    if (verdict !== 'unchanged') filesSame = false
    process.stdout.write(`${verdict.padEnd(10)} ${name}\n`)
  }
  if (!same) {
    process.stderr.write(filesSame
      ? 'engine-lock --check: the three exes are unchanged, but the rest of the lock differs '
        + '(its comment, upstream or reported version was rewritten) — re-run without --check and commit it\n'
      : 'engine-lock --check: the lock does not describe the payload on disk — '
        + 'run `node plugin/scripts/engine-lock.mjs` and commit the result\n')
    process.exit(1)
  }
  process.stdout.write('OK: engine.lock matches the payload on disk\n')
  process.exit(0)
}

// --- 写入 -------------------------------------------------------------------
mkdirSync(dirname(LOCK), { recursive: true })
writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`)
process.stdout.write(`wrote ${LOCK}\n`)
for (const name of REQUIRED) {
  const before = previous?.files?.[name]
  const changed = before === undefined ? 'new'
    : before.sha256 === files[name].sha256 && before.bytes === files[name].bytes ? 'unchanged' : 'CHANGED'
  process.stdout.write(`  ${changed.padEnd(10)} ${name}  ${files[name].bytes} bytes  ${files[name].sha256}\n`)
}
process.stdout.write(`upstream ${lock.upstream.commit} (${lock.upstream.built}), reported version ${lock.reported_version}\n`)
if (release !== null) {
  process.stdout.write(`release ${release.tag} ${release.asset} ${release.bytes} bytes sha256 ${String(release.sha256)}\n`)
}
process.stdout.write('next: node test/run.mjs   # artifact-check re-verifies the identity\n')
