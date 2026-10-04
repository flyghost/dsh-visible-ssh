/**
 * 插件配置：默认值、引擎所在的位置，以及**引擎该读哪一份 `host.toml`**。
 *
 * 插件自身不打包引擎——它驱动**平台包**
 * `packages/engine-win32-x64/`（`visible-ssh.exe`，由引擎项目产出后整组拷进来；
 * 见 `docs/engine-artifacts.md`）里的产物，位置由 `locate.ts` 按**包名**解析，
 * 所以开发期的 `link:` 安装与装到别的机器都能零配置解析到位。
 * 下面每一条路径都从**本文件**的位置推导出来。
 *
 * **配置（`host.toml`）不从这里推导**：它属于**操作者**，不属于 checkout。解析顺序
 * 见 `chooseHostConfig()`；插件把结果作为 `--config <绝对路径>` 交给引擎
 * （`locate.ts`），所以引擎永远不用去猜。实测：引擎只认 `--config` 与 `SSH_CONFIG`
 * 环境，**不认** `%APPDATA%`、`config/host.toml`、也不看 cwd（`docs/test-baseline.md`
 * 第十三节）。`config/host.toml.example` 仍然留在 `scripts/config/` 里：它是模板，
 * 而且引擎自己的"从 exe 目录向上找 `scripts/config/host.toml`"那条老契约与 skill
 * 副本都依赖那个位置。
 *
 * 插件从那份文件里**只读一项**：`[host] session` —— 引擎不认这个键（未知键照旧被
 * 忽略），插件用它当"缺省会话窗口"（见 `parseHostConfigSession()`）。于是"连哪台机器"
 * 与"默认进哪个 tmux 会话"都写在同一份配置里，而不是散在环境变量与代码里。
 *
 * 另外插件还会**只读**本机的 `~/.ssh/config`（`sshConfigPath`），用来在设置界面里
 * 列出"这台机器已经配好的远端"（`connection/ssh-config.ts`）。那纯粹是便利：引擎
 * 自己不解析 ssh 配置，是 ssh.exe 去读的，所以真正的解析权始终在 ssh 那边。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `.../plugin/src/engine/config.js` -> `.../plugin/src` -> `.../plugin` -> 仓库根。
 *
 * **注意深度**：本文件在 `src/engine/` 下，所以要从自身位置往上走**两级**才到包目录。
 * 少走一级的话 `repoRoot` 会变成 `plugin/src`，于是**显式** `exeEntry` 的相对路径会解到
 * `plugin/src/…` —— 这不是"找不到文件"那么响亮的失败，而是 `artifact-check` 里那条
 * 显式断言（`cfg.repoRoot === <repo>`）会变红。改本文件的位置时，这一行必须同批改。
 */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_REPO_ROOT = dirname(PLUGIN_DIR)

/** bridge 跑哪一个引擎：编译产物（默认）或待命参照实现。 */
export type EngineKind = 'go' | 'python'

/**
 * loader 传进来的 `config` 块。
 *
 * 每个键都故意是 `unknown`：这一层是**外部输入**（loader 行里的 YAML/JSON），
 * 类型系统在这里能保证的只有「键可能存在」。取值、转换与拒绝都在
 * `resolveConfig` 里显式做。
 */
export interface PluginConfig {
  repoRoot?: unknown
  engine?: unknown
  exeEntry?: unknown
  pythonEntry?: unknown
  python?: unknown
  configPath?: unknown
  defaultSession?: unknown
  timeoutMs?: unknown
  commandTimeoutMs?: unknown
  spoolDir?: unknown
  screenTtlMs?: unknown
  screenTimeoutMs?: unknown
  connectionsFile?: unknown
}

