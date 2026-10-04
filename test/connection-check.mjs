// connection 层（src/connection/connections.js）与 connection 路由（src/routes/index.js）的
// 离线检查：不需要 DSH、不需要 SSH、不需要目标主机。存储写的是一个一次性目录
// 里的真文件（所以「每次操作都重新读」这个行为是真的，不是模拟出来的），
// 凭据那道缝是假的，CLI 则是一个注入进来的函数——createConnectionHandler
// 之所以收 `runCli`，原因正在于此。
//
// 这里值得证明的东西，以及为什么：
//   * 第一次保存 profile 时没有密码就存不下去（env 变量没覆盖到的键，引擎会
//     去合并 CLI 的 TOML，所以一个没有密码的 profile 会带着**旧**密码静默连上
//     该 profile 的主机）
//   * 存下来的 profile 以 SSH_* 环境变量的形式到达 CLI（「agent 连到用户选的
//     那台机器」背后的全部机制）
//   * 密码绝不出现浏览器能读到的东西里
//   * 优先走 credentials 那道缝，它拒绝时降级到文件
//   * `source()` 能区分 profile / CLI 配置 / 什么都没有
//   * connection 路由的每个状态码都可达
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONNECTIONS_VERSION,
  createConnections,
  defaultConnectionsFile,
  passwordRefFor,
  readConnections,
  slugId,
  validateProfile,
} from '../plugin/lib/connection/connections.js'
import { CONNECTION_ROUTE_PATH, createConnectionHandler } from '../plugin/lib/routes/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(HERE, 'env', 'tmp', 'connections')

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// `sshConfigPath: null` 是有意的：这台"机器"没有家目录，所以路由连 `~/.ssh/config`
// 都不会去碰（真机上的路径由 `resolveConfig` 推出来，见 unit/config.test.mjs）。
const CFG = Object.freeze({ defaultSession: 'default', screenTtlMs: 300, screenTimeoutMs: 20_000, sshConfigPath: null })

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    end(body) { this.body = body ?? '' },
    json() { return this.body === '' ? null : JSON.parse(this.body) },
  }
}

/** 假的 node 请求；body 和真的一样，是个 async iterable。 */
function req(method, url, { body, contentType = 'application/json' } = {}) {
  const headers = { host: '127.0.0.1:43120' }
  if (body !== undefined) headers['content-type'] = contentType
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body, 'utf8') },
  }
}

/** 一个接受写入的 credentials 缝（顺利路径）。 */
function fakeCredentials() {
  const store = new Map()
  return {
    store,
    resolve: async (ref) => (store.has(ref) ? { value: store.get(ref) } : undefined),
    set: async (ref, value) => { store.set(ref, value) },
    unset: async (ref) => { store.delete(ref) },
  }
}

// --- 校验 -----------------------------------------------------------------
eq('slug: a label becomes an id', slugId('LAN Box 3B+'), 'lan-box-3b')
eq('slug: an empty source still yields an id', slugId(''), 'host')
eq('ref: the password reference is a shell identifier', passwordRefFor('lan-box-3b'), 'VISIBLE_SSH_LAN_BOX_3B_PASSWORD')

{
  const base = { host: 'lan-box.local', user: 'me', port: 22, session: 'default' }
  const noPassword = validateProfile(base)
  check('validate: a first save without a password is accepted (key-only host)', noPassword.ok === true && noPassword.profile.id === 'lan-box-local', noPassword)

  const ok = validateProfile({ ...base, label: 'LAN box' }, { password: 'secret' })
  eq('validate: a complete profile is accepted', ok.ok === true && ok.profile, { id: 'lan-box-local', label: 'LAN box', host: 'lan-box.local', port: 22, user: 'me', session: 'default' })

  const defaulted = validateProfile({ host: '10.0.0.5', user: 'root' })
  check('validate: label defaults to user@host and port to 22', defaulted.ok === true && defaulted.profile.label === 'root@10.0.0.5' && defaulted.profile.port === 22 && defaulted.profile.session === 'default', defaulted)

  for (const [field, patch] of [
    ['host', { host: 'bad host' }],
    ['user', { user: 'bad user' }],
    ['port', { port: 70000 }],
    ['port', { port: 'abc' }],
    ['session', { session: '-rf' }],
    ['id', { id: 'Not An Id' }],
  ]) {
    const bad = validateProfile({ ...base, ...patch })
    check(`validate: a bad ${field} is refused`, bad.ok === false && typeof bad.message === 'string', { patch, bad })
  }

  const newline = validateProfile(base, { password: 'a\nb' })
  check('validate: a password with a line break is refused', newline.ok === false, newline)
}

