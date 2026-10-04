/**
 * 从 CLI 的 JSON envelope 到工具规范值的纯投影。
 *
 * 刻意不引入任何 `@deepseek-ai/*` 导入：正因如此，整个翻译层才能离线测试——
 * 用普通 node、不需要 DSH 宿主；这与引擎项目里把 `terminal.py` 保持为无 IO
 * 是同一种切分。
 *
 * 类型分两层，这是本文件的核心约定：
 *
 * - `Raw*Envelope`（不导出）——引擎真正发出的那套词汇：snake_case 键。它们是
 *   **信任边界**：`project*` 的入参一律是 `unknown`，进门先做一次 `as` 收窄，
 *   之后所有字段访问都有类型可依。这里写下的类型是「引擎承诺了什么」，不是
 *   运行时验证——每个 `project*` 都只做一次这种收窄。
 * - `Projected*`（导出）——工具规范值：camelCase，且 required/optional 的布局
 *   必须与 `tools/index.ts` 里对应 output schema 逐字对齐，否则 `InferValue`
 *   就会拒收 `execute` 的返回值。
 */

/** 引擎 `history` 子块（`status` 与 `up`、`reset` 共用）。 */
interface RawHistory {
  limit?: string | null
  born_with?: string | null
  in_use?: string | null
  stale?: boolean
}

/** 任何一个带 `history` 子块的信封。 */
interface RawHistoryOwner {
  history?: RawHistory | null
}

interface RawStatusEnvelope extends RawHistoryOwner {
  session: string
  exists: boolean
  clients?: unknown[] | null
  idle?: boolean | null
  reason?: string | null
  last_line?: string | null
  config_path: string
}

interface RawUpEnvelope extends RawStatusEnvelope {
  created?: boolean
  existed?: boolean
}

interface RawRunEnvelope {
  session: string
  command: string
  output?: string | null
  exit_code?: number | string | null
  settled?: boolean
  timeout?: number | null
}

interface RawResetEnvelope extends RawHistoryOwner {
  session: string
  had_session?: boolean
  detached_clients?: number | string | null
  history_limit?: string | null
}

interface RawDownEnvelope {
  session: string
  killed?: boolean
}

interface RawCaptureEnvelope {
  session: string
  exists?: boolean
  lines?: unknown
  width?: number | null
  height?: number | null
  cursor_x?: number | null
  cursor_y?: number | null
  last_line?: string | null
}

interface RawWatchEnvelope {
  session: string
  target: string
  title: string
  tmux_command: string
}

interface RawSessionRow {
  name: string
  attached?: number | string | null
  windows?: number | string | null
  current?: boolean
}

interface RawListEnvelope {
  session: string
  exists?: boolean
  sessions?: unknown
}

interface RawGeometry {
  cursor_x?: number | string | null
  cursor_y?: number | string | null
  width?: number | string | null
  height?: number | string | null
}

interface RawDoctorEnvelope {
  session: string
  exists?: boolean
  host_key?: unknown
  host_key_type?: unknown
  known_hosts?: unknown
  config_path?: unknown
  config?: unknown
  dial_ms?: number | string | null
  total_ms?: number | string | null
  geometry?: RawGeometry | null
  history_limit?: unknown
  history_born?: unknown
  shell?: unknown
}

/** scrollback 块，`status` 与 `up`、`reset` 共用。 */
export interface ProjectedHistory {
  limit?: string | null
  bornWith?: string | null
  inUse?: string | null
  stale: boolean
}

/** `ssh_console_status` 的规范值（`connection` 由工具层补上）。 */
export interface ProjectedStatus {
  session: string
  exists: boolean
  attachedClients: number
  idle?: boolean | null
  reason?: string | null
  lastLine?: string | null
  history: ProjectedHistory
  configPath: string
}

/** `ssh_console_up` 的规范值：状态文档，外加这次调用改动了什么。 */
export interface ProjectedUp extends ProjectedStatus {
  created: boolean
  existed: boolean
}

/** `ssh_console_run` 的规范值。 */
export interface ProjectedRun {
  session: string
  command: string
  output: string
  exitCode?: number | null
  settled: boolean
  timeoutSeconds?: number | null
}

/** `ssh_console_reset` 的规范值。 */
export interface ProjectedReset {
  session: string
  hadSession: boolean
  detachedClients: number
  historyLimit?: string | null
  history: ProjectedHistory
}

/** `ssh_console_down` 的规范值。 */
export interface ProjectedDown {
  session: string
  killed: boolean
}

