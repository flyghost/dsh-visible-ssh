/**
 * 远端连接从哪来，以及怎么告诉引擎去用它。
 *
 * 共有三个来源，按**引擎自己**解析它们的顺序尝试
 * （实测，`host_config.py:43-95`；那份参照实现随引擎源码在引擎项目里）：
 *
 *   1. 用户通过面板填写的 profile —— 本模块把 `SSH_HOST` / `SSH_PORT` /
 *      `SSH_USER` / `SSH_PASSWORD` 注入子进程，而这些环境变量优先于 CLI 的
 *      TOML 文件；
 *   2. 引擎这次要读的那份 `host.toml`——什么都不注入，引擎的行为与本模块出现之前
 *      完全一样。它是哪一份由 `engine/config.ts` 的 `chooseHostConfig()` 定：插件
 *      配置的 `configPath` > `SSH_CONFIG` > 用户目录（`%APPDATA%\visible-ssh\`
 *      / `$XDG_CONFIG_HOME/visible-ssh/`）> 仓内 `scripts/config/host.toml`；
 *   3. 两者都没有 —— 面板显示表单而不是镜像。
 *
 * 有三条属性是刻意如此：
 *
 *   * 这里**没有任何必填项**。继续使用 host.toml 的部署不会被要求填表单，
 *     工具也照常工作、不受影响。这正是来源 (2) 存在的全部理由：
 *     把 profile 变成必填，就等于从一套本来就按老方式配好的部署里把工具剥掉。
 *   * **密码绝不抵达浏览器或模型。** 当 provider 接受它时，它被写进 credentials 缝
 *     （`$DSH_HOME/.credentials.yaml`，0600），否则写进本插件自己的文件；
 *     `list()` 只报告 `hasPassword`。唯一的读者是 `envFor()`，它构造子进程的环境。
 *   * **文件按操作重新读取**，绝不缓存。文件很小，而缓存会意味着在一个窗口里保存的
 *     profile 在另一个窗口里看不见，直到宿主重启 —— 这正是本功能要避免的那种陈旧。
 *
 * 一条 profile 只有在已经存过密码时才可以不带密码：引擎会对任何环境变量没覆盖到的
 * 键合并 CLI 的 TOML，所以一条没有密码的 profile 会静默地用**旧文件**里的密码去连
 * 这条 profile 的主机。
 *
 * 类型分两层：文件的**信任边界**（`readConnections` 里的 `JSON.parse`、
 * settings 命名空间送来的快照、credentials 缝的返回值）一律以 `unknown` 进门、
 * 就地收窄；过了这道门之后，全模块共用下面这几个命名形状。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseSessionName } from '../shared/session-name.js'

/** connections 文件的 schema 版本；不匹配即视为「无配置」。 */
export const CONNECTIONS_VERSION = 1

/** 版本号的类型（永远是 `1`）。 */
export type ConnectionsVersion = typeof CONNECTIONS_VERSION

/** 凭据引用前缀。引用必须是 POSIX shell 标识符。 */
const REF_PREFIX = 'VISIBLE_SSH_'

/** 一条 profile 记录：文档与 settings 命名空间共用的形状。 */
export interface Profile {
  id: string
  label?: string | null
  host: string
  port?: number | null
  user: string
  session?: string | null
}

/** `profile id -> 密码` 的映射。 */
export type StoredSecrets = Record<string, string>

/** connections 文档的持久化形状。 */
export interface ConnectionsDoc {
  version: number
  active: string | null
  profiles: Profile[]
  secrets: StoredSecrets
}

/** `settings` 命名空间里的一条主机（schema 刻意没有密码字段）。 */
export interface SettingsHost {
  id: string
  label: string
  host: string
  port: number
  user: string
  session: string
}

/** `settings` 命名空间的文档形状。 */
export interface SettingsDocument {
  active: string
  hosts: SettingsHost[]
}

/** 主机列表所栖身的介质。 */
export interface ConnectionStore {
  readonly kind: 'file' | 'settings'
  readonly target: string
  read(): Promise<ConnectionsDoc>
  write(state: ConnectionsDoc): Promise<void>
}

