/**
 * `plugin/src/engine/exec.ts` —— 无管道回退路的暂存文件清理。
 *
 * 为什么非要有这个 spec：**清理失败曾经把一次成功的调用变成失败**。`watch` 这条 verb
 * 会在本机拉起一个真控制台，那个控制台一直攥着 `.out` 的句柄，于是收尾的 `unlink` 报
 * EBUSY，异常从 `finally` 里抛出去、盖掉本来已经拿到的结果 —— 面板上就多出一行
 * `bridge: EBUSY: resource busy or locked, unlink '…'`。所以这条路径现在有两个义务：
 *
 *   * 删不掉不是错误（第三项检查用一个**目录**冒充删不掉的暂存文件，`rm` 不带
 *     `recursive` 一定会失败，正是这里要吞掉的那类失败）；
 *   * 陈旧文件按年龄收走，否则宿主 tmpdir 里会堆到几百个（第一项检查）。
 *
 * 临时目录按本仓规矩落在 `test/env/tmp/`（gitignore），跑完删掉。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { sweepSpoolDir } from '../../plugin/lib/engine/exec.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(resolve(HERE, '..', 'env', 'tmp'), 'unit-spool')
mkdirSync(ROOT, { recursive: true })

const TTL = 60 * 60 * 1000

/** 造一个暂存目录，并把给定名字的文件的 mtime 推回 `ageMs` 之前。 */
function spoolDir(names) {
  const dir = mkdtempSync(join(ROOT, 'spool-'))
  const now = Date.now()
  for (const [name, ageMs] of Object.entries(names)) {
    writeFileSync(join(dir, name), 'x')
    const seconds = (now - ageMs) / 1000
    utimesSync(join(dir, name), seconds, seconds)
  }
  return dir
}

const dirs = []
function fresh(names) {
  const dir = spoolDir(names)
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('sweepSpoolDir', () => {
  it('sweeps what is older than the ttl and leaves the rest', async () => {
    const dir = fresh({ 'old.out': 2 * TTL, 'old.err': 2 * TTL, 'old.cmd': 2 * TTL, 'fresh.out': 1000 })
    const removed = await sweepSpoolDir(dir, TTL)
    expect(removed.sort()).toEqual(['old.cmd', 'old.err', 'old.out'])
    expect(existsSync(join(dir, 'old.out'))).toBe(false)
    expect(existsSync(join(dir, 'old.err'))).toBe(false)
    expect(existsSync(join(dir, 'old.cmd'))).toBe(false)
    expect(existsSync(join(dir, 'fresh.out'))).toBe(true)
  })

  it('leaves anything that is not a spool file alone', async () => {
    const dir = fresh({ 'notes.txt': 2 * TTL, 'host.toml': 2 * TTL, 'stale.out': 2 * TTL })
    const removed = await sweepSpoolDir(dir, TTL)
    expect(removed).toEqual(['stale.out'])
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
    expect(existsSync(join(dir, 'host.toml'))).toBe(true)
  })

  it('does not throw when a spool file cannot be removed', async () => {
    const dir = fresh({})
    // 一个**非空目录**冒充删不掉的暂存文件：`rm` 不带 `recursive` 必然失败
    // （ENOTEMPTY，正好是 `rm` 会重试的那一类），重试到底也删不掉。
    mkdirSync(join(dir, 'stuck.out'))
    writeFileSync(join(dir, 'stuck.out', 'held'), 'x')
    const seconds = (Date.now() - 2 * TTL) / 1000
    utimesSync(join(dir, 'stuck.out'), seconds, seconds)
    await expect(sweepSpoolDir(dir, TTL)).resolves.toEqual([])
    expect(existsSync(join(dir, 'stuck.out'))).toBe(true)
  })

  it('a missing directory is not an error', async () => {
    const missing = join(ROOT, 'never-created')
    await expect(sweepSpoolDir(missing, TTL)).resolves.toEqual([])
  })
})
