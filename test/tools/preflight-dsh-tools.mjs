/**
 * 一次性预检（临时物，不属于仓库可见区）：不重启宿主，先替宿主把工具表装一遍。
 *
 * 两件事：
 *  1. 用**真的** `@deepseek-ai/dsh-tools` 的 `defineTool` 过一遍 `registerTools`，
 *     确认 9 个工具的 schema 能被框架接受、名字不重复 —— 这正是宿主组合期要做的事，
 *     所以任何 schema/重名问题会在这里先暴露，而不是等到重启宿主。
 *  2. 对**只读**的四个工具（status/list/doctor/capture）真的调一次 `execute`，
 *     走真引擎、真 SSH、真 tmux —— 等于把宿主侧那一半做了一次端到端演练。
 *     写类工具（up/run/reset/down/watch）故意不碰：会动远端会话或弹终端窗口。
 *
 * 用法：node test/tools/preflight-dsh-tools.mjs
 */
import { resolveConfig } from '../../plugin/lib/engine/config.js'
import { createEnginePort } from '../../plugin/lib/engine/exec.js'
import { registerTools } from '../../plugin/lib/tools/index.js'

const registered = []
const ctx = {
  tools: {
    register(tool) {
      registered.push(tool)
      return () => {}
    },
  },
}

// connections 传 undefined：工具就会走 `cli-config` 那条路，和直接跑 CLI 一致。
// 引擎端口要传真实现：这一遍演练的就是真 CLI、真 SSH、真 tmux。
const cfg = resolveConfig()
const dispose = registerTools(ctx, cfg, undefined, createEnginePort(cfg))

const names = registered.map((tool) => tool.name)
const expected = [
  'ssh_console_status',
  'ssh_console_list',
  'ssh_console_doctor',
  'ssh_console_capture',
  'ssh_console_up',
  'ssh_console_run',
  'ssh_console_reset',
  'ssh_console_down',
  'ssh_console_watch',
]
console.log(JSON.stringify({ step: 'register', count: names.length, names, sameAsExpected: JSON.stringify(names) === JSON.stringify(expected) }, null, 2))

const shape = registered.map((tool) => ({
  name: tool.name,
  parameters: Object.keys(tool.parameters?.properties ?? {}),
  hasOutput: tool.output !== undefined,
}))
console.log(JSON.stringify({ step: 'shape', shape }, null, 2))

// 必须是**真的** AbortSignal：runPiped 把它原样交给 child_process.spawn，
// 一个只有 throwIfAborted 的鸭子类型会被 Node 拒绝（探针自己踩过这一步）。
const controller = new AbortController()
const signal = controller.signal
const readOnly = ['ssh_console_status', 'ssh_console_list', 'ssh_console_doctor', 'ssh_console_capture']
for (const name of readOnly) {
  const tool = registered.find((candidate) => candidate.name === name)
  try {
    const payload = await tool.execute({}, { signal })
    const text = JSON.stringify(payload)
    console.log(JSON.stringify({ step: 'execute', name, ok: true, payload: text.length > 1200 ? `${text.slice(0, 1200)}…(${text.length} chars)` : text }))
  } catch (error) {
    console.log(JSON.stringify({ step: 'execute', name, ok: false, error: String(error?.message ?? error) }))
  }
}

for (const d of [dispose]) d()