/** credentials 缝（`ctx.credentials`）里本模块用到的那部分。 */
export interface CredentialsService {
  resolve(ref: string): unknown
  set(ref: string, value: string): unknown
  unset(ref: string): unknown
}

/** 值得汇报一条降级警告的地方。 */
export interface WarningLogger {
  warn?(message: string): void
}

/** 从浏览器送进来的那条 profile（字段全是未知，进门校验）。 */
export interface ProfileInput {
  id?: unknown
  label?: unknown
  host?: unknown
  port?: unknown
  user?: unknown
  session?: unknown
}

/** `validateProfile` 的结论。 */
export type ProfileValidation =
  | { ok: true; profile: Profile }
  | { ok: false; message: string }

/** `saveProfile` 的结论：要么是存下来的那条（连它的密码此刻住在哪里），要么是一句原因。 */
export type ProfileSave =
  | { ok: true; profile: Profile & { passwordStore: PasswordStore | null }; active: string | null }
  | { ok: false; message: string }

/** 密码此刻住在哪里：credentials 缝、本插件自己的文件，或哪儿都不在。 */
export type PasswordStore = 'credentials' | 'file'

/**
 * 面板能看到的一条 profile。
 *
 * 逐字段显式构造，**不用**展开存下来的那条 profile：文件里多出来的键不该顺着
 * `list()` 漏给浏览器，键的顺序也该是稳定的。
 */
export interface ListedProfile {
  id: string
  label: string
  host: string
  port: number
  user: string
  session: string
  hasPassword: boolean
  passwordStore: PasswordStore | null
}

/** 一条 profile 的密码查得的结果。 */
export interface PasswordLookup {
  value: string | null
  store: PasswordStore | null
}

/** 采纳另一种介质的结果。 */
export interface StoreAdoption {
  migrated: number
  adopted: number
  error?: string
}

/**
 * 默认位置：`<DSH_HOME>/dsh-visible-ssh/connections.json`。
 *
 * 其他每个 DSH 组件都通过 `DSH_HOME` 解析自己的状态，所以插件自己的文件应当放在
 * 那里，而不是放在插件目录里（被复制的安装可能就在插件目录里，而且它可能是只读的）。
 *
 * @param env - 从中读取 `DSH_HOME` 的环境。
 * @returns connections 文件的绝对路径。
 */
export function defaultConnectionsFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(resolve(home), 'dsh-visible-ssh', 'connections.json')
}

/** profile id 的字段语法：小写、连字符、短。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
/** 主机名、IPv4、IPv6（冒号）以及带点后缀的名字。 */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/
/** 类 POSIX 的账号名，另加 `user@domain` 形式。 */
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/

/**
 * 从人类可读的 label 或主机名推导出 profile id。
 * @param source - 要 slug 化的 label 或 host。
 * @returns 一个候选 id；绝不为空（回退为 `host`）。
 */
