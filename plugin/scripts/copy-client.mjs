#!/usr/bin/env node
/**
 * 把客户端半**逐字**拷进 lib/。
 *
 * 为什么不交给 tsc：`src/client/index.js` 的契约就是「这份文件原样交给浏览器的
 * `window.__ModuleLoader__`」—— 一个没有 import/export 的单文件脚本。tsc 是从 AST
 * 重新打印的，它不但会重排版，还会在 `"type": "module"` 的包里给这样的文件末尾补一个
 * `export {}`，把它变成 ES 模块；那样这份文件就不再是它自己了。宿主侧由
 * `tsc -p tsconfig.json` 编译（tsconfig 里 exclude 了 `src/client`），这个脚本只负责
 * 这一个文件。
 *
 * 用法：`node scripts/copy-client.mjs`（由 `npm run build` 在 tsc 之后调用）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // plugin/scripts
const PLUGIN = resolve(HERE, '..') // plugin/
const SOURCE = join(PLUGIN, 'src', 'client', 'index.js')
const TARGET = join(PLUGIN, 'lib', 'client', 'index.js')

const source = readFileSync(SOURCE)
mkdirSync(dirname(TARGET), { recursive: true })
writeFileSync(TARGET, source)

// 逐字校验：这次拷贝的全部意义就是字节相同，所以在这里当场断言，而不是等谁去 diff。
const copied = readFileSync(TARGET)
if (!source.equals(copied)) {
  console.error(`copy-client: ${TARGET} does not match ${SOURCE}`)
  process.exit(1)
}
console.log(`copy-client: ${source.length} bytes -> ${TARGET}`)
