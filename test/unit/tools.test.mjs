/**
 * `plugin/src/tools/index.ts` —— 9 个模型工具注册在**内存端口**上。
 *
 * 这里演练的是注册表与端口之间的那条缝：`register(defineTool({…}))`（真 `defineTool`，
 * 所以参数规格与 output schema 真的会被编译）＋ 每一处 `engine.run(argv, {signal, env})`。
 * 真 CLI 那一侧留给 `test/tools/preflight-dsh-tools.mjs`（它跑真 exe、真 SSH）。
 */
import { describe, expect, it } from 'vitest'
import { registerTools } from '../../plugin/lib/tools/index.js'
import { createFakeEngine } from '../../plugin/lib/engine/fake.js'
import { resolveConfig } from '../../plugin/lib/engine/config.js'

const CFG = resolveConfig({})

/** 假 ctx：只提供 `tools.register`，把工具收进一个数组。 */
function fakeCtx() {
  const registered = []
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

function harness() {
  const engine = createFakeEngine()
    .reply('status', { ok: true, session: 'default', exists: true, attached_clients: 1, last_line: 'me@lan-box:/opt $' })
    .reply('list', { ok: true, session: 'default', exists: true, sessions: [{ name: 'default', attached: 3, windows: 1, current: true }] })
  const { ctx, registered } = fakeCtx()
  const dispose = registerTools(ctx, CFG, undefined, engine)
  return { engine, registered, dispose }
}

const signal = () => new AbortController().signal

describe('registerTools', () => {
  it('registers nine uniquely named tools and hands back one disposer', () => {
    const { registered, dispose } = harness()
    expect(registered.length).toBe(9)
    expect(new Set(registered.map((tool) => tool.name)).size).toBe(9)
    expect(typeof dispose).toBe('function')
  })

  it('sends status through the port with the canonical argv', async () => {
    const { engine, registered } = harness()
    const status = registered.find((tool) => tool.name === 'ssh_console_status')
    const value = await status.execute({}, { signal: signal() })
    expect(engine.argvsOf('status')).toEqual([['--session', 'default', 'status', '--json']])
    expect(value.session).toBe('default')
    expect(value.exists).toBe(true)
  })

  it('honours an explicit session argument', async () => {
    const { engine, registered } = harness()
    const list = registered.find((tool) => tool.name === 'ssh_console_list')
    await list.execute({ session: 'e2e' }, { signal: signal() })
    expect(engine.argvsOf('list')).toEqual([['--session', 'e2e', 'list', '--json']])
  })

  it('lets a failure out of execute as the engine reported it', async () => {
    const { engine, registered } = harness()
    engine.fail('capture', 'console', 'no tmux server running')
    const capture = registered.find((tool) => tool.name === 'ssh_console_capture')
    await expect(capture.execute({}, { signal: signal() })).rejects.toMatchObject({
      kind: 'console',
      message: 'no tmux server running',
    })
  })

  it('refuses to start on an already-aborted signal', async () => {
    const { engine, registered } = harness()
    const controller = new AbortController()
    controller.abort()
    const status = registered.find((tool) => tool.name === 'ssh_console_status')
    await expect(status.execute({}, { signal: controller.signal })).rejects.toThrow()
    expect(engine.calls).toEqual([])
  })
})
