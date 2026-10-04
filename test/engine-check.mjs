// 针对引擎接缝的离线检查：端口会去跑哪个 CLI（engine/locate.ts），以及两个引擎
// 各自接受什么 argv。不需要 DSH、不需要 SSH、不需要 exe —— `engineCommand` 是纯函数。
//
// 为什么非要有这个套件：两个引擎在**两处**实测到的行为上不一致，而其中一处
// 不一致是**静默**失败的。这两处都容易写错，却很难被发现：
//
//   * `--json` 只存在于 Python（是个 subparser 的 flag）。Go CLI 永远输出那个
//     信封，所以在它那里传这个 flag 会得到 `flag provided but not defined`。
//   * **Python** 把 `--json`/`--timeout` 放在 verb **之后**；**Go** 要求每个 flag
//     都放在 verb **之前**。对 `run` 来说，Go 侧会把 verb 之后的一切拼进命令
//     字符串，所以未翻译的形状会在 pane 里执行
//     `--json --timeout 30 -- df -h /` 这个字面字符串，而**不是**报错。
//
// 下面最后一项检查直接把这个隐患断言住，于是将来若有重构靠「把规范 argv 直接
// 交给 Go」来「简化」翻译，它会在**这里**失败，而不是在某个人的 tmux pane 里
// 失败。
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineCommand } from '../plugin/lib/engine/locate.js'
import { resolveConfig } from '../plugin/lib/engine/config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// 这个套件**只**谈 argv 形状，所以它显式声明"哪儿都没有配置文件"（`exists` 永远为假，
// 环境也是空的）：否则 `configPath` 会随这台机器上有没有用户目录那份 host.toml
// 而变，下面每条断言的字面量都会跟着漂 —— 一个会随操作者家目录变绿变红的套件不算密闭。
// `--config` 本身的行为在下面单独一段里用**注入的**存在判断断言。
const go = resolveConfig({ repoRoot: REPO }, {}, () => false)
const python = resolveConfig({ repoRoot: REPO, engine: 'python' }, {}, () => false)

// --- 跑哪个程序，只由 config 决定 ------------------------------------------
// 默认 `exeEntry` 是 null：位置由**平台包**解析（`locate.resolveEngine()`），这里不碰
// 磁盘就能断言的那部分是"默认不再是某个仓内路径"。解析本身对不对由
// `test/artifact-check.mjs` 走真 `require.resolve()` 断言。
eq('config: the compiled exe is the default engine', go.engine, 'go')
eq('config: exeEntry is unset by default, so the payload comes from the platform package',
  go.exeEntry, null)
eq('config: an explicit exeEntry is still honoured (relative paths join repoRoot)',
  resolveConfig({ repoRoot: REPO, exeEntry: join('vendor', 'visible-ssh.exe') }).exeEntry,
  join(REPO, 'vendor', 'visible-ssh.exe'))
eq('config: and an absolute one is taken as-is',
  resolveConfig({ repoRoot: REPO, exeEntry: 'E:/elsewhere/visible-ssh.exe' }).exeEntry,
  'E:/elsewhere/visible-ssh.exe')
eq('config: python stays available as a standby', python.engine, 'python')
eq('config: the standby keeps its entry point (the implementation itself lives in the engine project)', python.pythonEntry, join(REPO, 'scripts', 'tools', 'tmux_console.py'))
check('config: a misspelled engine is refused instead of silently choosing one',
  (() => { try { resolveConfig({ repoRoot: REPO, engine: 'golang' }); return false } catch { return true } })(),
  null)

// --- python 分支与 M5 之前插件所发送的逐字节相同 ---------------------------
{
  const argv = ['--session', 's', 'status', '--json']
  const command = engineCommand(python, argv)
  eq('python: the canonical shape IS its shape (flags after the verb)', command.args, [python.pythonEntry, ...argv])
  eq('python: the interpreter still comes from config', command.program, 'python')
}

// --- go 分支：丢掉 --json，把 --timeout 移到 verb 之前 ---------------------
{
  const command = engineCommand(go, ['--session', 's', 'status', '--json'])
  eq('go: the canonical flag is dropped and nothing else changes', command.args, ['--session', 's', 'status'])
  check('go: it runs the exe inside the platform package',
    command.program === join(REPO, 'packages', 'engine-win32-x64', 'visible-ssh.exe'), command.program)
}
{
  const command = engineCommand(go, ['--session', 's', 'reset', '--json'])
  eq('go: a verb with no extra flags translates to flags-then-verb', command.args, ['--session', 's', 'reset'])
}

