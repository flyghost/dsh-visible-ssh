/**
 * 面向浏览器的路由：只读镜像、连接表单自己的读/写一对，以及面板的 session
 * 操作。
 *
 * 为什么用路由而不是模型工具：pane 属于正在看它的人，所以人自己的浏览器应当
 * 能看到它 —— 也能指定该看哪台机器 —— 而不花掉一个模型回合。两条路径都严格
 * 如此：镜像跑的是 capture 工具所跑的那个同样的 CLI verb，且什么都不输入；
 * 连接那一对编辑的是一个本地 JSON 文件，并（为了一次测试）跑 `status`，那同样
 * 什么都不输入。
 *
 * 四条性质就是全部设计：
 *
 *   1. 这里**绝不**凭空造东西。镜像的 body 就是 `projectCapture` 的规范值，
 *      所以浏览器和模型读的是同一组字段名。
 *   2. 每一轮轮询只做**一次** capture。每次 capture 都是一条全新的 SSH 连接
 *      （实测约 1.3s），所以镜像持有一个短 TTL 缓存，并且每个 session 共享同
 *      一次在途加载：多个标签页、恰好落在一次 tick 之后的手动刷新，或开发模式
 *      下 React 的双次 effect，都**绝不**能成倍放大 SSH 流量。TTL（300ms）远
 *      低于面板的轮询间隔 —— 它吸收突发，**绝不**让镜像显得过期。
 *   3. 在任何东西启动之前，**每一个**输入都要先校验。session 名来自查询字符
 *      串，profile 来自请求体；两者都是给 CLI 的 argv 词、也是这里的缓存键，
 *      所以形状不合法就是一个 400，而不是一个子进程和一个无界的 map。
 *   4. 两条路由都**绝不**看到密码。存储把它写进凭据接缝（或它自己的文件），并
 *      以 `hasPassword` 作答；只有子进程的环境才会携带这个值（见
 *      `src/connection/connections.js`）。
 *   5. 面板**只**通过引擎行事，**绝不**绕开它。打开人观看的那个窗口用的是引擎
 *      自己的 `watch` verb —— 它拥有平台接缝（引擎源码 `internal/launch`）与 `\;` 选项
 *      链 —— 而杀掉一个 session 就是 `down`。这一层校验名字并转发；它**绝不**
 *      拼 ssh 命令行，理由与工具侧相同。
 *
 * 这些路径字面量在 `src/client/index.js` 里有一份重复（客户端那一半是原样发给浏览器
 * 的，无法 import 本文件）。两处必须一起改 —— `test/manifest-check.mjs`
 * 断言它们一致。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { projectCapture, projectDown, projectSessionList, projectWatch } from '../engine/project.js'
import type { ProjectedCapture } from '../engine/project.js'
import type { EnginePort } from '../engine/port.js'
import { parseSession, parseSessionName } from '../shared/session-name.js'
import type { SessionNameResult } from '../shared/session-name.js'
import type { Connections, ListedProfile, ProfileInput } from '../connection/connections.js'
import { loadSshHosts } from '../connection/ssh-config.js'
import type { SshConfigHost, SshHostList } from '../connection/ssh-config.js'
import type { ResolvedConfig } from '../engine/config.js'
import { rememberRuntime, runtimeView } from '../state/view.js'

/**
 * 组合自身的 Host/Origin + 认证围栏。宿主组合了它才存在，所以这条路由只用
 * `ctx.get('connection')` 机会性探测（见 `rejectedByFence`）。
 */
export interface ConnectionFence {
  /** 请求该被拒绝时给出状态码，否则 undefined。 */
  requestRejection(req: IncomingMessage): number | undefined
}

/** 惰性取围栏：没有连接服务的组合里它恒为 undefined。 */
export type ConnectionProvider = () => ConnectionFence | null | undefined

/** 一次 capture 的缓存读结果。 */
export interface ScreenRead<T> {
  value: T
  cached: boolean
  shared: boolean
  ageMs: number
}

/** 按 session 缓存的单飞结果。 */
export interface ScreenCache<T> {
  ttlMs: number
  read(session: string): Promise<ScreenRead<T>>
}

