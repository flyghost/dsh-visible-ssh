/**
 * `plugin/src/engine/config.ts` 的配置选择 —— S5。
 *
 * 引擎只认 `--config` 与 `SSH_CONFIG`，**自己不读用户目录**（实测：Windows 那个
 * per-user 配置目录它从不看），所以"这次读哪一份 host.toml"是插件侧的决定。优先级在
 * `chooseHostConfig()` 里：
 *
 *   config.configPath  >  SSH_CONFIG  >  用户目录  >  仓内 scripts/config/host.toml  >  都没有
 *
 * 这里测的全是纯函数：推导用的"根"与"文件在不在"都是注入的，所以这一层既不碰真机、
 * 也不碰真家目录（密闭门禁会盯着这件事：本文件里不许出现本机状态的名字）。
 *
 * `--config` 的注入（放在所有 flag 之前）在 `locate.test.mjs` 与 `test/engine-check.mjs`。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chooseHostConfig, parseHostConfigSession, resolveConfig, sshConfigPath, userConfigPath } from '../../plugin/lib/engine/config.js'

const WIN = { platform: 'win32', appData: 'C:/Users/me/AppData/Roaming', home: 'C:/Users/me', xdgConfig: '' }
const LINUX_XDG = { platform: 'linux', appData: '', home: '/home/me', xdgConfig: '/home/me/.config-custom' }
const LINUX_PLAIN = { platform: 'linux', appData: '', home: '/home/me', xdgConfig: '' }
const NOWHERE = { platform: 'linux', appData: '', home: '', xdgConfig: '' }

describe('where the operator keeps their own host.toml', () => {
  it('on Windows it lives under the roaming per-user directory', () => {
    expect(userConfigPath(WIN)).toBe(join('C:/Users/me/AppData/Roaming', 'visible-ssh', 'host.toml'))
  })

  it('elsewhere it is the XDG config home, falling back to ~/.config', () => {
    expect(userConfigPath(LINUX_XDG)).toBe(join('/home/me/.config-custom', 'visible-ssh', 'host.toml'))
    expect(userConfigPath(LINUX_PLAIN)).toBe(join('/home/me/.config', 'visible-ssh', 'host.toml'))
  })

  it('with no root to speak of it says so instead of inventing a path', () => {
    expect(userConfigPath(NOWHERE)).toBeNull()
  })
})

describe('chooseHostConfig priorities', () => {
  const REPO = 'E:/repo/scripts/config/host.toml'
  const USER = 'C:/Users/me/AppData/Roaming/visible-ssh/host.toml'
  const candidates = (over = {}) => ({
    explicit: null, env: null, user: USER, repo: REPO, exists: () => false, ...over,
  })

  it('an explicit configPath wins outright — it is not even checked for existence', () => {
    expect(chooseHostConfig(candidates({ explicit: 'E:/mine.toml' })))
      .toEqual({ path: 'E:/mine.toml', source: 'config' })
  })

  it('SSH_CONFIG beats the user directory, and is passed through verbatim', () => {
    expect(chooseHostConfig(candidates({ env: 'relative/from/cwd.toml', exists: () => true })))
      .toEqual({ path: 'relative/from/cwd.toml', source: 'env' })
  })

  it('an empty SSH_CONFIG is treated as unset', () => {
    expect(chooseHostConfig(candidates({ env: '' }))).toBeNull()
  })

  it('the user directory beats the repository — but only if the file is really there', () => {
    expect(chooseHostConfig(candidates({ exists: (path) => path === USER })))
      .toEqual({ path: USER, source: 'user' })
    expect(chooseHostConfig(candidates({ exists: (path) => path === REPO })))
      .toEqual({ path: REPO, source: 'repo' })
  })

  it('nothing anywhere is an answer too: null, so no --config is invented', () => {
    expect(chooseHostConfig(candidates())).toBeNull()
  })
})

describe('resolveConfig wires that into the plugin config', () => {
  it('joins a relative configPath onto repoRoot and reports where it came from', () => {
    const cfg = resolveConfig({ repoRoot: 'E:/repo', configPath: join('private', 'host.toml') }, {}, () => false)
    expect(cfg.configPath).toBe(join('E:/repo', 'private', 'host.toml'))
    expect(cfg.configSource).toBe('config')
  })

  it('takes an absolute configPath as it is', () => {
    expect(resolveConfig({ repoRoot: 'E:/repo', configPath: 'D:/else/host.toml' }, {}, () => false))
      .toMatchObject({ configPath: 'D:/else/host.toml', configSource: 'config' })
  })

  it('honours SSH_CONFIG without checking the disk', () => {
    expect(resolveConfig({ repoRoot: 'E:/repo' }, { SSH_CONFIG: 'nope.toml' }, () => false))
      .toMatchObject({ configPath: 'nope.toml', configSource: 'env' })
  })

  it('falls back to this repository only when that file exists', () => {
    const repo = join('E:/repo', 'scripts', 'config', 'host.toml')
    expect(resolveConfig({ repoRoot: 'E:/repo' }, {}, (path) => path === repo))
      .toMatchObject({ configPath: repo, configSource: 'repo' })
    expect(resolveConfig({ repoRoot: 'E:/repo' }, {}, () => false))
      .toMatchObject({ configPath: null, configSource: null })
  })

  it('existence gates the user directory: a missing file loses to the repository', () => {
    // 一次只有一个候选存在，所以这条同时钉住"存在才用"与"仓内那份排在最后但还是会被用"。
    const cfg = resolveConfig({ repoRoot: 'E:/repo' }, {}, (path) => path === join('E:/repo', 'scripts', 'config', 'host.toml'))
    expect(cfg.configSource).toBe('repo')
    expect(cfg.configPath).toBe(join('E:/repo', 'scripts', 'config', 'host.toml'))
  })
})

/**
 * 缺省会话窗口：`[host] session` 是插件从那份 `host.toml` 里**唯一**读的内容
 * （引擎不认这个键，见 `hostcfg.c`："未知键照旧被忽略"）。所以读文件这件事本身
 * 也走注入：单测给的是字符串，不是磁盘。
 */