// --- run：原样放行就会静默出错的形状 ---------------------------------------
const RUN_CMD = 'df -h /  |  head -3'
const canonicalRun = ['--session', 's', 'run', '--json', '--timeout', '30', '--', RUN_CMD]
{
  const { args } = engineCommand(go, canonicalRun)
  eq('go run: flags precede the verb and the command is the last word',
    args, ['--timeout', '30', '--session', 's', 'run', '--', RUN_CMD])
  check('go run: `--` immediately follows the verb, so the engine strips it and joins ONLY the command',
    args.indexOf('run') + 1 === args.indexOf('--'), args)
  check('go run: the command survives byte-for-byte (one argv element, pipes and all)',
    args.at(-1) === RUN_CMD, args.at(-1))
  check('go run: no `--json` and no stray `--timeout` left after the verb',
    !args.slice(args.indexOf('run')).includes('--json') && !args.slice(args.indexOf('run')).includes('--timeout'),
    args)
}

// --- 隐患被直接断言：把规范形状交给 Go **不是**无害的 ---------------------
{
  const verbAt = canonicalRun.indexOf('run')
  const joinedAsGoWould = canonicalRun.slice(verbAt + 1).filter((word) => word !== '--').join(' ')
  check('hazard: the untranslated shape would make Go run the flags as the command',
    joinedAsGoWould !== RUN_CMD && joinedAsGoWould.includes('--json'), joinedAsGoWould)
  const translated = engineCommand(go, canonicalRun).args
  const verbAtTranslated = translated.indexOf('run')
  const joinedAfterTranslation = translated.slice(verbAtTranslated + 1).filter((word) => word !== '--').join(' ')
  eq('and the translation is what prevents it', joinedAfterTranslation, RUN_CMD)
}

// --- 命令里含 `--json` 不是附带损伤 ----------------------------------------
{
  const argv = ['--session', 's', 'run', '--json', '--timeout', '30', '--', 'curl --json x']
  const { args } = engineCommand(go, argv)
  eq('go run: a `--json` INSIDE the command string is untouched (it is never its own element)',
    args.at(-1), 'curl --json x')
}

// --- S5：配置由插件侧选中，并以 `--config` 放在所有 flag 之前 ---------------
// 引擎自己**不读用户目录**（实测：Windows 的那个 per-user 配置目录它从不看），只认
// `--config` 与 `SSH_CONFIG`。所以"配置属于操作者"必须由插件侧落地：`chooseHostConfig()`
// 选一份，`engineCommand()` 用 `--config <绝对路径>` 告诉引擎。这里断言的是接缝，
// 不是选择策略（策略在 `test/unit/config.test.mjs`）。
const REPO_CONFIG = join(REPO, 'scripts', 'config', 'host.toml')
{
  const cfg = resolveConfig({ repoRoot: REPO }, {}, (path) => path === REPO_CONFIG)
  eq('config: an existing scripts/config/host.toml is the one that gets used', cfg.configPath, REPO_CONFIG)
  eq('config: and it is recorded as coming from the repository', cfg.configSource, 'repo')
  eq('config: the engine is told with --config AHEAD of every other flag',
    engineCommand(cfg, ['--session', 's', 'run', '--json', '--timeout', '30', '--', 'df -h /']).args,
    ['--config', REPO_CONFIG, '--timeout', '30', '--session', 's', 'run', '--', 'df -h /'])
  eq('config: a caller that passes its own --config does not get a second one',
    engineCommand(cfg, ['--config', 'E:/mine.toml', '--session', 's', 'capture']).args,
    ['--config', 'E:/mine.toml', '--session', 's', 'capture'])
  eq('config: finding nothing invents no --config (the engine keeps its own discovery)',
    engineCommand(resolveConfig({ repoRoot: REPO }, {}, () => false), ['--session', 's', 'status']).args,
    ['--session', 's', 'status'])
  eq('config: the python branch is left alone (the reference implementation discovers its own)',
    engineCommand(resolveConfig({ repoRoot: REPO, engine: 'python' }, {}, () => true),
      ['--session', 's', 'status', '--json']).args,
    [join(REPO, 'scripts', 'tools', 'tmux_console.py'), '--session', 's', 'status', '--json'])
}

const failed = results.filter((entry) => !entry.ok)
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed,
  verdict: failed.length === 0 ? 'OK: the engine seam translates both CLIs correctly' : 'FAILURES above',
}, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