/**
 * `status --json` 的原始信封 —— 浏览器那条 `test` action 只读这四个字段。
 * 这是与引擎之间的信任边界：`runCli` 交回来的东西是 `unknown`，进门只做一次
 * 擦除式断言，字段本身仍按 `unknown` 处理（`exists` 用 `=== true`、其余 `?? null`）。
 */
interface RawStatusProbe {
  session?: unknown
  exists?: unknown
  last_line?: unknown
  config_path?: unknown
}

/** 已解析的 POST body：调用方按对象读，与改动前完全一样。 */
type ActionBody = Record<string, unknown>

/** `wanted()` 的校验结论：具名时是真校验，否则是一个恒真标记。 */
type SessionCheck = SessionNameResult | { ok: true }

declare module '@deepseek-ai/cordis' {
  interface Context {
    connection?: ConnectionFence
  }
}

/** 浏览器为拉取 pane 而轮询的路由。与 `src/client/index.js` 保持同步。 */
export const SCREEN_ROUTE_PATH = '/visible-ssh/screen'

/** 面板读写连接所走的路由。契约相同。 */
export const CONNECTION_ROUTE_PATH = '/visible-ssh/connection'

/**
 * 面板询问它可以对什么动手 —— 并借此动手 —— 的路由。契约相同。
 *
 * `GET` 是一次**本地**读取：哪台主机是活跃的，以及哪些 session 名属于它。
 * 某个 session 是否真的存在，是刻意**不**在这里回答的 —— 面板已经在轮询的镜像
 * 会回答那个问题，所以这条路由不碰 SSH，可以按面板较慢的节奏轮询而不开连接。
 */
export const SESSIONS_ROUTE_PATH = '/visible-ssh/sessions'

// 为那些把本模块当作路由层门面的调用方重新导出。
export { MAX_SESSION_LENGTH, parseSession } from '../shared/session-name.js'

/** 回显给浏览器的错误文本上限。 */
const MAX_ERROR_TEXT = 400

/** 连接请求只是几个短字段；比这更大的东西就是恶意了。 */
const MAX_BODY_BYTES = 16 * 1024

/**
 * 挡在一个 capture 函数前面的短期、单飞缓存。
 *
 * 失败**绝不**缓存：失败的 capture 交给下一次轮询重试，而不是把面板钉在一个它
 * 看不见的 TTL 的错误上。加入一次在途加载的调用方被告知的是 `shared: true`
 * 而不是 `cached: true`，因为读这条路由自己的诊断时这个区别很要紧：`cached`
 * 意味着 CLI 没跑，`shared` 意味着它为多个调用方跑了一次。
 *
 * @param options - `ttlMs`、`load(session)`，以及一个可注入的 `now` 时钟。
 * @returns `{ ttlMs, read(session) }`；缓存未命中时 `read` **绝不** reject。
 */
export function createScreenCache<T>({ ttlMs, load, now = Date.now }: {
  /** 一次成功的加载在缓存里活多久。 */
  ttlMs: number
  /** 真正的加载；只在未命中时被调用，且同一 session 同时只跑一次。 */
  load: (session: string) => Promise<T>
  /** 时钟，测试可注入。 */
  now?: () => number
}): ScreenCache<T> {
  /** session -> `{ at, value }`，只在成功时写入。 */
  const fresh = new Map<string, { at: number; value: T }>()
  /** session -> 当前正在跑的加载的 `Promise<{ at, value }>`。 */
  const inFlight = new Map<string, Promise<{ at: number; value: T }>>()

  return {
    ttlMs,
    /**
     * @param session - 一个已校验过的 session 名。
     * @returns 一次 capture 的 `{ value, cached, shared, ageMs }`。
     */
    read(session) {
      const stamp = now()
      const hit = fresh.get(session)
      if (hit !== undefined && stamp - hit.at < ttlMs) {
        return Promise.resolve({ value: hit.value, cached: true, shared: false, ageMs: stamp - hit.at })
      }

      const joined = inFlight.get(session)
      if (joined !== undefined) {
        // 一次加载、多个等待者：第二个调用方**绝不**能只因为第一个还在连接中
        // 就另开一条 SSH 连接。
        return joined.then((entry) => ({
          value: entry.value,
          cached: false,
          shared: true,
          ageMs: Math.max(0, now() - entry.at),
        }))
      }

      const started = Promise.resolve()
        .then(() => load(session))
        .then((value) => {
          // 时间戳打在加载之后：`ageMs` 必须描述数据，而不是调用方
          // 为这条连接等了多久。
          const entry = { at: now(), value }
          fresh.set(session, entry)
          return entry
        })
        .finally(() => {
          inFlight.delete(session)
        })

      inFlight.set(session, started)
      return started.then((entry) => ({ value: entry.value, cached: false, shared: false, ageMs: 0 }))
    },
  }
}