export function slugId(source: unknown): string {
  const slug = String(source ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug === '' ? 'host' : slug
}

/**
 * 校验一条来自浏览器的 profile。
 *
 * @param input - `{ id?, label?, host, port?, user, session? }`。
 * @param password - 提交上来的密码，如果有（`undefined` = 保留已存的那份；从来没有过就
 *   是「这台不用密码」，引擎会走操作者 `~/.ssh` 里的密钥，实测可行且失败是响的）。
 * @returns `{ ok: true, profile }` 或 `{ ok: false, message }`。
 */
export function validateProfile(
  input: unknown,
  { password }: { password?: unknown } = {},
): ProfileValidation {
  if (input === null || typeof input !== 'object') return { ok: false, message: 'profile must be an object' }

  const raw = input as Record<string, unknown>
  const id = raw.id === undefined || raw.id === '' ? slugId(raw.host) : String(raw.id)
  if (!ID_RE.test(id)) {
    return { ok: false, message: 'id must be 1-32 characters of a-z, 0-9 and "-", and start with a letter or digit' }
  }

  const host = String(raw.host ?? '').trim()
  if (!HOST_RE.test(host)) {
    return { ok: false, message: 'host must be a hostname or address (letters, digits, . _ : -), 1-255 characters' }
  }

  const user = String(raw.user ?? '').trim()
  if (!USER_RE.test(user)) {
    return { ok: false, message: 'user must be an account name (letters, digits, . _ @ -), 1-64 characters' }
  }

  const rawPort = raw.port === undefined || raw.port === '' ? 22 : Number(raw.port)
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    return { ok: false, message: 'port must be an integer between 1 and 65535' }
  }

  const session = parseSessionName(raw.session === undefined || raw.session === '' ? 'default' : raw.session)
  if (!session.ok) return { ok: false, message: session.message }

  if (password !== undefined && password !== null) {
    if (typeof password !== 'string') return { ok: false, message: 'password must be a string' }
    if (/[\r\n\0]/.test(password)) return { ok: false, message: 'password must not contain line breaks' }
    if (password === '') return { ok: false, message: 'password must not be empty; delete the profile instead' }
  }
  // 没给密码不是错：引擎只把 SSH_HOST/SSH_PORT/SSH_USER 给 ssh.exe，缺 SSH_PASSWORD 时
  // 它就走操作者 `~/.ssh` 里的密钥（实测密钥机不需要密码，密码错了引擎会响地报
  // `transport failed during read: … Permission denied`）。旧 C 引擎要求 password 非空
  // （`hostcfg.c:411`）的那道闸门随引擎一起作废了。

  const label = String(raw.label ?? '').trim().slice(0, 64)
  return {
    ok: true,
    profile: { id, label: label === '' ? `${user}@${host}` : label, host, port: rawPort, user, session: session.session },
  }
}

/**
 * 读取 connections 文档。
 *
 * 文件缺失、读不到、版本不匹配或格式损坏，都会被读成「没有配置」而不是报错：
 * 这个文件只是 CLI 自己那份配置前面的一层便利封装，所以一份损坏的文件**必须不能**
 * 让插件变得不可用 —— 它应当让面板重新提供表单。
 *
 * @param file - connections 文件的绝对路径。
 * @returns `{ version, active, profiles, secrets }`，其中数组有保证。
 */
