/**
 * 系统提示里的**静态**规则段：把「这台远端主机该走哪条路」从工具体内提到
 * 模型每一轮都必然读到的地方。
 *
 * ## 为什么必须是一段 section，而不是塞进工具描述
 *
 * 工具描述只在模型**决定去读那个工具**之后才被展开，而这里要修的是「它根本
 * 没想到有这条路」。实测过的现场是：`~/.ssh/config` 里配好了别名、`.pem` 就位、
 * 面板也活着，AI 却在本机 `wsl` 里手敲 `ssh`——因为分派规则从来没有写进它读
 * 得到的任何一段文本。能力存在 ≠ 会被使用。
 *
 * ## 为什么这段文本里**不许出现变量**
 *
 * 系统提示是**前缀缓存**的载体：这段文字只要变一个字节，它后面的全部内容都要
 * 重新计费。所以这里只写**恒真的规则**，当前是谁、当前哪个会话这类会变的事实
 * 交给 `prompt/runtime.ts` 的运行时快照（那份本来就是每轮刷新的 user-role
 * 快照）。这也解释了 `interpolate: false`：这段文本连 `{{}}` 插值都不参加，
 * 逐字节稳定。
 *
 * ## 为什么 order 是 950
 *
 * `FILE_REFERENCE` 是 900，`TOOL_BASH` 是 1000。这段落在两者之间，也就是**排在
 * 宿主自己的 bash/pwsh 工具说明之前**——而"在本机 shell 里 ssh 过去"正是要被
 * 停掉的那条替代路径。规则必须先于诱惑出现。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 段的注册名。全局唯一，同层重名会抛。 */
export const REMOTE_HOST_SECTION = 'visible-ssh:remote-host'

/** 900 (`FILE_REFERENCE`) 与 1000 (`TOOL_BASH`) 之间，见文件头。 */
const SECTION_ORDER = 950

/**
 * 规则正文。措辞上刻意做了三件事：
 *
 * 1. **给判定条件**（"when one is configured"），不给绝对命令——否则在没配
 *    主机的会话里这段就是噪音，模型会学会忽略它。
 * 2. **说出代价**，不只说禁令：「本机 shell 也能做到，但人看不见」比「不许用
 *    本机 shell」更抗诱惑，因为后者在模型看来只是条无理由的约束。
 * 3. **禁令与出口成对**（见 `tools/law.ts` 的注释）：只写"别动 default"会让
 *    读者回避整个工具面，那正是当初失手的形状。
 */
export const REMOTE_HOST_RULES = `## Remote host work

A remote host may be configured for this session — the \`ssh_console_*\` tools drive it. When one is:

- **That host's work goes through \`ssh_console_*\`.** Files, packages, services, logs, builds — anything that touches that machine uses these tools. Reaching it from the local shell instead (\`ssh\`/\`scp\`/\`plink\` inside pwsh or wsl) also "works", but it defeats the point: a command typed into the shared tmux pane is visible to the human watching it and can be interrupted or taken over mid-run. A local shell run is invisible.
- **Read with \`ssh_console_status\` / \`ssh_console_capture\`; change with \`ssh_console_run\`.** \`status\` never types anything, so it is always safe to call first.
- **The pane named \`default\` belongs to the human.** Read it freely; never type destructive work into it. Create a private session instead — \`ssh_console_up\` with \`session: "agent-<topic>"\` — and pass that name to every other tool.
- **The current target and session are stated in the \`visible-ssh runtime\` part of this context.** Read them there instead of assuming a default; \`ssh_console_status\` reports the session actually in use.`

/**
 * 注册这段规则。
 * @param ctx - 已经能解引用 `systemPrompt` 的宿主上下文。
 * @returns 注销器（Cordis 的 effect disposer）。
 */
export function registerRemoteHostSection(ctx: Context): () => void {
  return ctx.systemPrompt.section({
    name: REMOTE_HOST_SECTION,
    order: SECTION_ORDER,
    text: REMOTE_HOST_RULES,
    interpolate: false,
  })
}