// --- 文件是宽容的 -------------------------------------------------
{
  const missing = join(SANDBOX, 'nope', 'connections.json')
  eq('store: a missing file reads as empty', await readConnections(missing), { version: CONNECTIONS_VERSION, active: null, profiles: [], secrets: {} })

  const corrupt = join(SANDBOX, 'corrupt.json')
  mkdirSync(SANDBOX, { recursive: true })
  writeFileSync(corrupt, '{ not json', 'utf8')
  eq('store: a corrupt file reads as empty', (await readConnections(corrupt)).profiles, [])

  const wrongVersion = join(SANDBOX, 'version.json')
  writeFileSync(wrongVersion, JSON.stringify({ version: 99, profiles: [{ id: 'x' }] }), 'utf8')
  eq('store: a version mismatch reads as empty', (await readConnections(wrongVersion)).profiles, [])

  eq('store: the default file lives under DSH_HOME', defaultConnectionsFile({ DSH_HOME: join(SANDBOX, 'home') }), join(SANDBOX, 'home', 'dsh-visible-ssh', 'connections.json'))
}

// --- 存储，对真实文件 ---------------------------------------
{
  const file = join(SANDBOX, 'file-backend', 'connections.json')
  const credentials = { resolve: async () => undefined, set: async () => { throw new Error('no provider') }, unset: async () => undefined }
  const connections = createConnections({ file, credentials, env: {}, configPath: join(SANDBOX, 'scripts', 'config', 'host.toml') })

  eq('store: nothing configured is source "none"', await connections.source(), 'none')
  eq('store: envFor with no profile injects nothing', await connections.envFor(undefined), {})

  const saved = await connections.saveProfile({ host: 'lan-box.local', user: 'me', session: 'work', label: 'LAN box' }, 'hunter2')
  eq('store: the password downgrades to the file when the seam refuses', saved.profile.passwordStore, 'file')
  eq('store: the saved profile becomes active', saved.active, 'lan-box-local')

  const listed = await connections.list()
  eq('store: list reports presence, not the secret', listed.profiles, [{
    id: 'lan-box-local',
    label: 'LAN box',
    host: 'lan-box.local',
    port: 22,
    user: 'me',
    session: 'work',
    hasPassword: true,
    passwordStore: 'file',
  }])
  check('store: the secret is nowhere in what the browser reads', !JSON.stringify(listed).includes('hunter2'), listed)

  eq('store: envFor carries the four engine variables', await connections.envFor(undefined), {
    SSH_HOST: 'lan-box.local',
    SSH_PORT: '22',
    SSH_USER: 'me',
    SSH_PASSWORD: 'hunter2',
  })
  eq('store: the active profile supplies the session', (await connections.active()).session, 'work')
  eq('store: source switches to "profile"', await connections.source(), 'profile')

  // 第二个 profile，以及它们之间的激活。
  const second = await connections.saveProfile({ host: 'other.example', user: 'root', session: 'default' }, 'other-secret')
  eq('store: a second save does not steal the active slot', second.active, 'lan-box-local')
  eq('store: activating another profile moves the tools with it', await connections.activate('other-example'), { ok: true, active: 'other-example' })
  eq('store: envFor follows the active profile', (await connections.envFor(undefined)).SSH_HOST, 'other.example')
  eq('store: an explicit id overrides the active one', (await connections.envFor('lan-box-local')).SSH_HOST, 'lan-box.local')

  // 不带密码重新保存，会保留已存的那个。
  const again = await connections.saveProfile({ id: 'lan-box-local', host: 'lan-box.local', user: 'me', session: 'work' }, undefined)
  eq('store: a later save keeps the existing password', again.profile.passwordStore, null)
  eq('store: and the stored secret still reaches the child', (await connections.envFor('lan-box-local')).SSH_PASSWORD, 'hunter2')

  // 换「当前连接」干活用的那个会话：只动当前那条档案，别的不许动。
  eq('store: switching the session of the current connection', await connections.setSession('logs'), { ok: true, session: 'logs' })
  eq('store: the active profile now carries the new session', (await connections.active()).session, 'logs')
  eq('store: the session switch leaves the other profile alone',
    (await connections.list()).profiles.find((row) => row.id === 'lan-box-local').session, 'work')
  eq('store: the switch is on disk, not only in memory',
    JSON.parse(readFileSync(file, 'utf8')).profiles.find((row) => row.id === 'other-example').session, 'logs')
  eq('store: a session name with a space is refused', await connections.setSession('no spaces'), {
    ok: false,
    message: 'session must be 64 characters or fewer, start with a letter or digit, and contain only letters, digits, and . _ : @ + -',
  })
  // `parseSessionName` 走 `String(value)`，所以 undefined 会被认成字面量 `'undefined'`
  // —— 那是个**合法**的会话名。缺字段必须在这里就被挡住。
  eq('store: a missing session field is refused, not read as the literal "undefined"',
    await connections.setSession(undefined),
    { ok: false, message: 'session must be a non-empty string' })
  eq('store: a refused name changes nothing', (await connections.active()).session, 'logs')

  eq('store: removing an unknown profile reports nothing removed', await connections.removeProfile('nope'), { ok: true, active: 'other-example', removed: true })
  eq('store: removing the last-but-one leaves one profile', (await connections.list()).profiles.length, 2)
  await connections.removeProfile('other-example')
  await connections.removeProfile('lan-box-local')
  eq('store: nothing left is source "none" again', await connections.source(), 'none')
  eq('store: with no current connection there is nothing to switch',
    await connections.setSession('default'),
    { ok: false, message: 'there is no current connection: activate one before changing its session' })
  const after = JSON.parse(readFileSync(file, 'utf8'))
  eq('store: the secret is dropped with its profile', after.secrets, {})
}

