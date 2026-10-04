/**
 * 产物身份校验：包里的 exe 是不是 `engine.lock` 说的那三个。
 *
 * exe **不进 git**（见 `packages/engine-win32-x64/README.md`），所以它们的身份只能记在
 * 同目录的锁里。于是每次宿主进程第一次要跑引擎之前，都拿锁对一遍字节数与 sha256 ——
 * 一次半旧的投放（换了 `visible-ssh.exe` 却忘了换 `visible-ssh-askpass.exe`）在引擎那边
 * 表现成"密码认证失败"，在这里表现成一句说得清的话。
 *
 * 磁盘访问与判定刻意分开：`verifyPayload()` 收一个可注入的哈希实现，单测能喂假数据；
 * `hashFile()` 是默认实现。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BridgeError, errorDetailOf } from './envelope.js'

/** `engine.lock` 里一条文件记录（只声明我们**用得上**的键）。 */
export interface LockEntry {
  bytes?: number
  sha256?: string
}

/**
 * `engine.lock` 的形状。锁是**产物项目**写的，所以这里只声明校验需要的字段，
 * 其余（`upstream`、`reported_version`）原样留在对象上供调用方读取。
 */
export interface EngineLockFile {
  engine?: string
  reported_version?: string
  upstream?: { project?: string; product?: string; commit?: string; built?: string }
  files?: Record<string, LockEntry>
}

/** 一次校验的结果：核过哪些文件名，以及那份锁本身。 */
export interface PayloadReport {
  checked: string[]
  lock: EngineLockFile
}

export interface VerifyOptions {
  /** 注入的哈希实现。给单测用，免得为了测判定逻辑在磁盘上摆真 exe。 */
  hash?: ((path: string) => string) | undefined
}

/** 锁在产物目录里的固定名字。 */
export function lockPath(dir: string): string {
  return join(dir, 'engine.lock')
}

/** 默认哈希实现：整份文件的 sha256（小写十六进制）。 */
export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 读一份锁。
 *
 * 缺锁与坏锁都抛 `BridgeError`：对平台包解析出来的那条路径来说，没有锁就意味着
 * 投放不全（不是"跳过校验"的理由）。
 */
export function readLock(dir: string): EngineLockFile {
  const path = lockPath(dir)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new BridgeError('spawn',
      `the engine payload has no engine.lock at ${path}: the drop-in is incomplete. `
      + 'Copy the three exes together with their lock (see docs/engine-artifacts.md).')
  }
  try {
    const parsed = JSON.parse(text) as EngineLockFile
    if (parsed.files === undefined || parsed.files === null) throw new Error('there is no "files" block')
    return parsed
  } catch (error) {
    throw new BridgeError('spawn', `engine.lock at ${path} is not usable: ${errorDetailOf(error)}`)
  }
}

/**
 * 核一遍 `dir` 里锁点名的每个文件。
 *
 * @param dir - 产物目录（三个 exe 与 `engine.lock` 同目录）。
 * @param options - 可注入的哈希实现。
 * @returns 已核过的文件名（字典序）与那份锁。
 */
export function verifyPayload(dir: string, options?: VerifyOptions): PayloadReport {
  const lock = readLock(dir)
  const files = lock.files ?? {}
  const names = Object.keys(files).sort()
  if (names.length === 0) {
    throw new BridgeError('spawn', `engine.lock at ${lockPath(dir)} lists no files`)
  }
  const hash = options?.hash ?? hashFile
  const checked: string[] = []
  for (const name of names) {
    const entry = files[name] ?? {}
    const path = join(dir, name)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      throw new BridgeError('spawn',
        `the engine payload is missing ${name} (engine.lock lists it). `
        + `Copy the three exes together into ${dir} (see docs/engine-artifacts.md).`)
    }
    if (typeof entry.bytes === 'number' && size !== entry.bytes) {
      throw new BridgeError('spawn',
        `the engine payload does not match engine.lock: ${name} is ${size} bytes, the lock says ${entry.bytes}.`)
    }
    const actual = hash(path)
    if (typeof entry.sha256 === 'string' && actual !== entry.sha256) {
      throw new BridgeError('spawn',
        `the engine payload does not match engine.lock: ${name} sha256 is ${actual}, the lock says `
        + `${entry.sha256} — the drop-in is stale or partial (see docs/engine-artifacts.md).`)
    }
    checked.push(name)
  }
  return { checked, lock }
}

/**
 * 目录里那几个**锁没点名**的 exe。
 *
 * 锁是权威：多出来的产物多半是上一个版本的残留（引擎换名字、少抄或多抄一个）。
 * 这条不在运行时拦（多一个文件不会让调用出错），留给 `test/artifact-check.mjs` 报警。
 */
export function unlistedPayload(dir: string, lock: EngineLockFile): string[] {
  const listed = new Set(Object.keys(lock.files ?? {}))
  try {
    return readdirSync(dir)
      .filter((name) => /^visible-ssh.*\.exe$/i.test(name) && !listed.has(name))
      .sort()
  } catch {
    return []
  }
}