/** 已完全解析、冻结的配置：`resolveConfig` 的产物，各层据此干活。 */
export interface ResolvedConfig {
  /** 存放引擎的仓库根（`packages/engine-win32-x64/`、`scripts/config/host.toml`）。 */
  repoRoot: string
  engine: EngineKind
  /**
   * 绝对的 CLI 路径；`null` 表示**按包名解析平台包**（`locate.ts` 的
   * `resolveEngine()`）。显式给值时，相对路径按 `repoRoot` 拼。
   */
  exeEntry: string | null
  python: string
  pythonEntry: string
  /**
   * 交给引擎的 `--config`：**绝对**路径（实测引擎原样使用这个参数，不解析），
   * 或 `null`（什么都不传，让引擎按自己的老规矩从 exe 目录向上找）。
   * 由 `chooseHostConfig()` 按 显式配置 > `SSH_CONFIG` > 用户目录 > 仓内 定下来。
   */
  configPath: string | null
  /** 上面那个路径是从哪个候选来的（诊断与 `host-config.mjs show` 用）。 */
  configSource: HostConfigSource | null
  /**
   * 本机 `~/.ssh/config` 的绝对路径，或 `null`（没有可用的家目录）。
   *
   * 插件**只读**这个文件（`connection/ssh-config.ts`），用来在设置界面里列出
   * "本机已经配好的远端"；引擎自己不解析它，是 ssh.exe 去读的。跟着 `HOME` /
   * `USERPROFILE` 走，而 Win32-OpenSSH 认的是真实用户 profile —— 两者不同时
   * （实测把 `HOME` 指到别处，ssh 仍读真家），列出来的清单可能与 ssh 实际用的
   * 不是同一份。界面只把它当**候选**，真去连的时候仍是 ssh 自己解析。
   */
  sshConfigPath: string | null
  defaultSession: string
  /** `defaultSession` 是从哪儿定下来的：`config`（插件配置）／`file`（那份 host.toml 的 `[host] session`）／`default`（内置默认）。 */
  sessionSource: SessionSource
  timeoutMs: number
  commandTimeoutMs: number
  screenTtlMs: number
  screenTimeoutMs: number
  /** `null` 表示用操作系统临时目录。 */
  spoolDir: string | null
  /** `null` 表示按 `DSH_HOME` 推导出 `connections.json`。 */
  connectionsFile: string | null
}

export const DEFAULTS: Readonly<ResolvedConfig> = Object.freeze({
  /** 存放引擎的仓库根（`packages/engine-win32-x64/`、`scripts/config/host.toml`）。 */
  repoRoot: DEFAULT_REPO_ROOT,
  /**
   * bridge 跑哪一个引擎。`go` 是编译产物（C 引擎，名字沿用历史），也是默认值；
   * `python` 是参照实现，作为**待命**引擎留在代码里——用
   * `config: { engine: 'python', pythonEntry: '…' }` 可以把某个 profile 切过去。
   *
   * 两个引擎的 argv 形状不同，由 locate 做翻译；实测差异见 locate.ts 里的
   * `engineCommand`。
   */
  engine: 'go',
  /**
   * 编译出来的 CLI 在哪里（引擎 `go`）。`null` = **按包名解析平台包**，这也是默认：
   * 产物是一个独立的包（`packages/engine-win32-x64/`，名字
   * `dsh-visible-ssh-engine-win32-x64`），插件把它声明成 `optionalDependencies`，
   * 于是 `require.resolve()` 在开发期解到 workspace 链接、装到别的机器时解到同层的
   * `node_modules/`。显式给值时是"别处还有一份产物"的逃生口（相对路径按 `repoRoot` 拼）。
   *
   * 三个 exe **必须同目录**：`visible-ssh.exe` 要能按自己的 exe 目录找到
   * `visible-ssh-askpass.exe` / `visible-ssh-launch.exe`（见 docs/engine-artifacts.md）。
   */
  exeEntry: null,
  /**
   * Python CLI 入口在 `repoRoot` 内的相对路径（引擎 `python`）。
   *
   * ⚠️ 这个待命引擎的**实现已经不随本仓提供**（它随引擎源码一起迁去了引擎项目）。
   * 默认值只是保留的路径形状：真要用 `engine: 'python'`，必须显式给
   * `pythonEntry`（可绝对路径）。缺文件时 bridge 会在 spawn 之前**响亮失败**
   * （`exec.ts` 的 `existsSync`），不会静默换引擎。
   */
  pythonEntry: join('scripts', 'tools', 'tmux_console.py'),
  /** 用来跑 Python 入口的解释器（引擎 `python`）。 */
  python: 'python',
  /**
   * `null` = 没有显式指定；**真正生效的那条路径由 `resolveConfig()` 现算**
   * （见 `chooseHostConfig()`），所以这个字段在 `DEFAULTS` 里只表示"默认不覆盖"。
   */
  configPath: null,
  /** 同上：默认没有来源。 */
  configSource: null,
  /**
   * `null` = 没有可用的家目录。真正生效的那条路径由 `resolveConfig()` 现算
   * （跟着 `HOME`/`USERPROFILE` 走），所以这里只表示"默认没有"。
   */
  sshConfigPath: null,
  /** 没有工具调用指定 session 时，驱动哪个 tmux session。 */
  defaultSession: 'default',
  /** 默认值就是内置默认：既没有插件配置、也没有那份文件里的 `session`。 */
  sessionSource: 'default',
  /** 单次 bridge 调用的墙钟上限，单位毫秒。 */
  timeoutMs: 60_000,
  /**
   * 一条远端命令可以跑多久，超过之后引擎就不再等了，单位毫秒。
   * 与 `timeoutMs` 不同：那个约束的是 CLI 进程，这个交给引擎，
   * 而只有引擎这一侧才能结束等待、把已经收到的输出返回并说明情况。
   * 默认取引擎自己的 `DEFAULT_TIMEOUT`（120s），好让工具与 CLI 保持一致。
   */
  commandTimeoutMs: 120_000,
  /**
   * 没有管道时的兜底方案把子进程的 stdout/stderr 落到哪里。只有宿主禁止
   * 管道 stdio 时才会用到（见 exec.ts）；null 表示用操作系统临时目录。
   */
  spoolDir: null,
  /**
   * 浏览器镜像（GET /visible-ssh/screen）在复用一次捕获到的屏幕之后，隔多久
   * 才再次去跑 CLI，单位毫秒。刻意远低于面板的轮询间隔：这样做是为了吸收
   * 突发（多个标签页、手动刷新恰好落在一次 tick 之后、开发模式下 React 的
   * 双次 effect），而不是让镜像变迟钝。一次捕获就是一条 SSH 连接（实测约
   * 1.3s），这里要限住的就是这个成本。
   */
  screenTtlMs: 300,
  /**
   * **一次**镜像捕获的墙钟上限。刻意比 `timeoutMs` 小：过了一分钟才回话的
   * 镜像没有用，而快速失败能让面板把话说清楚，并在下一个 tick 重试。
   */
  screenTimeoutMs: 20_000,
  /**
   * 面板管理的连接放在哪里。`null` 会推导出
   * `<DSH_HOME>/dsh-visible-ssh/connections.json`——那是其他每个 DSH 组件
   * 存放自己状态的地方，而不是插件目录（拷贝安装可能落在本进程写不进去的
   * 位置，而且包目录不是状态）。
   *
   * 文件不存在是受支持的状态：此时引擎照旧读
   * `scripts/config/host.toml`，面板则给出表单，而不是假装已有连接。
   */
  connectionsFile: null,
})

