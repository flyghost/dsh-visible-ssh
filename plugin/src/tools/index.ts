/**
 * 面向模型的工具面。
 *
 * 一个 CLI verb 一个工具，且刻意不多给：本插件的价值在于一条命令落进人正
 * attach 着的 tmux pane，所以这个工具面只是引擎的一层薄而诚实的投影，而不是
 * 它的第二份实现。所有难的部分（空闲门禁、按 session 隔离的退出码槽、prompt
 * 解析）都留在 Python 里，连同它们的测试。
 *
 * 约定借自插件开发指南：参数在 `execute` 运行之前先过 schema 校验，`execute`
 * 返回一个规范 camelCase 值，`render` 是另行拆出的纯文本投影，而 abort signal
 * 在任何工作开始之前就被检查。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  ParameterPropertySpec,
  ParameterSchemaSpec,
  ToolDefinition,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { requireApproval } from '../approval/index.js'
import type { EnginePort } from '../engine/port.js'
import type { Connections } from '../connection/connections.js'
import type { ResolvedConfig } from '../engine/config.js'
import {
  projectCapture,
  projectDoctor,
  projectDown,
  projectReset,
  projectRun,
  projectSessionList,
  projectStatus,
  projectUp,
  projectWatch,
} from '../engine/project.js'
import type { ProjectedStatus } from '../engine/project.js'

/** 一条回答来自哪台机器，也就是 `STATUS_PROPERTIES.connection` 的值形状。 */
interface ConnectionValue {
  source: string
  target?: string | null
  label?: string | null
  id?: string | null
}

/**
 * `status` 与 `up` 的 `render` 拿到的值：投影出来的状态文档，外加这一层
 * 自己贴上去的 `connection`。
 */
type StatusValue = ProjectedStatus & { connection: ConnectionValue }

/** 只带 `session` 的那几个工具的参数（status/list/capture/up/doctor/watch）。 */
interface SessionArgs {
  session?: string | undefined
}

/**
 * 校验期 schema 的片段。`satisfies` 是刻意的：模块级的 `const` 会把
 * `type: 'string'`、`required: true` 这类字面量放宽成 `string`/`boolean`，
 * 而 `defineTool` 的 `InferValue`/`InferArgs` 正是靠这些字面量推出工具的
 * 值类型与必填项；`satisfies` 提供上下文类型、保住字面量，且不改动运行时
 * 数据（`satisfies` 不产生任何代码）。
 */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] } satisfies ValueSchemaSpec
const NULLABLE_BOOLEAN = { oneOf: [{ type: 'boolean' }, { type: 'null' }] } satisfies ValueSchemaSpec
const NULLABLE_INTEGER = { oneOf: [{ type: 'integer' }, { type: 'null' }] } satisfies ValueSchemaSpec
const NULLABLE_NUMBER = { oneOf: [{ type: 'number' }, { type: 'null' }] } satisfies ValueSchemaSpec

/**
 * bridge 在引擎自身的命令超时之上额外允许的墙钟时间。
 *
 * 刻意给得宽松：引擎的计时只在命令发出后才开始，而 bridge 的计时从进程启动
 * 就算起——connect、`up()`、`arm()`，以及可能合法地阻塞满 30 秒空闲超时的
 * `wait_idle()`，全都发生在前面。富余量给紧了，一个干脆的「人正在打字」的回答
 * 就会变成一个莫须有的 bridge 超时。
 */
const BRIDGE_SLACK_MS = 60_000

/** 模型请求的命令超时上限（一小时）。 */
const MAX_COMMAND_TIMEOUT_MS = 3_600_000

const SESSION_PARAM = {
  type: 'string',
  description: 'tmux session name to act on. Defaults to the plugin\'s configured session ("default").',
} satisfies ParameterPropertySpec

const HISTORY_PROPERTIES = {
  limit: { ...NULLABLE_STRING, description: 'Configured server-wide history-limit.' },
  bornWith: { ...NULLABLE_STRING, description: 'The limit this pane was created with; scrollback cannot be enlarged afterwards.' },
  inUse: { ...NULLABLE_STRING, description: 'Lines currently held in the pane scrollback.' },
  stale: { type: 'boolean', required: true, description: 'True when this pane predates the configured limit, so old output is being discarded.' },
} satisfies ParameterSchemaSpec

