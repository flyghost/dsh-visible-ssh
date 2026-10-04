#!/usr/bin/env node
/**
 * `host.toml` 在哪儿 —— 看，或者把模板种到用户目录去。
 *
 * 为什么要有这个脚本：引擎只认 `--config`（或 `SSH_CONFIG`），**自己不读用户目录**（实测
 * `%APPDATA%\visible-ssh\host.toml` 它从不看）。所以"配置属于操作者"这件事由插件侧做：
 * `plugin/src/engine/config.ts` 的 `chooseHostConfig()` 按
 *
 *   config.configPath  >  SSH_CONFIG  >  用户目录  >  仓内 scripts/config/host.toml
 *
 * 选一份，再用 `--config <绝对路径>` 交给引擎。这里把同一个答案摆到人眼前，并提供"把模板
 * 种到用户目录"这一步 —— 装到别的机器时，那通常是唯一需要手工填的东西。
 *
 *   node plugin/scripts/host-config.mjs path      # 只打印生效的那份（给脚本用）
 *   node plugin/scripts/host-config.mjs show      # 四个候选、谁存在、谁被选中
 *   node plugin/scripts/host-config.mjs install   # 把模板种到用户目录（已存在则拒绝）
 *   node plugin/scripts/host-config.mjs install --force
 *
 * **本脚本从不打印任何 `host.toml` 的内容** —— 那份文件里有密码（理由见
 * `docs/engine-artifacts.md`）。它只谈路径。
 *
 * 它读 `plugin/lib/engine/config.js`：同一份解析逻辑，不在这里重抄一遍，所以先
 * `npm run build`（或直接跑 `node test/run.mjs`，它会先构建）。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

function usage(stream = process.stdout) {
  stream.write('usage: node plugin/scripts/host-config.mjs <path|show|install> [--force]\n')
}

let config = null
try {
  config = await import('../lib/engine/config.js')
} catch {
  process.stderr.write('host-config: plugin/lib/ is not built yet — run `npm run build` first '
    + '(or `node test/run.mjs`, which builds before it tests)\n')
  process.exit(1)
}

const { resolveConfig, systemConfigRoots, userConfigPath } = config
const cfg = resolveConfig(undefined)
const roots = systemConfigRoots(process.env)
const user = userConfigPath(roots)
const repo = join(cfg.repoRoot, 'scripts', 'config', 'host.toml')
const fromEnv = process.env.SSH_CONFIG === undefined || process.env.SSH_CONFIG === ''
  ? null
  : process.env.SSH_CONFIG

/**
 * 四个候选，按优先级。
 * @returns 每项是 `{ name, path, exists, note }`；`path` 为 `null` 表示这个平台推不出来。
 */
function candidates() {
  return [
    { name: 'config', path: cfg.configPath === null || cfg.configSource !== 'config' ? null : cfg.configPath, note: 'plugin config { configPath: … }' },
    { name: 'env', path: fromEnv, note: 'SSH_CONFIG' },
    { name: 'user', path: user, note: `%APPDATA%\\visible-ssh (win32) / $XDG_CONFIG_HOME/visible-ssh` },
    { name: 'repo', path: repo, note: 'inside this repository' },
  ].map((entry) => ({ ...entry, exists: entry.path === null ? false : existsSync(entry.path) }))
}

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const words = argv.filter((word) => word !== '--force')
const verb = words[0]

if (verb === undefined || verb === '--help' || verb === '-h') {
  usage(verb === undefined ? process.stderr : process.stdout)
  process.exit(verb === undefined ? 2 : 0)
}

if (verb === 'path') {
  process.stdout.write(`${cfg.configPath ?? '(none)'}\n`)
  process.exit(0)
}

if (verb === 'show') {
  const rows = candidates()
  process.stdout.write(`${JSON.stringify({
    effective: cfg.configPath === null ? null : { path: cfg.configPath, source: cfg.configSource },
    candidates: rows,
    example: join(REPO, 'scripts', 'config', 'host.toml.example'),
    note: 'contents are never printed here: that file holds a password',
  }, null, 2)}\n`)
  process.exit(0)
}

if (verb === 'install') {
  if (user === null) {
    process.stderr.write('host-config: cannot tell where this platform keeps user configuration '
      + '(neither APPDATA nor HOME is set) — copy the example there yourself:\n'
      + `             ${join(REPO, 'scripts', 'config', 'host.toml.example')}\n`)
    process.exit(1)
  }
  const example = join(REPO, 'scripts', 'config', 'host.toml.example')
  if (!existsSync(example)) {
    process.stderr.write(`host-config: ${example} is missing — that template ships in git; re-check the checkout\n`)
    process.exit(1)
  }
  if (existsSync(user) && !force) {
    process.stderr.write(`host-config: ${user} already exists — refusing to overwrite it.\n`
      + '             Look at it (`show` prints paths only), or re-run with --force to replace it\n'
      + '             (the old file is then gone: this tool keeps no copy).\n')
    process.exit(1)
  }
  mkdirSync(dirname(user), { recursive: true })
  copyFileSync(example, user)
  process.stdout.write(`wrote ${user}\n`)
  process.stdout.write('next: open it and fill in [host] host / port / user (password may stay in the\n')
  process.stdout.write('      environment via password_env = "SSH_PASSWORD"), then restart the host —\n')
  process.stdout.write('      `node plugin/scripts/host-config.mjs path` shows which file the plugin picked.\n')
  process.exit(0)
}

usage(process.stderr)
process.exit(2)
