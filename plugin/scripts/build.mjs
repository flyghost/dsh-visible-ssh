#!/usr/bin/env node
/**
 * 构建插件：宿主侧交给 tsc，客户端半**逐字**拷贝。
 *
 * 这是构建的**唯一**定义 —— `plugin/package.json` 的 `build` 脚本、开发时的
 * `watch`，以及 `test/run.mjs` 的产物新鲜度门禁都走这里，免得 tsc 命令行在两处
 * 各写一遍后慢慢漂移。
 *
 * 用法：`npm run build`（在 `plugin/` 或仓库根都行）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // plugin/scripts
const PLUGIN = resolve(HERE, '..') // plugin/
const REPO = resolve(PLUGIN, '..') // 仓库根
const LIB = join(PLUGIN, 'lib')
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc')

// 插件运行时不依赖 npm（宿主提供一切），但**构建**它需要一个编译器。这句话是给
// 「刚克隆下来、还没装依赖」的人看的：他不是搞坏了什么，只是少了一步。
if (!existsSync(TSC)) {
  console.error([
    `build: no TypeScript compiler at ${TSC}`,
    'The plugin needs no npm at runtime, but building it does. Install the workspace first:',
    `  cd ${REPO} && npm install`,
  ].join('\n'))
  process.exit(1)
}

// 先整个删掉产物再编译。tsc 不会去删「源码已经不存在」的旧产物，于是删掉一个
// 模块之后，`lib/` 里那份旧 JS 仍然能被 import（这次拆 bridge.ts 就踩到了：
// `lib/engine/bridge.js` 活着，而 `src/engine/bridge.ts` 已经没了）。产物目录
// 本来就不受版本管理，重建是免费的。
rmSync(LIB, { recursive: true, force: true })

const compiled = spawnSync(process.execPath, [TSC, '-p', join(PLUGIN, 'tsconfig.json')], {
  stdio: 'inherit',
  cwd: PLUGIN,
})
if (compiled.status !== 0) process.exit(compiled.status ?? 1)

// 客户端半不进 tsc 的 program（见 tsconfig.json 的说明），由这个脚本逐字拷贝。
await import('./copy-client.mjs')