/** JSON 响应；`no-store`，因为这里的每个答案都是活的事实。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 桥接失败在有 `kind` 时取其值，外加有界的给人看的文本。 */
function describeFailure(error: unknown): { kind: string; message: string } {
  const kind = error !== null && typeof error === 'object' && 'kind' in error && typeof error.kind === 'string' ? error.kind : 'bridge'
  const detail = error !== null && typeof error === 'object' && 'message' in error ? error.message : error
  const text = String(detail ?? error)
  return { kind, message: text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text }
}

/**
 * 组合自身的 Host/Origin + 认证围栏，机会性读取。
 *
 * 这些路由在一个持有 SSH 凭据的主机上应答浏览器页面，所以围栏是复用而不是重新
 * 发明。用 `ctx.get`（而不是静态的 `inject`），因为本插件也会加载到没有连接
 * 服务的组合里，那里根本没有什么可用来围。
 *
 * @returns 请求已被拒绝且响应已发出时返回 true。
 */
function rejectedByFence(connection: ConnectionProvider, req: IncomingMessage, res: ServerResponse): boolean {
  const fence = connection()
  if (fence === undefined || fence === null) return false
  const rejection = fence.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/**
 * 构建镜像的请求处理器。它与注册分开导出，这样整条请求路径 —— 围栏、方法检查、
 * session 校验、缓存、状态码 —— 都能用假的 `req`/`res` 对象离线驱动。
 *
 * @param options - `cfg`、`load(session, env)`、一个 `connections` 面、一个可选
 *   的用于围栏的 `connection()` provider，以及一个可注入的 `now`。
 * @returns `{ cache, handle }`。
 */
/** `createScreenHandler` 的选项。 */
export interface ScreenHandlerOptions {
  cfg: ResolvedConfig
  /** 跑一次 capture 并投影；环境由缓存键决定，不是由此刻活跃的连接决定。 */
  load: (session: string, env: Record<string, string>) => Promise<ProjectedCapture>
  connections?: Connections | undefined
  connection?: ConnectionProvider
  now?: () => number
}

/** 镜像此刻应当使用的 session、环境与机器身份。 */
export interface ScreenView {
  session: string
  env: Record<string, string>
  target: string | null
  label: string | null
  id: string | null
  source: 'profile' | 'cli-config' | 'none'
}

export function createScreenHandler({
  cfg,
  load,
  connections,
  connection = () => undefined,
  now = Date.now,
}: ScreenHandlerOptions): {
  cache: ScreenCache<ProjectedCapture>
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
} {
  /** 镜像此刻应当使用的 session 与环境。 */
  async function current(): Promise<ScreenView> {
    const active = connections === undefined ? null : await connections.active()
    return {
      session: active?.session ?? cfg.defaultSession,
      env: active === null || connections === undefined ? {} : await connections.envFor(active.id),
      target: active === null ? null : `${active.user}@${active.host}:${active.port ?? 22}`,
      label: active?.label ?? null,
      id: active?.id ?? null,
      source: connections === undefined ? 'cli-config' : await connections.source(),
    }
  }

  /**
   * 缓存键：**连接**加 session。
   *
   * 两台主机可以各有一个 `default` session，所以只按 session 做键会让刚刚激活
   * 的连接在整个 TTL 内提供上一台主机的屏幕。分隔符**不可能**出现在任何一半里
   * —— session 名由 session-name.js 校验、profile id 由 connections.js 校验
   * —— 所以切分是无歧义的；CLI-config 那种情况下 id 那一半为空。
   */
  const KEY_SEPARATOR = '\u0000'
  const keyOf = (id: string | null, session: string): string => `${id ?? ''}${KEY_SEPARATOR}${session}`

  const cache = createScreenCache({
    ttlMs: cfg.screenTtlMs,
    // 环境来自**键**，而不是来自此刻活跃的那个：在一次连接下开始的 capture，
    // **绝不**能在另一次连接下结束。
    load: async (key: string): Promise<ProjectedCapture> => {
      const at = key.indexOf(KEY_SEPARATOR)
      const id = key.slice(0, at)
      const env = id === '' || connections === undefined ? {} : await connections.envFor(id)
      return load(key.slice(at + 1), env)
    },
    now,
  })

  return {
    cache,
    /** @param req - node IncomingMessage。@param res - node ServerResponse。 */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (rejectedByFence(connection, req, res)) return

      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }

      let session: string
      let view: ScreenView
      try {
        const url = new URL(String(req.url ?? SCREEN_ROUTE_PATH), 'http://localhost')
        view = await current()
        const parsed = parseSession(url.searchParams.get('session'), view.session)
        if (!parsed.ok) {
          sendJson(res, parsed.fromConfig ? 500 : 400, {
            ok: false,
            error: { kind: parsed.fromConfig ? 'bad-config' : 'bad-session', message: parsed.message },
          })
          return
        }
        session = parsed.session
      } catch (error) {
        // 一个 node 无法解析的 URL：上报为客户端的错，并带上解析器自己的话，
        // 这样一条坏链接是可诊断的。
        sendJson(res, 400, { ok: false, error: { kind: 'bad-request', message: describeFailure(error).message } })
        return
      }

      try {
        const shot = await cache.read(keyOf(view.id, session))
        // `session` 故意写在最后：CLI 上报的是 tmux 归一化后的名字，而镜像应当
        // 用它来标注自己，即使调用方要的是 `a.b`（tmux 存成 `a_b`）。
        sendJson(res, 200, {
          ok: true,
          ...shot.value,
          session: shot.value?.session ?? session,
          requestedSession: session,
          connection: { source: view.source, id: view.id, label: view.label, target: view.target },
          cached: shot.cached,
          shared: shot.shared,
          ageMs: shot.ageMs,
          now: now(),
        })
      } catch (error) {
        sendJson(res, 502, {
          ok: false,
          session,
          connection: { source: view.source, id: view.id, label: view.label, target: view.target },
          error: describeFailure(error),
        })
      }
    },
  }
}

