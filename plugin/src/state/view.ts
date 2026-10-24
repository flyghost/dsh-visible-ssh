/**
 * `RuntimeView` —— 「此刻 AI 会在哪台机、哪个会话上干活」的**单一事实源**。
 *
 * ## 为什么要有这个文件
 *
 * 同一件事（当前目标是谁）过去散在三处各算各的：`connections.active()`、
 * `cfg.defaultSession`、`tools/index.ts` 里 `sessionOf()` 的临时三元表达式。
 * 三处各自正确，但**没有一处能回答「模型在决定要不要调用之前会看到什么」**——
 * 因为三个读取点都在**工具被调用之后**才说话。于是出现过这样一条闭环：
 * 人去下拉里选了 `agent-ops`，模型读到的参数说明还写着 `("default")`，而
 * `"default"` 是人的 pane、不许动手 ⇒ 模型判定「这套工具做不了破坏性操作」
 * ⇒ 绕过插件去本机 `ssh`。
 *
 * 现在把这个算盘只打一次，算完的事实交给三处消费：
 *
 * ```
 *   connections.active() ─┐
 *   cfg.defaultSession  ──┼─> runtimeView() ─┬─> prompt/runtime.ts  （每轮上下文快照）
 *   cfg.sessionSource   ──┘                  ├─> tools/index.ts     （sessionOf 的缺省值）
 *                                            └─> routes/index.ts    （GET 面板负载）
 * ```
 *
 * ## 三条设计约束
 *
 * 1. **纯读**：不写盘、不连 SSH、不碰引擎。它会被每轮上下文组装调用，
 *    必须便宜到可以随便调。
 * 2. **不猜**：每一档都带 `sessionOrigin`，说明这个会话名**是谁定的**——
 *    `arg`（这次调用点名的）／`profile`（人在下拉里选的）／`config`（插件
 *    配置）／`file`（那份 host.toml 的 `[host] session`）／`default`（出厂）。
 *    「出厂默认」和「人选的」在行为上必须可区分，否则告警无从触发。
 * 3. **可判别**：`onHumanPane` 为真时，调用方**必须**把出口一起说出来
 *    （见 `tools/law.ts` 的 `PANE_LAW`）——只报警不给路的告警会把人推去绕路。
 */

import type { Profile } from '../connection/connections.js'
import type { ResolvedConfig } from '../engine/config.js'
import { HUMAN_PANE } from '../tools/law.js'

/** 这个会话名是谁定下来的。 */
export type SessionOrigin = 'arg' | 'profile' | 'config' | 'file' | 'default'

/** 此刻的运行时事实。字段全部是「模型做决定之前就该知道」的那几个。 */
export interface RuntimeView {
  /** 连接从哪来：人存的档案／CLI 自己的 host.toml／都没有。 */
  source: 'profile' | 'cli-config' | 'none'
  /** 档案 id（`source==='profile'` 时有）。 */
  id: string | null
  /** 人给这台机起的别名。 */
  label: string | null
  /** `user@host:port`，模型的唯一定位符。 */
  target: string | null
  /** 这次会用到的 tmux 会话名（点名的或推出来的）。 */
  session: string
  /** 上面那个名字是谁定的。 */
  sessionOrigin: SessionOrigin
  /** 建议的私有会话名（要动 `"default"` 时照这个建）。 */
  privateSession: string
  /** `session` 是否正是**人**的那个 pane——即「要动手就得先建私有会话」。 */
  onHumanPane: boolean
}