/**
 * 用户目录那份配置该在哪：从哪几个根推导。
 *
 * 这几个根是**注入**的；`systemConfigRoots()` 是唯一读进程环境的地方 —— 于是单测
 * 可以喂假根，永远不用碰真机。
 */
export interface ConfigRoots {
  /** `process.platform`。 */
  platform: string
  /** Windows：`%APPDATA%`（通常是 `…\AppData\Roaming`）；没有则空串。 */
  appData: string
  /** 家目录（POSIX `HOME`，Windows `USERPROFILE`）；没有则空串。 */
  home: string
  /** POSIX 的 `$XDG_CONFIG_HOME`；没有则空串。 */
  xdgConfig: string
}

/** 从进程环境里取一份 `ConfigRoots`。**唯一**提到那几个变量名的地方。 */
export function systemConfigRoots(env: NodeJS.ProcessEnv = process.env): ConfigRoots {
  return {
    platform: process.platform,
    appData: env.APPDATA ?? '',
    home: env.HOME ?? env.USERPROFILE ?? '',
    xdgConfig: env.XDG_CONFIG_HOME ?? '',
  }
}

/**
 * 用户目录里那份 `host.toml` 的绝对路径；`roots` 里没有可用的根时是 `null`。
 *
 * Windows 用 `%APPDATA%\visible-ssh\host.toml`；其余平台用
 * `$XDG_CONFIG_HOME/visible-ssh/host.toml`，没有 `XDG_CONFIG_HOME` 就退到
 * `~/.config/visible-ssh/host.toml`。
 */
export function userConfigPath(roots: ConfigRoots): string | null {
  if (roots.platform === 'win32') {
    return roots.appData === '' ? null : join(roots.appData, 'visible-ssh', 'host.toml')
  }
  const base = roots.xdgConfig !== '' ? roots.xdgConfig : roots.home === '' ? null : join(roots.home, '.config')
  return base === null ? null : join(base, 'visible-ssh', 'host.toml')
}

/**
 * 本机 `~/.ssh/config` 的绝对路径；`roots` 里没有家目录时是 `null`。
 *
 * 与 `userConfigPath()` 一样，根是注入的，所以单测永远不碰真机。这个文件插件
 * 只读（列出本机配过的远端），不写。
 */