describe('the default session window comes from the chosen host.toml', () => {
  const REPO = join('E:/repo', 'scripts', 'config', 'host.toml')
  const onlyRepo = (path) => path === REPO
  const file = (text) => () => text

  it('reads [host] session out of the file the machine lives in', () => {
    const cfg = resolveConfig({ repoRoot: 'E:/repo' }, {}, onlyRepo, file('[host]\nhost = "box"\nsession = "work"\n'))
    expect(cfg.defaultSession).toBe('work')
    expect(cfg.sessionSource).toBe('file')
  })

  it('an explicit plugin defaultSession outranks the file', () => {
    const cfg = resolveConfig({ repoRoot: 'E:/repo', defaultSession: 'e2e' }, {}, onlyRepo, file('[host]\nsession = "work"\n'))
    expect(cfg.defaultSession).toBe('e2e')
    expect(cfg.sessionSource).toBe('config')
  })

  it('a file that says nothing about session leaves the built-in default alone', () => {
    expect(resolveConfig({ repoRoot: 'E:/repo' }, {}, onlyRepo, file('[host]\nhost = "box"\n')))
      .toMatchObject({ defaultSession: 'default', sessionSource: 'default' })
  })

  it('no file at all means nothing to read — and nothing is read', () => {
    const never = () => { throw new Error('there is no config, so this must not be called') }
    expect(resolveConfig({ repoRoot: 'E:/repo' }, {}, () => false, never))
      .toMatchObject({ configPath: null, defaultSession: 'default', sessionSource: 'default' })
  })

  it('an unreadable file is not fatal either', () => {
    expect(resolveConfig({ repoRoot: 'E:/repo' }, {}, onlyRepo, () => null))
      .toMatchObject({ defaultSession: 'default', sessionSource: 'default' })
  })
})

describe('parseHostConfigSession, on text alone', () => {
  it('takes the value from the [host] section, quotes and all', () => {
    expect(parseHostConfigSession('[host]\nhost = "192.0.2.10"\nsession = "e2e"')).toBe('e2e')
    expect(parseHostConfigSession("[host]\nsession = 'e2e'")).toBe('e2e')
    expect(parseHostConfigSession('[host]\nsession = e2e')).toBe('e2e')
    expect(parseHostConfigSession('[host]\n  SESSION = "e2e"  ')).toBe('e2e')
    expect(parseHostConfigSession('[Host]\r\nsession = "e2e"\r\n')).toBe('e2e')
  })

  it('ignores a session in some other section, or before any section', () => {
    expect(parseHostConfigSession('session = "nope"\n[host]\nhost = "box"')).toBeNull()
    expect(parseHostConfigSession('[other]\nsession = "nope"\n[host]\nhost = "box"')).toBeNull()
  })

  it('a commented-out session is a comment, not a setting', () => {
    expect(parseHostConfigSession('[host]\n# session = "nope"\nhost = "box"')).toBeNull()
    expect(parseHostConfigSession('[host]\nsession = "e2e" # 主要那个')).toBe('e2e')
    expect(parseHostConfigSession('[host]\nsession = "a#b"')).toBe('a#b')
  })

  it('an empty or missing value is no answer, not an empty session name', () => {
    expect(parseHostConfigSession('[host]\nsession = ""')).toBeNull()
    expect(parseHostConfigSession('[host]\nsession =')).toBeNull()
    expect(parseHostConfigSession('[host]\nhost = "box"')).toBeNull()
    expect(parseHostConfigSession('')).toBeNull()
  })

  it('never throws on a file it does not understand', () => {
    expect(parseHostConfigSession('[host\nsession = "e2e"')).toBeNull()
    expect(parseHostConfigSession('[[host]]\nsession = "e2e"')).toBeNull()
  })
})

/**
 * 本机 `~/.ssh/config` 的路径。插件拿它唯一的用途是"列一份候选给人挑"
 * （`connection/ssh-config.ts`），**从不写**；路径同样从注入的根推出来，所以
 * 这一层也不碰真机。
 */
describe('the path of the operator ssh config', () => {
  it('is <home>/.ssh/config', () => {
    expect(sshConfigPath(WIN)).toBe(join('C:/Users/me', '.ssh', 'config'))
  })

  it('is null when there is no home to speak of', () => {
    expect(sshConfigPath(NOWHERE)).toBeNull()
    expect(sshConfigPath({ ...WIN, home: '' })).toBeNull()
  })

  it('resolveConfig carries it out of the same roots it used for host.toml', () => {
    // 这里喂的是**环境**（`systemConfigRoots` 唯一读的东西），不是 `ConfigRoots`：
    // 于是这条测的是 `resolveConfig` 真的把根传下去了，而不是两处各推一遍。
    expect(resolveConfig({ repoRoot: 'E:/repo' }, { HOME: 'C:/Users/me' }, () => false).sshConfigPath)
      .toBe(join('C:/Users/me', '.ssh', 'config'))
  })
})
