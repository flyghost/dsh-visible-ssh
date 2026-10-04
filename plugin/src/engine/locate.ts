/**
 * 引擎**在哪**、以及它接受什么样的 argv —— 这两件事只在这里决定。
 *
 * **位置**：编出来的引擎是一个**平台包**（`dsh-visible-ssh-engine-win32-x64`，见
 * `packages/engine-win32-x64/README.md`）。插件把它声明成 `optionalDependencies`，
 * 于是 `require.resolve()` 在开发期解到 workspace 的 `node_modules/` 链接、装到别的机器
 * 时解到同层的 `node_modules/`——**不拼任何仓库内路径**。显式配置的 `exeEntry` 优先，
 * 用来指向别处的一份产物。解析不到时**不回退**：一条说不清"引擎在哪"的报错，比一条把
 * 沙箱的 EPERM 说成"CLI 没输出 JSON"的报错有用得多。
 *
 * **argv**：有意支持两个引擎（M5）：编译出来的 exe 是默认，Python 参考实现作为备用，
 * 直到 M6 把它删掉。两者有两处不一致，**都是实测的**，其中一处还会**静默**失败：
 *
 *   1. `--json` 只在 Python 里存在，在那里它是一个 subparser flag。C CLI 总是输出
 *      信封（`main.c`：「this CLI always emits JSON」），所以那里根本没有这个
 *      flag：传它得到的是 `flag provided but not defined: -json`。
 *   2. FLAG 位置。Python 接受把 `--json` / `--timeout` 写在 verb **之后**；C 引擎
 *      要求每个 flag 都在 verb **之前**。对 `run` 而言，C 侧会把 verb 之后的
 *      内容拼进命令，所以未翻译的
 *      `run --json --timeout 30 -- df -h /` **不会**报错 —— 它会在 pane 里执行
 *      字面字符串 `--json --timeout 30 -- df -h /`。因此翻译不是装点门面。
 *
 * 调用方保持一种规范 argv 形状，并且永远不知道实际跑的是哪个引擎。
 *
 * **配置**：`cfg.configPath` 非空时，这里把 `--config <绝对路径>` 插到**最前面**
 * （每个 flag 都在 verb 之前，实测 `status --config x` 会被判成 usage 错）。引擎
 * 原样使用这个参数、不解析它，所以 `config.ts` 解析出来的路径必须是绝对的。调用方
 * 自己带了 `--config` 时不插第二份。`engine: 'python'` 分支**不做这件事**：参照实现
 * 有自己的发现逻辑，而两条路都认 `SSH_CONFIG` 环境。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { BridgeError, errorCodeOf, errorDetailOf } from './envelope.js'
import type { ResolvedConfig } from './config.js'

/** 一个可执行文件与它的参数，可直接交给 `spawn`。 */
export interface EngineCommand {
  /** 可执行文件：编译产物的**绝对**路径，或 Python 引擎的解释器名。 */
  program: string
  args: string[]
}

/** 引擎产物解析到哪里，以及它是怎么被定下来的。 */
export interface EngineTarget {
  /** 绝对路径的 CLI。 */
  program: string
  /** `config` = 显式 `exeEntry`；`package` = 平台包解析。 */
  source: 'config' | 'package'
  /** 该产物所在目录（校验 `engine.lock` 的地方）；显式 `exeEntry` 时为 `null`。 */
  packageDir: string | null
}

/** 平台包的名字前缀；完整名字见 `enginePackageName()`。 */
const PACKAGE_PREFIX = 'dsh-visible-ssh-engine'

/** 解析平台包时用的 `require`，锚在**本文件**的位置上（见文件头注释）。 */
const requireFromHere = createRequire(import.meta.url)

/** 已解出的包目录，按包名缓存：`require.resolve` 每次都要走一遍文件系统。 */
const resolvedPackages = new Map<string, string>()

/**
 * 这个平台的产物包叫什么。
 *
 * 名字与 npm 生态里的平台包一致（`os`/`cpu` 由包自己的清单声明），因此装到一个
 * 没有对应产物的平台上时，`optionalDependencies` 会**静静地跳过**它，而这里会给出
 * 一句说得清的话（见 `enginePackageMissingError`）。
 */
export function enginePackageName(platform: string = process.platform, arch: string = process.arch): string {
  return `${PACKAGE_PREFIX}-${platform}-${arch}`
}

/** 解出某个平台包的目录（缓存）。解不到就是 `enginePackageMissingError`。 */
export function enginePackageDir(name: string = enginePackageName()): string {
  const cached = resolvedPackages.get(name)
  if (cached !== undefined) return cached
  let manifest: string
  try {
    manifest = requireFromHere.resolve(`${name}/package.json`)
  } catch {
    throw enginePackageMissingError(name)
  }
  const dir = dirname(manifest)
  resolvedPackages.set(name, dir)
  return dir
}

/**
 * 这一次调用该跑哪个可执行文件。
 *
 * @param cfg - 已解析的配置；`exeEntry` 非空就按它走，否则解析平台包。
 * @returns 程序路径、来源、以及要校验的目录。
 */
export function resolveEngine(cfg: ResolvedConfig): EngineTarget {
  if (cfg.exeEntry !== null) {
    return { program: cfg.exeEntry, source: 'config', packageDir: null }
  }
  const dir = enginePackageDir()
  return { program: join(dir, 'visible-ssh.exe'), source: 'package', packageDir: dir }
}

