/**
 * `plugin/src/connection/ssh-config.ts` —— 把本机 `~/.ssh/config` 变成一份可挑的
 * 候选清单（设置界面那一节 "本机 ssh 配置里的远端"）。
 *
 * 这一层是**纯函数**：文本由测试喂进去，"家目录"也是注入的字符串，所以它既不读
 * 这台机器、也不读真实的 ssh 配置（密闭门禁盯着这件事：本文件里不许出现本机状态
 * 的名字）。
 *
 * 为什么插件要读它：引擎自己不解析 ssh 配置 —— 它把 `user@host` 交给 ssh.exe，
 * 于是 ssh 展开 `HostName`、挑 `IdentityFile`。所以"用 ssh 里配好的那台机器"只要
 * 把**别名**写进 `host` 就够了（`docs/test-baseline.md` 里那两条实测），这个解析器
 * 存在的唯一目的是让人**看得见**有哪些别名。它只读，绝不写。
 *
 * 边界：只认每个 `Host` 段里直接写着的 `HostName`/`User`/`Port`/`IdentityFile`；
 * `Host *` 当默认值补空；其他带通配或 `!` 的段不列；不替代 ssh 自己的解析器。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSshHosts, parseSshConfig } from '../../plugin/lib/connection/ssh-config.js'

const HOME = 'C:/Users/me'

describe('parseSshConfig: 一台一台机器', () => {
  it('读出一个普通段的四个字段', () => {
    const [host] = parseSshConfig([
      'Host lan-box',
      '  HostName 192.0.2.10',
      '  User me',
      '  Port 2222',
      '  IdentityFile ~/.ssh/lan-box',
    ].join('\n'), HOME)
    expect(host).toEqual({
      alias: 'lan-box',
      hostName: '192.0.2.10',
      user: 'me',
      port: 2222,
      identityFile: join(HOME, '.ssh', 'lan-box'),
    })
  })

  it('没写 HostName 时回落成别名 —— 那是 ssh 自己的行为', () => {
    const [host] = parseSshConfig('Host 192.0.2.12\n  User me', HOME)
    expect(host).toEqual({
      alias: '192.0.2.12',
      hostName: '192.0.2.12',
      user: 'me',
      port: null,
      identityFile: null,
    })
  })

  it('`Key=value` 与 `Key value` 一样认，键名大小写不敏感', () => {
    const [host] = parseSshConfig('hOsT box\nHOSTNAME=10.0.0.1\nuser=root\nIDENTITYFILE=~/.ssh/k', HOME)
    expect(host).toEqual({
      alias: 'box',
      hostName: '10.0.0.1',
      user: 'root',
      port: null,
      identityFile: join(HOME, '.ssh', 'k'),
    })
  })

  it('整行注释、行内注释与空行都不算配置', () => {
    const hosts = parseSshConfig([
      '# 我的机器',
      '',
      'Host a   # 家里的',
      '  HostName 10.0.0.1 # 局域网',
    ].join('\n'), HOME)
    expect(hosts).toEqual([{ alias: 'a', hostName: '10.0.0.1', user: null, port: null, identityFile: null }])
  })

  it('一行多个别名 = 多台机器，共用同一段的值', () => {
    const hosts = parseSshConfig('Host one two\n  HostName gw\n  User ops', HOME)
    expect(hosts.map((host) => [host.alias, host.hostName, host.user]))
      .toEqual([['one', 'gw', 'ops'], ['two', 'gw', 'ops']])
  })

  it('同一个段里第一个值胜出（ssh 的规矩）', () => {
    const [host] = parseSshConfig('Host box\n  User first\n  User second', HOME)
    expect(host.user).toBe('first')
  })

  it('第一个 Host 之前的东西是全局选项，不属于任何一台机器', () => {
    const hosts = parseSshConfig('User global\nIdentityFile ~/.ssh/global\n\nHost box', HOME)
    expect(hosts).toEqual([{ alias: 'box', hostName: 'box', user: null, port: null, identityFile: null }])
  })

  it('Include 不会凭空造出机器，也不会炸', () => {
    const hosts = parseSshConfig('Include ~/.ssh/conf.d/*\n\nHost a\n  HostName 10.0.0.1', HOME)
    expect(hosts.map((host) => host.alias)).toEqual(['a'])
  })

  it('去掉一层配对的引号', () => {
    const [host] = parseSshConfig('Host box\n  IdentityFile "~/.ssh/key-host-01.pem"', HOME)
    expect(host.identityFile).toBe(join(HOME, '.ssh', 'key-host-01.pem'))
  })

  it('没有家目录时 `~` 原样留着，绝不猜', () => {
    const [host] = parseSshConfig('Host box\n  IdentityFile ~/.ssh/k', '')
    expect(host.identityFile).toBe('~/.ssh/k')
  })

  it('`~` 单独出现时就是家目录', () => {
    const [host] = parseSshConfig('Host box\n  IdentityFile ~', HOME)
    expect(host.identityFile).toBe(HOME)
  })
})

describe('parseSshConfig: 哪些段算"一台机器"', () => {
  it('`Host *` 自己不列，但给别的段补没写过的键', () => {
    const hosts = parseSshConfig([
      'Host *',
      '  User default-user',
      '  Port 22',
      '',
      'Host withuser',
      '  HostName 10.0.0.1',
      '  User mine',
    ].join('\n'), HOME)
    expect(hosts).toEqual([
      { alias: 'withuser', hostName: '10.0.0.1', user: 'mine', port: 22, identityFile: null },
    ])
  })

  it('带通配、`?` 或 `!` 取反的段都不是一台机器', () => {
    const hosts = parseSshConfig([
      'Host web-*',
      '  User deploy',
      'Host db?',
      '  User pg',
      'Host ok !bad-host',
      '  HostName fine',
      'Host good',
      '  HostName 10.0.0.2',
    ].join('\n'), HOME)
    expect(hosts.map((host) => host.alias)).toEqual(['good'])
  })

  it('一段都没有时是空清单，不是报错', () => {
    expect(parseSshConfig('', HOME)).toEqual([])
    expect(parseSshConfig('# 只有注释\n', HOME)).toEqual([])
  })
})

describe('parseSshConfig: 端口只认合法的', () => {
  it.each([
    ['abc', null],
    ['0', null],
    ['70000', null],
    ['22', 22],
    [' 2222 ', 2222],
  ])('Port %s → %s', (written, expected) => {
    const [host] = parseSshConfig(`Host box\n  Port ${written}`, HOME)
    expect(host.port).toBe(expected)
  })
})

describe('loadSshHosts: 读不动也是一种答案', () => {
  it('没有路径（这台机器没有可用的家目录）时什么都不读', () => {
    expect(loadSshHosts(null)).toEqual({ path: null, hosts: [], error: null })
    expect(loadSshHosts('')).toEqual({ path: null, hosts: [], error: null })
  })

  it('文件不在是正常状态：空清单、没有 error', () => {
    expect(loadSshHosts('C:/Users/me/.ssh/config', () => null))
      .toEqual({ path: 'C:/Users/me/.ssh/config', hosts: [], error: null })
  })

  it('真的读不动（权限之类）时把消息留在 error 里，绝不抛', () => {
    const result = loadSshHosts('C:/Users/me/.ssh/config', () => { throw new Error('EACCES: permission denied') })
    expect(result.hosts).toEqual([])
    expect(result.error).toBe('EACCES: permission denied')
  })

  it('家目录是从路径本身推出来的，于是 `~` 能展开', () => {
    const result = loadSshHosts('C:/Users/me/.ssh/config', () => 'Host key-host-01\n  IdentityFile ~/.ssh/key-host-01.pem')
    expect(result.hosts).toEqual([
      { alias: 'key-host-01', hostName: 'key-host-01', user: null, port: null, identityFile: join('C:/Users/me', '.ssh', 'key-host-01.pem') },
    ])
  })

  it('一份像样的配置读出来是若干候选', () => {
    const text = [
      '# machines I keep around',
      'Host lan-box',
      '  HostName 192.0.2.10',
      '  User me',
      '  IdentityFile ~/.ssh/lan-box',
      '',
      'Host key-host-01',
      '  HostName 198.51.100.7',
      '  User root',
      '  IdentityFile ~/.ssh/key-host-01.pem',
      '',
      'Host *',
      '  Port 22',
    ].join('\n')
    const result = loadSshHosts('C:/Users/me/.ssh/config', () => text)
    expect(result.error).toBeNull()
    expect(result.hosts.map((host) => host.alias)).toEqual(['lan-box', 'key-host-01'])
    expect(result.hosts.map((host) => host.port)).toEqual([22, 22])
  })
})