/**
 * 收集一个有界的 JSON 请求体。
 *
 * 两种失败模式是故意保持区分的：body 畸形是调用方的错（400），而超大是一个尺寸
 * 上限（413）；把它们塌缩成一个 `null` 曾让畸形 JSON 上报成 413 —— 被
 * test/connection-check.mjs 抓到了。
 *
 * @returns `{ ok: true, value }`，或带 reason `'malformed'` / `'too-large'` 的
 *   `{ ok: false, reason }`。
 */
/** `readJsonBody` 的结论：要么是解析出来的值（`unknown`，进门再判），要么是失败原因。 */
type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'malformed' | 'too-large' }

async function readJsonBody(req: IncomingMessage): Promise<JsonBodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    // `Readable` 的异步迭代器在 @types/node 里给出 `any`；分块事实上总是 Buffer。
    const piece: Buffer = chunk
    size += piece.length
    if (size > MAX_BODY_BYTES) return { ok: false, reason: 'too-large' }
    chunks.push(piece)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

/**
 * 读取并审查一个 POST body，在它不可用时由本函数自行应答请求。
 *
 * 抽出来是为了让两条 action 路由不会在状态码上走偏：content-type 不对是 415、
 * JSON 畸形是 400、body 超大是 413、body 不是对象是 400。connection-check.mjs
 * 把每一条都钉住了，而这个块的第二份拷贝恰恰就是其中一条悄悄变掉的方式。
 *
 * @returns 解析出的对象；若响应已经发出则返回 `undefined`。
 */
