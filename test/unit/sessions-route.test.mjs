/**
 * `plugin/src/routes/index.ts` 的 sessions 路由 —— 由**内存端口**驱动。
 *
 * 这条检查是 S3 的收益本身：整条请求路径（方法检查、session 校验、argv、投影、状态
 * 码）都能在不起真 webServer、不 spawn、不碰 SSH 的情况下跑完，因为处理器收的是一
 * 个 `EnginePort`。route-check.mjs 覆盖的是同一个处理器的**离线形状**（它注入 `load`，
 * 用假 req/res 驱动三条路由）；这里补的是它与端口相接的那一段。
 */
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createSessionsHandler } from '../../plugin/lib/routes/index.js'
import { createFakeEngine } from '../../plugin/lib/engine/fake.js'
import { resolveConfig } from '../../plugin/lib/engine/config.js'

const CFG = resolveConfig({})

/** 一次请求；body 给 `undefined` 就发一个没有 body 的请求。 */
function fakeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.headers = body === undefined ? {} : { 'content-type': 'application/json' }
  return req
}

/** 一个只会记下状态码与 JSON body 的响应。 */
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(text) {
      this.body = text === undefined || text === '' ? undefined : JSON.parse(text)
    },
  }
}

function harness({ list = { profiles: [{ id: 'me', label: 'LAN box', host: 'lan-box.local', port: 22, user: 'me', session: 'dev' }] }, activeId = 'me' } = {}) {
  const activated = []
  const switched = []
  const connections = {
    file: 'E:/tmp/connections.json',
    source: async () => 'profile',
    list: async () => list,
    activeId: async () => activeId,
    // `list`/`open`/`kill` 这些 action 解析的是**活跃**主机的连接与环境，不是请求里的。
    active: async () => list.profiles.find((profile) => profile.id === activeId) ?? null,
    envFor: async (id) => ({ SSH_HOST: `host-of-${id}` }),
    activate: async (id) => {
      activated.push(id)
      return { ok: id === 'me' }
    },
    // 换会话是**存储**那边的写入（工具的默认会话跟着它走），所以这里也只记下它收到的
    // 名字 —— 校验与落盘是连接层自己的事（connection-check.mjs 管那段）。
    setSession: async (session) => {
      if (typeof session !== 'string' || session === '') return { ok: false, message: 'session must be a non-empty string' }
      switched.push(session)
      return { ok: true, session }
    },
  }
  const engine = createFakeEngine()
    .reply('list', { ok: true, session: 'dev', exists: true, sessions: [{ name: 'dev', attached: 1, windows: 2, current: true }] })
    .reply('watch', { ok: true, session: 'dev', target: 'me@lan-box.local:22', title: 'dsh', tmux_command: 'tmux attach -t dev' })
    .reply('down', { ok: true, session: 'dev', killed: true })
  const handler = createSessionsHandler({ cfg: CFG, connections, engine })
  return { handler, engine, activated, switched }
}

describe('sessions route: GET', () => {
  it('answers from the connections face alone, never touching the engine', async () => {
    const { handler, engine } = harness()
    const res = fakeRes()
    await handler.handle(fakeReq('GET'), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      source: 'profile',
      active: { id: 'me', label: 'LAN box', target: 'me@lan-box.local:22', session: 'dev' },
      defaultSession: 'default',
      file: 'E:/tmp/connections.json',
      sessions: [{ name: 'dev', exists: null }],
    })
    expect(res.body.profiles).toEqual([
      { id: 'me', label: 'LAN box', target: 'me@lan-box.local:22', session: 'dev', active: true },
    ])
    expect(engine.calls).toEqual([])
  })

  it('falls back to the default session when no connection is active', async () => {
    const { handler } = harness({ list: { profiles: [] }, activeId: null })
    const res = fakeRes()
    await handler.handle(fakeReq('GET'), res)
    expect(res.body.active).toBe(null)
    expect(res.body.sessions).toEqual([{ name: 'default', exists: null }])
  })
})