// --- 凭据那道缝，当它接受时 ------------------------------------------------
{
  const file = join(SANDBOX, 'seam-backend', 'connections.json')
  const credentials = fakeCredentials()
  const connections = createConnections({ file, credentials, env: {}, configPath: join(SANDBOX, 'scripts', 'config', 'host.toml') })

  const saved = await connections.saveProfile({ host: 'lan-box.local', user: 'me' }, 'seam-secret')
  eq('seam: the password is stored through the seam', saved.profile.passwordStore, 'credentials')
  eq('seam: the seam holds it under the documented reference', credentials.store.get('VISIBLE_SSH_LAN_BOX_LOCAL_PASSWORD'), 'seam-secret')
  eq('seam: the file keeps no secret', JSON.parse(readFileSync(file, 'utf8')).secrets, {})
  eq('seam: and the child still gets it', (await connections.envFor(undefined)).SSH_PASSWORD, 'seam-secret')

  await connections.removeProfile('lan-box-local')
  eq('seam: removing the profile clears the seam too', credentials.store.size, 0)
}

// --- source：引擎这次要读的那份 host.toml ----------------------------
{
  const root = join(SANDBOX, 'repo-with-cli-config')
  mkdirSync(join(root, 'scripts', 'config'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'config', 'host.toml'), '[host]\nhost = "x"\n', 'utf8')
  // 这份路径是 `engine/config.ts` 的 `chooseHostConfig()` 选出来的（S5 之前是本模块自己按
  // repoRoot 拼的）；连接层只被告知"引擎会读这里"，不再自己推导。
  const connections = createConnections({ file: join(SANDBOX, 'empty', 'connections.json'), env: {}, configPath: join(root, 'scripts', 'config', 'host.toml') })
  eq('source: an existing host.toml reads as "cli-config"', await connections.source(), 'cli-config')
  eq('source: and it injects nothing', await connections.envFor(undefined), {})

  const pointing = createConnections({ file: join(SANDBOX, 'empty', 'connections.json'), env: { SSH_CONFIG: join(root, 'scripts', 'config', 'host.toml') }, configPath: null })
  eq('source: SSH_CONFIG is honoured over the resolved path', await pointing.source(), 'cli-config')

  const absent = createConnections({ file: join(SANDBOX, 'empty', 'connections.json'), env: {}, configPath: null })
  eq('source: no config anywhere is "none", so the engine gets no --config', await absent.source(), 'none')
}