/** `ssh_console_capture` 的规范值。 */
export interface ProjectedCapture {
  session: string
  exists: boolean
  screen: string
  lineCount: number
  width?: number | null
  height?: number | null
  cursorX?: number | null
  cursorY?: number | null
  lastLine?: string | null
}

/** `ssh_console_watch` 的规范值。 */
export interface ProjectedWatch {
  session: string
  target: string
  title: string
  tmuxCommand: string
}

/** `list` 里的一行。 */
export interface ProjectedSession {
  name: string
  attached: number
  windows: number
  current: boolean
}

/** `ssh_console_list` 的规范值。 */
export interface ProjectedSessionList {
  session: string
  exists: boolean
  sessions: ProjectedSession[]
}

/** pane 的尺寸与光标位置。 */
export interface ProjectedGeometry {
  cursorX: number
  cursorY: number
  width: number
  height: number
}

/** `ssh_console_doctor` 的规范值。 */
export interface ProjectedDoctor {
  session: string
  exists: boolean
  hostKey?: string | null
  hostKeyType?: string | null
  knownHosts?: string | null
  configPath?: string | null
  config?: string | null
  dialMs: number
  totalMs: number
  geometry: ProjectedGeometry
  historyLimit?: string | null
  historyBorn?: string | null
  shell?: string | null
}

/**
 * `visible-ssh.exe status --json` -> `ssh_console_status` 的规范值。
 *
 * 字段名是 camelCase，CLI 传输层的那套词汇（snake case、`clients`、
 * `history.born_with`）不会透出去。
 *
 * @param payload - 从 `status --json` 解析出的 JSON envelope。
 */
export function projectStatus(payload: unknown): ProjectedStatus {
  const doc = payload as RawStatusEnvelope
  return {
    session: doc.session,
    exists: doc.exists,
    attachedClients: (doc.clients ?? []).length,
    idle: doc.idle,
    reason: doc.reason,
    lastLine: doc.last_line,
    history: projectHistory(doc),
    configPath: doc.config_path,
  }
}

/** scrollback 块，`status` 与 `up` 共用。 */
function projectHistory(doc: RawHistoryOwner): ProjectedHistory {
  return {
    limit: doc.history?.limit ?? null,
    bornWith: doc.history?.born_with ?? null,
    inUse: doc.history?.in_use ?? null,
    stale: doc.history?.stale === true,
  }
}

/**
 * `up --json` -> 规范值：完整的状态文档，外加这次调用改动了什么。`created`
 * 就是幂等性的答案——false 表示 session 本来就在，什么都没被重建。
 *
 * @param payload - 从 `up --json` 解析出的 JSON envelope。
 */
export function projectUp(payload: unknown): ProjectedUp {
  const doc = payload as RawUpEnvelope
  return {
    ...projectStatus(doc),
    created: doc.created === true,
    existed: doc.existed === true,
  }
}

/**
 * `run --json` -> 规范值。
 *
 * `settled: false` 搭配 `exitCode: null` 是诚实的「没有结论」情形：命令活过了
 * 它的超时，或者它把 shell 弄死了（`exit`）。已经到达 pane 的那部分输出仍然
 * 在，而盯着 pane 的人手里有剩下的部分。
 *
 * @param payload - 从 `run --json` 解析出的 JSON envelope。
 */
export function projectRun(payload: unknown): ProjectedRun {
  const doc = payload as RawRunEnvelope
  return {
    session: doc.session,
    command: doc.command,
    output: doc.output ?? '',
    exitCode: doc.exit_code === null || doc.exit_code === undefined
      ? null
      : Number(doc.exit_code),
    settled: doc.settled === true,
    timeoutSeconds: doc.timeout ?? null,
  }
}

/**
 * `reset --json` -> 规范值。
 *
 * `detachedClients` 是这次重建的人肉代价：有那么多个开着的窗口被断开，必须由
 * 人手工重新打开。
 *
 * @param payload - 从 `reset --json` 解析出的 JSON envelope。
 */
export function projectReset(payload: unknown): ProjectedReset {
  const doc = payload as RawResetEnvelope
  return {
    session: doc.session,
    hadSession: doc.had_session === true,
    detachedClients: Number(doc.detached_clients ?? 0),
    historyLimit: doc.history_limit ?? null,
    history: projectHistory(doc),
  }
}

/**
 * `down --json` -> 规范值。`killed: false` 意味着没有东西可杀，这不是错误。
 *
 * @param payload - 从 `down --json` 解析出的 JSON envelope。
 */
export function projectDown(payload: unknown): ProjectedDown {
  const doc = payload as RawDownEnvelope
  return {
    session: doc.session,
    killed: doc.killed === true,
  }
}