/**
 * 这个 argv 里有没有这个 flag（只看形状：带值的 flag 只看它的名字）。
 * @param argv - 调用方给的规范 argv。
 * @param flag - 例如 `'--config'`。
 */
function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((word) => word === flag)
}

/**
 * 把调用方的规范 argv 转成这个引擎接受的程序与 argv。
 *
 * 丢弃一个等于 `--json` 的元素是安全的，因为调用方唯一会加的非 flag 元素就是 `run`
 * 的命令，而它是一个**单独**的 argv 元素：命令字符串里的 `--json` 绝不可能自己成为
 * 一个元素。
 *
 * @param cfg - 已解析的配置；它的 `engine` 决定走哪个分支。
 * @param argv - 调用方的规范 argv，例如 `['--session', 'x', 'status', '--json']`。
 * @param program - 已经解好的可执行文件；不给时按 `resolveEngine()` 现解（单测直接喂它，
 *                  免得为了一份 argv 翻译去碰文件系统）。
 * @returns `{ program, args }`，可直接交给 `spawn`。
 */
export function engineCommand(cfg: ResolvedConfig, argv: readonly string[], program?: string): EngineCommand {
  if (cfg.engine === 'python') {
    // Python 自己的形状**就是**规范形状：flag 在 verb 之后，`--json` 保留。
    return { program: cfg.python, args: [cfg.pythonEntry, ...argv] }
  }
  const flags: string[] = []
  // 配置先于一切：它决定这次调用读哪份 host.toml，而引擎要求 flag 都在 verb 之前。
  // 调用方已经给了 `--config` 就尊重调用方那一份（`hasFlag` 只看形状，不看值）。
  if (cfg.configPath !== null && !hasFlag(argv, '--config')) flags.push('--config', cfg.configPath)
  const rest: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    // `noUncheckedIndexedAccess` 把索引访问标成可能 `undefined`。argv 是调用方现造的
    // 紧凑数组，循环条件已保证这个下标在界内 —— 这两个早退在真实输入上**不可达**，
    // 只是把「界内」这件事写进类型里。
    if (word === undefined) break
    if (word === '--json') continue
    if (word === '--timeout' && index + 1 < argv.length) {
      const value = argv[index + 1]
      if (value === undefined) break
      flags.push(word, value)
      index += 1
      continue
    }
    rest.push(word)
  }
  return { program: program ?? resolveEngine(cfg).program, args: [...flags, ...rest] }
}

/**
 * 这个平台**压根没有**产物包时的说法。
 *
 * 一份刚 `git clone` 下来的仓库就是这种状态：exe 不进 git，只有跑过一次
 * `npm install` 才有那条 `node_modules/` 链接。所以说清三件事：怎么补上、产物为什么不
 * 在包里、以及不想放产物时怎么切到 Python。
 */
export function enginePackageMissingError(name: string): BridgeError {
  return new BridgeError('spawn',
    `cannot run the engine: no package ${name} for this platform (require.resolve did not find it). `
    + 'The compiled engine ships as a platform package that the plugin declares as an optional dependency: '
    + 'run `npm install` at the repository root so node_modules links it, and put the three exes in '
    + `packages/engine-win32-x64/ — they are not in git (see docs/engine-artifacts.md). `
    + "Or set config { exeEntry: '<path to visible-ssh.exe>' } to point at an existing drop-in, or "
    + "switch to the reference implementation with { engine: 'python', pythonEntry: '…' }.")
}

/**
 * 产物**根本不在**时的说法。
 *
 * 包解析成功、但里面少文件（半旧投放、或有人只拷了主程序）。引擎 'go' 是默认，所以
 * 一份刚拷来的产物会先走到这里，然后才去读 `docs/engine-artifacts.md`。
 */
export function engineAbsentError(cfg: ResolvedConfig, program: string): BridgeError {
  return new BridgeError('spawn',
    `cannot run ${program}: no such file (engine '${cfg.engine}'). `
    + 'The compiled engine is not vendored per package: take visible-ssh.exe together with its '
    + 'visible-ssh-askpass.exe and visible-ssh-launch.exe from the engine project and drop them into '
    + 'packages/engine-win32-x64/ (see docs/engine-artifacts.md). '
    + "Set config { exeEntry: '<path to visible-ssh.exe>' } to point somewhere else, or use the "
    + "reference implementation instead with { engine: 'python', pythonEntry: '…' }.")
}

/**
 * 产物在、但 `spawn` 自己失败时的说法。
 *
 * `ENOENT` 值得多一句解释（路径对不上、或产物被挪走），其余错误（沙箱下的 `EPERM`
 * 之类）原样带上 Node 的 `code` 与 message。
 */
export function engineSpawnError(cfg: ResolvedConfig, program: string, error: unknown): BridgeError {
  const hint = errorCodeOf(error) === 'ENOENT'
    ? " (engine 'go': the compiled engine is missing from the platform package "
      + 'dsh-visible-ssh-engine-<platform>-<arch> — see docs/engine-artifacts.md, or set config '
      + "{ engine: 'python' } with an explicit pythonEntry)"
    : ''
  return new BridgeError('spawn', `cannot run ${program}: ${errorDetailOf(error)}${hint}`)
}