describe('sessions route: POST actions', () => {
  it('list runs the engine for the addressed session and marks every row present', async () => {
    const { handler, engine } = harness()
    const res = fakeRes()
    await handler.handle(fakeReq('POST', { action: 'list' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      session: 'dev',
      exists: true,
      sessions: [{ name: 'dev', attached: 1, windows: 2, current: true, exists: true }],
    })
    expect(engine.argvsOf('list')).toEqual([['--session', 'dev', 'list', '--json']])
  })

  it('an explicit session in the body wins over the active one', async () => {
    const { handler, engine } = harness()
    // 信封里的 session 是引擎自己回答的，不是请求的副本；让替身照 argv 回答，就能同时
    // 钉住这两件事：请求里的 session 真的走到了 argv，投影照抄的是引擎的答案。
    // `reply()` 的优先级高于 handler，所以先 `reset()` 把钉住的答复清掉。
    engine.reset()
    engine.handle((argv) => ({ ok: true, session: argv[1], exists: true, sessions: [] }))
    const res = fakeRes()
    await handler.handle(fakeReq('POST', { action: 'list', session: 'e2e' }), res)
    expect(engine.argvsOf('list')).toEqual([['--session', 'e2e', 'list', '--json']])
    expect(res.body).toEqual({ ok: true, session: 'e2e', exists: true, sessions: [] })
  })

  it('open maps to watch and kill maps to down', async () => {
    const { handler, engine } = harness()
    const open = fakeRes()
    await handler.handle(fakeReq('POST', { action: 'open', session: 'dev' }), open)
    expect(open.body).toEqual({
      ok: true,
      opened: { session: 'dev', target: 'me@lan-box.local:22', title: 'dsh', tmuxCommand: 'tmux attach -t dev' },
    })
    expect(engine.argvsOf('watch')).toEqual([['--session', 'dev', 'watch', '--json']])

    const kill = fakeRes()
    await handler.handle(fakeReq('POST', { action: 'kill', session: 'dev' }), kill)
    expect(kill.body).toEqual({ ok: true, killed: { session: 'dev', killed: true } })
    expect(engine.argvsOf('down')).toEqual([['--session', 'dev', 'down', '--json']])
  })

  it('activate goes to the connections face, not the engine, and 404s an unknown id', async () => {
    const { handler, engine, activated } = harness()
    const ok = fakeRes()
    await handler.handle(fakeReq('POST', { action: 'activate', id: 'me' }), ok)
    expect([ok.statusCode, ok.body.ok]).toEqual([200, true])

    const missing = fakeRes()
    await handler.handle(fakeReq('POST', { action: 'activate', id: 'nope' }), missing)
    expect([missing.statusCode, missing.body.ok]).toEqual([404, false])
    expect(activated).toEqual(['me', 'nope'])
    expect(engine.calls).toEqual([])
  })

  it('session writes through the connections face and answers with the refreshed view', async () => {
    // 「换会话」改的是**存储**里当前那条档案的 session —— 工具的默认会话与镜像都读它，
    // 所以这条路一次都不该碰引擎：它只是写一次、然后把新的 targets() 回给调用方。
    const { handler, engine, switched } = harness()
    const ok = fakeRes()
    await handler.handle(fakeReq('POST', { action: 'session', session: 'dev' }), ok)
    expect([ok.statusCode, ok.body.ok]).toEqual([200, true])
    // 回答是整张视图（客户端拿它重画两个下拉），不是请求的回声。
    expect(ok.body.active).toMatchObject({ id: 'me', session: 'dev' })
    expect(ok.body.sessions).toEqual([{ name: 'dev', exists: null }])
    expect(switched).toEqual(['dev'])
    expect(engine.calls).toEqual([])

    const refused = fakeRes()
    await handler.handle(fakeReq('POST', { action: 'session', session: '' }), refused)
    expect([refused.statusCode, refused.body]).toEqual([400, {
      ok: false,
      error: { kind: 'bad-session', message: 'session must be a non-empty string' },
    }])
    expect(switched).toEqual(['dev'])
  })

  it('rejects an unknown action with 400 bad-action', async () => {
    const { handler, engine } = harness()
    const res = fakeRes()
    await handler.handle(fakeReq('POST', { action: 'launch' }), res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error.kind).toBe('bad-action')
    expect(engine.calls).toEqual([])
  })

  it('turns an engine failure into 502 with the engine\'s own kind', async () => {
    const { handler, engine } = harness()
    engine.fail('list', 'transport', 'banner exchange: connection refused')
    const res = fakeRes()
    await handler.handle(fakeReq('POST', { action: 'list', session: 'dev' }), res)
    expect(res.statusCode).toBe(502)
    expect(res.body).toEqual({
      ok: false,
      error: { kind: 'transport', message: 'banner exchange: connection refused' },
    })
  })
})

describe('sessions route: the request edges', () => {
  it('405s a method that is neither GET nor POST, naming what it allows', async () => {
    const { handler, engine } = harness()
    const res = fakeRes()
    await handler.handle(fakeReq('PUT', { action: 'list' }), res)
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe('GET, POST')
    expect(engine.calls).toEqual([])
  })

  it('415s a body that is not declared as JSON', async () => {
    const { handler } = harness()
    const req = fakeReq('POST', { action: 'list' })
    req.headers = { 'content-type': 'text/plain' }
    const res = fakeRes()
    await handler.handle(req, res)
    expect(res.statusCode).toBe(415)
    expect(res.body.error.kind).toBe('unsupported-media-type')
  })
})
