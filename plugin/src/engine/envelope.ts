/**
 * 信封层的两件事：**引擎 `--json` 信封的形状**，以及失败怎么被报出来。
 *
 * 这是与引擎之间的信任边界，也是唯一声明「我相信引擎吐出的 JSON 长什么样」的地方。
 * Python 与 C 两个引擎都把同一份契约写在 stdout 上：
 *
 *   - 成功 `{"ok": true, …}` —— 里面还有什么由各 verb 决定，本插件只投影它认识的键。
 *   - 失败 `{"ok": false, "error": {"kind": …, "message": …}}` —— `kind` 机器可路由，
 *     `message` 给人看。
 *
 * **非零退出本身不是错误**：CLI 正是为了调用方能路由失败，才把失败报成信封。只有
 * 信封缺失或无法解析时才抛 `protocol`。
 */

/**
 * 引擎 `--json` 信封在**失败**分支上的形状。
 *
 * 按契约 `kind`/`message` 都是字符串；两者缺省时的机会主义默认值由调用处决定，
 * 所以这里把它们标成可选。这里的 `as` 是**类型断言**（不是 `as any`，也没有
 * `@ts-expect-error`），运行时被完全擦除。
 */
interface EngineEnvelope {
  ok?: boolean
  error?: {
    kind?: string
    message?: string
  }
}

/** 把 `JSON.parse` 的产物收成信封形状；不是对象（含 `null`/数组）就当空信封。 */
export function asEnvelope(payload: unknown): EngineEnvelope {
  return (typeof payload === 'object' && payload !== null ? payload : {}) as EngineEnvelope
}

/** 一个带机器可路由的 `kind` 的 bridge 失败。 */
export class BridgeError extends Error {
  /** `spawn` | `timeout` | `protocol` 之一，或 CLI 自己报的那些 kind。 */
  readonly kind: string

  /** @param kind - `spawn` | `timeout` | `protocol` 之一，或 CLI 自己的那些 kind。 */
  constructor(kind: string, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.kind = kind
  }
}

/**
 * 信封里的失败，收成 `{ kind, message }`；成功（或不是信封）返回 `null`。
 *
 * 挑出来而不是就地抛，是为了让 `exec.ts` 在**同一条**代码路径上做完解析与抛出，
 * 也让 `fake.ts` 能用同一份默认文案。
 */
export function failureOf(payload: unknown): { kind: string; message: string } | null {
  const envelope = asEnvelope(payload)
  if (envelope.ok !== false) return null
  return {
    kind: envelope.error?.kind ?? 'cli',
    message: envelope.error?.message ?? 'the CLI reported a failure',
  }
}

/** 取出 `error` 上人可读的那部分：优先 `message`，否则原值本身（与 `?? error` 同义）。 */
export function errorDetailOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  const message: unknown = 'message' in error ? error.message : undefined
  return message === undefined || message === null ? String(error) : String(message)
}

/** 取出 Node 错误上的 `code`（`EPERM` 那些）；非字符串一律当「没有 code」。 */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code: unknown = error.code
  return typeof code === 'string' ? code : undefined
}

/** 一次子进程收尾后的**原始**产出：两个流与退出码。 */
export interface EngineOutput {
  /** 子进程的 stdout（未 trim）。 */
  stdout: string
  /** 子进程的 stderr（未 trim）。 */
  stderr: string
  /** 退出码，或 `null`（被信号结束）。 */
  code: number | null
}

/**
 * 把一次子进程的原始产出变成调用方要的信封 —— **纯函数**，不碰进程。
 *
 * 这是 `exec.ts` 里唯一值得单测的那一步，所以它单独住在这里：unit 层可以直接喂
 * 字符串进来，验证「空 stdout 报 protocol 且带上退出码」、「吐了非 JSON 报
 * protocol」、「信封说 `ok:false` 就抛那个 `kind`」，完全不需要 spawn 任何东西。
 *
 * 非零退出本身**不是**错误：CLI 正是为了调用方能路由失败，才把失败报成 JSON 信封
 * （`{"ok": false, "error": {...}}`）。只有信封缺失或无法解析时才抛 `protocol`。
 *
 * @param output - `stdout`/`stderr`/`code`。
 * @returns 解析后的 JSON 信封。**故意是 `unknown`**：信封里有什么由各 verb 的契约
 *   决定，只有 `project*` 那些投影层才声明自己相信哪些键。
 * @throws {BridgeError} `protocol`（stdout 上没有 JSON）或 CLI 自己报的那个 `kind`。
 */
export function parseEngineOutput(output: EngineOutput): unknown {
  const text = String(output.stdout ?? '').trim()
  if (text === '') {
    const detail = String(output.stderr ?? '').trim().slice(0, 400)
    throw new BridgeError(
      'protocol',
      `the CLI printed no JSON (exit ${output.code ?? '?'})${detail === '' ? '' : `: ${detail}`}`,
    )
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new BridgeError('protocol', `the CLI printed something other than JSON: ${text.slice(0, 200)}`)
  }
  const failure = failureOf(payload)
  if (failure !== null) throw new BridgeError(failure.kind, failure.message)
  return payload
}
