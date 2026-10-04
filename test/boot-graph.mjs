// 把 Chromium 为渲染进程缓存的每一个
// `globalThis["__DSH_BOOT__"] = {...}` 图都抽出来，并报告我们插件的客户端模块
// 是否在其中。
//
//   node test/boot-graph.mjs
//
// 为什么要看这张图：客户端模块系统里某个模块加载失败，**不会**让渲染进程启动
// 失败，所以「健康」什么也说明不了。这张图才能说明：如果我们的那一行不在，说明
// 宿主根本没提供这个 bundle；如果在，说明 bundle 已经发出去了，失败发生在执行期。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Electron 的 user-data 根目录逐机器而异 —— 而且**它是操作者机器上的东西**，所以
// 这个工具不替你去猜：要么 `DSH_USERDATA=<…>\DSH Desktop`，要么把缓存目录直接当
// 第一个参数给它，都没有就说出来并停下（既不崩掉，也不默认翻自己的 `%APPDATA%`）。
const USER_DATA = process.env.DSH_USERDATA
const given = process.argv[2]
const CACHE = given ?? (USER_DATA === undefined || USER_DATA === '' ? null : join(USER_DATA, 'Partitions', 'dsh-desktop-renderer', 'Cache', 'Cache_Data'))
if (CACHE === null) {
  console.log(JSON.stringify({ skipped: 'no Electron user-data root given — this tool never guesses where your machine keeps it. Set DSH_USERDATA (usually %APPDATA%\\DSH Desktop) or pass the cache directory as the first argument, e.g. node test/boot-graph.mjs "%APPDATA%\\DSH Desktop\\Partitions\\dsh-desktop-renderer\\Cache\\Cache_Data"' }, null, 2))
  process.exit(0)
}
if (!existsSync(CACHE)) {
  console.log(JSON.stringify({ skipped: `no Electron user-data cache at ${CACHE} (set DSH_USERDATA, or pass a cache dir)` }, null, 2))
  process.exit(0)
}
const NEEDLE = Buffer.from('globalThis["__DSH_BOOT__"] = ')
const MINE = 'dsh-visible-ssh'

/** 从 `from` 起第一个 `{` 开始，做花括号配平扫描。 */
function objectAt(text, from) {
  const start = text.indexOf('{', from)
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

const found = []
let files = 0
for (const name of readdirSync(CACHE)) {
  const path = join(CACHE, name)
  let stat
  try { stat = statSync(path) } catch { continue }
  if (!stat.isFile() || stat.size === 0) continue
  files += 1
  const bytes = readFileSync(path)
  let at = bytes.indexOf(NEEDLE)
  let index = 0
  while (at !== -1) {
    index += 1
    const text = bytes.subarray(at).toString('utf8')
    const raw = objectAt(text, 0)
    if (raw !== null) {
      const row = { file: name, size: stat.size, at, mtime: stat.mtime.toISOString(), index }
      try {
        const graph = JSON.parse(raw)
        const entries = Array.isArray(graph.entries) ? graph.entries : []
        row.graphRev = graph.rev
        row.entries = entries.length
        row.entryIds = entries.map((entry) => entry.id)
        row.mine = entries.filter((entry) => String(entry.id).includes(MINE) || JSON.stringify(entry).includes(MINE))
        row.batches = (graph.batches ?? []).map((batch) => ({ phase: batch.phase, url: batch.url, ids: batch.entries?.length }))
      } catch (error) {
        row.parseError = String(error.message)
        row.rawHead = raw.slice(0, 200)
      }
      found.push(row)
    }
    at = bytes.indexOf(NEEDLE, at + NEEDLE.length)
  }
}

console.log(JSON.stringify({
  cacheFiles: files,
  graphs: found.map((row) => ({
    file: row.file,
    at: row.at,
    mtime: row.mtime,
    graphRev: row.graphRev,
    entries: row.entries,
    hasMine: row.mine !== undefined && row.mine.length > 0,
    mine: row.mine,
    batches: row.batches,
    parseError: row.parseError,
  })),
}, null, 2))