async function readActionBody(req: IncomingMessage, res: ServerResponse): Promise<ActionBody | undefined> {
  const header = req.headers?.['content-type']
  // `split` 至少给一段，所以这里不会真的走到 `?? ''`。
  const [rawType] = String(header ?? '').split(';', 1)
  const contentType = (rawType ?? '').trim().toLowerCase()
  if (contentType !== 'application/json') {
    sendJson(res, 415, { ok: false, error: { kind: 'unsupported-media-type', message: 'content-type must be application/json' } })
    return undefined
  }

  let parsed: JsonBodyResult
  try {
    parsed = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, { ok: false, error: { kind: 'bad-request', message: describeFailure(error).message } })
    return undefined
  }
  if (!parsed.ok) {
    const tooLarge = parsed.reason === 'too-large'
    sendJson(res, tooLarge ? 413 : 400, {
      ok: false,
      error: {
        kind: tooLarge ? 'payload-too-large' : 'bad-request',
        message: tooLarge ? `body must be at most ${MAX_BODY_BYTES} bytes of JSON` : 'body must be a JSON object',
      },
    })
    return undefined
  }
  // 请求体是与浏览器之间的信任边界：解析结果按对象交给调用方，字段本身仍是
  // `unknown`（断言擦除，运行期一个字节都没变）。
  return parsed.value as ActionBody
}

/** `createConnectionHandler` 的选项。 */
export interface ConnectionHandlerOptions {
  cfg: ResolvedConfig
  connections: Connections
  connection?: ConnectionProvider
  /** 引擎端口（默认就地造真的），这样整条路径都能用 `engine/fake.ts` 测。 */
  engine?: EnginePort
  /** 可注入的桥接调用（默认走 `engine`），给测试一个更窄的缝。 */
  runCli?: (argv: string[], env: Record<string, string>) => Promise<unknown>
  /**
   * 读本机 `~/.ssh/config` 的方式，默认真读 `cfg.sshConfigPath`。
   *
   * 之所以留这道缝：那个文件是**操作者的**，而本仓有一条硬规矩 —— 密闭套件永远
   * 不碰真机。测试喂一份清单进来，线上则读真文件。
   */
  sshHosts?: () => SshHostList
}

/**
 * 构建连接路由的处理器。
 *
 * 一条路径、两个方法：`GET` 回答面板必须渲染什么（哪个来源在供数、不含密钥的
 * profiles），`POST` 施加一个 action。失败的 *test* 是带 `test.ok === false` 的
 * 200，因为「凭据错了」是一个答案，不是服务器错误 —— 而畸形的请求是 400、
 * profile 缺失是 404。
 *
 * @param options - `cfg`、`connections`、一个可选的 `connection()` 围栏，以及
 *   一个可注入的 `runCli`（桥接调用），这样整条路径都可测试。
 * @returns `{ handle }`。
 */