export async function readConnections(file: string): Promise<ConnectionsDoc> {
  const empty: ConnectionsDoc = { version: CONNECTIONS_VERSION, active: null, profiles: [], secrets: {} }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return empty
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object') return empty
  const doc = parsed as { version?: unknown; active?: unknown; profiles?: unknown; secrets?: unknown }
  if (doc.version !== CONNECTIONS_VERSION) return empty
  const rows: unknown[] = Array.isArray(doc.profiles) ? doc.profiles : []
  const profiles = rows.filter((row): row is Profile =>
    row !== null && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string')
  const secrets = doc.secrets !== null && typeof doc.secrets === 'object' ? doc.secrets as StoredSecrets : {}
  return {
    version: CONNECTIONS_VERSION,
    active: typeof doc.active === 'string' ? doc.active : null,
    profiles,
    secrets,
  }
}

/**
 * 写出 connections 文档，顺带创建它的目录。
 * @param file - connections 文件的绝对路径。
 * @param state - 要持久化的文档。
 */
export async function writeConnections(file: string, state: ConnectionsDoc): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * connections 文档所栖身的介质。
 *
 * 两种实现共用一个门面：插件自己的 JSON 文件（没有 settings provider 的部署继续
 * 用它，也是只有文件的插件早就在写的那个）和一个 `ctx.settings` 命名空间
 * （DSH 设置页可以显示它，而且在那里主机列表是一等的设置项，而不是本插件 home
 * 里的一个文件）。
 *
 * @param file - connections 文件的绝对路径。
 * @returns 覆盖该文件的一个 store，含 secrets。
 */
export function createFileStore(file: string): ConnectionStore {
  return {
    kind: 'file',
    target: file,
    read: () => readConnections(file),
    write: (state) => writeConnections(file, state),
  }
}

/** 一条 profile 记录，从 settings 文档进来的路上会被校验。 */
function validRow(row: unknown): row is Profile {
  if (row === null || typeof row !== 'object') return false
  const candidate = row as Record<string, unknown>
  return typeof candidate.id === 'string' && candidate.id !== ''
    && typeof candidate.host === 'string' && candidate.host !== ''
    && typeof candidate.user === 'string' && candidate.user !== ''
}

/**
 * 由 settings 命名空间支撑的 store。
 *
 * schema 刻意**没有**密码字段，而且即使调用方递来一份完整的内部文档，`write` 也会
 * 剥掉 `secrets`。这两半都很重要：DSH 自己记载的限制是 `redactSecrets` 无法证明某个
 * secret 不能经由 union/intersection/transform 抵达，而一份被序列化的 schema 会把
 * secret 的**默认值**带给每个渲染它的客户端。所以无论怎么标注，settings 文档都是
 * 存放凭据的错误位置 —— 它们该留在 credentials 缝（或本插件自己的 0600 文件）里。
 *
 * @param options - `snapshot()`（解析后的 settings 值）、`replace(next)`
 *   （持久化用户层），以及用于汇报的、人类可读的 `target`。
 * @returns 覆盖该命名空间的一个 store。
 */
export function createSettingsStore(
  { snapshot, replace, target }: {
    snapshot: () => unknown
    replace: (next: SettingsDocument) => void | Promise<void>
    target: string
  },
): ConnectionStore {
  return {
    kind: 'settings',
    target,
    async read() {
      const raw = (snapshot() ?? {}) as { active?: unknown; hosts?: unknown }
      const hosts: unknown[] = Array.isArray(raw.hosts) ? raw.hosts : []
      return {
        version: CONNECTIONS_VERSION,
        active: typeof raw.active === 'string' && raw.active !== '' ? raw.active : null,
        profiles: hosts.filter(validRow),
        secrets: {},
      }
    },
    async write(state) {
      await replace({
        active: state.active ?? '',
        hosts: state.profiles.filter(validRow).map((row) => ({
          id: row.id,
          label: row.label ?? `${row.user}@${row.host}`,
          host: row.host,
          port: row.port ?? 22,
          user: row.user,
          session: row.session ?? 'default',
        })),
      })
    },
  }
}

/**
 * 只读取文件里的 `secrets` 映射。
 * @param file - connections 文件的绝对路径。
 */
async function readSecretsFrom(file: string): Promise<StoredSecrets> {
  return (await readConnections(file)).secrets
}

/**
 * 就地编辑文件里的 `secrets` 映射，保留其他每一个键。
 *
 * 用读-改-写，而不是整份文档写回：在 settings 模式下，这个文件只是 secrets 的
 * **sidecar**（主机列表住在命名空间里），所以它的其他键必须活下来。在 file 模式下，
 * 这正是该文档一直以来的那次读-改-写。
 *
 * @param file - connections 文件的绝对路径。
 * @param edit - 接收当前的 secrets 映射，返回下一个。
 */
async function writeSecretsTo(file: string, edit: (secrets: StoredSecrets) => StoredSecrets): Promise<StoredSecrets> {
  const state = await readConnections(file)
  const next = { ...state, secrets: edit(state.secrets) }
  await writeConnections(file, next)
  return next.secrets
}

/**
 * 某条 profile 的密码所用的凭据引用名。
 *
 * 在 credentials 缝里，引用优先于已存的文档，所以导出了这个变量的用户会覆盖面板
 * 保存的内容 —— 这是有意的，也是这个名字被写进文档而不是藏起来的原因。
 *
 * @param id - profile id。
 * @returns 一个合法的引用名，例如 `VISIBLE_SSH_PI_PASSWORD`。
 */
export function passwordRefFor(id: unknown): string {
  return `${REF_PREFIX}${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASSWORD`
}

/** 宽容地读取 credentials 缝的返回形状（`string` 或 `{ value }`）。 */
function valueOf(hit: unknown): string | null {
  if (typeof hit === 'string') return hit
  if (hit !== null && typeof hit === 'object' && typeof (hit as { value?: unknown }).value === 'string') {
    return (hit as { value: string }).value
  }
  return null
}

/** 取错误的可读部分；与 `error?.message ?? error` 同义（`unknown` 不能直接进模板串）。 */
function errorDetailOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  const message: unknown = 'message' in error ? error.message : undefined
  return message === undefined || message === null ? String(error) : String(message)
}

