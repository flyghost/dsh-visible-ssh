/**
 * 连接存储在 `ctx.settings` 这一侧的实现。
 *
 * 为什么需要一个 settings 命名空间：主机列表就是配置，而 DSH 本来就有配置该待的
 * 那一个地方——`设置 → visible-ssh`，就在产品自己的各分区旁边。把它塞在本插件主
 * 目录下的一个文件里，等于多出第二个编辑器、第二个存储、以及第二样要备份的东西。
 *
 * 这个模块负责三条性质：
 *
 *   1. **文档里不带任何秘密。** schema 里没有 password 字段，而
 *      `createSettingsStore` 的写入即使被调用方硬塞一个也会把它剥掉。DSH 自己
 *      记录在案的局限是：`redactSecrets` 无法证明某个秘密经 union/intersection/
 *      transform 之后不可达，而一个被序列化的 schema 会把秘密的**默认值**带给每个
 *      客户端——所以凭据不能只是被标记，它**必须不存在**。密码留在 credentials 缝
 *      里，或者在没有任何 provider 被组合时留在本插件自己那个 0600 的文件里。
 *   2. **settings 服务是可选的。** 它可能根本没有被组合，也可能在本插件之后才挂
 *      载；`installSection` 给了我们「在就使用它，不在就回退到组合时的那个值」这个
 *      行为，而 connections.js 无论如何都能靠自己那个文件继续工作。
 *   3. **schemastery 也是可选的**，而且是懒加载、防御式导入的：缺了这个 schema 库
 *      必须降级到文件存储并给一条警告，**绝不**把插件带崩。（`loadSchema` 可注入，
 *      所以离线套件能在没装这个包的情况下跑通正常路径。）
 */
import { createSettingsStore } from './connections.js'
import type { Connections, SettingsDocument, WarningLogger } from './connections.js'
import type { Context } from '@deepseek-ai/cordis'

/**
 * schemastery 的最小结构面。
 *
 * 那个包只发 `lib/types/`，没有 `lib/index.d.ts`，所以这里按用到的形状
 * 本地描述它 —— 顺便让 `loadSchema` 保持可注入：离线套件不需要装那个包
 * 也能走通正常路径。
 */
interface SchemasterySchema {
  required(): SchemasterySchema
  default(value: unknown): SchemasterySchema
}

interface SchemasteryNamespace {
  string(): SchemasterySchema
  number(): SchemasterySchema
  object(shape: Record<string, SchemasterySchema>): SchemasterySchema
  array(item: SchemasterySchema): SchemasterySchema
}

/** schema 加载器：正常是 schemastery 自己，测试里可以换成假的。 */
type SchemasteryLoader = () => Promise<SchemasteryNamespace>

/**
 * 宿主 settings 服务里本插件用到的那两个方法。
 *
 * 宿主没有随包发布它的类型（仓根的依赖里没有 settings 包），所以这里按调用
 * 形状本地声明，并把它加到 cordis 的 `Context` 上。
 */
interface SettingsService {
  installSection(
    owner: Context,
    namespace: string,
    schema: SchemasterySchema,
    base: SettingsDocument,
    hooks: { setSource(get?: (() => unknown) | undefined): void; onChange(): void },
  ): void
  replace(namespace: string, next: SettingsDocument): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 宿主组合了 settings 服务时才有。 */
    settings?: SettingsService
  }
}

/** `adoptSettings` 的结果：**绝不**抛出，所以失败也是一种返回值。 */
export type SettingsAdoption =
  | { adopted: false; reason: 'no-settings-service' | 'no-schemastery' | 'install-failed' | 'store-failed'; error?: string }
  | { adopted: true; reason: 'ok'; migrated: number }

/** 把 catch 到的东西变成一句能写进消息的文本（`unknown`，所以先收窄）。 */
function errorDetailOf(error: unknown): string {
  const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined
  return String(message ?? error)
}

/** settings 命名空间。小写加连字符，这是服务要求的。 */
export const SETTINGS_NAMESPACE = 'visible-ssh'

/** 空文档：组合基线，也是没有用户层时的回退值。 */
export const SETTINGS_BASE: SettingsDocument = { active: '', hosts: [] }

/**
 * 构建命名空间的 schema。
 *
 * @param z - schemastery 的命名空间对象。
 * @returns `{ active, hosts }` 的 schema。
 */
export function buildSchema(z: SchemasteryNamespace): SchemasterySchema {
  const host = z.object({
    id: z.string().required(),
    label: z.string().default(''),
    host: z.string().required(),
    port: z.number().default(22),
    user: z.string().required(),
    session: z.string().default('default'),
  })
  return z.object({
    active: z.string().default(''),
    hosts: z.array(host).default([]),
  })
}

/** 真正的加载器：宿主 bundle 已经随包发出去的那个 schema 库。 */
export async function loadSchemastery(): Promise<SchemasteryNamespace> {
  const module = await import('@deepseek-ai/schemastery')
  return (module.default ?? module) as unknown as SchemasteryNamespace
}

/**
 * 如果 settings 服务已被组合，就把主机列表放进一个 settings 命名空间。
 *
 * @param options - `settingsCtx`（注入进来的那个 context）、`owner`（本插件自己的
 *   ctx，用于卸载时的回退）、`connections`（要被升级的那个面）、可选的
 *   `logger`，以及可注入的 `loadSchema`。
 * @returns `{ adopted, reason, migrated? }` —— **绝不**抛出。
 */
export async function adoptSettings({ settingsCtx, owner, connections, logger, loadSchema = loadSchemastery }: {
  settingsCtx: Context | null | undefined
  owner: Context
  connections: Connections
  logger?: WarningLogger
  loadSchema?: SchemasteryLoader
}): Promise<SettingsAdoption> {
  const settings = settingsCtx === undefined || settingsCtx === null ? undefined : settingsCtx.settings
  if (settings === undefined || settings === null) return { adopted: false, reason: 'no-settings-service' }

  let z: SchemasteryNamespace
  try {
    z = await loadSchema()
  } catch (error) {
    logger?.warn?.(`dsh-visible-ssh: schemastery is unavailable (${errorDetailOf(error)}); the connection file at ${connections.file} stays in charge`)
    return { adopted: false, reason: 'no-schemastery' }
  }

  let snapshot: () => unknown = () => SETTINGS_BASE
  try {
    settings.installSection(owner, SETTINGS_NAMESPACE, buildSchema(z), SETTINGS_BASE, {
      // 服务交给我们一个活的 getter；卸载时它会把这里换回组合基线，
      // 于是一个被禁用的插件就不再从 settings 作答。
      setSource: (get?: (() => unknown) | undefined) => { snapshot = typeof get === 'function' ? get : (() => SETTINGS_BASE) },
      onChange: () => {},
    })
  } catch (error) {
    logger?.warn?.(`dsh-visible-ssh: could not register the ${SETTINGS_NAMESPACE} settings namespace (${errorDetailOf(error)}); keeping the connection file at ${connections.file}`)
    return { adopted: false, reason: 'install-failed' }
  }

  const result = await connections.useStore(createSettingsStore({
    snapshot: () => snapshot(),
    replace: (next) => settings.replace(SETTINGS_NAMESPACE, next),
    target: `settings:${SETTINGS_NAMESPACE}`,
  }))
  if (result.error !== undefined) return { adopted: false, reason: 'store-failed', error: result.error }
  return { adopted: true, reason: 'ok', migrated: result.migrated }
}