/** 把任意字符串收成一个能当 tmux 会话名用的后缀。 */
function slug(text: string | null | undefined): string {
  const cleaned = (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'work' : cleaned.slice(0, 24)
}

/** 建议的私有会话名：跟着主机别名走，人一眼能认出来是给谁干的活。 */
export function privateSessionName(view: Pick<RuntimeView, 'label' | 'target'>): string {
  return `agent-${slug(view.label ?? view.target?.split('@').pop() ?? null)}`
}

/**
 * 会话名的解析顺序，**与 `tools/index.ts` 的 `sessionOf()` 必须逐档一致**：
 * 点名 > 档案（人在下拉里选的）> `cfg.defaultSession`。
 *
 * 拆成纯函数只为能被单元测试逐档钉住：这条顺序一旦漂移，下拉就又白选了。
 */
export function resolveSession(
  cfg: Pick<ResolvedConfig, 'defaultSession' | 'sessionSource'>,
  active: Pick<Profile, 'session'> | null,
  arg?: string | null,
): { session: string; sessionOrigin: SessionOrigin } {
  const named = arg === undefined || arg === null || arg === '' ? null : arg
  if (named !== null) return { session: named, sessionOrigin: 'arg' }
  const fromProfile = active?.session
  if (fromProfile !== undefined && fromProfile !== null && fromProfile !== '') {
    return { session: fromProfile, sessionOrigin: 'profile' }
  }
  return { session: cfg.defaultSession, sessionOrigin: cfg.sessionSource }
}

/** 读一次当前事实。`arg` 是这次调用点名的会话名（没有就不传）。 */
export async function runtimeView(
  cfg: Pick<ResolvedConfig, 'defaultSession' | 'sessionSource'>,
  connections: { source(): Promise<'profile' | 'cli-config' | 'none'>; active(): Promise<Profile | null> } | undefined,
  arg?: string | null,
): Promise<RuntimeView> {
  const source = connections === undefined ? 'cli-config' : await connections.source()
  const active = connections === undefined ? null : await connections.active()
  const { session, sessionOrigin } = resolveSession(cfg, active, arg)
  const target = active === null ? null : `${active.user}@${active.host}:${active.port ?? 22}`
  const label = active?.label ?? null
  return {
    source,
    id: active?.id ?? null,
    label,
    target,
    session,
    sessionOrigin,
    privateSession: privateSessionName({ label, target }),
    onHumanPane: session === HUMAN_PANE,
  }
}

/**
 * 一份**上次算出来**的视图。
 *
 * 为什么要有缓存：`systemPrompt.context()` 的 `text` 提供者必须是**同步**的
 * （`(context: AssembleContext) => string`），而 `connections.active()` 是异步
 * 读文件的。所以上下文那一段不能现算，只能读这份缓存。
 *
 * 谁负责喂它：**每一个真正改变事实或真正查询事实的入口**——
 * 工具执行（`tools/index.ts` 的 `sessionOf()` 每次都会刷新）、路由的 POST
 * （人在下拉里改完立刻刷）、插件装配（首次）。这条分工的含义是：人改完下拉，
 * 下一轮上下文就是新的；而不是"上下文自己会去读盘"。
 *
 * 绝不抛错：它服务于每轮 prompt 组装，一个坏掉的连接档案不该让模型失去系统
 * 提示。出错时保留上次的好值（没有好值就返回 null，上下文那一段整体不出）。
 */
let cached: RuntimeView | null = null
let inflight: Promise<RuntimeView | null> | null = null

/** 上次算出来的那份（`null` = 还没算过）。 */
export function cachedRuntime(): RuntimeView | null {
  return cached
}

/** 记下一份刚算出来的视图（工具与路由算完顺手喂进来，省一次读盘）。 */
export function rememberRuntime(view: RuntimeView): void {
  cached = view
}

/** 重算一份并记下。并发调用合并成一次；任何失败都不外传。 */
export function refreshRuntime(
  cfg: Pick<ResolvedConfig, 'defaultSession' | 'sessionSource'>,
  connections: { source(): Promise<'profile' | 'cli-config' | 'none'>; active(): Promise<Profile | null> } | undefined,
): Promise<RuntimeView | null> {
  if (inflight !== null) return inflight
  const pending = runtimeView(cfg, connections)
    .then((view) => {
      cached = view
      return view
    })
    .catch(() => cached)
    .finally(() => {
      inflight = null
    })
  inflight = pending
  return pending
}