export function createConnectionHandler({
  cfg,
  connections,
  connection = () => undefined,
  engine,
  runCli = (argv: string[], env: Record<string, string>): Promise<unknown> =>
    engine === undefined
      ? Promise.reject(new Error('createConnectionHandler needs an engine port or an explicit runCli'))
      : engine.run(argv, { timeoutMs: cfg.screenTimeoutMs, env }),
  sshHosts = (): SshHostList => loadSshHosts(cfg.sshConfigPath ?? null),
}: ConnectionHandlerOptions): { handle(req: IncomingMessage, res: ServerResponse): Promise<void> } {
  /** 面板在表单与镜像之间做抉择所需的全部东西。 */
  async function overview(): Promise<{
    source: 'profile' | 'cli-config' | 'none'
    active: string | null
    profiles: ListedProfile[]
    file: string
    defaultSession: string
    /** 本机 `~/.ssh/config` 里的候选（只读），面板用它给表单"填一个别名"。 */
    sshConfig: { path: string | null; hosts: SshConfigHost[]; error: string | null }
  }> {
    const listed = await connections.list()
    const ssh = sshHosts()
    return {
      source: await connections.source(),
      active: await connections.activeId(),
      profiles: listed.profiles,
      file: connections.file,
      defaultSession: cfg.defaultSession,
      sshConfig: { path: ssh.path, hosts: ssh.hosts, error: ssh.error },
    }
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (rejectedByFence(connection, req, res)) return

      if (req.method === 'GET') {
        try {
          sendJson(res, 200, { ok: true, ...(await overview()) })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: describeFailure(error) })
        }
        return
      }

      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end()
        return
      }

      const body = await readActionBody(req, res)
      if (body === undefined) return

      const action = String(body.action ?? '')
      try {
        if (action === 'save') {
          // 浏览器送进来的 profile 是不可信输入，字段仍是 `unknown`：形状在这里
          // 断言成容器类型（擦除），真正逐字段的校验在 `saveProfile` 里。
          const checked = await connections.saveProfile((body.profile ?? {}) as ProfileInput, body.password)
          if (!checked.ok) {
            sendJson(res, 400, { ok: false, error: { kind: 'bad-profile', message: checked.message } })
            return
          }
          sendJson(res, 200, { ok: true, saved: checked.profile.id, ...(await overview()) })
          return
        }

        if (action === 'remove') {
          const id = String(body.id ?? '')
          const result = await connections.removeProfile(id)
          sendJson(res, result.removed ? 200 : 404, { ok: result.removed, ...(await overview()) })
          return
        }

        if (action === 'activate') {
          const id = String(body.id ?? '')
          const result = await connections.activate(id)
          sendJson(res, result.ok ? 200 : 404, { ok: result.ok, ...(await overview()) })
          return
        }

        if (action === 'test') {
          // `status` 证明 SSH + 认证可用，且不向任何 pane 输入：一个不存在的
          // session 仍然是一个成功的答案。
          const wanted = body.id === undefined || body.id === '' ? undefined : String(body.id)
          const active = await connections.active()
          const target = wanted === undefined ? active : (await connections.list()).profiles.find((profile) => profile.id === wanted)
          const session = target?.session ?? active?.session ?? cfg.defaultSession
          const checked = parseSessionName(session)
          if (!checked.ok) {
            sendJson(res, 200, { ok: true, test: { ok: false, message: checked.message } })
            return
          }
          const env = await connections.envFor(wanted ?? active?.id)
          try {
            // 引擎 `status` 的 JSON：唯一一处按字段名取出它，字段本身仍是 `unknown`
            // （断言擦除，与未加类型时逐字节相同）。
            const payload = (await runCli(['--session', checked.session, 'status', '--json'], env)) as RawStatusProbe
            sendJson(res, 200, {
              ok: true,
              test: {
                ok: true,
                session: payload.session,
                exists: payload.exists === true,
                lastLine: payload.last_line ?? null,
                configPath: payload.config_path ?? null,
              },
            })
          } catch (error) {
            sendJson(res, 200, { ok: true, test: { ok: false, message: describeFailure(error).message } })
          }
          return
        }

        sendJson(res, 400, { ok: false, error: { kind: 'bad-action', message: `unknown action ${JSON.stringify(action)}; expected save, remove, activate or test` } })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: describeFailure(error) })
      }
    },
  }
}

/** `createSessionsHandler` 的选项。 */
export interface SessionsHandlerOptions {
  cfg: ResolvedConfig
  connections: Connections
  connection?: ConnectionProvider
  /** 引擎端口（默认就地造真的），这样整条路径都能用 `engine/fake.ts` 测。 */
  engine?: EnginePort
  /** 可注入的桥接调用（默认走 `engine`），给测试一个更窄的缝。 */
  runCli?: (argv: string[], env: Record<string, string>) => Promise<unknown>
}

/**
 * 构建面板的 session 路由。
 *
 * `GET` 回答面板可以对什么动手：哪个来源在供数、选择器渲染的主机列表，以及属于
 * 活跃主机的那些 session 名。`POST` 恰恰施加一个 action，而每个 action 都是引擎
 * 自己的 verb，而不是重新实现：
 *
 *   - `open`     -> `watch`，它拼出 ssh/tmux 命令行，并在**本机**打开人观看的那
 *                   个窗口（那条平台接缝归引擎所有，这条路由**绝不**能长出第二
 *                   条）；
 *   - `kill`     -> `down`，引擎的「杀掉这个 session」verb；
 *   - `activate` -> 连接存储，这样选择器可以切换主机；
 *   - `session`  -> 连接存储，改**当前连接**干活用的 tmux 会话（对话框里那一格；工具
 *                   与镜像都读 `active().session`，所以一次写就让两边一起换）。
 *
 * 每一行都故意带 `exists: null`。镜像已经每两秒回答一次那个问题，所以每个 tick
 * 再花一条 SSH 连接去了解面板手里已经拿着的东西纯属浪费；由客户端合并。
 *
 * 人点一下按钮**就是**对 `kill` 的同意 —— 这就是为什么这条路由不走工具所用的、
 * 面向模型的审批接缝。浏览器围栏仍然生效（见 rejectedByFence），并且面板会问
 * 两次。
 *
 * @param options - `cfg`、`connections`、一个可选的 `connection()` 围栏，以及
 *   一个可注入的 `runCli`（桥接调用），这样整条路径都可测试。
 * @returns `{ handle }`。
 */
