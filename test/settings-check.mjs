// settings 支撑的 connection 存储的离线检查：不需要 DSH、不需要 SSH、不需要
// 目标主机。一个假的 settings 服务模拟了唯一要紧的那条契约（`installSection`
// 交给插件一个**活的** getter，`replace` 写用户层，解析顺序是 base <- user），
// 另有一个真文件充当 sidecar。
//
// 这里值得证明的东西，以及为什么：
//   * 主机列表可以经 namespace 读和写，而且文档里**不**含任何秘密——正是这条
//     不变量才让 settings 文档成为存放主机列表的安全之所（DSH 自己的
//     `redactSecrets` 证明不了某个秘密无法从 union 里够到，而序列化出去的
//     schema 会把秘密的**默认值**交给每一个客户端，所以凭据**必须缺席**，
//     而不是被标注出来）
//   * 即便调用方把一个完整的内部文档交给存储，密码也仍然留在文件 sidecar
//     （或 credentials 那道缝）里
//   * 从文件做的那次一次性升级不丢任何已配置的 profile，也不搬走任何密码
//   * 每一种降级都能扛过去：没有服务、没有 schemastery、installSection
//     抛错、以及 read() 会失败的存储
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnections, createSettingsStore } from '../plugin/lib/connection/connections.js'
import { SETTINGS_BASE, SETTINGS_NAMESPACE, adoptSettings, buildSchema } from '../plugin/lib/connection/settings.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(HERE, 'env', 'tmp', 'settings')

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/**
 * schemastery 的替身。
 *
 * buildSchema 只碰 object/array/string/number 加上 `required()` 与
 * `default()`，所以这个假货需要的恰好就是这些——而且这里没有任何东西假装
 * 自己在校验。这项检查的要点是**我们**的 schema 绝不出现密码字段，而不是
 * schemastery 能正常工作。
 */
function chain(inner) {
  return {
    inner,
    required: () => chain(inner),
    default: () => chain(inner),
  }
}
const fakeZ = {
  string: () => chain('string'),
  number: () => chain('number'),
  array: (inner) => chain(inner),
  object: (shape) => ({ type: 'object', shape }),
}

/**
 * `ctx.settings` 的替身。
 *
 * 交给 `setSource` 的那个 getter 在**每一次**调用时都重新解析，真实的 scope
 * （`scope.get()`）就是这么做的，所以一次 `replace` 会立刻可见，不需要任何
 * watch 那套管线。
 */
function fakeSettingsService({ base = SETTINGS_BASE, failInstall = false } = {}) {
  const namespaces = new Map()
  let user = {}
  const resolve = (ns) => {
    const registration = namespaces.get(ns)
    return { ...(registration?.base ?? base), ...user }
  }
  return {
    installed: namespaces,
    userLayer: () => user,
    service: {
      installSection(owner, ns, schema, entry, hooks) {
        if (failInstall) throw new Error('installSection refused')
        namespaces.set(ns, { schema, base: entry, owner })
        hooks.setSource(() => resolve(ns))
        hooks.onChange?.()
      },
      replace(ns, section) {
        if (!namespaces.has(ns)) throw new Error(`replace on unregistered namespace ${ns}`)
        user = { ...section }
      },
      get(ns) { return resolve(ns) },
    },
  }
}

