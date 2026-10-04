/**
 * `plugin/src/engine/fake.ts` —— unit 层的替身。
 *
 * fake 的**唯一**职责是：说出真端口会说的一切，但不 spawn。所以这里既检查它自己的
 * 那几只手（`calls`/`verbs`/`argvsOf`/`reply`/`fail`/`reset`），也检查它**和真端口
 * 不分叉的那条**：答复要过同一段 `failureOf()`，信封里的 `ok:false` 一样得变成抛出的
 * `BridgeError`。
 */
import { describe, expect, it } from 'vitest'
import { createFakeEngine, verbOf } from '../../plugin/lib/engine/fake.js'
import { BridgeError } from '../../plugin/lib/engine/envelope.js'

describe('verbOf', () => {
  it('skips leading flags and their values', () => {
    expect(verbOf(['--session', 'default', 'capture', '--json'])).toBe('capture')
    expect(verbOf(['--config', 'c.toml', '--session', 's', 'status'])).toBe('status')
  })

  it('stops at --, because everything after it is the command', () => {
    expect(verbOf(['--timeout', '30', 'run', '--', 'df -h /'])).toBe('run')
    expect(verbOf(['--', 'ls'])).toBe('')
  })

  it('has no verb to give for flags alone', () => {
    expect(verbOf(['--json'])).toBe('')
    expect(verbOf([])).toBe('')
  })
})

describe('createFakeEngine', () => {
  it('answers {ok:true} by default and records what it was asked', async () => {
    const engine = createFakeEngine()
    const argv = ['--session', 'default', 'status', '--json']
    await expect(engine.run(argv)).resolves.toEqual({ ok: true })
    argv[0] = 'mutated-after-the-fact'
    expect(engine.calls.length).toBe(1)
    expect(engine.calls[0].argv).toEqual(['--session', 'default', 'status', '--json'])
    expect(engine.verbs()).toEqual(['status'])
    expect(engine.argvsOf('status')).toEqual([['--session', 'default', 'status', '--json']])
    expect(engine.argvsOf('capture')).toEqual([])
  })

  it('keeps the options the caller passed, including the absence of a timeout', async () => {
    const engine = createFakeEngine()
    const signal = new AbortController().signal
    await engine.run(['--session', 's', 'capture'], { signal, timeoutMs: 20_000, env: { SSH_HOST: 'lan-box.local' } })
    await engine.run(['--session', 's', 'status'])
    expect(engine.calls[0]).toMatchObject({ verb: 'capture', signal, timeoutMs: 20_000, env: { SSH_HOST: 'lan-box.local' } })
    expect(engine.calls[1]).toMatchObject({ verb: 'status', signal: undefined, timeoutMs: undefined, env: undefined })
  })

  it('replies per verb and is chainable', async () => {
    const engine = createFakeEngine()
    const returned = engine.reply('status', { ok: true, session: 'default', exists: true }).reply('list', { ok: true, sessions: [] })
    expect(returned).toBe(engine)
    await expect(engine.run(['status', '--json'])).resolves.toEqual({ ok: true, session: 'default', exists: true })
    await expect(engine.run(['list', '--json'])).resolves.toEqual({ ok: true, sessions: [] })
    // 没钉过的 verb 仍是默认答复。
    await expect(engine.run(['doctor', '--json'])).resolves.toEqual({ ok: true })
  })

  it('fails a verb by throwing, the way the real port does', async () => {
    const engine = createFakeEngine().fail('capture', 'transport', 'banner exchange: connection refused')
    await expect(engine.run(['--session', 's', 'capture'])).rejects.toBeInstanceOf(BridgeError)
    await expect(engine.run(['--session', 's', 'capture'])).rejects.toMatchObject({
      kind: 'transport',
      message: 'banner exchange: connection refused',
    })
  })

  it('lets reply() and fail() replace each other for the same verb', async () => {
    const engine = createFakeEngine().fail('status', 'spawn', 'gone').reply('status', { ok: true })
    await expect(engine.run(['status'])).resolves.toEqual({ ok: true })
    engine.fail('status', 'console', 'no pane')
    await expect(engine.run(['status'])).rejects.toMatchObject({ kind: 'console' })
  })

  it('falls back to the handler for verbs that were not scripted, and reply() wins over it', async () => {
    const seen = []
    const engine = createFakeEngine((argv, call) => {
      seen.push(call.verb)
      return { ok: true, session: argv[argv.length - 2] }
    }).reply('status', { ok: true, scripted: true })
    await expect(engine.run(['--session', 'dev', 'status', '--json'])).resolves.toEqual({ ok: true, scripted: true })
    await expect(engine.run(['--session', 'dev', 'list', '--json'])).resolves.toEqual({ ok: true, session: 'list' })
    expect(seen).toEqual(['list'])
  })

  it('turns an ok:false envelope from a handler into a thrown BridgeError', async () => {
    const engine = createFakeEngine(() => ({ ok: false, error: { kind: 'console', message: 'no tmux server' } }))
    await expect(engine.run(['--session', 's', 'capture'])).rejects.toMatchObject({
      kind: 'console',
      message: 'no tmux server',
    })
  })

  it('resets the log, the scripted answers and the handler', async () => {
    const engine = createFakeEngine(() => ({ ok: true, from: 'handler' }))
    await engine.run(['status'])
    engine.reply('list', { ok: true, from: 'reply' }).fail('capture', 'console', 'x').handle(undefined)
    await expect(engine.run(['list'])).resolves.toEqual({ ok: true, from: 'reply' })
    engine.reset()
    expect(engine.calls).toEqual([])
    expect(engine.verbs()).toEqual([])
    await expect(engine.run(['list'])).resolves.toEqual({ ok: true, from: 'handler' })
    await expect(engine.run(['capture'])).resolves.toEqual({ ok: true, from: 'handler' })
  })
})