const HISTORY_PROPERTY = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: HISTORY_PROPERTIES,
} satisfies ParameterPropertySpec

/** 状态文档，status 与 up 的输出 schema 共用。 */
const STATUS_PROPERTIES = {
  session: { type: 'string', required: true, description: 'The normalized session name tmux actually stores.' },
  exists: { type: 'boolean', required: true, description: 'Whether the tmux session exists right now.' },
  attachedClients: { type: 'integer', required: true, description: 'How many terminal clients are attached — i.e. how many humans are watching.' },
  idle: { ...NULLABLE_BOOLEAN, description: 'Whether the pane looks untouched by a human. null when the session does not exist.' },
  reason: { ...NULLABLE_STRING, description: 'Why the idle gate answered as it did.' },
  lastLine: { ...NULLABLE_STRING, description: 'The last non-empty line on screen, typically the shell prompt.' },
  history: HISTORY_PROPERTY,
  configPath: { type: 'string', required: true, description: 'The connection config file the CLI loaded. Never contains the password in the value.' },
  connection: {
    type: 'object',
    additionalProperties: false,
    required: true,
    description: 'Which machine this answer came from.',
    properties: {
      source: { type: 'string', required: true, description: '"profile" when a connection configured in the right-sidebar panel is active, "cli-config" when the CLI\'s own scripts/config/host.toml is deciding, "none" when neither exists.' },
      target: { ...NULLABLE_STRING, description: 'user@host:port of the active profile; null when the CLI file decides.' },
      label: { ...NULLABLE_STRING, description: 'The profile\'s human label.' },
      id: { ...NULLABLE_STRING, description: 'The profile id.' },
    },
  },
} satisfies ParameterSchemaSpec

const WATCH_OUTPUT_PROPERTIES = {
  session: { type: 'string', required: true, description: 'The tmux session the new window attaches to.' },
  target: { type: 'string', required: true, description: 'user@host the window connects to.' },
  title: { type: 'string', required: true, description: 'Window title, derived from the host config label.' },
  tmuxCommand: { type: 'string', required: true, description: 'The remote command the window runs.' },
} satisfies ParameterSchemaSpec

/** 用一行说明这个回答来自哪台机器。 */
function connectionLine(connection: ConnectionValue | null | undefined): string {
  if (connection === undefined || connection === null) return 'connection: unknown'
  if (connection.source === 'profile') {
    return `connection: profile "${connection.id}" — ${connection.label ?? '(unlabelled)'} (${connection.target ?? 'target unknown'})`
  }
  if (connection.source === 'cli-config') {
    return 'connection: the CLI\'s own config (scripts/config/host.toml); no profile is configured in the panel'
  }
  return 'connection: none — neither a panel profile nor the CLI config; fill one in from the right-sidebar panel'
}

/** 状态文档按行展开；session 不存在时则只有一行「已不在」。 */
function statusLines(value: StatusValue): string[] {
  if (!value.exists) {
    return [connectionLine(value.connection), `tmux session "${value.session}" does not exist. Call ssh_console_up to create it.`]
  }
  return [
    connectionLine(value.connection),
    `session "${value.session}": exists, ${value.attachedClients} client(s) attached, idle=${value.idle} (${value.reason})`,
    `last line: ${value.lastLine ?? '(none)'}`,
    `history: limit=${value.history.limit ?? '?'} bornWith=${value.history.bornWith ?? '?'} inUse=${value.history.inUse ?? '?'}${value.history.stale ? '  [STALE — rebuild recommended]' : ''}`,
  ]
}

/** 把状态文档渲染成文本块。 */
function renderStatus(value: StatusValue): { type: 'text'; text: string }[] {
  return statusLines(value).map((text) => ({ type: 'text', text }))
}

/** 共享前言：说明共享 pane 到底是什么。 */
const PANE_PREAMBLE =
  'Commands are typed into a tmux pane on the remote host that a human may be attached to, '
  + 'so they see every keystroke and can take over at any moment. '

const NOT_IDLE_NOTE =
  'Unlike the other verbs this one never types into the pane, so it is always safe to call — '
  + 'call it before ssh_console_run when you are unsure whether a human is mid-typing '
  + '(idle=false means do NOT inject). '

