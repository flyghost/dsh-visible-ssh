/**
 * `plugin/src/state/view.ts` ＋ `plugin/src/prompt/*` —— 「此刻是谁」怎么算、
 * 怎么渲染，以及**静态段里不许出现会变的东西**。
 *
 * 三个文件合在一起测，因为它们是同一件事的三段：`resolveSession()` 决定用哪个
 * 会话名（纯函数，逐档可钉），`runtimeView()` 把它连同目标机一起打包，
 * `renderRuntime()` 把它摊成模型读到的那几行。
 *
 * 最要紧的一条断言在最后：`REMOTE_HOST_RULES` 必须**逐字节恒定**。它进的是系统
 * 提示前缀，混进一个会变的会话名就会把整段前缀缓存打穿——那是笔真金白银的账。
 */
import { describe, expect, it } from 'vitest'
import { privateSessionName, resolveSession, runtimeView } from '../../plugin/lib/state/view.js'
import { renderRuntime } from '../../plugin/lib/prompt/runtime.js'
import { REMOTE_HOST_RULES } from '../../plugin/lib/prompt/section.js'

const CFG_CONFIG = { defaultSession: 'ops', sessionSource: 'config' }
const CFG_DEFAULT = { defaultSession: 'default', sessionSource: 'default' }

const PROFILE = {
  id: 'p1',
  label: 'aliyun-server-01',
  host: '192.0.2.10',
  port: 22,
  user: 'me',
  session: 'agent-ops',
}

/** 假 connections：只实现 view 需要的那两个读口。 */
function stubConnections(source, active) {
  return { source: async () => source, active: async () => active }
}

describe('resolveSession', () => {
  it('lets an explicitly named session win over everything', () => {
    expect(resolveSession(CFG_DEFAULT, PROFILE, 'e2e')).toEqual({ session: 'e2e', sessionOrigin: 'arg' })
  })

  it('treats an empty argument as no argument at all', () => {
    expect(resolveSession(CFG_DEFAULT, PROFILE, '')).toEqual({ session: 'agent-ops', sessionOrigin: 'profile' })
    expect(resolveSession(CFG_DEFAULT, PROFILE, null)).toEqual({ session: 'agent-ops', sessionOrigin: 'profile' })
  })

  it('uses the profile the human picked, and says so', () => {
    expect(resolveSession(CFG_CONFIG, PROFILE)).toEqual({ session: 'agent-ops', sessionOrigin: 'profile' })
  })

  it('falls back to the config default only when nobody picked one', () => {
    expect(resolveSession(CFG_CONFIG, null)).toEqual({ session: 'ops', sessionOrigin: 'config' })
    expect(resolveSession(CFG_CONFIG, { session: '' })).toEqual({ session: 'ops', sessionOrigin: 'config' })
  })

  it('keeps the built-in default distinguishable from a choice', () => {
    expect(resolveSession(CFG_DEFAULT, undefined)).toEqual({ session: 'default', sessionOrigin: 'default' })
  })
})

describe('runtimeView', () => {
  it('reports the target, the origin of the session name, and the pane it lands on', async () => {
    const view = await runtimeView(CFG_DEFAULT, stubConnections('profile', PROFILE))
    expect(view).toMatchObject({
      source: 'profile',
      id: 'p1',
      label: 'aliyun-server-01',
      target: 'me@192.0.2.10:22',
      session: 'agent-ops',
      sessionOrigin: 'profile',
      privateSession: 'agent-aliyun-server-01',
      onHumanPane: false,
    })
  })

  it('flags the human pane when the resolved name is the built-in default', async () => {
    const view = await runtimeView(CFG_DEFAULT, stubConnections('none', null))
    expect(view.session).toBe('default')
    expect(view.onHumanPane).toBe(true)
    expect(view.target).toBeNull()
  })

  it('still answers when no connections service is composed at all', async () => {
    const view = await runtimeView(CFG_CONFIG, undefined)
    expect(view.source).toBe('cli-config')
    expect(view.target).toBeNull()
  })
})

describe('privateSessionName', () => {
  it('derives a session name a human can recognise', () => {
    expect(privateSessionName({ label: 'Aliyun Server 01', target: null })).toBe('agent-aliyun-server-01')
    expect(privateSessionName({ label: null, target: 'me@192.0.2.10:22' })).toBe('agent-192-0-2-10-22')
    expect(privateSessionName({ label: null, target: null })).toBe('agent-work')
  })
})

describe('renderRuntime', () => {
  const base = {
    source: 'profile',
    id: 'p1',
    label: 'aliyun-server-01',
    target: 'me@192.0.2.10:22',
    session: 'agent-ops',
    sessionOrigin: 'profile',
    privateSession: 'agent-aliyun-server-01',
    onHumanPane: false,
  }

  it('states target and session with where the session name came from', () => {
    const text = renderRuntime(base)
    expect(text).toContain('visible-ssh runtime')
    expect(text).toContain('me@192.0.2.10:22')
    expect(text).toContain('profile "aliyun-server-01"')
    expect(text).toContain('agent-ops  (chosen in the conversation')
    expect(text).not.toContain('warning:')
  })

  it('offers the concrete way out whenever the session is the human pane', () => {
    const text = renderRuntime({ ...base, session: 'default', sessionOrigin: 'profile', onHumanPane: true })
    expect(text).toContain('is the human\'s pane')
    expect(text).toContain('ssh_console_up with session: "agent-aliyun-server-01"')
    expect(text).not.toContain('warning:')
  })

  it('warns when the name is nobody\'s choice but the built-in default', () => {
    const text = renderRuntime({ ...base, session: 'default', sessionOrigin: 'default', onHumanPane: true })
    expect(text).toContain('nobody has picked a session')
    expect(text).toContain('built-in default')
    expect(text).toContain('warning:')
  })

  it('says plainly when there is no host at all', () => {
    const text = renderRuntime({ ...base, target: null, label: null })
    expect(text).toContain('target:  none')
  })
})

describe('REMOTE_HOST_RULES', () => {
  it('routes remote work to the ssh_console tools and names the cost of going around', () => {
    expect(REMOTE_HOST_RULES).toContain('ssh_console_*')
    expect(REMOTE_HOST_RULES).toContain('ssh_console_run')
    expect(REMOTE_HOST_RULES).toContain('defeats the point')
  })

  it('pairs the human-pane ban with the private-session exit', () => {
    expect(REMOTE_HOST_RULES).toContain('belongs to the human')
    expect(REMOTE_HOST_RULES).toContain('ssh_console_up')
    expect(REMOTE_HOST_RULES).toContain('agent-<topic>')
  })

  it('holds no variable at all — it is the prompt cache prefix', () => {
    expect(REMOTE_HOST_RULES).not.toContain('{{')
    expect(REMOTE_HOST_RULES).not.toContain('${')
    expect(REMOTE_HOST_RULES).toBe(REMOTE_HOST_RULES.trimEnd())
  })
})
