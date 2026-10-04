/**
 * 引擎**端口**：插件与引擎之间唯一的那道缝。
 *
 * 在 S3 之前，调用方直接 import `runJson(cfg, argv, …)` —— 于是「哪个可执行文件、
 * 怎么拼 argv、走管道还是走暂存文件」这三件事跟「调用方想要什么」绑在一起，
 * 测试要测一条路由就必须有一个真 exe、一门真 SSH。
 *
 * 现在只有这一个接口：
 *
 *   * **真实实现**是 {@link createEnginePort}（`exec.ts`）：spawn 真进程。
 *   * **测试实现**是 {@link createFakeEngine}（`fake.ts`）：内存里回答，记下每次
 *     调用，可以按 verb 指定回复或失败。
 *
 * 投影层（`project.ts`）与调用方都只看得到 `EnginePort`，因此 unit 层完全不碰
 * SSH、不 spawn 任何东西。
 */

/** 一次调用要叠加到本进程环境之上的变量（`SSH_HOST`/`SSH_PORT`/`SSH_USER`/`SSH_PASSWORD`）。 */
export type ChildEnv = Record<string, string>

/** 一次调用的可选项。全都可以省略：省略时用端口自己绑定的默认值。 */
export interface EngineOptions {
  /** 来自工具调用的 abort signal，全程被遵守。 */
  signal?: AbortSignal | undefined
  /**
   * **本次**调用的上限。省略时用端口绑定的默认值（`cfg.timeoutMs`）。`run` 传的
   * 比那些快速 verb 更大：它的上限必须超过给引擎的命令超时，否则桥接会在命令能
   * 落定之前就把子进程杀掉。
   */
  timeoutMs?: number | undefined
  /** 给子进程的额外环境（`SSH_*`），或 `undefined`/`null` 表示原样继承本进程的环境。 */
  env?: ChildEnv | null | undefined
}

/**
 * 一台引擎：吃**规范** argv，吐解析后的 JSON 信封。
 *
 * 「规范」指的是跟引擎无关的那种形状（flag 在 verb 之后、带 `--json`）；具体跑的是
 * 编译产物还是 Python 参照实现、要不要把 flag 前移、`--json` 要不要丢，都由实现
 * 自己决定，调用方永远不知道（见 `locate.ts` 的 `engineCommand`）。
 */
export interface EnginePort {
  /**
   * @param argv - CLI 词元，例如 `['--session', 'default', 'status', '--json']`。
   * @param options - signal / 本次超时 / 子进程环境。
   * @returns 解析后的 JSON 信封。**故意是 `unknown`**：信封里有什么由各 verb 的
   *   契约决定，只有 `project*` 那些投影层才声明自己相信哪些键。
   * @throws {BridgeError} `spawn`（起不来）、`timeout`（没在期限内回答）、
   *   `protocol`（stdout 上没有 JSON），或 CLI 自己在信封里报的那个 `kind`。
   */
  run(argv: readonly string[], options?: EngineOptions): Promise<unknown>
}
