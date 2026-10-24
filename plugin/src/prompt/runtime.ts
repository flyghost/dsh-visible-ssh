/**
 * 运行时快照：**会变的那部分事实**，每轮刷新一次，进模型上下文的 user-role
 * 快照（`systemPrompt.context()`），不进系统提示。
 *
 * ## 为什么必须分成两段（静态 section + 动态 context）
 *
 * 二者落在模型的**不同位置**，成本与语义都不一样：
 *
 * | | 静态 section（`section.ts`） | 动态 context（本文件） |
 * |---|---|---|
 * | 进哪 | 系统提示前缀 | 每轮的 user-role 快照 |
 * | 变不变 | 逐字节恒定 | 每轮重算 |
 * | 代价 | 变了就**打穿前缀缓存** | 本来就每轮新的，无额外代价 |
 * | 装什么 | 规则（「该走哪条路」） | 事实（「此刻是谁」） |
 *
 * 把「当前会话名」写进 section 是最容易犯的错：它一改，整段系统提示连同后面
 * 全部工具 schema 的缓存一起作废。反过来，把规则塞进 context 则会让它在历史
 * 里越堆越多。所以两者的分界不是风格问题——**它是缓存与正确性的分界线**。
 *
 * ## 为什么快照里必须写出「这个默认值是谁定的」
 *
 * 曾经的真实失手：出厂默认会话名是 `default`，而 `default` 是人的 pane、不许
 * 动手。AI 拿到的两句话（"默认是 default" ＋ "别在 default 上动手"）合成一个
 * 封闭结论——"这套工具做不了破坏性操作"——于是绕到本机 `ssh` 去执行，正好绕
 * 进了这条禁令想避免的不可见通道。写清 `built-in default — nobody chose it`
 * 之后，这句话才有第三条出口：**去建一个私有会话**。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeView, SessionOrigin } from '../state/view.js'
import { cachedRuntime } from '../state/view.js'

/** 快照的注册名。全局唯一。 */
export const RUNTIME_CONTEXT = 'visible-ssh:runtime'

/**
 * `CONTEXT_ORDERS` 现有档位是 110 (`SANDBOX_POLICY`) / 115 (`APPROVAL_POLICY`)
 * / 120 (`SUBAGENT_DELEGATION`)。这里用 200：**排在那三条策略之后**，因为它是
 * 具体目标的说明，读之前该先知道沙箱与审批的界限。
 */
const CONTEXT_ORDER = 200

/** 会话名的来历，翻成给人（和模型）看的一句话。 */
const ORIGIN_TEXT: Record<SessionOrigin, string> = {
  arg: 'named by the current call',
  profile: "chosen in the conversation's session picker",
  config: "the plugin config's defaultSession",
  file: 'the host.toml [host] session key',
  default: 'built-in default — nobody chose it',
}

/** 把一份视图渲染成快照文本。纯函数，好测。 */
export function renderRuntime(view: RuntimeView): string {
  const lines: string[] = ['visible-ssh runtime']
  if (view.target === null) {
    lines.push('  target:  none — no remote host is configured for this session '
      + '(Settings → visible-ssh, or the CLI config file); the ssh_console_* tools cannot reach anything until one is')
  } else {
    lines.push(`  target:  ${view.target}${view.label === null ? '' : `  (profile "${view.label}")`}`)
  }
  lines.push(`  session: ${view.session}  (${ORIGIN_TEXT[view.sessionOrigin]})`)
  if (view.onHumanPane) {
    lines.push(`  pane:    "${view.session}" is the human's pane — read it freely, but create a private `
      + `session before typing anything destructive: ssh_console_up with session: "${view.privateSession}"`)
  }
  if (view.onHumanPane && view.sessionOrigin === 'default') {
    lines.push('  warning: nobody has picked a session for this connection and none is configured, so the '
      + 'name above is the built-in default. Do not treat it as a choice — create a private session for any '
      + 'work that changes the host.')
  }
  return lines.join('\n')
}

/**
 * 注册运行时快照。
 *
 * `text` 必须是同步提供者（宿主的签名是 `(context) => string`），而连接档案是
 * 异步读出来的——所以这里只读 `cachedRuntime()`，缓存由**真正查询或改变事实的
 * 那几处**喂进来（工具执行、路由 POST、装配首次），见 `state/view.ts`。
 *
 * 缓存还是空的时候返回空串：宿主约定「空文本不贡献任何内容」，于是最坏情况是
 * 这一轮没有快照，而不是抛错打断组装。
 *
 * @param ctx - 已经能解引用 `systemPrompt` 的宿主上下文。
 * @returns 注销器。
 */
export function registerRuntimeContext(ctx: Context): () => void {
  return ctx.systemPrompt.context({
    name: RUNTIME_CONTEXT,
    order: CONTEXT_ORDER,
    text: () => {
      const view = cachedRuntime()
      return view === null ? '' : renderRuntime(view)
    },
  })
}
