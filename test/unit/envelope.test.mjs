/**
 * `plugin/src/engine/envelope.ts` —— 信封与失败。
 *
 * 这是 S3 里 unit 层存在的理由：`parseEngineOutput` 是 `exec.ts` 唯一值得单测的一步，
 * 而它被特意做成纯函数（吃 `{stdout, stderr, code}`，不碰进程），所以这里可以直接喂
 * 字符串进来，把「空 stdout 报 protocol」、「吐了非 JSON 报 protocol」、「信封说
 * ok:false 就抛那个 kind」三件事钉住 —— 一次 spawn 都不需要。
 */
import { describe, expect, it } from 'vitest'
import {
  BridgeError,
  asEnvelope,
  errorCodeOf,
  errorDetailOf,
  failureOf,
  parseEngineOutput,
} from '../../plugin/lib/engine/envelope.js'

describe('parseEngineOutput', () => {
  it('hands back a successful envelope as-is', () => {
    const payload = parseEngineOutput({ stdout: '{"ok":true,"session":"default"}', stderr: '', code: 0 })
    expect(payload).toEqual({ ok: true, session: 'default' })
  })

  it('tolerates surrounding whitespace on stdout', () => {
    expect(parseEngineOutput({ stdout: '  {"ok":true}\n', stderr: '', code: 0 })).toEqual({ ok: true })
  })

  it('reports protocol when stdout carried no JSON, with the exit code', () => {
    let caught
    try {
      parseEngineOutput({ stdout: '', stderr: '', code: 2 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BridgeError)
    expect(caught.kind).toBe('protocol')
    expect(caught.message).toBe('the CLI printed no JSON (exit 2)')
  })

  it('quotes stderr when there is any, bounded to 400 characters', () => {
    let caught
    try {
      parseEngineOutput({ stdout: '   ', stderr: `oops ${'x'.repeat(500)}`, code: 3 })
    } catch (error) {
      caught = error
    }
    expect(caught.kind).toBe('protocol')
    const prefix = 'the CLI printed no JSON (exit 3): '
    expect(caught.message.startsWith(`${prefix}oops `)).toBe(true)
    // 400 是**整段** detail 的上限，`oops ` 也占额度 —— 所以只剩 395 个 x。
    expect(caught.message).toBe(`${prefix}oops ${'x'.repeat(395)}`)
    expect(caught.message.includes('x'.repeat(396))).toBe(false)
  })

  it('still names a missing exit code when the process died on a signal', () => {
    let caught
    try {
      parseEngineOutput({ stdout: '', stderr: '', code: null })
    } catch (error) {
      caught = error
    }
    expect(caught.message).toBe('the CLI printed no JSON (exit ?)')
  })

  it('reports protocol when stdout is not JSON, quoting its head', () => {
    let caught
    try {
      parseEngineOutput({ stdout: 'not json at all', stderr: '', code: 0 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BridgeError)
    expect(caught.kind).toBe('protocol')
    expect(caught.message).toBe('the CLI printed something other than JSON: not json at all')
  })

  it('binds the head of a long non-JSON stdout to 200 characters', () => {
    let caught
    try {
      parseEngineOutput({ stdout: 'y'.repeat(500), stderr: '', code: 0 })
    } catch (error) {
      caught = error
    }
    expect(caught.message.endsWith('y'.repeat(200))).toBe(true)
    expect(caught.message.includes('y'.repeat(201))).toBe(false)
  })

  it("throws the engine's own kind and message when the envelope says ok:false", () => {
    let caught
    try {
      parseEngineOutput({
        stdout: '{"ok":false,"error":{"kind":"console","message":"banner exchange failed"}}',
        stderr: '',
        code: 3,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BridgeError)
    expect(caught.kind).toBe('console')
    expect(caught.message).toBe('banner exchange failed')
  })

  it('falls back to cli when a failure envelope names no kind', () => {
    let caught
    try {
      parseEngineOutput({ stdout: '{"ok":false}', stderr: '', code: 4 })
    } catch (error) {
      caught = error
    }
    expect(caught.kind).toBe('cli')
    expect(caught.message).toBe('the CLI reported a failure')
  })
})

describe('failureOf', () => {
  it('is null for anything that is not ok:false', () => {
    expect(failureOf({ ok: true })).toBe(null)
    expect(failureOf({ session: 'default' })).toBe(null)
    expect(failureOf(null)).toBe(null)
    expect(failureOf('nope')).toBe(null)
  })

  it('picks out kind and message, defaulting each', () => {
    expect(failureOf({ ok: false, error: { kind: 'spawn', message: 'no such file' } })).toEqual({
      kind: 'spawn',
      message: 'no such file',
    })
    expect(failureOf({ ok: false, error: { message: 'only a message' } })).toEqual({
      kind: 'cli',
      message: 'only a message',
    })
    expect(failureOf({ ok: false })).toEqual({ kind: 'cli', message: 'the CLI reported a failure' })
  })
})

describe('asEnvelope', () => {
  it('treats every non-object as an empty envelope', () => {
    expect(asEnvelope(null)).toEqual({})
    expect(asEnvelope('text')).toEqual({})
    expect(asEnvelope(7)).toEqual({})
    expect(asEnvelope({ ok: false })).toEqual({ ok: false })
  })
})

describe('errorDetailOf and errorCodeOf', () => {
  it('prefers message, but never says "undefined"', () => {
    expect(errorDetailOf(new Error('boom'))).toBe('boom')
    expect(errorDetailOf({ code: 'EPERM' })).toBe(String({ code: 'EPERM' }))
    expect(errorDetailOf('plain')).toBe('plain')
    expect(errorDetailOf(null)).toBe('null')
  })

  it('reads code only when it is a string', () => {
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe('EPERM')
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 13 }))).toBe(undefined)
    expect(errorCodeOf(new Error('x'))).toBe(undefined)
    expect(errorCodeOf(null)).toBe(undefined)
  })
})