// --- 连接路由 -------------------------------------------------
{
  const file = join(SANDBOX, 'route', 'connections.json')
  const credentials = fakeCredentials()
  const connections = createConnections({ file, credentials, env: {}, configPath: join(SANDBOX, 'scripts', 'config', 'host.toml') })
  const calls = []
  // 本机 `~/.ssh/config` 由**注入**的读取器代表：那份文件属于操作者，密闭套件
  // 永远不碰真机（`test/run.mjs` 的静态门禁盯着这条约定）。
  const sshAsked = []
  const handler = createConnectionHandler({
    cfg: CFG,
    connections,
    sshHosts: () => {
      sshAsked.push('asked')
      return {
        path: 'C:/Users/x/.ssh/config',
        hosts: [{ alias: 'box', hostName: '10.0.0.9', user: 'ops', port: 2222, identityFile: 'C:/Users/x/.ssh/k' }],
        error: null,
      }
    },
    runCli: async (argv, env) => {
      calls.push({ argv, env })
      return { ok: true, session: argv[1], exists: false, last_line: null, config_path: 'x.toml' }
    },
  }).handle

  const empty = fakeRes()
  await handler(req('GET', CONNECTION_ROUTE_PATH), empty)
  eq('route: GET answers 200 with the source and no profiles', [empty.statusCode, empty.json().source, empty.json().profiles], [200, 'none', []])
  check('route: GET names the file it manages', typeof empty.json().file === 'string' && empty.json().file.endsWith('connections.json'), empty.json().file)
  eq('route: GET carries the ssh candidates it was given, path and all', empty.json().sshConfig, {
    path: 'C:/Users/x/.ssh/config',
    hosts: [{ alias: 'box', hostName: '10.0.0.9', user: 'ops', port: 2222, identityFile: 'C:/Users/x/.ssh/k' }],
    error: null,
  })
  eq('route: the ssh list is read once per GET, through the injected seam', sshAsked.length, 1)

  const created = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'save', profile: { host: 'lan-box.local', user: 'me', session: 'work' }, password: 'route-secret' }) }), created)
  const createdBody = created.json()
  eq('route: POST save answers 200 and reports the new state', [created.statusCode, createdBody.saved, createdBody.source, createdBody.active], [200, 'lan-box-local', 'profile', 'lan-box-local'])
  check('route: the save answer never echoes the password', !JSON.stringify(createdBody).includes('route-secret'), createdBody)

  const tested = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'test' }) }), tested)
  eq('route: test runs the CLI and reports the verdict', [tested.statusCode, tested.json().test.ok, tested.json().test.exists], [200, true, false])
  eq('route: test asked for status on the profile\'s session', calls.at(-1).argv, ['--session', 'work', 'status', '--json'])
  eq('route: test handed the CLI the injected environment', calls.at(-1).env, { SSH_HOST: 'lan-box.local', SSH_PORT: '22', SSH_USER: 'me', SSH_PASSWORD: 'route-secret' })

  // 只走密钥的机器（本机 ssh 配置里的别名就是这种）：第一次保存本来就没有密码可填。
  // 引擎（v0.0.1）拿到这三个变量就够，缺 SSH_PASSWORD 时 ssh 会去用操作者 ~/.ssh 里的
  // 密钥；密码错了它是**响的**（`transport failed during read: … Permission denied`），
  // 所以这里不需要一道"必须先填密码"的闸门来防静默失败。
  const keyOnly = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'save', profile: { id: 'keyhost', host: 'key-host-01', user: 'root' } }) }), keyOnly)
  const keyBody = keyOnly.json()
  eq('route: a first save with no password at all is accepted', [keyOnly.statusCode, keyBody.saved, keyBody.profiles.find((profile) => profile.id === 'keyhost').hasPassword], [200, 'keyhost', false])
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'test', id: 'keyhost' }) }), fakeRes())
  check('route: a key-only profile hands the CLI no password at all', calls.at(-1).env.SSH_PASSWORD === undefined, calls.at(-1).env)

  const keyRemoved = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'remove', id: 'keyhost' }) }), keyRemoved)
  eq('route: a key-only profile is removed like any other (no secret was ever stored)', [keyRemoved.statusCode, keyRemoved.json().profiles.length], [200, 1])

  const failing = createConnectionHandler({
    cfg: CFG,
    connections,
    runCli: async () => { throw Object.assign(new Error('config file not found'), { kind: 'cli' }) },
  }).handle
  const failure = fakeRes()
  await failing(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'test' }) }), failure)
  eq('route: a failing test is a 200 with test.ok false, not a server error', [failure.statusCode, failure.json().ok, failure.json().test.ok, failure.json().test.message], [200, true, false, 'config file not found'])

  const badAction = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'explode' }) }), badAction)
  eq('route: an unknown action is a 400', [badAction.statusCode, badAction.json().error.kind], [400, 'bad-action'])

  const badProfile = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'save', profile: { host: 'lan-box.local', user: 'me' }, password: '' }) }), badProfile)
  eq('route: an invalid profile is a 400 with the validator\'s words', [badProfile.statusCode, badProfile.json().error.kind], [400, 'bad-profile'])

  const noType = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: '{}', contentType: 'text/plain' }), noType)
  eq('route: a non-JSON body is a 415', noType.statusCode, 415)

  const badJson = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: '{oops' }), badJson)
  eq('route: malformed JSON is a 400', [badJson.statusCode, badJson.json().error.kind], [400, 'bad-request'])

  const huge = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'save', pad: 'x'.repeat(20 * 1024) }) }), huge)
  eq('route: an oversized body is a 413', [huge.statusCode, huge.json().error.kind], [413, 'payload-too-large'])

  const missingProfile = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'activate', id: 'ghost' }) }), missingProfile)
  eq('route: activating an unknown profile is a 404', [missingProfile.statusCode, missingProfile.json().ok], [404, false])

  const removed = fakeRes()
  await handler(req('POST', CONNECTION_ROUTE_PATH, { body: JSON.stringify({ action: 'remove', id: 'lan-box-local' }) }), removed)
  eq('route: removing a profile answers 200 with the new state', [removed.statusCode, removed.json().ok, removed.json().profiles], [200, true, []])

  const wrongMethod = fakeRes()
  await handler(req('PUT', CONNECTION_ROUTE_PATH), wrongMethod)
  eq('route: another method is a 405 naming both', [wrongMethod.statusCode, wrongMethod.headers.allow], [405, 'GET, POST'])

  const fenced = createConnectionHandler({ cfg: CFG, connections, connection: () => ({ requestRejection: () => 401 }), runCli: async () => ({}) }).handle
  const rejected = fakeRes()
  await fenced(req('GET', CONNECTION_ROUTE_PATH), rejected)
  eq('route: the fence answers before the store is read', [rejected.statusCode, rejected.body], [401, ''])
}

rmSync(SANDBOX, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed,
  verdict: failed.length === 0 ? 'OK: the connection layer behaves as documented' : 'FAILURES above',
}, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