/**
 * 把每个工具注册进宿主 registry。
 * @param ctx - 宿主插件上下文（其中 `tools` 已注入）。
 * @param cfg - 解析后的插件配置。
 * @param connections - 连接门面；为 `undefined` 时退化成只认 CLI 自己的配置。
 * @param engine - 引擎端口（engine/port.js）；每一处 CLI 调用都从它走。
 * @returns 一个能把它们全部注销掉的 disposer。
 */
export function registerTools(
  ctx: Context,
  cfg: ResolvedConfig,
  connections: Connections | undefined,
  engine: EnginePort,
): () => void {
  const disposers: Array<() => void> = []
  const register = (tool: ToolDefinition) => { disposers.push(ctx.tools.register(tool)) }
  /** 调用方此刻正在对话的那条连接（connections.js）。 */
  const activeConnection = async () => (connections === undefined ? null : connections.active())
  /** 让 CLI 指向当前活动连接的那份子进程环境变量。 */
  const envOf = async (): Promise<Record<string, string>> => (connections === undefined ? {} : connections.envFor(undefined))
  /** 回答来自哪台机器——模型靠这个给自己定位。 */
  const connectionInfo = async (): Promise<ConnectionValue> => {
    if (connections === undefined) return { source: 'cli-config', target: null, label: null, id: null }
    const active = await activeConnection()
    return {
      source: await connections.source(),
      target: active === null ? null : `${active.user}@${active.host}:${active.port ?? 22}`,
      label: active?.label ?? null,
      id: active?.id ?? null,
    }
  }
  const sessionOf = async (args: SessionArgs): Promise<string> => {
    if (args.session !== undefined && args.session !== '') return args.session
    const active = await activeConnection()
    return active?.session ?? cfg.defaultSession
  }

  register(defineTool({
    name: 'ssh_console_status',
    description:
      'Report the state of the shared tmux pane on the remote host: whether the session exists, '
      + 'how many humans are attached to it, whether the shell is idle, the last line on screen, '
      + 'and the scrollback high-water marks. '
      + 'It also names WHICH machine the answer came from: a profile configured in the right-sidebar panel, or the CLI\'s own scripts/config/host.toml when no profile exists. '
      + 'Read-only: this never types into the pane and never creates a session. '
      + NOT_IDLE_NOTE
      + 'It is also the cheap way to re-check after a surprising result, for instance whether the pane '
      + 'predates the configured scrollback (history.stale=true means old output is being discarded and '
      + 'the session needs ssh_console_reset). '
      + 'Each tmux session is a separate conversation surface: the one named "default" belongs to the '
      + 'human watching it, so do not run destructive work there — use a private session name.',
    parameters: {
      session: SESSION_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: STATUS_PROPERTIES,
      },
      render: (_args, value) => renderStatus(value),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const session = await sessionOf(args)
      const env = await envOf()
      const payload = await engine.run(['--session', session, 'status', '--json'], { signal: exec.signal, env })
      return { ...projectStatus(payload), connection: await connectionInfo() }
    },
  }))

  register(defineTool({
    name: 'ssh_console_list',
    description:
      'List every tmux session on the remote host: each one\'s name, how many humans are attached '
      + 'to it, and how many windows it holds. '
      + 'This is the read to make BEFORE you know what to address — ssh_console_status and '
      + 'ssh_console_capture both need a session name, and this is how one is found; it is also how you '
      + 'check that a name is free before doing destructive work in it. '
      + 'It names WHICH machine the answer came from the same way ssh_console_status does. '
      + 'Read-only: nothing is typed into any pane, so it needs no idle gate and cannot disturb a human. '
      + 'It costs one SSH connection, so call it once and keep the answer rather than polling it.',
    parameters: {
      session: SESSION_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: { type: 'string', required: true, description: 'The session this call addressed — the explicit one, or the active host\'s.' },
          exists: { type: 'boolean', required: true, description: 'Whether THAT session is in the list. False says nothing about the other rows.' },
          sessions: {
            type: 'array',
            required: true,
            description: 'Every session on the host, in tmux\'s own order. Empty when there are none.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true, description: 'The stored session name. tmux rewrites "." and ":" to "_" at creation time.' },
                attached: { type: 'integer', required: true, description: 'Attached clients — i.e. how many humans are watching that pane right now.' },
                windows: { type: 'integer', required: true, description: 'How many windows the session holds.' },
                current: { type: 'boolean', required: true, description: 'True for the session this call addressed.' },
              },
            },
          },
          connection: STATUS_PROPERTIES.connection,
        },
      },
      render: (_args, value) => {
        const lines = [connectionLine(value.connection)]
        if (value.sessions.length === 0) {
          lines.push('no tmux sessions on this host yet — ssh_console_up creates one.')
          return lines.map((text) => ({ type: 'text', text }))
        }
        for (const row of value.sessions) {
          const notes = []
          if (row.current) notes.push('the one this call addressed')
          if (row.attached > 0) notes.push(`${row.attached} client(s) attached`)
          if (row.windows !== 1) notes.push(`${row.windows} windows`)
          lines.push(`- "${row.name}"${notes.length === 0 ? '' : ' — ' + notes.join(', ')}`)
        }
        lines.push(value.exists
          ? `"${value.session}" is among them.`
          : `"${value.session}" is NOT among them — ssh_console_up creates it; anything else here is private.`)
        return lines.map((text) => ({ type: 'text', text }))
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const session = await sessionOf(args)
      const env = await envOf()
      const payload = await engine.run(['--session', session, 'list', '--json'], { signal: exec.signal, env })
      return { ...projectSessionList(payload), connection: await connectionInfo() }
    },
  }))

  register(defineTool({
    name: 'ssh_console_doctor',
    description:
      'Diagnose a host on the engine\'s own terms — the read to make when something is WRONG: '
      + 'ssh_console_status or ssh_console_capture failed, a session you expected is missing, or the '
      + 'connection being used is not the one you thought was configured. '
      + 'It hands over what the other tools only imply: which config file and which known_hosts decided '
      + 'this call, what host key the server presented, whether the session exists at all, which shell '
      + 'its pane runs, how the scrollback limit compares with what the session was born with, and how '
      + 'much of the wall clock went into the SSH dial. '
      + 'Prefer it to guessing from an error string: those are the fields that tell a changed host key '
      + 'apart from a session that was simply never created. '
      + 'It costs several remote reads, so reach for it when diagnosing rather than on every call. '
      + 'Read-only: nothing is typed into any pane.',
    parameters: {
      session: SESSION_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: { type: 'string', required: true, description: 'The session this call addressed — the explicit one, or the active host\'s.' },
          exists: { type: 'boolean', required: true, description: 'Whether that tmux session exists right now.' },
          hostKey: { ...NULLABLE_STRING, description: 'How the client judged the host key this call: "matched" when it matched known_hosts, "pinned (first seen; appended as ...)" when it was just recorded, or "NOT VERIFIED (policy=insecure)". null when no verdict was reached.' },
          hostKeyType: { ...NULLABLE_STRING, description: 'The key type the server presented, e.g. ssh-ed25519. null when no key was involved.' },
          knownHosts: { ...NULLABLE_STRING, description: 'The known_hosts file this call trusted.' },
          configPath: { ...NULLABLE_STRING, description: 'The connection config file the CLI loaded. Never contains the password in the value.' },
          config: { ...NULLABLE_STRING, description: 'The loaded config as a masked multi-line summary: path, host, port, user, password (masked) and timeout.' },
          dialMs: { type: 'integer', required: true, description: 'Milliseconds spent establishing the SSH connection — the number to look at when everything is merely slow.' },
          totalMs: { type: 'integer', required: true, description: 'Milliseconds from process start to this answer.' },
          geometry: {
            type: 'object',
            additionalProperties: false,
            required: true,
            description: 'The pane\'s size and where its cursor sits.',
            properties: {
              cursorX: { type: 'integer', required: true },
              cursorY: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          historyLimit: { ...NULLABLE_STRING, description: 'The tmux history-limit in force, as tmux words it. null when it was never set.' },
          historyBorn: { ...NULLABLE_STRING, description: 'The history-limit this session was created with. Compare it with historyLimit: a session born tighter keeps its own scrollback.' },
          shell: { ...NULLABLE_STRING, description: 'The command the pane currently runs, typically the shell. null when it could not be read (e.g. no session).' },
          connection: STATUS_PROPERTIES.connection,
        },
      },
      render: (_args, value) => {
        const lines = [connectionLine(value.connection)]
        lines.push(value.exists
          ? `session "${value.session}" exists; its pane runs ${value.shell ?? '(command not reported)'}`
          : `session "${value.session}" does NOT exist — ssh_console_up creates it.`)
        lines.push(value.hostKey === null
          ? `host key: no verdict (known_hosts: ${value.knownHosts ?? 'unset'})`
          : `host key: ${value.hostKeyType ?? 'type unknown'} — ${value.hostKey}`)
        lines.push(`dial ${value.dialMs}ms, ${value.totalMs}ms from process start`)
        lines.push(`pane ${value.geometry.width}x${value.geometry.height}, cursor (${value.geometry.cursorX}, ${value.geometry.cursorY})`)
        if (value.historyLimit !== null || value.historyBorn !== null) {
          lines.push(`scrollback: history-limit ${value.historyLimit ?? '(never set)'}, this session born with ${value.historyBorn ?? '(unknown)'}`)
        }
        if (value.config !== null && value.config !== undefined) lines.push(...value.config.split('\n').filter((row) => row !== ''))
        return lines.map((text) => ({ type: 'text', text }))
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const session = await sessionOf(args)
      const env = await envOf()
      const payload = await engine.run(['--session', session, 'doctor', '--json'], { signal: exec.signal, env })
      return { ...projectDoctor(payload), connection: await connectionInfo() }
    },
  }))

  register(defineTool({
    name: 'ssh_console_capture',
    description:
      'Read what the shared tmux pane shows RIGHT NOW: the visible screen as text, plus the pane '
      + 'geometry and cursor position. '
      + 'This is a MIRROR, and it is read-only by construction — nothing is typed, so unlike '
      + 'ssh_console_run it needs no idle gate and cannot disturb a human who is mid-typing or a '
      + 'command that is still running. That makes it the right call when a run timed out, was '
      + 'interrupted, or returned `settled=false`: the pane, not the returned fragment, is the truth '
      + 'about what happened. Call it before deciding to retry anything. '
      + 'It reads the VISIBLE screen only — scrollback is not included, so long output may have '
      + 'scrolled past. For the idle gate, session existence and scrollback limits use '
      + 'ssh_console_status instead. Each poll is one SSH connection (measured ~1.3s here), so do not '
      + 'call it in a tight loop.',
    parameters: {
      session: SESSION_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: { type: 'string', required: true, description: 'The session that was read.' },
          exists: { type: 'boolean', required: true, description: 'False when there is no such session; every other field is then empty.' },
          screen: { type: 'string', required: true, description: 'The visible pane, blank rows between content preserved and the empty tail dropped.' },
          lineCount: { type: 'integer', required: true, description: 'How many lines the screen holds.' },
          width: { ...NULLABLE_INTEGER, description: 'Pane width in columns.' },
          height: { ...NULLABLE_INTEGER, description: 'Pane height in rows.' },
          cursorX: { ...NULLABLE_INTEGER, description: 'Cursor column, 0-based. -1 when unreadable.' },
          cursorY: { ...NULLABLE_INTEGER, description: 'Cursor row, 0-based. -1 when unreadable.' },
          lastLine: { ...NULLABLE_STRING, description: 'The last non-blank line, typically the shell prompt.' },
        },
      },
      render: (_args, value) => {
        if (!value.exists) {
          return [{ type: 'text', text: `tmux session "${value.session}" does not exist — nothing to show.` }]
        }
        if (value.screen === '') {
          return [{ type: 'text', text: `session "${value.session}" is live but its visible screen is empty.` }]
        }
        return [{ type: 'text', text: value.screen }]
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const session = await sessionOf(args)
      const env = await envOf()
      const payload = await engine.run(['--session', session, 'capture', '--json'], { signal: exec.signal, env })
      return projectCapture(payload)
    },
  }))

  register(defineTool({
    name: 'ssh_console_up',
    description:
      'Create the shared tmux pane on the remote host if it does not exist, and make it ready to run '
      + 'commands: it applies the scrollback options at creation time (a pane cannot be enlarged '
      + 'afterwards), revives a dead shell, and installs the out-of-band exit-code reporter. '
      + 'Idempotent — calling it on a live session only re-applies options, so it is safe to call before '
      + 'any run. Returns the same state document as ssh_console_status plus `created`, which tells you '
      + 'whether this call actually built the session. '
      + 'It types into the pane when the reporter has to be installed, so it obeys the same idle gate as '
      + 'ssh_console_run and refuses rather than overwrite a half-typed human command.',
    parameters: {
      session: SESSION_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...STATUS_PROPERTIES,
          created: { type: 'boolean', required: true, description: 'True when this call created the session rather than finding it.' },
          existed: { type: 'boolean', required: true, description: 'Whether the session existed before this call.' },
        },
      },
      render: (_args, value) => [
        ...statusLines(value),
        value.created ? 'this call created the session.' : 'the session already existed; options re-applied.',
      ].map((text) => ({ type: 'text', text })),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const session = await sessionOf(args)
      const env = await envOf()
      const payload = await engine.run(['--session', session, 'up', '--json'], { signal: exec.signal, env })
      return { ...projectUp(payload), connection: await connectionInfo() }
    },
  }))

  register(defineTool({
    name: 'ssh_console_run',
    description:
      PANE_PREAMBLE
      + 'The command is sent VERBATIM — no wrapper, no markers, no escaping — so quoting, pipes, '
      + 'redirections, variables and globs behave exactly as if the human had typed them. '
      + 'Refuses to inject while the pane is busy or a human is mid-typing; that refusal is a safety '
      + 'feature, not an error to work around. '
      + 'The result carries the visible output and the real exit code, read out of band from '
      + 'PROMPT_COMMAND rather than parsed from the screen. `settled=false` with `exitCode=null` means no '
      + 'exit code arrived in time: the command outlived its timeout, or it destroyed the shell (e.g. '
      + '`exit`); the output collected so far is still returned, and a human watching the pane can say '
      + 'what happened. Raise `timeoutMs` for long builds instead of re-running. '
      + 'Do not run anything destructive in the session named "default" — that is the human\'s pane.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The shell command to type into the pane, exactly as a person would type it.',
      },
      session: SESSION_PARAM,
      timeoutMs: {
        type: 'integer',
        description: `How long to wait for the command to settle, in milliseconds. Defaults to ${cfg.commandTimeoutMs}. `
          + `Capped at ${MAX_COMMAND_TIMEOUT_MS}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: { type: 'string', required: true, description: 'The session the command ran in.' },
          command: { type: 'string', required: true, description: 'The command as it was typed into the pane.' },
          output: { type: 'string', required: true, description: 'What the pane showed for this command, with the echo and the prompt stripped.' },
          exitCode: { ...NULLABLE_INTEGER, description: 'The real exit code, or null when none arrived (see settled).' },
          settled: { type: 'boolean', required: true, description: 'False when no exit code arrived: timeout or dead shell.' },
          timeoutSeconds: { ...NULLABLE_NUMBER, description: 'The timeout that was in force for this call, in seconds.' },
        },
      },
      render: (_args, value) => {
        const verdict = value.settled
          ? `--- exit code: ${value.exitCode} ---`
          : '--- exit code: unknown (timeout or the shell died) ---'
        return [{ type: 'text', text: `${value.output}\n${verdict}` }]
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const session = await sessionOf(args)
      const env = await envOf()
      const timeoutMs = resolveTimeout(args.timeoutMs, cfg)
      const argv = [
        '--session', session,
        'run', '--json',
        '--timeout', String(timeoutMs / 1000),
        '--', args.command,
      ]
      const payload = await engine.run(argv, { signal: exec.signal, timeoutMs: timeoutMs + BRIDGE_SLACK_MS, env })
      return projectRun(payload)
    },
  }))

  register(defineTool({
    name: 'ssh_console_reset',
    description:
      'Rebuild the shared tmux pane so it picks up the current scrollback limit. '
      + 'DESTRUCTIVE: this kills the session, so every attached human window is disconnected (its '
      + '`ssh -t ... tmux attach` exits) and the pane\'s entire scrollback is discarded. The caller gets '
      + 'a fresh, empty pane. '
      + 'Use it only when ssh_console_status reports history.stale=true, or when the shell is wedged past '
      + 'recovery. It requires interactive approval and will fail closed when no approval answerer is '
      + 'composed; if that happens, hand the decision to the user instead of retrying.',
    parameters: {
      session: SESSION_PARAM,
      justification: {
        type: 'string',
        description: 'One sentence for the user explaining why this exact session must be rebuilt. Shown in the approval prompt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: { type: 'string', required: true, description: 'The session that was rebuilt.' },
          hadSession: { type: 'boolean', required: true, description: 'Whether a session existed before the rebuild.' },
          detachedClients: { type: 'integer', required: true, description: 'How many human windows were disconnected by this call.' },
          historyLimit: { ...NULLABLE_STRING, description: 'The scrollback limit now in force.' },
          history: HISTORY_PROPERTY,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `session "${value.session}" rebuilt; history-limit now ${value.historyLimit ?? '?'}`
          + (value.detachedClients > 0
            ? `\n${value.detachedClients} attached window(s) were disconnected and must be reopened (run ssh_console_watch, or the launcher .bat).`
            : ''),
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const session = await sessionOf(args)
      const env = await envOf()
      await requireApproval(ctx, exec, 'ssh_console_reset', rebuildReason(session, args.justification))
      const payload = await engine.run(['--session', session, 'reset', '--json'], { signal: exec.signal, env })
      return projectReset(payload)
    },
  }))

  register(defineTool({
    name: 'ssh_console_down',
    description:
      'Kill the shared tmux pane on the remote host. '
      + 'DESTRUCTIVE: every attached human window is disconnected and all scrollback is lost; anything '
      + 'still running in the pane dies with it. '
      + 'Use it to clean up a private session you created, and never on the session named "default" '
      + 'unless the user asked for it. It requires interactive approval and will fail closed when no '
      + 'approval answerer is composed; if that happens, hand the decision to the user instead of retrying. '
      + 'Killing a session that does not exist is not an error (killed=false).',
    parameters: {
      session: SESSION_PARAM,
      justification: {
        type: 'string',
        description: 'One sentence for the user explaining why this exact session must be killed. Shown in the approval prompt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: { type: 'string', required: true, description: 'The session the call targeted.' },
          killed: { type: 'boolean', required: true, description: 'True when a session was actually killed; false when there was nothing to kill.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.killed
          ? `session "${value.session}" killed.`
          : `no session "${value.session}" — nothing to kill.`,
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const session = await sessionOf(args)
      const env = await envOf()
      await requireApproval(ctx, exec, 'ssh_console_down', killReason(session, args.justification))
      const payload = await engine.run(['--session', session, 'down', '--json'], { signal: exec.signal, env })
      return projectDown(payload)
    },
  }))

  register(defineTool({
    name: 'ssh_console_watch',
    description:
      'Open a visible terminal window that attaches to the shared tmux pane. '
      + 'The window is launched ON THE MACHINE RUNNING THIS PLUGIN (it runs the local Windows Terminal '
      + 'with `ssh -t <host> tmux attach`), not on the remote host — so this is how a human gets to watch '
      + 'the AI work, and it is the recovery step after ssh_console_reset disconnected their window. '
      + 'It creates the session if it does not exist yet, so it is safe to call before or after ssh_console_up. '
      + 'Requires Windows Terminal (wt.exe) on the local machine; anywhere else the call fails with a '
      + '`spawn` error rather than silently doing nothing.',
    parameters: {
      session: SESSION_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: WATCH_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `opened a local window "${value.title}" -> ${value.target} (${value.tmuxCommand})`,
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const session = await sessionOf(args)
      const env = await envOf()
      const payload = await engine.run(['--session', session, 'watch', '--json'], { signal: exec.signal, env })
      return projectWatch(payload)
    },
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * 对模型给出的命令超时做钳制，缺省时回落到配置里的那个。
 * @param requested - 模型给的 `timeoutMs`，可能没有。
 * @param cfg - 解析后的插件配置。
 */
function resolveTimeout(requested: number | undefined, cfg: ResolvedConfig): number {
  if (requested === undefined || requested === null) return cfg.commandTimeoutMs
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(requested)}`)
  }
  return Math.min(requested, MAX_COMMAND_TIMEOUT_MS)
}

/** 随重建审批请求一起提交、给人看的理由文本。 */
function rebuildReason(session: string, justification: string | undefined): string {
  const base = `rebuild tmux session "${session}": kills it, disconnects every attached window and discards the pane scrollback`
  return justification === undefined || justification === '' ? base : `${base} — ${justification}`
}

/** 随杀死审批请求一起提交、给人看的理由文本。 */
function killReason(session: string, justification: string | undefined): string {
  const base = `kill tmux session "${session}": disconnects every attached window and loses the pane scrollback`
  return justification === undefined || justification === '' ? base : `${base} — ${justification}`
}