export function createSessionsHandler({
  cfg,
  connections,
  connection = () => undefined,
  engine,
  runCli = (argv: string[], env: Record<string, string>): Promise<unknown> =>
    engine === undefined
      ? Promise.reject(new Error('createSessionsHandler needs an engine port or an explicit runCli'))
      : engine.run(argv, { timeoutMs: cfg.timeoutMs, env }),
}: SessionsHandlerOptions): { handle(req: IncomingMessage, res: ServerResponse): Promise<void> } {
  /** `user@host:port`，这条路由上报的唯一机器身份。 */
  const targetOf = (profile: ListedProfile): string => `${profile.user}@${profile.host}:${profile.port ?? 22}`

  /** 哪台主机是活跃的、还能是哪些，以及属于它的那些名字。 */
  async function targets() {
    const source = await connections.source()
    const listed = await connections.list()
    const activeId = await connections.activeId()
    const active = listed.profiles.find((profile) => profile.id === activeId) ?? null
    const session = active?.session ?? cfg.defaultSession
    // 同一份事实的第三个消费者（前两个是工具与模型上下文）。面板照着它显示
    // 「此刻会在哪台机、哪个会话上干活」，与模型上下文里那段快照逐个字段同源——
    // 两处说不一样的话，人才会以为插件没生效（这正是当初那张"下拉明明选了"的
    // 疑团的土壤）。算这一遍顺手刷新缓存：面板那 5 s 一次的 GET 就是心跳。
    const runtime = await runtimeView(cfg, connections)
    rememberRuntime(runtime)
    return {
      source,
      active: active === null
        ? null
        : { id: active.id, label: active.label, target: targetOf(active), session },
      profiles: listed.profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        target: targetOf(profile),
        session: profile.session ?? cfg.defaultSession,
        active: profile.id === activeId,
      })),
      defaultSession: cfg.defaultSession,
      // 命名出来，好让未配置的面板能指向它将会编辑的那个文件，
      // 与设置区完全一样。
      file: connections.file,
      // GET 是**本地**读取，所以这里只有活跃主机那一个名字，而存在性是诚实的
      // null。远端到底有哪些会话由 POST 的 `list` action 回答（那是这条路由上唯一
      // 一次要付 SSH 的读），客户端拿它把行数长出来。
      sessions: source === 'none' ? [] : [{ name: session, exists: null }],
      runtime,
    }
  }

  /** 具名的那个 session，或活跃主机自己的那个，已解析或已拒绝。 */
  async function wanted(body: ActionBody): Promise<{ session: string; parsed: SessionCheck }> {
    const named = body.session === undefined || body.session === '' ? undefined : String(body.session)
    if (named !== undefined) return { session: named, parsed: parseSessionName(named) }
    const view = await targets()
    return { session: view.sessions[0]?.name ?? cfg.defaultSession, parsed: { ok: true } }
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (rejectedByFence(connection, req, res)) return

      if (req.method === 'GET') {
        try {
          sendJson(res, 200, { ok: true, ...(await targets()) })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: describeFailure(error) })
        }
        return
      }

      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end()
        return
      }

      const body = await readActionBody(req, res)
      if (body === undefined) return

      const action = String(body.action ?? '')
      try {
        if (action === 'activate') {
          const id = String(body.id ?? '')
          const result = await connections.activate(id)
          sendJson(res, result.ok ? 200 : 404, { ok: result.ok, ...(await targets()) })
          return
        }

        if (action === 'session') {
          // 改**当前连接**干活用的那个 tmux 会话（工具与镜像都读它）。名字的合法性
          // 由门面自己判定（`parseSessionName`），这样任何调用方都拿到同一套规则；
          // 应答与 `activate` 一样带上完整 `targets()`，让一次往返就刷新整张面板。
          const result = await connections.setSession(body.session)
          sendJson(res, result.ok ? 200 : 400, result.ok
            ? { ok: true, ...(await targets()) }
            : { ok: false, error: { kind: 'bad-session', message: result.message } })
          return
        }

        if (action === 'list' || action === 'open' || action === 'kill') {
          const { session, parsed } = await wanted(body)
          if (parsed.ok !== true) {
            sendJson(res, 400, { ok: false, error: { kind: 'bad-session', message: parsed.message } })
            return
          }
          // 这个 action 所属的连接，是从**活跃**主机解析的而不是从请求解析的：
          // 面板对它显示的东西动手。
          const active = await connections.active()
          const env = active === null ? {} : await connections.envFor(active.id)

          if (action === 'list') {
            // 这条路由上**唯一**一次要付 SSH 的读：GET 按较慢的节奏被轮询，所以
            // 枚举绝不能挂在它上面。列出来的每一行都是 tmux 自己报出来的，因此
            // 存在性是 true —— 不再是 GET 那一行里诚实的 null。
            const payload = await runCli(['--session', session, 'list', '--json'], env)
            const listed = projectSessionList(payload)
            sendJson(res, 200, {
              ok: true,
              session: listed.session,
              exists: listed.exists,
              sessions: listed.sessions.map((row) => ({ ...row, exists: true })),
            })
            return
          }

          if (action === 'open') {
            const payload = await runCli(['--session', session, 'watch', '--json'], env)
            sendJson(res, 200, { ok: true, opened: projectWatch(payload) })
            return
          }
          const payload = await runCli(['--session', session, 'down', '--json'], env)
          sendJson(res, 200, { ok: true, killed: projectDown(payload) })
          return
        }

        sendJson(res, 400, {
          ok: false,
          error: { kind: 'bad-action', message: `unknown action ${JSON.stringify(action)}; expected list, open, kill, activate or session` },
        })
      } catch (error) {
        sendJson(res, 502, { ok: false, error: describeFailure(error) })
      }
    },
  }
}

