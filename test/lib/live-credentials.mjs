/**
 * live 检查（真正要 SSH 的那几个）唯一的凭据来源。
 *
 * 那些检查需要一个可达的远端主机，而"哪台机器、哪个用户、什么密码"**必须是
 * 命令里显式给的**：本仓的检查不读操作者的家目录，也不偷偷借用某个既有
 * profile。两种给法，二选一：
 *
 *   A. 写在环境里（首选）
 *      SSH_HOST=<host> SSH_USER=<user> [SSH_PORT=<port>] [SSH_PASSWORD=<password>] \
 *        node test/live-route.mjs
 *
 *      这里会把你给的 host/port/user 现写成一份**不含密码**的
 *      `test/env/tmp/<name>/config/host.toml`，再把 `SSH_CONFIG` 指过去 ——
 *      插件的 `chooseHostConfig()` 把 `SSH_CONFIG` 原样认作配置路径，于是它
 *      既是 `connections.source()` 眼里的"CLI 自己的配置"，也是引擎收到的
 *      `--config`（实测 `HOSTCFG_ENV_CONFIG` 这个名字引擎**根本不看**，所以
 *      这里不再设它）。密码只走 `SSH_PASSWORD` 进程环境：实测
 *      "配置里不写 password、密码只走环境变量"时引擎照样能连，所以磁盘上
 *      从不留密码。这份生成物在 `test/env/tmp/` 下（已 gitignore），每次跑
 *      都会先删掉重写。
 *
 *   B. 就用本机仓里那份（要明说）
 *      VISIBLE_SSH_USE_REPO_CONFIG=1 node test/live-route.mjs
 *
 *      这时配置路径就是 `scripts/config/host.toml` —— 那份文件里带着
 *      真密码，所以这条路必须由操作者主动打开，绝不做默认。想验"引擎按
 *      exe 位置向上发现配置"的语义时用它。
 *
 * 两种都没有 → 返回 `{ok:false, why}`，调用方打印 `{skipped: why}` 后 exit 0：
 * 一个 live 检查在没给凭据时应当**跳过**，不是猜、也不是失败。
 *
 * `known_hosts` **不需要**跟着搬：实测把配置放到临时目录、同目录里没有
 * `known_hosts` 时，`list` 的结果与带着它时完全一致（宿主密钥校验不拦）。
 *
 * 生成物必须有 `[host]` 段头 —— 引擎的解析器认的是段里的键，缺了它会把这份
 * 文件判成 `missing or malformed [host] section`（一开始漏了它，`live-route`
 * 的 mirror 断言因此 502）。`scripts/config/host.toml.example:15` 就是段头。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEST = join(HERE, '..')
const REPO = join(TEST, '..')
const REPO_CONFIG = join(REPO, 'scripts', 'config', 'host.toml')
const TMP = join(TEST, 'env', 'tmp')

/** TOML 字符串字面量：键的形状抄 `scripts/config/host.toml.example:15-18`。 */
function quote(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}
export function liveCredentials({ name } = {}) {
  const dir = join(TMP, name, 'config')
  const configPath = join(dir, 'host.toml')

  const host = process.env.SSH_HOST
  const user = process.env.SSH_USER
  const password = process.env.SSH_PASSWORD
  const explicit = host !== undefined && host !== '' && user !== undefined && user !== ''

  if (explicit) {
    rmSync(join(TMP, name), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      configPath,
      [
        `# 由 test/lib/live-credentials.mjs 为 ${name} 这一次 live 检查生成。`,
        '# 刻意不写 password：密码只走 SSH_PASSWORD 进程环境，磁盘上不留。',
        '[host]',
        `host = ${quote(host)}`,
        `port = ${Number.parseInt(process.env.SSH_PORT ?? '22', 10) || 22}`,
        `user = ${quote(user)}`,
        '',
      ].join('\n'),
      'utf8',
    )
    return {
      ok: true,
      how: `SSH_HOST/SSH_USER${password === undefined || password === '' ? '' : '/SSH_PASSWORD'} → ${configPath}`,
      host,
      user,
      password: password ?? null,
      configPath,
      env: { SSH_CONFIG: configPath },
    }
  }

  if (process.env.VISIBLE_SSH_USE_REPO_CONFIG === '1' && existsSync(REPO_CONFIG)) {
    return {
      ok: true,
      how: `this machine's ${REPO_CONFIG} (VISIBLE_SSH_USE_REPO_CONFIG=1)`,
      host: null,
      user: null,
      password: null,
      configPath: REPO_CONFIG,
      env: { SSH_CONFIG: REPO_CONFIG },
    }
  }

  return {
    ok: false,
    why:
      `no remote host given. These checks never guess: pass one explicitly, e.g.\n` +
      `  SSH_HOST=<host> SSH_USER=<user> [SSH_PORT=<port>] [SSH_PASSWORD=<password>] node test/${name}.mjs\n` +
      `or, to use this repository's own ${REPO_CONFIG} on purpose,\n` +
      `  VISIBLE_SSH_USE_REPO_CONFIG=1 node test/${name}.mjs`,
  }
}
