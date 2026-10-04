/**
 * `plugin/src/engine/verify.ts` —— 产物身份校验。
 *
 * 这个 spec 是**真的碰磁盘**的，因为它要钉住的三类失败都发生在磁盘上：文件缺了、
 * 字节数不对、sha256 对不上。判定的那一半刻意与磁盘访问分开（`verifyPayload` 收一个
 * 可注入的哈希实现），所以"哈希不对"这一步不用为了测它去造一个 sha256 真对不上的文件。
 *
 * 临时目录按本仓规矩落在 `test/env/tmp/`（gitignore），跑完删掉。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { hashFile, lockPath, readLock, unlistedPayload, verifyPayload } from '../../plugin/lib/engine/verify.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = resolve(HERE, '..', 'env', 'tmp')
const ROOT = join(TMP, 'unit-verify')
mkdirSync(ROOT, { recursive: true })

const THREE = ['visible-ssh.exe', 'visible-ssh-askpass.exe', 'visible-ssh-launch.exe']

/** 造一个"投放"目录：写文件、写锁，返回目录。 */
function dropIn(options = {}) {
  const dir = mkdtempSync(join(ROOT, 'payload-'))
  const body = options.body ?? 'exe'
  for (const name of THREE) writeFileSync(join(dir, name), body)
  if (options.lock !== null) {
    const files = {}
    for (const name of THREE) {
      files[name] = {
        bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
      }
    }
    const lock = { engine: 'visible-ssh', reported_version: '0.0.1-c1', files }
    writeFileSync(lockPath(dir), options.raw ?? JSON.stringify(lock, null, 2))
  }
  return dir
}

/** 改一个已投放的锁：读出 JSON、交给 mutator、写回。 */
function rewriteLock(dir, mutator) {
  const lock = JSON.parse(readFileSync(lockPath(dir), 'utf8'))
  mutator(lock)
  writeFileSync(lockPath(dir), JSON.stringify(lock))
}

function thrown(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('readLock', () => {
  it('points at engine.lock inside the payload directory', () => {
    expect(lockPath('E:/pkg')).toBe(join('E:/pkg', 'engine.lock'))
  })

  it('reports a missing lock as an incomplete drop-in, not as "skip the check"', () => {
    const dir = dropIn({ lock: null })
    const error = thrown(() => readLock(dir))
    expect(error).not.toBeNull()
    expect(error.kind).toBe('spawn')
    expect(error.message).toContain('has no engine.lock at')
    expect(error.message).toContain('the drop-in is incomplete')
  })

  it('refuses a lock that is not JSON', () => {
    const dir = dropIn({ raw: 'not json at all' })
    const error = thrown(() => readLock(dir))
    expect(error.message).toContain('is not usable')
  })

  it('refuses a lock without a files block', () => {
    const dir = dropIn({ raw: JSON.stringify({ engine: 'visible-ssh' }) })
    expect(thrown(() => readLock(dir)).message).toContain('is not usable')
  })

  it('hands back the lock itself, including the fields it does not use', () => {
    const dir = dropIn()
    expect(readLock(dir).reported_version).toBe('0.0.1-c1')
  })
})

describe('verifyPayload', () => {
  it('accepts a payload that matches the lock, and names what it checked', () => {
    const dir = dropIn()
    const report = verifyPayload(dir)
    expect(report.checked).toEqual([...THREE].sort())
    expect(report.lock.files).toHaveProperty('visible-ssh.exe')
  })

  it('reports a listed file that is not there', () => {
    const dir = dropIn()
    rmSync(join(dir, 'visible-ssh-askpass.exe'))
    const error = thrown(() => verifyPayload(dir))
    expect(error.kind).toBe('spawn')
    expect(error.message).toContain('is missing visible-ssh-askpass.exe')
    expect(error.message).toContain('see docs/engine-artifacts.md')
  })

  it('reports a size mismatch with both numbers', () => {
    const dir = dropIn()
    rewriteLock(dir, (lock) => { lock.files['visible-ssh.exe'].bytes = 999999 })
    const error = thrown(() => verifyPayload(dir))
    expect(error.message).toContain('is 3 bytes, the lock says 999999')
  })

  it('reports a sha256 mismatch — the "stale or partial drop-in" case', () => {
    const dir = dropIn()
    rewriteLock(dir, (lock) => { lock.files['visible-ssh-launch.exe'].sha256 = 'deadbeef' })
    const error = thrown(() => verifyPayload(dir))
    expect(error.message).toContain('sha256 is')
    expect(error.message).toContain('the lock says deadbeef')
    expect(error.message).toContain('the drop-in is stale or partial')
  })

  it('takes an injected hash, so the decision can be tested without a real digest', () => {
    const dir = dropIn()
    rewriteLock(dir, (lock) => {
      for (const name of THREE) lock.files[name].sha256 = 'injected'
    })
    expect(verifyPayload(dir, { hash: () => 'injected' }).checked).toEqual([...THREE].sort())
    expect(thrown(() => verifyPayload(dir, { hash: () => 'other' })).message).toContain('the lock says injected')
  })

  it('refuses a lock that lists nothing at all', () => {
    const dir = dropIn({ raw: JSON.stringify({ engine: 'visible-ssh', files: {} }) })
    expect(thrown(() => verifyPayload(dir)).message).toContain('lists no files')
  })

  it('checks the payload in a stable (sorted) order, so the first failure is deterministic', () => {
    const dir = dropIn()
    for (const name of THREE) rmSync(join(dir, name))
    expect(thrown(() => verifyPayload(dir)).message).toContain('is missing visible-ssh-askpass.exe')
  })
})

describe('unlistedPayload', () => {
  it('names the exes the lock does not mention, and ignores everything else', () => {
    const dir = dropIn()
    writeFileSync(join(dir, 'visible-ssh-old.exe'), 'stale')
    writeFileSync(join(dir, 'README.md'), '# not an exe')
    expect(unlistedPayload(dir, readLock(dir))).toEqual(['visible-ssh-old.exe'])
  })

  it('is empty for a payload that is exactly what the lock says', () => {
    const dir = dropIn()
    expect(unlistedPayload(dir, readLock(dir))).toEqual([])
  })

  it('does not throw for a directory that is not there', () => {
    expect(unlistedPayload(join(ROOT, 'nope'), {})).toEqual([])
  })
})

describe('hashFile', () => {
  it('is a plain sha256 of the whole file', () => {
    const file = join(ROOT, 'hash-me.bin')
    writeFileSync(file, 'abc')
    expect(hashFile(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(existsSync(file)).toBe(true)
  })
})