/**
 * routes 与工具都与之对话的连接层。
 *
 * @param options - `file`（插件自己的文档，也是回退介质）、可选的起始 `store`、
 *   可选的 `credentials` 服务、可选的 `logger`（那条值得汇报的降级警告），以及
 *   `configPath`——引擎这次会读的那份 `host.toml`（`config.ts` 的
 *   `chooseHostConfig()` 定的），`source()` 靠它认出"CLI 自己的配置"。
 * @returns 连接门面；每个方法都会重新读取自己的介质，所以它便宜，但从不陈旧。
 */
export function createConnections(
  { file, store, credentials, logger, env = process.env, configPath }: {
    file: string
    store?: ConnectionStore
    credentials?: CredentialsService | null
    logger?: WarningLogger
    env?: NodeJS.ProcessEnv
    configPath?: string | null
  },
) {
  /**
   * **主机列表**所栖身的介质。
   *
   * 起始为插件自己的文件，这样即便完全没有 settings 服务被组合进来插件也能工作；
   * 当那个服务挂载时（可能发生在本插件之后）由 `useStore` 就地升级。
   */
  let medium: ConnectionStore = store ?? createFileStore(file)

  /**
   * 读取整个状态：主机列表来自介质，secrets 来自文件。
   *
   * 在 file 模式下文件两者都是，所以那两次读取就是同一次读取。在 settings 模式下
   * 命名空间不带密码字段（见 createSettingsStore），所以文件仍是 sidecar —— 而这也
   * 正是从只有文件的插件升级上来的部署早就存放它们的地方。
   */
  async function readState(): Promise<ConnectionsDoc> {
    const doc = await medium.read()
    if (medium.kind === 'file') return doc
    return { ...doc, secrets: await readSecretsFrom(file) }
  }

  /** 当前那份 secrets 映射，无论它此刻住在哪里。 */
  async function currentSecrets(): Promise<StoredSecrets> {
    return medium.kind === 'file' ? (await medium.read()).secrets : readSecretsFrom(file)
  }

  /** 持久化对主机列表的一次改动，并交回被写出的文档。 */
  async function mutate(change: (state: ConnectionsDoc) => ConnectionsDoc): Promise<ConnectionsDoc> {
    const state = await readState()
    const next = change(state)
    await medium.write(next)
    return next
  }

  /** `id` 的密码此刻住在哪里。 */
  async function readPassword(id: string): Promise<PasswordLookup> {
    if (credentials !== undefined && credentials !== null) {
      try {
        const hit = await credentials.resolve(passwordRefFor(id))
        const value = valueOf(hit)
        if (value !== null && value !== '') return { value, store: 'credentials' }
      } catch (error) {
        logger?.warn?.(`dsh-visible-ssh: credentials.resolve failed for ${passwordRefFor(id)}: ${errorDetailOf(error)}`)
      }
    }
    const stored = (await currentSecrets())[id]
    return typeof stored === 'string' && stored !== '' ? { value: stored, store: 'file' } : { value: null, store: null }
  }

  /** 存放（或用 `null` 清除）`id` 的密码。 */
  async function writePassword(id: string, value: string | null): Promise<PasswordStore | null> {
    if (credentials !== undefined && credentials !== null && typeof value === 'string') {
      try {
        await credentials.set(passwordRefFor(id), value)
        // 留在文件里的值不会遮蔽任何东西，只会残留；删掉它，这样一旦缝接收了
        // 这个 secret，缝就是唯一的来源。
        await writeSecretsTo(file, (secrets) => Object.fromEntries(Object.entries(secrets).filter(([key]) => key !== id)))
        return 'credentials'
      } catch (error) {
        logger?.warn?.(`dsh-visible-ssh: credentials.set rejected ${passwordRefFor(id)} (${errorDetailOf(error)}); storing in ${file} instead`)
      }
    }
    if (credentials !== undefined && credentials !== null && value === null) {
      try {
        await credentials.unset(passwordRefFor(id))
      } catch { /* 那里什么都没存，结果是一样的 */ }
    }
    const secret = value
    await writeSecretsTo(file, (secrets) => {
      const next: StoredSecrets = { ...secrets }
      if (secret === null) delete next[id]
      else next[id] = secret
      return next
    })
    return value === null ? null : 'file'
  }

  return {
    /**
     * 主机列表此刻住在哪里：插件自己的文件，或它被升级到的 settings 命名空间。
     * 刻意做成 getter —— 介质可能在门面之下改变（见 useStore），而捕获下来的字符串
     * 恰好会在人正读它的时候变陈旧。
     */
    get file(): string { return medium.target },

    /**
     * 采纳另一种介质，并把主机列表一次性搬过去。
     *
     * 这是升级路径：settings 服务可能在本插件之后挂载，而一个文件里已经有 profile 的
     * 部署**必须不能**丢掉它们。密码**不**搬运 —— 它们从不离开文件（或 credentials
     * 缝），所以没有什么要搬的。
     *
     * @param next - 要采纳的 store。
     * @returns `{ migrated }`：搬过去了多少条 profile。
     */
    async useStore(next: ConnectionStore): Promise<StoreAdoption> {
      const previous = medium
      medium = next
      try {
        const adopted = await next.read()
        if (adopted.profiles.length > 0) return { migrated: 0, adopted: adopted.profiles.length }
        const fromFile = await previous.read()
        if (fromFile.profiles.length === 0) return { migrated: 0, adopted: 0 }
        await next.write({ ...fromFile, secrets: {} })
        return { migrated: fromFile.profiles.length, adopted: fromFile.profiles.length }
      } catch (error) {
        logger?.warn?.(`dsh-visible-ssh: could not adopt the settings store (${errorDetailOf(error)}); staying on ${file}`)
        medium = previous
        return { migrated: 0, adopted: 0, error: errorDetailOf(error) }
      }
    },

    /** 浏览器可以看到的 profile：绝不是密码本身，只是它是否存在。 */
    async list() {
      const state = await readState()
      const rows: ListedProfile[] = []
      for (const profile of state.profiles) {
        const password = await readPassword(profile.id)
        rows.push({
          id: profile.id,
          label: profile.label ?? `${profile.user}@${profile.host}`,
          host: profile.host,
          port: profile.port ?? 22,
          user: profile.user,
          session: profile.session ?? 'default',
          hasPassword: password.value !== null,
          passwordStore: password.store,
        })
      }
      return { active: state.active, profiles: rows }
    },

    /** 当前激活的 profile id，或 null。 */
    async activeId(): Promise<string | null> {
      const state = await readState()
      if (state.active !== null && state.profiles.some((profile) => profile.id === state.active)) return state.active
      if (state.profiles.length !== 1) return null
      const only = state.profiles[0]
      return only === undefined ? null : only.id
    },

    /** 当前激活的 profile（带它的 session），或 null。 */
    async active(): Promise<Profile | null> {
      const id = await this.activeId()
      if (id === null) return null
      const state = await readState()
      const profile = state.profiles.find((candidate) => candidate.id === id)
      return profile === undefined ? null : { ...profile, port: profile.port ?? 22, session: profile.session ?? 'default' }
    },

    /**
     * 此刻哪个来源能提供连接。
     * @returns `'profile'`、`'cli-config'`（引擎这次要读的那份 `host.toml` 存在）
     *   或 `'none'`。
     */
    async source(): Promise<'profile' | 'cli-config' | 'none'> {
      if (await this.active() !== null) return 'profile'
      // 与引擎拿到的是同一个答案：`SSH_CONFIG` 环境压过 `config.ts` 解析出来的那份
      // （那个顺序就是引擎自己的优先级，见 `chooseHostConfig()`）。
      const cliConfig = env.SSH_CONFIG !== undefined && env.SSH_CONFIG !== ''
        ? env.SSH_CONFIG
        : configPath ?? null
      if (cliConfig === null) return 'none'
      try {
        await readFile(cliConfig, 'utf8')
        return 'cli-config'
      } catch {
        return 'none'
      }
    },

    /**
     * 让子进程与这条 profile 对话的环境。
     * @param id - profile id；默认为当前激活的那条。
     * @returns 没有 profile 适用时是 `{}`（子进程于是读 host.toml），
     *   否则是引擎赋予优先级的四个 `SSH_*` 变量。
     */
    async envFor(id?: string | null): Promise<Record<string, string>> {
      const state = await readState()
      const wanted = id ?? (await this.activeId())
      if (wanted === null) return {}
      const profile = state.profiles.find((candidate) => candidate.id === wanted)
      if (profile === undefined) return {}
      const password = await readPassword(profile.id)
      const environment: Record<string, string> = {
        SSH_HOST: String(profile.host),
        SSH_PORT: String(profile.port ?? 22),
        SSH_USER: String(profile.user),
      }
      if (password.value !== null) environment.SSH_PASSWORD = password.value
      return environment
    },

    /** 保存（或更新）一条 profile；返回存下来的形状。 */
    async saveProfile(input: ProfileInput, password?: unknown): Promise<ProfileSave> {
      const id = input?.id === undefined || input.id === '' ? slugId(input?.host) : String(input.id)
      const checked = validateProfile({ ...input, id }, { password })
      if (!checked.ok) return checked
      const store = password === undefined
        ? null
        : await writePassword(id, typeof password === 'string' ? password : null)
      const state = await mutate((current) => {
        const profiles = current.profiles.filter((profile) => profile.id !== id)
        profiles.push(checked.profile)
        return { ...current, profiles, active: current.active ?? id }
      })
      return { ok: true, profile: { ...checked.profile, passwordStore: store }, active: state.active }
    },

    /** 删除一条 profile，以及曾属于它的那份 secret。 */
    async removeProfile(id: string) {
      await writePassword(id, null)
      const state = await mutate((current) => {
        const profiles = current.profiles.filter((profile) => profile.id !== id)
        return { ...current, profiles, active: current.active === id ? (profiles[0]?.id ?? null) : current.active }
      })
      return { ok: true, active: state.active, removed: !state.profiles.some((profile) => profile.id === id) }
    },

    /** 把某条 profile 设为工具与镜像使用的那一条。 */
    async activate(id: string) {
      const state = await mutate((current) => {
        if (!current.profiles.some((profile) => profile.id === id)) return current
        return { ...current, active: id }
      })
      return { ok: state.active === id, active: state.active }
    },

    /**
     * 改**当前那条** profile 干活用的 tmux session。
     *
     * 「当前连接」有两半：`activate` 选哪台机器，这个方法选那台机器上哪个 tmux
     * 会话。没自己指定 session 的那几个工具、以及右侧那块镜像，读的都是
     * `active().session`，所以这里改完之后两边一起换 —— 不需要第二处状态。
     *
     * @param session - 要切过去的 tmux 会话名，按 `parseSessionName` 校验。
     * @returns 成功 `{ ok: true, session }`；名字不合法、或本来就没有当前连接时
     *   `{ ok: false, message }`。
     */
    async setSession(session: unknown): Promise<{ ok: true; session: string } | { ok: false; message: string }> {
      // 先挡住「根本没给名字」：`parseSessionName` 走 `String(value)`，所以
      // `undefined` 会被它认成字面量 `'undefined'` —— 那是个合法的 tmux 会话名。
      // 于是一个漏了 `session` 字段的请求会静悄悄地把当前连接切到一个名叫
      // 「undefined」的会话上。宁可这里 400。
      if (typeof session !== 'string' || session === '') {
        return { ok: false, message: 'session must be a non-empty string' }
      }
      const checked = parseSessionName(session)
      if (!checked.ok) return { ok: false, message: checked.message }
      const id = await this.activeId()
      if (id === null) {
        return { ok: false, message: 'there is no current connection: activate one before changing its session' }
      }
      let found = false
      await mutate((current) => {
        const profiles = current.profiles.map((profile) => {
          if (profile.id !== id) return profile
          found = true
          return { ...profile, session: checked.session }
        })
        return { ...current, profiles }
      })
      if (!found) return { ok: false, message: `no connection with id ${JSON.stringify(id)}` }
      return { ok: true, session: checked.session }
    },
  }
}

/** 连接门面：`createConnections` 的返回形状。 */
export type Connections = ReturnType<typeof createConnections>
