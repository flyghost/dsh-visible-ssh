/**
 * 真实引擎端口：唯一启动进程的地方。
 *
 * 两种传输方式，结果相同：
 *
 *   1. PIPES（正常路径）。子进程把一份 JSON 文档写到 stdout。
 *   2. NO PIPES（回退）。某些受限主机禁止子进程使用管道 stdio —— 在 Windows 上、
 *      DSH 文件沙箱之下实测：只要 stdio 不是 'ignore'，`spawnSync` 和异步 `spawn`
 *      **两者都**会以 `EPERM` 失败，而 PowerShell 自己的管道不受影响。所以回退路径
 *      让 `cmd.exe` 把子进程的流重定向进暂存文件，事后再读回来。生产主机走路径 1；
 *      这条路存在的意义，是让插件在无法架设管道的地方也能用。
 *
 * Python 侧**绝不**被要求知道用了哪种传输方式：它的职责是把 JSON 打到 stdout 上，
 * 而重定向自然就产出这个结果。
 *
 * `env` 是面板选定的连接抵达引擎的方式：CLI 自己的加载器让
 * `SSH_HOST`/`SSH_PORT`/`SSH_USER`/`SSH_PASSWORD` 优先于
 * `scripts/config/host.toml`，并且每次调用都重新读取它们，所以一次调用可以被指向一台
 * 机器而完全不用碰任何文件（见 connection/connections.ts）。
 *
 * spawn 之前做两件事，顺序固定：**解出产物**（`locate.resolveEngine()`，位置只由那里
 * 决定），再**核一遍它的身份**（`verify.verifyPayload()`，按目录缓存在本进程里）。
 * 两者都在起进程之前失败 —— 一次调用要么跑的是锁里说的那份产物，要么根本不起进程。
 */
import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { ResolvedConfig } from './config.js'
import { BridgeError, errorCodeOf, parseEngineOutput } from './envelope.js'
import type { EngineOutput } from './envelope.js'
import { engineAbsentError, engineCommand, engineSpawnError, resolveEngine } from './locate.js'
import type { EngineCommand, EngineTarget } from './locate.js'
import type { ChildEnv, EngineOptions, EnginePort } from './port.js'
import { lockPath, verifyPayload } from './verify.js'

/** 那些意味着「这台主机不让我们拥有管道」、而不是「引擎不见了」的错误。 */
const NO_PIPE_CODES = new Set(['EPERM', 'EACCES', 'EPIPE', 'ENOTSUP'])

/** 已经按 `engine.lock` 核过身份的产物目录（按路径缓存：一个进程里核一次就够）。 */
const verifiedDirs = new Set<string>()

/** 核一个产物目录，同一个进程里只真核一次。 */
function verifyDirOnce(dir: string): void {
  if (verifiedDirs.has(dir)) return
  verifyPayload(dir)
  verifiedDirs.add(dir)
}

/**
 * 这一次调用的产物要不要核、核哪个目录。
 *
 * 平台包解析出来的那条路径**必须有**锁：缺锁意味着投放不全，不是"跳过校验"的理由
 * （`verifyPayload` 会因此报错）。显式 `exeEntry` 指到别处时，只有那里确实放着
 * `engine.lock` 才核 —— 显式配置是操作者自己的那摊事。
 */
function verifyTargetOnce(target: EngineTarget): void {
  if (target.packageDir !== null) {
    verifyDirOnce(target.packageDir)
    return
  }
  const beside = dirname(target.program)
  if (existsSync(lockPath(beside))) verifyDirOnce(beside)
}