export function sshConfigPath(roots: ConfigRoots): string | null {
  return roots.home === '' ? null : join(roots.home, '.ssh', 'config')
}

/** 生效的 `host.toml` 是从哪个候选来的。 */
export type HostConfigSource = 'config' | 'env' | 'user' | 'repo'
/**
 * `defaultSession` 是从哪儿定下来的。
 *
 * `config` = 插件配置里的 `defaultSession`（显式覆盖）／`file` = 那份 `host.toml`
 * 的 `[host] session`／`default` = 内置默认（`'default'`）。
 */
export type SessionSource = 'config' | 'file' | 'default'

/** `chooseHostConfig()` 的输入。`exists` 也注入，好让"文件在不在"在单测里可控。 */
export interface HostConfigCandidates {
  /** 插件配置里的显式 `configPath`（已按 `repoRoot` 拼成绝对路径），或 `null`。 */
  explicit: string | null
  /** `SSH_CONFIG` 环境变量（原样），或 `null`。 */
  env: string | null
  /** `userConfigPath()` 的结果，或 `null`。 */
  user: string | null
  /** 仓内那份：`<repoRoot>/scripts/config/host.toml`。 */
  repo: string
  exists: (path: string) => boolean
}

/** 选中的那份配置，以及它为什么被选中。 */
export interface HostConfigChoice {
  path: string
  source: HostConfigSource
}

/**
 * 引擎该读哪一份 `host.toml`。
 *
 *   1. `config: { configPath: '…' }` —— 操作者明说，绝对可信，**不检查存在**；
 *   2. `SSH_CONFIG` 环境 —— 引擎自己也认这个变量，这里**原样透传**（相对路径的
 *      语义因此由引擎与 cwd 决定：要可预测就给绝对路径）；
 *   3. 用户目录里那份 —— **存在才用**，这是"配置属于操作者"的落点；
 *   4. 仓内 `scripts/config/host.toml` —— **存在才用**。开发、skill 副本与本仓的
 *      live 检查都走这条，所以它排在最后，但不是不存在；
 *   5. 都没有 —— `null`：不传 `--config`，让引擎按它自己的老规矩（从 exe 目录
 *      向上找）去说它自己那句话。
 */
export function chooseHostConfig(candidates: HostConfigCandidates): HostConfigChoice | null {
  if (candidates.explicit !== null) return { path: candidates.explicit, source: 'config' }
  if (candidates.env !== null && candidates.env !== '') return { path: candidates.env, source: 'env' }
  if (candidates.user !== null && candidates.exists(candidates.user)) return { path: candidates.user, source: 'user' }
  if (candidates.exists(candidates.repo)) return { path: candidates.repo, source: 'repo' }
  return null
}

/**
 * 从一份 `host.toml` 的**文本**里取出 `[host] session`；没有、看不懂，或读不出，都是 `null`。
 *
 * 这份文件的"正统主人"是引擎（`hostcfg.c` 只认 `host` / `user` / `password` /
 * `label` / `port` / `connect_timeout` / `password_env`，**未知键照旧被忽略**），
 * 所以这里读的正是引擎**不会**读的那一项：插件自己的"缺省会话窗口"。
 *
 * 故意不引 TOML 依赖（本包的 `dependencies` 是空的）：只按行扫，容忍空行、
 * `#` 注释、单双引号、裸值与 CRLF；`session` 出现在 `[host]` 之外的段里一律不算。
 * 一份不认识的文件不该让插件起不来，所以这里从不抛错。
 *
 * @param text - 那份配置文件的全文。
 * @returns 会话名（已去空白与最外层引号），或 `null`。
 */
export function parseHostConfigSession(text: string): string | null {
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim()
    if (line === '') continue
    const header = /^\[([^\]]*)\]$/.exec(line)
    if (header !== null) {
      section = (header[1] ?? '').trim().toLowerCase()
      continue
    }
    if (section !== 'host') continue
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line)
    if (pair === null) continue
    if ((pair[1] ?? '').toLowerCase() !== 'session') continue
    const value = unquoteToml(pair[2] ?? '')
    return value === '' ? null : value
  }
  return null
}

/** 砍掉行里 `#` 之后的部分；引号里的 `#` 属于值。 */
function stripTomlComment(line: string): string {
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index)
    if (quote === '') {
      if (char === '"' || char === "'") quote = char
      else if (char === '#') return line.slice(0, index)
    } else if (char === quote) {
      quote = ''
    }
  }
  return line
}

