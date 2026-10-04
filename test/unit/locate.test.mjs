/**
 * `plugin/src/engine/locate.ts` —— 端口会把运行交给**哪个 CLI**、以及它接受什么 argv。
 *
 * 两件事分开测：
 *
 *   * **位置**：编出来的引擎是一个平台包（`dsh-visible-ssh-engine-win32-x64`），默认
 *     `exeEntry` 是 null，所以程序路径由 `require.resolve()` 解出来（另见
 *     `test/artifact-check.mjs`，它走真仓库）；显式 `exeEntry` 是逃生口，优先。
 *   * **argv**：两个引擎有两处实测的不一致，第二处会**静默**失败：C 引擎要求每个 flag
 *     都在 verb **之前**，而 `run` 会把 verb 之后的内容原样拼进命令，所以未翻译的
 *     `run --json --timeout 30 -- df -h /` 不会报错，它会在 pane 里执行那串字面量。
 *     这几条检查就是钉住这个翻译；翻译本身是纯函数，所以喂**显式** program，免得为了
 *     一份 argv 去碰文件系统。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  engineAbsentError, engineCommand, enginePackageDir, enginePackageName, engineSpawnError, resolveEngine,
} from '../../plugin/lib/engine/locate.js'
import { resolveConfig } from '../../plugin/lib/engine/config.js'

// `resolveConfig` 会把 pythonEntry 解析成绝对路径（相对仓根），所以这里断言的是它
// 自己的值：这条检查钉的是「python 分支原样透传 argv」，不是路径解析。
const PYTHON = resolveConfig({ engine: 'python', python: 'python3', pythonEntry: 'scripts/tools/tmux_console.py' })

// 本文件谈的是 argv 形状，所以这两个 cfg 显式声明"哪儿都没有配置文件"（环境为空、
// `exists` 永远为假）：否则 `configPath` 会随这台机器上有没有用户目录那份 `host.toml`
// 而变，下面每条字面量断言都会跟着漂。`--config` 的注入本身由后面单独两条钉住。
const GO = resolveConfig({ engine: 'go' }, {}, () => false)
// 假想的一份仓内配置：路径用 `join` 拼（Windows 上 join 给的是反斜杠，`resolveConfig`
// 也是这么拼的，写死正斜杠就只有 Windows 会红）。
const GO_CONFIG_PATH = join('E:/repo', 'scripts', 'config', 'host.toml')
const GO_WITH_CONFIG = resolveConfig(
  { engine: 'go', repoRoot: 'E:/repo' }, {}, (path) => path === GO_CONFIG_PATH,
)
const PROGRAM = 'E:/repo/packages/engine-win32-x64/visible-ssh.exe'

// 平台包只有 win32-x64 一个（exe 是 Windows 二进制，`os`/`cpu` 写在包清单里）。
const ON_WINDOWS_X64 = process.platform === 'win32' && process.arch === 'x64'

describe('where the engine is', () => {
  it('names the payload package after the platform it was built for', () => {
    expect(enginePackageName('win32', 'x64')).toBe('dsh-visible-ssh-engine-win32-x64')
    expect(enginePackageName('linux', 'arm64')).toBe('dsh-visible-ssh-engine-linux-arm64')
  })

  it.skipIf(!ON_WINDOWS_X64)('resolves it through node_modules, not through a repo path', () => {
    const target = resolveEngine(GO)
    expect(target.source).toBe('package')
    expect(target.packageDir).toMatch(/packages[\\/]engine-win32-x64$/)
    expect(target.program).toBe(join(target.packageDir, 'visible-ssh.exe'))
    // `engineCommand` 不给 program 时走的就是这条路。
    expect(engineCommand(GO, ['status']).program).toBe(target.program)
  })

  it('lets an explicit exeEntry win, and does not claim a package dir then', () => {
    const target = resolveEngine(resolveConfig({ exeEntry: 'E:/elsewhere/visible-ssh.exe' }))
    expect(target).toEqual({ program: 'E:/elsewhere/visible-ssh.exe', source: 'config', packageDir: null })
  })
})

describe('engineCommand', () => {
  it('leaves the reference implementation alone: its shape IS the canonical one', () => {
    expect(PYTHON.pythonEntry).toMatch(/scripts[\\/]tools[\\/]tmux_console\.py$/)
    expect(engineCommand(PYTHON, ['--session', 'default', 'status', '--json'])).toEqual({
      program: 'python3',
      args: [PYTHON.pythonEntry, '--session', 'default', 'status', '--json'],
    })
  })

  it('runs the compiled engine without --json, which it does not define', () => {
    expect(engineCommand(GO, ['--session', 'default', 'status', '--json'], PROGRAM)).toEqual({
      program: PROGRAM,
      args: ['--session', 'default', 'status'],
    })
  })

  it('hoists a trailing --timeout above the verb, value and all', () => {
    expect(engineCommand(GO, ['--session', 'default', 'run', '--json', '--timeout', '30', '--', 'df -h /'], PROGRAM)).toEqual({
      program: PROGRAM,
      args: ['--timeout', '30', '--session', 'default', 'run', '--', 'df -h /'],
    })
  })

  it('keeps the order of the flags it does not move', () => {
    expect(engineCommand(GO, ['--config', 'c.toml', '--session', 's', 'capture', '--json'], PROGRAM).args).toEqual([
      '--config', 'c.toml', '--session', 's', 'capture',
    ])
  })

  it('leaves a value-less --timeout where it stands rather than eating the next word', () => {
    expect(engineCommand(GO, ['--session', 's', 'status', '--timeout'], PROGRAM).args).toEqual([
      '--session', 's', 'status', '--timeout',
    ])
  })

  it('does not touch a command string that happens to contain --json', () => {
    // 命令是**单独**一个 argv 元素，所以它里面的 --json 不可能被当成一个元素丢掉。
    expect(engineCommand(GO, ['--session', 's', 'run', '--', 'echo --json'], PROGRAM).args).toEqual([
      '--session', 's', 'run', '--', 'echo --json',
    ])
  })

  it('tells the engine which host.toml to read, ahead of every other flag', () => {
    // 引擎只认 `--config` 与 `SSH_CONFIG`（它自己不读用户目录），而且每个 flag 都必须在
    // verb 之前 —— 所以这份配置要排在 `--timeout` 与 verb 的前面。
    expect(GO_WITH_CONFIG.configPath).toBe(GO_CONFIG_PATH)
    expect(engineCommand(GO_WITH_CONFIG, ['--session', 'default', 'run', '--json', '--timeout', '30', '--', 'df -h /'], PROGRAM).args).toEqual([
      '--config', GO_CONFIG_PATH,
      '--timeout', '30', '--session', 'default', 'run', '--', 'df -h /',
    ])
  })

  it('does not add a second --config when the caller already passed one', () => {
    // 调用方（工具层）自己带 `--config` 时它说了算：多插一份就会有两个互相矛盾的 flag。
    expect(engineCommand(GO_WITH_CONFIG, ['--config', 'c.toml', '--session', 's', 'capture', '--json'], PROGRAM).args).toEqual([
      '--config', 'c.toml', '--session', 's', 'capture',
    ])
  })

  it('invents no --config when not one candidate exists', () => {
    expect(engineCommand(GO, ['--session', 's', 'status'], PROGRAM).args).toEqual(['--session', 's', 'status'])
  })

  it('never injects it into the reference implementation branch', () => {
    const withConfig = resolveConfig({ engine: 'python', python: 'python3', pythonEntry: 'scripts/tools/tmux_console.py' }, {}, () => true)
    expect(engineCommand(withConfig, ['status', '--json']).args).toEqual([withConfig.pythonEntry, 'status', '--json'])
  })
})

describe('the three spawn explanations', () => {
  it('the missing package one says how to get one, and how to switch to python', () => {
    // 这台机器上包**在**，所以用一个本平台一定没有的包名去撞真实的解析失败。
    let error
    try {
      enginePackageDir('dsh-visible-ssh-engine-plan9-sparc')
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeDefined()
    expect(error.kind).toBe('spawn')
    expect(error.message).toContain('no package dsh-visible-ssh-engine-')
    expect(error.message).toContain('npm install')
    expect(error.message).toContain('packages/engine-win32-x64/')
    expect(error.message).toContain("{ exeEntry: '<path to visible-ssh.exe>' }")
    expect(error.message).toContain("{ engine: 'python', pythonEntry: '…' }")
  })

  it('the absent one names the file, the engine and the three-file rule', () => {
    const error = engineAbsentError(GO, 'E:/repo/bin/visible-ssh.exe')
    expect(error.kind).toBe('spawn')
    expect(error.message).toContain('cannot run E:/repo/bin/visible-ssh.exe: no such file')
    expect(error.message).toContain("(engine 'go')")
    expect(error.message).toContain('packages/engine-win32-x64/')
    expect(error.message).toContain('visible-ssh-askpass.exe')
    expect(error.message).toContain('docs/engine-artifacts.md')
    expect(error.message).toContain("{ exeEntry: '<path to visible-ssh.exe>' }")
    expect(error.message).toContain("{ engine: 'python', pythonEntry: '…' }")
  })

  it('the ENOENT one adds the artifact hint, other codes are reported as they are', () => {
    const enoent = engineSpawnError(GO, 'visible-ssh.exe', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    expect(enoent.message).toContain('spawn ENOENT')
    expect(enoent.message).toContain('the compiled engine is missing from the platform package')

    const eperm = engineSpawnError(GO, 'visible-ssh.exe', Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }))
    expect(eperm.message).toBe('cannot run visible-ssh.exe: spawn EPERM')
  })
})