/**
 * 在组合的 web server 上注册每一条路由，如果它有的话。
 *
 * `webServer` **不**加进本插件的静态 `inject`：那样做会把整个插件 —— 包括七个
 * 面向模型的工具 —— 滞留在任何没有浏览器载体的组合里（headless、TUI）。这些
 * 路由改为等待载体，与 `dsh-client-modules` 完全一样。
 *
 * @param ctx - 宿主插件上下文。
 * @param cfg - 解析后的插件配置。
 * @param connections - 连接面（connections.js）。
 * @param engine - 引擎端口；镜像的每一次 capture 都从它走。生产里是
 *   `createEnginePort(cfg)`，测试里是 `createFakeEngine()`。
 */
export function registerWebRoutes(
  ctx: Context,
  cfg: ResolvedConfig,
  connections: Connections,
  engine: EnginePort,
): void {
  const load = (session: string, env: Record<string, string>): Promise<ProjectedCapture> => engine
    .run(['--session', session, 'capture', '--json'], { timeoutMs: cfg.screenTimeoutMs, env })
    .then(projectCapture)

  const screen = createScreenHandler({
    cfg,
    load,
    connections,
    connection: () => ctx.get('connection'),
  })
  const config = createConnectionHandler({
    cfg,
    connections,
    engine,
    connection: () => ctx.get('connection'),
  })
  const sessions = createSessionsHandler({
    cfg,
    connections,
    engine,
    connection: () => ctx.get('connection'),
  })

  const mount = (webCtx: Context) => webCtx.effect(function* routes() {
    yield webCtx.webServer.register({ kind: 'exact', path: SCREEN_ROUTE_PATH, handler: screen.handle } satisfies WebRoute)
    yield webCtx.webServer.register({ kind: 'exact', path: CONNECTION_ROUTE_PATH, handler: config.handle } satisfies WebRoute)
    yield webCtx.webServer.register({ kind: 'exact', path: SESSIONS_ROUTE_PATH, handler: sessions.handle } satisfies WebRoute)
  }, 'dsh-visible-ssh: browser routes')

  if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], mount)
  else mount(ctx)
}