/** 去掉一层配对的引号并去空白；裸值原样返回。 */
function unquoteToml(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed.charAt(0)
  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/** 读一份文本文件；读不到就是 `null`（配置解析从不因为文件问题抛错）。 */
function readTextIfPossible(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function pick(raw: PluginConfig | undefined, key: keyof PluginConfig, fallback: unknown): unknown {
  const value = raw?.[key]
  if (value === undefined || value === null || value === '') return fallback
  return value
}

/**
 * 把 loader 传进来的配置对象叠加到默认值之上。
 * @param raw - 本插件 loader 行的 `config` 块，可能不存在。
 * @param env - 用来读 `SSH_CONFIG` 与用户目录（默认进程环境；单测喂假的）。
 * @param exists - 用来判断候选文件在不在（默认 `existsSync`；单测喂假的）。
 * @param readText - 用来读选中那份 `host.toml` 的 `[host] session`（默认真读文件；
 *   单测喂假的，于是单测永远不碰真机）。
 * @returns 一份冻结的、已完全解析的配置。
 */
export function resolveConfig(
  raw: PluginConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  readText: (path: string) => string | null = readTextIfPossible,
): Readonly<ResolvedConfig> {
  const repoRoot = resolve(String(pick(raw, 'repoRoot', DEFAULTS.repoRoot)))
  const entry = String(pick(raw, 'pythonEntry', DEFAULTS.pythonEntry))
  const exe = pick(raw, 'exeEntry', null)
  const engine = String(pick(raw, 'engine', DEFAULTS.engine))
  // 拼错就报错，而不是静默地去跑另一个引擎：否则一个拼错的
  // `engine` 会在谁都没察觉的情况下决定整条传输路径。
  if (engine !== 'go' && engine !== 'python') {
    throw new Error(`engine must be 'go' or 'python', got ${JSON.stringify(engine)}`)
  }
  const spoolDir = pick(raw, 'spoolDir', DEFAULTS.spoolDir)
  const connectionsFile = pick(raw, 'connectionsFile', DEFAULTS.connectionsFile)
  const explicitConfig = pick(raw, 'configPath', null)
  const roots = systemConfigRoots(env)
  const chosen = chooseHostConfig({
    explicit: explicitConfig === null
      ? null
      : (isAbsolute(String(explicitConfig)) ? String(explicitConfig) : join(repoRoot, String(explicitConfig))),
    env: env.SSH_CONFIG ?? null,
    user: userConfigPath(roots),
    repo: join(repoRoot, 'scripts', 'config', 'host.toml'),
    exists,
  })
  // 缺省会话窗口：插件配置 > 那份 host.toml 的 [host] session > 内置默认。
  // 引擎不认这个键，所以这一项只有插件读；读不到文件就安静退回默认值。
  const configuredSession = pick(raw, 'defaultSession', null)
  const fileSession = configuredSession === null && chosen !== null
    ? parseHostConfigSession(readText(chosen.path) ?? '')
    : null
  return Object.freeze({
    repoRoot,
    engine,
    exeEntry: exe === null ? null : (isAbsolute(String(exe)) ? String(exe) : join(repoRoot, String(exe))),
    python: String(pick(raw, 'python', DEFAULTS.python)),
    pythonEntry: isAbsolute(entry) ? entry : join(repoRoot, entry),
    configPath: chosen === null ? null : chosen.path,
    configSource: chosen === null ? null : chosen.source,
    sshConfigPath: sshConfigPath(roots),
    defaultSession: configuredSession === null
      ? (fileSession ?? DEFAULTS.defaultSession)
      : String(configuredSession),
    sessionSource: configuredSession !== null ? 'config' : (fileSession === null ? 'default' : 'file'),
    timeoutMs: Number(pick(raw, 'timeoutMs', DEFAULTS.timeoutMs)),
    commandTimeoutMs: Number(pick(raw, 'commandTimeoutMs', DEFAULTS.commandTimeoutMs)),
    screenTtlMs: Number(pick(raw, 'screenTtlMs', DEFAULTS.screenTtlMs)),
    screenTimeoutMs: Number(pick(raw, 'screenTimeoutMs', DEFAULTS.screenTimeoutMs)),
    spoolDir: spoolDir === null ? null : resolve(String(spoolDir)),
    connectionsFile: connectionsFile === null ? null : resolve(String(connectionsFile)),
  })
}
