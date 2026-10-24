/**
 * `plugin/src/tools/law.ts` —— 禁令与出口必须同句的那条法规，以及 9 条工具描述
 * 是否真的守住了它。
 *
 * 这一层测试存在的理由很具体：当初的失手不是"少了一句提醒"，而是四条描述里只有
 * 一条给了出口。而真正执行命令的那个工具（`ssh_console_run`）恰好是没给出口的
 * 那条。所以这里钉的不是文案风格，是**判据**：
 *
 *   * 只要一条描述把 `"default"` 说成人的 pane，它就必须在同一条描述里给出
 *     `ssh_console_up` + `session: "agent-<topic>"` 这条正向出口；
 *   * 任何描述都不许把一个**具体会话名**当成默认值写死（那是当初那句
 *     `Defaults to the plugin's configured session ("default")` 的形状）。
 */
import { describe, expect, it } from 'vitest'
import { HUMAN_PANE, PANE_LAW } from '../../plugin/lib/tools/law.js'
import { registerTools } from '../../plugin/lib/tools/index.js'
import { createFakeEngine } from '../../plugin/lib/engine/fake.js'
import { resolveConfig } from '../../plugin/lib/engine/config.js'

/** 9 条工具（真 `defineTool`，所以参数规格也真被编译过）。 */
function nineTools() {
  const registered = []
  const ctx = { tools: { register(tool) { registered.push(tool); return () => {} } } }
  registerTools(ctx, resolveConfig({}), undefined, createFakeEngine())
  return registered
}

/** 一条工具对模型说过的全部话：描述 ＋ 参数规格。 */
function spokenText(tool) {
  return `${tool.description ?? ''} ${JSON.stringify(tool.parameters ?? {})}`
}

describe('PANE_LAW', () => {
  it('names the human pane once, so callers cannot drift', () => {
    expect(HUMAN_PANE).toBe('default')
  })

  it('carries the ban and the way out in the same sentence pair', () => {
    expect(PANE_LAW).toContain('belongs to the human')
    expect(PANE_LAW).toContain('never')
    expect(PANE_LAW).toContain('ssh_console_up')
    expect(PANE_LAW).toContain('agent-')
  })
})

describe('the nine tool descriptions', () => {
  it('never leave a ban without its exit', () => {
    const offenders = nineTools()
      .filter((tool) => spokenText(tool).includes(`"${HUMAN_PANE}"`))
      .filter((tool) => !spokenText(tool).includes('ssh_console_up') && !spokenText(tool).includes('agent-'))
      .map((tool) => tool.name)
    expect(offenders).toEqual([])
  })

  it('never pin a session name as the literal default', () => {
    for (const tool of nineTools()) {
      expect(spokenText(tool)).not.toContain('("default")')
      expect(spokenText(tool)).not.toContain("configured session (\"default\")")
    }
  })

  it('point an omitted session at the runtime snapshot, not at a guess', () => {
    const status = nineTools().find((tool) => tool.name === 'ssh_console_status')
    const sessionParam = status.parameters.properties.session
    expect(sessionParam.description).toContain('visible-ssh runtime')
    expect(sessionParam.description).not.toContain('"default"')
  })
})
