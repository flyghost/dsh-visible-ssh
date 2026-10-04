/**
 * 本机 `~/.ssh/config` 的**只读**解析：把"这台机器配过哪些远端"变成设置界面里
 * 一行行可点的候选。
 *
 * 为什么是插件读、而且是**只读**：引擎自己不解析 ssh 配置（实测它的
 * `transport_ssh.c` 只是把 `user@host` 丢给 ssh.exe，于是 ssh 自己会去读
 * `~/.ssh/config`、展开 `HostName`、挑 `IdentityFile`——见 `docs/test-baseline.md`
 * 里那两条 `.ssh` 探针），所以"用 ssh 里配好的那台机器"**今天就能用**：把别名写进
 * `host` 就行。缺的只是"看得见"：这个文件从来没被谁列出来过。
 *
 * 边界，故意画得很小：
 *   * 不写、不改、不移动那个文件；这里只有 `readFileSync`。
 *   * 只读每个 `Host` 块里**直接写着**的 `HostName` / `User` / `Port` /
 *     `IdentityFile`；`Host *`（恰好一个通配）当作默认值补空，其他带通配或
 *     `!` 取反的段一律**不列**（它们不是"一台机器"）。
 *   * `Include`、`Match`、行内 `#` 之后的内容按 ssh 的规矩忽略/剥掉；不支持
 *     反斜杠续行。目的是"给人一份能挑的清单"，不是"替代 ssh 的解析器"。
 *   * 绝不读私钥内容：`IdentityFile` 只留**路径**给人看。
 *
 * 环境是**注入**的（`home` 由调用方给），所以单测喂一份文本就能跑，永远不碰真机。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 从 `~/.ssh/config` 里读出来的**一台**远端。 */
export interface SshConfigHost {
  /** `Host` 行里的别名（原样保留大小写）。写进插件的 `host` 的就是它。 */
  alias: string
  /** `HostName`；没写时等于别名（ssh 自己的行为）。 */
  hostName: string
  /** `User`，没写是 `null`（引擎要求 `user` 那一格有值，所以界面要提示）。 */
  user: string | null
  /** `Port`，没写或不是数字是 `null`（引擎也有自己的 `port`，以它为准）。 */
  port: number | null
  /** `IdentityFile` 的**路径**（`~` 已按家目录展开），仅用于展示。 */
  identityFile: string | null
}

/**
 * 一次读取的结果。
 *
 * `error` 只在**真的读不动**时才有值（权限、编码）：文件不存在是受支持的状态
 * （一台机器没配过 ssh 别名很常见），那时 `hosts` 是空的、`error` 是 `null`。
 */
export interface SshHostList {
  /** 被读的那个文件，或 `null`（这台机器没有可用的家目录）。 */
  path: string | null
  hosts: SshConfigHost[]
  error: string | null
}

/** 一个 `Host` 段：别名，以及块里直接写着的键值。 */
interface Block {
  aliases: string[]
  values: Map<string, string>
}

/**
 * 解析 `~/.ssh/config` 的**文本**。
 *
 * @param text - 那个文件的全文。
 * @param home - 用来展开 `IdentityFile` 开头的 `~`；没有家目录就传空串。
 * @returns 按文件顺序排列的候选；带通配/取反的段不在里面。
 */
export function parseSshConfig(text: string, home = ''): SshConfigHost[] {
  const blocks: Block[] = []
  let current: Block | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim()
    if (line === '') continue
    // `Key value` 与 `Key=value` 两种写法 ssh 都认；键名大小写不敏感。
    const pair = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(line)
    if (pair === null) continue
    const key = (pair[1] ?? '').toLowerCase()
    const value = unquote(pair[2] ?? '')
    if (key === 'host') {
      current = { aliases: value.split(/\s+/).filter((alias) => alias !== ''), values: new Map() }
      blocks.push(current)
      continue
    }
    // `Host` 之前的东西是全局选项，不属于任何一台机器。
    if (current === null) continue
    // ssh 的规矩：同一个段里**第一个**出现的值胜出。
    if (!current.values.has(key)) current.values.set(key, value)
  }

  // `Host *` 是常见的"放默认值"写法；只补段里没写过的键（近似 ssh 的顺序语义：
  // 第一个匹配到的值胜出，而自己段里的值总在通配之前）。
  const defaults = new Map<string, string>()
  for (const block of blocks) {
    if (block.aliases.length !== 1 || block.aliases[0] !== '*') continue
    for (const [key, value] of block.values) if (!defaults.has(key)) defaults.set(key, value)
  }

  const hosts: SshConfigHost[] = []
  for (const block of blocks) {
    // 通配段（`*`、`alias-*`、`!bad`）不是"一台机器"，不列进候选。
    if (block.aliases.some((alias) => /[*?!]/.test(alias))) continue
    for (const alias of block.aliases) {
      const read = (key: string): string | null => block.values.get(key) ?? defaults.get(key) ?? null
      hosts.push({
        alias,
        hostName: read('hostname') ?? alias,
        user: read('user'),
        port: parsePort(read('port')),
        identityFile: expandHome(read('identityfile'), home),
      })
    }
  }
  return hosts
}

/**
 * 读一个 `~/.ssh/config`。
 *
 * @param path - 要读的文件（`config.ts` 的 `cfg.sshConfigPath`），或 `null`。
 * @param read - 读文件的方式；默认真读，单测喂假的。
 * @returns 候选清单；任何读取问题都变成 `error`，从不抛错。
 */
export function loadSshHosts(path: string | null, read: (path: string) => string | null = readTextIfPossible): SshHostList {
  if (path === null || path === '') return { path: null, hosts: [], error: null }
  let text: string | null
  try {
    text = read(path)
  } catch (error) {
    return { path, hosts: [], error: error instanceof Error ? error.message : String(error) }
  }
  // 文件不在是正常状态：这台机器没配过 ssh 别名。
  if (text === null) return { path, hosts: [], error: null }
  // 家目录从路径本身推：约定这份文件就在 `<home>/.ssh/config`。
  return { path, hosts: parseSshConfig(text, dirname(dirname(path))), error: null }
}

/** 读一份文本文件；读不到就是 `null`（不存在、没权限、是目录都算）。 */
function readTextIfPossible(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 砍掉行里 `#` 之后的部分（ssh 的注释就这一种）。 */
function stripComment(line: string): string {
  const at = line.indexOf('#')
  return at === -1 ? line : line.slice(0, at)
}

/** 去掉一层配对的引号并去空白；`Key=value` 右边多余的空格也在这里吃掉。 */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/** `Port` 只认 1–65535 的整数，其余（含没写）是 `null`。 */
function parsePort(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  const port = Number(value)
  return port >= 1 && port <= 65535 ? port : null
}

/** 把开头的 `~` 换成家目录；没有家目录或不是 `~` 开头就原样返回。 */
function expandHome(value: string | null, home: string): string | null {
  if (value === null || value === '') return null
  if (home === '') return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}
