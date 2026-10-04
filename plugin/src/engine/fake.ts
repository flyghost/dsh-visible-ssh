/**
 * 内存里的引擎端口（fake）—— unit 层用它替代真进程。
 *
 * 它和 `exec.ts` 的 `createEnginePort()` 实现**同一个** `EnginePort` 接口，所以任何
 * 吃端口的代码（路由处理器、工具注册表）都能在**不 spawn、不碰 SSH、不起宿主**的
 * 情况下被测。这正是 S3 拆出端口的全部理由。
 *
 * 三种用法，从粗到细：
 *
 *   ```ts
 *   const engine = createFakeEngine()
 *     .reply('status', { ok: true, session: 'default', exists: true })   // 按 verb 给固定答复
 *     .reply('list', { ok: true, sessions: [] })
 *   await engine.run(['status', '--json'])
 *   engine.verbs()        // ['status'] —— 谁被调过、按什么顺序
 *   ```
 *
 *   ```ts
 *   const engine = createFakeEngine((argv) => argv[0] === 'capture' ? { ok: true, screen: 'hi' } : { ok: true })
 *   ```
 *
 *   ```ts
 *   engine.fail('capture', 'transport', 'banner exchange: connection refused')  // 端口**抛出**（和真端口一致）
 *   ```
 *
 * 答复**故意走 `failureOf()`**（和真端口同一段代码）：所以可以像真 CLI 那样把失败
 * 写成信封 `{ ok: false, error: { kind, message } }` 交给 fake，调用方看到的仍是抛出的
 * `BridgeError` —— fake 不会在"失败长什么样"这件事上跟真端口分叉。
 */
import { BridgeError, failureOf } from './envelope.js'
import type { ChildEnv, EngineOptions, EnginePort } from './port.js'

/** 一次被记下来的调用。 */
export interface FakeEngineCall {
  /** 调用方给的 argv（**原样**，没有经过 `engineCommand` 的 flag 重排）。 */
  argv: readonly string[]
  /** 按 `verbOf()` 认出来的 verb；认不出是 `''`。 */
  verb: string
  /** 调用方这次给的取消信号。 */
  signal: AbortSignal | undefined
  /** 调用方这次给的超时；`undefined` 表示它会取 `cfg.timeoutMs`。 */
  timeoutMs: number | undefined
  /** 调用方这次给的连接环境。 */
  env: ChildEnv | null | undefined
}

/** 逐个调用决定答复；返回信封（`ok:false` 会被翻成抛出的 `BridgeError`）。 */
export type FakeHandler = (
  argv: readonly string[],
  call: FakeEngineCall,
) => unknown | Promise<unknown>

/** `createFakeEngine()` 的返回值：一个端口，外加检查它被怎么用了的那几只手。 */
export interface FakeEngine extends EnginePort {
  /** 按顺序记下的每一次调用。 */
  readonly calls: FakeEngineCall[]
  /** 每一次调用的 argv，按顺序。 */
  readonly argvs: readonly (readonly string[])[]
  /** 按顺序认出来的 verb 列表，例如 `['status', 'capture']`。 */
  verbs(): string[]
  /** 某个 verb 被调用时的 argv 列表（用来断言 flag 顺序）。 */
  argvsOf(verb: string): (readonly string[])[]
  /** 给某个 verb 钉一个固定答复。 */
  reply(verb: string, payload: unknown): FakeEngine
  /** 让某个 verb 抛出 `BridgeError(kind, message)`。 */
  fail(verb: string, kind: string, message: string): FakeEngine
  /** 替换逐调用处理器（`undefined` 表示只用 `reply`/`fail` 钉的答复）。 */
  handle(handler: FakeHandler | undefined): FakeEngine
  /** 清空调用日志与钉住的答复，回到刚造出来的状态。 */
  reset(): FakeEngine
}

/**
 * 从 argv 里认出 verb —— 只按**形状**认，不查名单。
 *
 * 为什么要它：真 CLI 的规矩是「flags 必须在 verb 之前」（`status --json` 与
 * `--json status` 都退 2），而带值的 flag（`--session default`、`--timeout 60`）意味着
 * 不能简单地取 `argv[0]`。这里跳过开头的 flag 与其值，直到第一个裸词 —— 那就是 verb。
 *
 * 注意它作用在**调用方给的** argv 上（`engineCommand()` 那套 flag 前移还没发生）。
 *
 * @param argv - 例如 `['--session', 'default', 'run', '--', 'ls -a']`。
 * @returns verb；一个都没有时返回 `''`（例如 `['--json']`）。
 */
export function verbOf(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    if (word === undefined) break
    // `--` 之后全是 verb 的入参（`run` 就是这么把命令交给远端 shell 的）。
    if (word === '--') break
    if (word.startsWith('-')) {
      // 这些 flag 的值是**下一个词**，别把值的误当成 verb。
      if (FLAGS_WITH_A_VALUE.has(word)) index += 1
      continue
    }
    return word
  }
  return ''
}

/** 带值的 flag（值在下一个 argv 槽里）。只列调用方真的会传的那些。 */
const FLAGS_WITH_A_VALUE: ReadonlySet<string> = new Set([
  '--session',
  '--timeout',
  '--config',
  '--ssh',
  '--host',
  '--port',
  '--user',
])

/**
 * 造一个内存端口。
 *
 * @param handler - 可选的逐调用处理器。
 * @returns 一个 `FakeEngine`。
 */
export function createFakeEngine(handler?: FakeHandler): FakeEngine {
  const calls: FakeEngineCall[] = []
  const scripted = new Map<string, unknown>()
  const failures = new Map<string, { kind: string; message: string }>()
  const initial = handler
  let current: FakeHandler | undefined = handler

  const engine: FakeEngine = {
    calls,
    get argvs(): readonly (readonly string[])[] {
      return calls.map((call) => call.argv)
    },
    verbs(): string[] {
      return calls.map((call) => call.verb)
    },
    argvsOf(verb: string): (readonly string[])[] {
      return calls.filter((call) => call.verb === verb).map((call) => call.argv)
    },
    reply(verb: string, payload: unknown): FakeEngine {
      scripted.set(verb, payload)
      failures.delete(verb)
      return engine
    },
    fail(verb: string, kind: string, message: string): FakeEngine {
      failures.set(verb, { kind, message })
      scripted.delete(verb)
      return engine
    },
    handle(next: FakeHandler | undefined): FakeEngine {
      current = next
      return engine
    },
    reset(): FakeEngine {
      calls.length = 0
      scripted.clear()
      failures.clear()
      current = initial
      return engine
    },
    async run(argv: readonly string[], options?: EngineOptions): Promise<unknown> {
      const call: FakeEngineCall = {
        argv: [...argv],
        verb: verbOf(argv),
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
        env: options?.env,
      }
      calls.push(call)

      const failure = failures.get(call.verb)
      if (failure !== undefined) throw new BridgeError(failure.kind, failure.message)

      const payload = current === undefined || scripted.has(call.verb)
        ? scripted.get(call.verb) ?? { ok: true }
        : await current(argv, call)

      // 同一段 `failureOf()`：信封说失败，调用方就该看到抛出的 BridgeError。
      const reported = failureOf(payload)
      if (reported !== null) throw new BridgeError(reported.kind, reported.message)
      return payload
    },
  }
  return engine
}