/** 为一个 cmd.exe 命令行引用一个 token（双引号包裹，内部的双引号翻倍）。 */
function cmdQuote(token: string): string {
  // `%` **先**翻倍，好让命令原样抵达引擎，而不是被 cmd 展开。在本机用一个手写的
  // .cmd 实测：`"python" "-c" "print('%PATH%')"` 抵达时本机的 PATH 已经被替换进去
  // 了，也就是说，没有这层转义的话，模型给出的命令里任何 `%VAR%` 都会在远端 shell
  // 看到它之前被本地改写掉。翻倍能精确往返：`ONE%` -> `ONE%`，`TWO%%` -> `TWO%%`，
  // `THREE%PATH%` -> `THREE%PATH%`（四条都通过回退路径实测过）。
  return `"${String(token).replace(/%/g, '%%').replace(/"/g, '""')}"`
}

/** 一个把 `env` 叠加在本进程自身环境之上的子进程环境。 */
function childEnv(env: ChildEnv | null | undefined): NodeJS.ProcessEnv | undefined {
  if (env === undefined || env === null) return undefined
  return { ...process.env, ...env }
}

/** 用管道 stdio 运行子进程并收走它的输出。 */
function runPiped(
  command: EngineCommand,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  env: ChildEnv | null | undefined,
): Promise<EngineOutput> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      const childEnvironment = childEnv(env)
      child = spawn(command.program, command.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        signal,
        ...childEnvironment === undefined ? {} : { env: childEnvironment },
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new BridgeError('timeout', `no answer within ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }) })
  })
}

/** 暂存文件超过这个年龄就算陈旧：`watch` 会留下一个一直攥着 `.out` 的真控制台。 */
const SPOOL_TTL_MS = 60 * 60 * 1000

/** 已经扫过的暂存目录 —— 每个进程每个目录只扫一次。 */
const sweptDirs = new Set<string>()

/**
 * 删一个暂存文件，删不掉就算了。
 *
 * Windows 上 `watch` 拉起来的那个真控制台会一直攥着 `.out` 的句柄，`unlink` 因此报
 * EBUSY。这条清理路径**不该**把一次已经成功的调用变成失败 —— 实测面板上就是这么多出
 * 一行 `bridge: EBUSY: resource busy or locked, unlink '…'` 的。
 */
async function removeBestEffort(path: string): Promise<boolean> {
  try {
    await rm(path, { force: true, maxRetries: 5, retryDelay: 50 })
    return true
  } catch {
    // 还被别的进程攥着：留着。下一次调用时 sweepSpoolOnce 按年龄再收一次。
    return false
  }
}

/** 收走一个暂存目录里已经过时的文件；返回真正删掉的名字。尽力而为，绝不抛。 */
export async function sweepSpoolDir(
  dir: string,
  ttlMs: number = SPOOL_TTL_MS,
  now: number = Date.now(),
): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // 目录还不存在：第一次调用时由 mkdir 建出来。
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (!name.endsWith('.out') && !name.endsWith('.err') && !name.endsWith('.cmd')) continue
    const full = join(dir, name)
    try {
      const info = await stat(full)
      if (now - info.mtimeMs <= ttlMs) continue
      if (await removeBestEffort(full)) removed.push(name)
    } catch {
      // 刚好被别的进程删掉了，或者读不到：跳过。
    }
  }
  return removed
}

/** 每个进程每个目录只扫一次：一次调用不值得反复列目录。 */
async function sweepSpoolOnce(dir: string): Promise<void> {
  if (sweptDirs.has(dir)) return
  sweptDirs.add(dir)
  await sweepSpoolDir(dir)
}

/** 以 NO pipes 方式运行子进程：一个生成的批处理文件重定向两个流。 */
async function runSpooled(
  cfg: ResolvedConfig,
  command: EngineCommand,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  env: ChildEnv | null | undefined,
): Promise<EngineOutput> {
  const dir = join(cfg.spoolDir ?? tmpdir(), 'dsh-visible-ssh')
  await mkdir(dir, { recursive: true })
  await sweepSpoolOnce(dir)
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const outPath = join(dir, `${stamp}.out`)
  const errPath = join(dir, `${stamp}.err`)
  const batPath = join(dir, `${stamp}.cmd`)
  try {
    // 走**批处理文件**，而不是走 argv。Node 在把每个参数送往 cmd.exe 的路上会给它
    // 加引号，随后 cmd 会把那些引号里的 `>` 当成普通文本而不是重定向：在本机实测，
    // 三种 argv 形状全都以退出码 1 结束，而且根本没生成输出文件，而同一条命令行写进
    // .cmd 文件则一次就成功。
    const inner = [command.program, ...command.args].map(cmdQuote).join(' ')
    // 连接变量以 `set "K=V"` 行的形式放入。在这条路径上，值里含双引号无法表示（cmd
    // 会重新解析它）；而作为正常路径的管道路径没有这个限制。
    const sets = env === undefined || env === null
      ? []
      : Object.entries(env).map(([key, value]) => `set ${cmdQuote(`${key}=${value}`)}`)
    const body = [
      '@echo off',
      'chcp 65001>nul 2>nul',
      ...sets,
      `${inner} > ${cmdQuote(outPath)} 2> ${cmdQuote(errPath)}`,
      'exit /b %errorlevel%',
      '',
    ].join('\r\n')
    await writeFile(batPath, body, 'utf8')

    const result = await new Promise<{ code: number | null }>((resolve, reject) => {
      const child = spawn('cmd.exe', ['/d', '/c', batPath], {
        stdio: 'ignore',
        windowsHide: true,
        signal,
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new BridgeError('timeout', `no answer within ${timeoutMs}ms`))
      }, timeoutMs)
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code }) })
    })
    const read = async (path: string): Promise<string> => {
      try { return await readFile(path, 'utf8') } catch { return '' }
    }
    return { stdout: await read(outPath), stderr: await read(errPath), code: result.code }
  } finally {
    // 尽力而为：`watch` 拉起来的控制台还攥着 `.out`，删不掉是常态，不是错误。
    await removeBestEffort(outPath)
    await removeBestEffort(errPath)
    await removeBestEffort(batPath)
  }
}

/**
 * 造一个跑真进程的端口。
 *
 * 端口**绑定**了 `cfg`：默认超时、暂存目录、以及「跑的是哪个引擎」。调用方只给
 * argv 和每次调用的可选项。
 *
 * @param cfg - 已解析的插件配置。
 * @returns 一个 `EnginePort`。
 */
export function createEnginePort(cfg: ResolvedConfig): EnginePort {
  return {
    async run(argv: readonly string[], options?: EngineOptions): Promise<unknown> {
      const timeoutMs = options?.timeoutMs ?? cfg.timeoutMs
      const signal = options?.signal
      const env = options?.env
      const target = resolveEngine(cfg)
      const command = engineCommand(cfg, argv, target.program)
      // 在 spawn **之前**失败，而不是之后：exe 缺失时，`spawn` 在 DSH 沙箱下报的是
      // EPERM（不是 ENOENT），无管道回退随后把路径交给 cmd.exe，于是调用方看到的是
      // `protocol: the CLI printed no JSON (exit 9009)` —— 这是真的，但毫无用处。
      // 一次 stat 换来一条可据以行动的消息。
      if (!existsSync(command.program)) throw engineAbsentError(cfg, command.program)
      // 身份也在起进程之前确认：跑一份和锁对不上的产物，比不跑更糟。
      verifyTargetOnce(target)

      let result: EngineOutput
      try {
        result = await runPiped(command, signal, timeoutMs, env)
      } catch (error) {
        if (signal?.aborted) throw error
        if (error instanceof BridgeError) throw error
        const code = errorCodeOf(error)
        if (code === undefined || !NO_PIPE_CODES.has(code)) {
          throw engineSpawnError(cfg, command.program, error)
        }
        result = await runSpooled(cfg, command, signal, timeoutMs, env)
      }

      // 解析那一步是纯函数，住在 envelope.ts，所以它能被单测直接喂字符串。
      return parseEngineOutput(result)
    },
  }
}