let seq = 0
function sandbox() {
  seq += 1
  const dir = join(SANDBOX, `case-${seq}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return { dir, file: join(dir, 'connections.json') }
}

const quiet = { warn: () => {} }

async function main() {
  // ---------------------------------------------------------------- schema
  const schema = buildSchema(fakeZ)
  check('schema: describes { active, hosts }', schema.type === 'object' && 'active' in schema.shape && 'hosts' in schema.shape)
  check('schema: names NO password field anywhere', !/password|secret/i.test(JSON.stringify(schema)))

  // ------------------------------------------------------- 存储本身
  const captured = { user: null }
  const unit = createSettingsStore({
    snapshot: () => ({ active: 'me', hosts: [{ id: 'me', host: 'h', user: 'u' }] }),
    replace: (next) => { captured.user = next },
    target: 'settings:visible-ssh',
  })
  const read = await unit.read()
  eq('store: profiles come from hosts', read.profiles.map((row) => row.id), ['me'])
  eq('store: active round-trips', read.active, 'me')
  eq('store: the store itself never yields secrets', read.secrets, {})

  const junk = createSettingsStore({ snapshot: () => ({ active: 5, hosts: 'nope' }), replace: () => {}, target: 't' })
  eq('store: a malformed document reads as empty', await junk.read(), { version: read.version, active: null, profiles: [], secrets: {} })

  await unit.write({ active: 'me', profiles: [{ id: 'me', host: 'h', user: 'u' }], secrets: { 'lan-box-local': 'hunter2' } })
  eq('store: write persists only { active, hosts }', Object.keys(captured.user).sort(), ['active', 'hosts'])
  check('store: write strips a secret handed to it', !JSON.stringify(captured.user).includes('hunter2'), captured.user)

  // ------------------------------------------------- 经 connection 面
  {
    const { file } = sandbox()
    const fake = fakeSettingsService()
    const connections = createConnections({ file, env: {}, configPath: null, logger: quiet })
    const adopted = await adoptSettings({ settingsCtx: { settings: fake.service }, owner: {}, connections, logger: quiet, loadSchema: async () => fakeZ })
    eq('adopt: the namespace is taken over', adopted, { adopted: true, reason: 'ok', migrated: 0 })
    eq('adopt: the face reports the namespace as its target', connections.file, `settings:${SETTINGS_NAMESPACE}`)

    const saved = await connections.saveProfile({ host: 'lan-box.local', user: 'me' }, 'hunter2')
    check('face: a profile saves through the namespace', saved.ok === true, saved)
    const listed = await connections.list()
    eq('face: list reads it back', listed.profiles.map((row) => row.id), ['lan-box-local'])
    eq('face: the password is reported as present, never as a value', [listed.profiles[0].hasPassword, listed.profiles[0].passwordStore], [true, 'file'])
    check('face: the settings document carries no secret', !JSON.stringify(fake.userLayer()).includes('hunter2'), fake.userLayer())
    eq('face: the host list is in the settings layer', fake.userLayer().hosts.map((row) => row.host), ['lan-box.local'])
    eq('face: the password stayed in the file sidecar', JSON.parse(readFileSync(file, 'utf8')).secrets, { 'lan-box-local': 'hunter2' })

    const env = await connections.envFor()
    eq('face: SSH_* still carries the secret to the engine', [env.SSH_HOST, env.SSH_USER, env.SSH_PASSWORD], ['lan-box.local', 'me', 'hunter2'])

    await connections.removeProfile('lan-box-local')
    eq('face: removing a profile clears its secret too', await (async () => (await connections.list()).profiles.length)(), 0)
    eq('face: …and the sidecar is clean', JSON.parse(readFileSync(file, 'utf8')).secrets, {})
  }

  // ------------------------------------------------------------- 迁移
  {
    const { file } = sandbox()
    const connections = createConnections({ file, env: {}, configPath: null, logger: quiet })
    await connections.saveProfile({ host: 'lan-box.local', user: 'me' }, 'from-the-file')
    const before = JSON.parse(readFileSync(file, 'utf8'))
    eq('migration: premise — the file holds a profile and its secret', [before.profiles.length, Object.keys(before.secrets)], [1, ['lan-box-local']])

    const fake = fakeSettingsService()
    const adopted = await adoptSettings({ settingsCtx: { settings: fake.service }, owner: {}, connections, logger: quiet, loadSchema: async () => fakeZ })
    eq('migration: the existing profile is carried across', adopted, { adopted: true, reason: 'ok', migrated: 1 })
    eq('migration: the namespace now owns it', fake.userLayer().hosts.map((row) => row.id), ['lan-box-local'])
    eq('migration: the password did NOT move', fake.userLayer().hosts.some((row) => 'password' in row || 'secrets' in row), false)
    eq('migration: …it is still in the sidecar', JSON.parse(readFileSync(file, 'utf8')).secrets, { 'lan-box-local': 'from-the-file' })
    const env = await connections.envFor()
    eq('migration: and it still reaches the engine', env.SSH_PASSWORD, 'from-the-file')
  }
  {
    // 已经有内容的 namespace **必须**赢：adopt 是一次升级，而不是一次会覆盖的导入。
    const { file } = sandbox()
    const connections = createConnections({ file, env: {}, configPath: null, logger: quiet })
    await connections.saveProfile({ host: 'file-only.local', user: 'me' }, 'x')
    const fake = fakeSettingsService()
    fake.userLayer().hosts = [{ id: 'from-settings', host: 'settings.local', user: 'me' }]
    const adopted = await adoptSettings({ settingsCtx: { settings: fake.service }, owner: {}, connections, logger: quiet, loadSchema: async () => fakeZ })
    eq('migration: a populated namespace is not overwritten', [adopted.migrated, fake.userLayer().hosts.map((row) => row.id)], [0, ['from-settings']])
  }

  // ----------------------------------------------------------- 降级
  {
    const { file } = sandbox()
    const connections = createConnections({ file, env: {}, configPath: null, logger: quiet })
    const noService = await adoptSettings({ settingsCtx: {}, owner: {}, connections, logger: quiet, loadSchema: async () => fakeZ })
    eq('degrade: no settings service means no adoption', noService, { adopted: false, reason: 'no-settings-service' })
    eq('degrade: …and the file is still the target', connections.file, file)
    check('degrade: …and saving still works on the file', (await connections.saveProfile({ host: 'lan-box.local', user: 'me' }, 'x')).ok === true)

    const noLibrary = await adoptSettings({
      settingsCtx: { settings: fakeSettingsService().service }, owner: {}, connections, logger: quiet,
      loadSchema: async () => { throw new Error('not installed') },
    })
    eq('degrade: a missing schemastery keeps the file in charge', noLibrary, { adopted: false, reason: 'no-schemastery' })
    eq('degrade: …target unchanged', connections.file, file)
  }
  {
    const { file } = sandbox()
    const connections = createConnections({ file, env: {}, configPath: null, logger: quiet })
    const broken = fakeSettingsService({ failInstall: true })
    const refused = await adoptSettings({ settingsCtx: { settings: broken.service }, owner: {}, connections, logger: quiet, loadSchema: async () => fakeZ })
    eq('degrade: a refused registration is survivable', refused, { adopted: false, reason: 'install-failed' })
    eq('degrade: …target unchanged', connections.file, file)
  }
  {
    // 最难缠的一种：namespace 注册成功了，但被采纳的存储读不了。
    // 这个面**必须**回滚到文件，而不是从此开始一律答空。
    const { file } = sandbox()
    const connections = createConnections({ file, env: {}, configPath: null, logger: quiet })
    await connections.saveProfile({ host: 'lan-box.local', user: 'me' }, 'x')
    const result = await connections.useStore({
      kind: 'settings',
      target: 'settings:broken',
      read: async () => { throw new Error('unreadable') },
      write: async () => {},
    })
    check('degrade: a store that cannot read is rejected', result.migrated === 0 && typeof result.error === 'string', result)
    eq('degrade: …and the face stayed on the file', connections.file, file)
    eq('degrade: …with its profiles intact', (await connections.list()).profiles.map((row) => row.id), ['lan-box-local'])
  }
}

await main()
rmSync(SANDBOX, { recursive: true, force: true })

const failed = results.filter((row) => row.ok !== true)
console.log(JSON.stringify({
  checks: results.length,
  verdict: failed.length === 0 ? `OK: ${results.length} settings-store checks green` : `FAILED: ${failed.length} of ${results.length}`,
  ...(failed.length === 0 ? {} : { failed }),
}, null, 2))
process.exitCode = failed.length === 0 ? 0 : 1