/**
 * `capture --json` -> 规范值：pane **此刻**显示的内容。
 *
 * `screen` 是可见 pane 拼接成的单个字符串，模型读的是它，镜像渲染的也是它。
 * geometry 一并带上，因为镜像需要它，而重新读一遍要多花一个来回（每一次
 * `display-message` 都是一次独立 exec，实测）。
 *
 * @param payload - 从 `capture --json` 解析出的 JSON envelope。
 */
export function projectCapture(payload: unknown): ProjectedCapture {
  const doc = payload as RawCaptureEnvelope
  const lines: string[] = Array.isArray(doc.lines) ? doc.lines : []
  return {
    session: doc.session,
    exists: doc.exists === true,
    screen: lines.join('\n'),
    lineCount: lines.length,
    width: doc.width ?? null,
    height: doc.height ?? null,
    cursorX: doc.cursor_x ?? null,
    cursorY: doc.cursor_y ?? null,
    lastLine: doc.last_line ?? null,
  }
}

/**
 * `watch --json` -> 规范值，描述那个被打开的窗口——它开在**运行本插件的机器**
 * 上（不是远端主机）。
 *
 * @param payload - 从 `watch --json` 解析出的 JSON envelope。
 */
export function projectWatch(payload: unknown): ProjectedWatch {
  const doc = payload as RawWatchEnvelope
  return {
    session: doc.session,
    target: doc.target,
    title: doc.title,
    tmuxCommand: doc.tmux_command,
  }
}

/**
 * `list --json` -> 规范值：这台主机上此刻有哪些 tmux 会话。
 *
 * 这是唯一一个不围着某一个会话转的投影，也是唯一一个调用方在调用前还不知道会话
 * 名的——面板要长出第二行、模型要挑一个私有会话名，靠的都是它。
 *
 * `current` 是引擎的判断，说的是「这就是本次调用用 --session 寻址的那个会话」，
 * 而且是按 tmux **存下来的**名字比的（'.' / ':' 在创建时就被改写成 '_'），所以
 * 调用方不必自己去比对名字——那正是最容易写错、又最难发现的一处。
 *
 * @param payload - 从 `list --json` 解析出的 JSON envelope。
 */
export function projectSessionList(payload: unknown): ProjectedSessionList {
  const doc = payload as RawListEnvelope
  const sessions: RawSessionRow[] = Array.isArray(doc.sessions) ? doc.sessions : []
  return {
    session: doc.session,
    exists: doc.exists === true,
    sessions: sessions.map((entry) => ({
      name: entry.name,
      attached: Number(entry.attached ?? 0),
      windows: Number(entry.windows ?? 0),
      current: entry.current === true,
    })),
  }
}

/** 引擎用空串表示「这项没读到」；对模型来说，那与 null 是同一件事，不能含糊。 */
function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * `doctor --json` -> `ssh_console_doctor` 的规范值：一次自述诊断。
 *
 * 与其它 verb 不同，doctor 的价值在于把**引擎自己看到的处境**交出来——它在用哪份
 * 配置、认哪份 known_hosts、对面递来的主机密钥是什么、这个会话到底存不存在、
 * pane 跑的是什么 shell、以及有多少时间是花在 SSH 拨号上。这些字段对
 * capture/status 的 JSON 契约而言是**契约之外**的东西（往那两个 verb 多加一个键
 * 就等于顺手改了契约），所以 doctor 是它们唯一的出口。
 *
 * @param payload - 从 `doctor --json` 解析出的 JSON envelope。
 */
export function projectDoctor(payload: unknown): ProjectedDoctor {
  const doc = payload as RawDoctorEnvelope
  const geometry: RawGeometry = doc.geometry ?? {}
  return {
    session: doc.session,
    exists: doc.exists === true,
    hostKey: asText(doc.host_key),
    hostKeyType: asText(doc.host_key_type),
    knownHosts: asText(doc.known_hosts),
    configPath: asText(doc.config_path),
    config: asText(doc.config),
    dialMs: Number(doc.dial_ms ?? 0),
    totalMs: Number(doc.total_ms ?? 0),
    geometry: {
      cursorX: Number(geometry.cursor_x ?? 0),
      cursorY: Number(geometry.cursor_y ?? 0),
      width: Number(geometry.width ?? 0),
      height: Number(geometry.height ?? 0),
    },
    historyLimit: asText(doc.history_limit),
    historyBorn: asText(doc.history_born),
    shell: asText(doc.shell),
  }
}
