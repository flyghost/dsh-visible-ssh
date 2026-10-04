// 手写客户端半的离线检查：不需要浏览器、不需要 DSH、不需要 SSH。
//
// 它伪造了 bundle 会碰到的四样东西——`window.__ModuleLoader__`、
// `require('react')`（配一个极小的 hook 运行时）、`document` 和 `fetch`——然后
// 像 shell 那样驱动函数体：load -> factory(require) -> apply(ctx)，
// 再**手动渲染** tab 主体、手动推进它的轮询器。
//
// 这里值得证明的东西：
//   * tab 类型与 body 槽位都被注册了，而且两个 disposer 都拿得回来
//   * 镜像会等面板载荷到位之后才开 SSH 连接，
//     而在什么都没配置时它根本不会跑
//   * 一次 tick 会去取文档里写明的端点，屏幕内容能进到 <pre>
//   * 慢的 capture 不会被叠加（在途时不会再发第二个 fetch）
//   * 失败时保留上一份好屏幕，并把原因显示出来
//   * 隐藏页面会停掉定时器，回来时重新启动它
//   * unmount 会清掉定时器和 visibility 监听器
//   * **只有**当读者已经停在尾部时，新输出才跟随尾部
//   * 面板是一个**选择器**，不是设置表单的第二份拷贝：它不渲染任何输入框，
//     而且它的 打开/杀掉/切换主机 动作都走面板路由
//   * 杀掉需要点两次，而「是否存在」这一条由镜像负责给出
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('../plugin/lib/client/index.js', import.meta.url))
const source = readFileSync(SOURCE, 'utf8')

const SCREEN = '/visible-ssh/screen'
const CONNECTION = '/visible-ssh/connection'
const SESSIONS = '/visible-ssh/sessions'

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
/** 让组件里每一条已经 resolve 的 promise 链都落定。 */
async function settle() { for (let i = 0; i < 10; i += 1) await Promise.resolve() }

// --- 一个短到能读懂的 hook 运行时 ----------------------------------------
// bundle 是一个函数组件（表单部分是嵌套的函数组件），用的是
// useState/useRef/useEffect/useCallback。React 有两条性质在这里很重要，
// 它们是**被建模出来的**，不是假设出来的：
//   * hooks 属于**一个组件实例**，以它在树里的位置为标识——嵌套组件
//     绝不能消耗它父组件的槽位；
//   * 卸载组件会丢掉它的 state，所以重新打开表单是从一份空白草稿开始，
//     而不是从一份过期的草稿开始。
// 重渲染是显式的：render() 调用组件、展开嵌套组件、提交 ref，然后运行
// deps 有变化的那些 effect。
function createHooks() {
  const instances = new Map()
  const state = { path: 'root', pending: new Map(), cursors: new Map(), seen: new Set() }

  const depsChanged = (before, next) => before === undefined || next === undefined
    || before.length !== next.length
    || before.some((value, index) => value !== next[index])

  const instanceOf = (path) => {
    let instance = instances.get(path)
    if (instance === undefined) {
      instance = { slots: [], refs: [], effects: [] }
      instances.set(path, instance)
    }
    return instance
  }
  const nextCursor = (path) => {
    const at = state.cursors.get(path) ?? 0
    state.cursors.set(path, at + 1)
    return at
  }

  /** 把组件元素替换成它渲染出来的东西，按它在树里的位置标识。 */
  function expand(node, path) {
    if (Array.isArray(node)) return node.flatMap((child, index) => expand(child, `${path}.${index}`))
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const childPath = `${path}>${node.type.name || 'component'}`
      state.seen.add(childPath)
      const outer = state.path
      state.path = childPath
      let rendered
      try {
        rendered = node.type(node.props ?? {})
      } finally {
        state.path = outer
      }
      return expand(rendered, childPath)
    }
    // children 的展平方式与 React 完全一致，这样组件里的
    // `children.map()` 就不会对 find/text 藏起一棵子树。
    return { ...node, children: (node.children ?? []).flatMap((child, index) => expand(child, `${path}.${index}`)) }
  }

  return {
    /** 渲染组件并提交：嵌套组件、ref、effect。 */
    render(component, props, rootKey = 'root') {
      state.seen = new Set([rootKey])
      state.cursors = new Map()
      state.pending = new Map()
      state.path = rootKey
      const tree = expand(component(props), rootKey)
      attachRefs(tree)

      for (const [path, entries] of state.pending) {
        const instance = instanceOf(path)
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index]
          const before = instance.effects[index]
          if (before !== undefined && !depsChanged(before.deps, entry.deps)) { entries[index] = before; continue }
          if (before !== undefined && typeof before.dispose === 'function') before.dispose()
          const dispose = entry.fn()
          entry.dispose = typeof dispose === 'function' ? dispose : null
        }
        // 一个不再渲染的 hook 仍然必须被清理掉。
        for (let index = entries.length; index < instance.effects.length; index += 1) {
          if (typeof instance.effects[index]?.dispose === 'function') instance.effects[index].dispose()
        }
        instance.effects = entries
      }
      // 消失的组件会同时丢掉它的 effect 和 state——但只在**这一个** root
      // 之内：检查里把面板与设置区块渲染成两个互相独立的 root，
      // 一个不能把另一个裁掉。
      for (const [path, instance] of [...instances]) {
        if (state.seen.has(path)) continue
        if (path !== rootKey && !path.startsWith(`${rootKey}.`) && !path.startsWith(`${rootKey}>`)) continue
        for (const entry of instance.effects) if (typeof entry.dispose === 'function') entry.dispose()
        instances.delete(path)
      }
      return tree
    },
    unmount() {
      for (const instance of instances.values()) {
        for (const entry of instance.effects) if (typeof entry.dispose === 'function') entry.dispose()
      }
      instances.clear()
    },
    hooks: {
      useState(initial) {
        const instance = instanceOf(state.path)
        const at = nextCursor(state.path)
        if (instance.slots.length <= at) instance.slots[at] = typeof initial === 'function' ? initial() : initial
        const setter = (value) => {
          instance.slots[at] = typeof value === 'function' ? value(instance.slots[at]) : value
        }
        return [instance.slots[at], setter]
      },
      useRef(initial) {
        const instance = instanceOf(state.path)
        const at = nextCursor(state.path)
        if (instance.refs.length <= at) instance.refs[at] = { current: initial }
        return instance.refs[at]
      },
      useEffect(fn, deps) {
        const path = state.path
        nextCursor(path)
        const list = state.pending.get(path) ?? []
        list.push({ fn, deps })
        state.pending.set(path, list)
      },
      useCallback(fn) {
        nextCursor(state.path)
        return fn
      },
    },
  }
}

/** React 会去设置 `ref.current`；检查里也需要它，用来跑滚动逻辑。 */
function attachRefs(node) {
  if (node === null || typeof node !== 'object') return
  const ref = node.props && node.props.ref
  if (ref !== null && typeof ref === 'object' && ref.current === null) {
    // 一个 24 行的 pane 挤在更短的面板里的几何尺寸：1000px 的文本放在
    // 400px 的视口里，已滚到底。
    ref.current = { scrollHeight: 1000, clientHeight: 400, scrollTop: 1000 }
  }
  for (const child of node.children ?? []) attachRefs(child)
}

/** 按标签名在元素树上做深度优先搜索。 */
function find(node, tag) {
  if (node === null || typeof node !== 'object') return null
  if (node.type === tag) return node
  for (const child of node.children ?? []) {
    const hit = find(child, tag)
    if (hit !== null) return hit
  }
  return null
}
/** 某个标签的全部元素，按文档顺序。 */
function findAll(node, tag) {
  if (node === null || typeof node !== 'object') return []
  const out = node.type === tag ? [node] : []
  for (const child of node.children ?? []) out.push(...findAll(child, tag))
  return out
}
/** 一棵子树里的所有字符串拼起来——够用来读一行状态了。 */
function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}
/** 第一个标签能匹配上的 button，这样头部顺序变动就不会打破检查。 */
const buttonNamed = (tree, label) => findAll(tree, 'button').find((node) => textOf(node) === label) ?? null
/**
 * 错误条，靠只有它在用的那条边框找到。
 *
 * 以前是按 <div> 的总数来数的，那等于把**面板**的排版钉死了：加一行 session
 * 行或一行提示都会让这个数字变，可什么都没出错。这里直接找错误条本身，
 * 「没有错误条」才仍然是一句真断言。
 */
const errorStrips = (node) => findAll(node, 'div')
  .filter((div) => div.props?.style?.border === '1px solid rgba(210,153,34,0.45)')

// --- 替身 ------------------------------------------------------------------
const registered = []
const window = { __ModuleLoader__: { load(entry) { registered.push(entry) } } }
const hooks = createHooks()
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }
for (const [name, fn] of Object.entries(hooks.hooks)) React[name] = fn
const requireShim = (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
}

/** 组件排下的那些定时器，检查据此可以手动推进它们。 */
const timers = { next: 1, live: new Map() }
const timersOf = (ms) => [...timers.live.entries()].filter(([, timer]) => timer.ms === ms)
globalThis.setInterval = (fn, ms) => {
  const id = timers.next++
  timers.live.set(id, { fn, ms })
  return id
}
globalThis.clearInterval = (id) => { timers.live.delete(id) }

/** 已发出的请求、仍未作答的请求，以及为它们预备好的响应。 */
const requests = []
const waiting = []
const planned = []

/**
 * 面板除了读会话路由，还会为了「远端到底有哪些会话」额外发一次
 * `POST { action: 'list' }`。那是一次**独立**的请求，不参与下面这套「先预备好
 * 一个回答、再按先后顺序配对」的机制：否则它会把之后每一次配对都推后一位，而
 * 错位表现出来就是某次 `await` 永远不落定。
 *
 * 所以它自带一份回答，发出即答：planList 换掉那份回答，planListNetworkError
 * 让它以网络错误告终。
 */
const listBody = {
  ok: true, session: 'default', exists: true,
  sessions: [
    { name: 'default', attached: 1, windows: 1, current: true },
    { name: 'scratch', attached: 0, windows: 2, current: false },
  ],
}
let listAnswer = { kind: 'response', status: 200, body: listBody }
const isListPost = (options) => {
  if (options === undefined || options.method !== 'POST') return false
  try { return JSON.parse(options.body).action === 'list' } catch { return false }
}
/** 面板索要远端会话列表的那些 POST。 */
const listPosts = () => requests.filter((entry) => isListPost(entry.options))
function planList(status = 200, body = listBody) { listAnswer = { kind: 'response', status, body } }
function planListNetworkError(message) { listAnswer = { kind: 'network', message } }

globalThis.fetch = (url, options) => {
  requests.push({ url, options })
  if (isListPost(options)) {
    return listAnswer.kind === 'network'
      ? Promise.reject(new Error(listAnswer.message))
      : Promise.resolve({
          ok: listAnswer.status >= 200 && listAnswer.status < 300,
          status: listAnswer.status,
          json: async () => listAnswer.body,
        })
  }
  return new Promise((resolve, reject) => {
    waiting.push({ resolve, reject })
    flush()
  })
}
function flush() {
  while (planned.length > 0 && waiting.length > 0) {
    const plan = planned.shift()
    const request = waiting.shift()
    if (plan.kind === 'network') request.reject(new Error(plan.message))
    else request.resolve(plan.response)
  }
}
/** 预备下一个回答。`status` 像浏览器那样驱动 `response.ok`。 */
function planResponse(status, body) {
  planned.push({ response: { ok: status >= 200 && status < 300, status, json: async () => body } })
  flush()
}
function planNetworkError(message) {
  planned.push({ kind: 'network', message })
  flush()
}
/** 已经发出的请求，按形状筛选。 */
const posts = () => requests.filter((entry) => entry.options !== undefined && entry.options.method === 'POST')
const gets = (url) => requests.filter((entry) => entry.url === url)

const listeners = new Map()
globalThis.document = {
  visibilityState: 'visible',
  addEventListener(type, fn) { listeners.set(type, fn) },
  removeEventListener(type) { listeners.delete(type) },
  fire(type) { const fn = listeners.get(type); if (fn) fn() },
}

// --- 像浏览器那样求值 bundle ------------------------------------------
const run = new Function('window', 'require', source)
run(window, requireShim)

// --- 像 shell 那样驱动插件 -------------------------------------------------
const calls = []
const disposers = []
let body = null
let section = null
let composer = null
const ctx = {
  effect(fn, label) {
    calls.push('effect:' + label)
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  inject(services, cb) {
    calls.push('inject:' + services.join(','))
    const dispose = cb({
      sidebarRightTabs: {
        register(definition) {
          calls.push('registerType:' + definition.id + '/' + definition.kind)
          ctx.type = {
            id: definition.id,
            kind: definition.kind,
            priority: definition.priority,
            title: definition.title(),
            guide: definition.guide?.map((guide) => guide.title()),
          }
          return () => calls.push('disposeType')
        },
      },
      sidebarRight: ctx.sidebarRight,
    })
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  slots: {
    register(where, component) {
      calls.push('registerSlot:' + where.name)
      if (where.name === 'settings.section') {
        ctx.section = { id: where.id, order: where.order, label: where.label(), renders: typeof component === 'function' }
        section = component
        return () => calls.push('disposeSection')
      }
      if (where.name === 'conversation.input.left') {
        // 对话框输入栏那一格。它必须是**自己的**分支：否则它会落到下面那条
        // 兜底上，把面板那次注册的结果覆盖掉。
        ctx.composer = { slot: where.name, id: where.id, order: where.order, label: where.label(), renders: typeof component === 'function' }
        composer = component
        return () => calls.push('disposeComposer')
      }
      ctx.body = { slot: where.name, key: where.key, renders: typeof component === 'function' }
      body = component
      return () => calls.push('disposeBody')
    },
    // slots 服务负责「这个槽位一存在就注册」；随包发布的那些区块依赖这条，
    // 所以替身立刻触发回调，并记下它确实走过了台账。
    inject(name, callback) {
      calls.push('slotInject:' + name)
      callback()
    },
  },
  sidebarRight: {
    openTab(kind, options) {
      calls.push('openTab:' + kind + '/' + JSON.stringify(options))
      ctx.openTab = { kind, options }
      // 真实的 dock 在没有 session 挂载时会抛错；这里建模一次，好让重试
      // 路径**被走到**，而不是被假设。
      if (ctx.__openThrew !== true) { ctx.__openThrew = true; throw new Error('no session dock mounted yet') }
    },
  },
}

const plugin = registered[0]?.factory(requireShim)
eq('bundle: exactly one module is loaded', registered.length, 1)
eq('bundle: the module id is the package name', registered[0]?.id, 'dsh-visible-ssh')
eq('bundle: the factory returns apply + inject', [typeof plugin?.apply, plugin?.inject], ['function', ['slots']])
plugin.apply(ctx)

eq('register: the tab type is registered', ctx.type, {
  id: 'dsh-visible-ssh:console',
  kind: 'visible-ssh:console',
  priority: 'extension',
  title: 'visible-ssh',
  guide: ['visible-ssh'],
})
eq('register: the body claims the pane slot', ctx.body, { slot: 'sidebar.right.pane.tab', key: 'dsh-visible-ssh:console', renders: true })
eq('register: a settings section is added next to the built-in ones', ctx.section, { id: 'visible-ssh', order: 20, label: 'visible-ssh', renders: true })
check('register: the section goes through the slot ledger', calls.includes('slotInject:settings.section'), calls)
eq('register: the composer gains the server ＋ session pickers', ctx.composer, {
  slot: 'conversation.input.left', id: 'visible-ssh:server', order: 10, label: 'visible-ssh', renders: true,
})
check('register: the composer picker goes through the slot ledger', calls.includes('slotInject:conversation.input.left'), calls)

// 那个 reveal effect 每秒重试一次，直到 dock 出现。
{
  const reveal = timersOf(1000)
  eq('reveal: a one-second retry timer exists', reveal.length, 1)
  reveal[0][1].fn()
  eq('reveal: the first attempt threw and the retry stays armed', timersOf(1000).length, 1)
  reveal[0][1].fn()
  eq('reveal: the second attempt opened the tab and the retry stopped', timersOf(1000).length, 0)
  eq('reveal: it opened our kind without stealing focus', ctx.openTab, { kind: 'visible-ssh:console', options: { revealIfOpened: false } })
}

// --- render 1：问宿主这个面板镜像的是哪台机器 ------------------------------
let tree = hooks.render(body, { sessionId: 'session-42' })
eq('boot: the first request is the panel payload', [gets(SESSIONS).length, requests.length], [1, 1])
eq('boot: the panel request asks for JSON and no caching', [requests[0].options.headers.accept, requests[0].options.cache], ['application/json', 'no-store'])
eq('boot: no SSH is opened before the host answers (no mirror timer)', timersOf(2000).length, 0)
check('boot: the mirror placeholder is already on screen', textOf(find(tree, 'pre')).includes('正在读取远端 pane'), textOf(tree).slice(0, 160))

// connection 路由的载荷——**设置**区块读的仍然是这一份。
// 载荷里的路径是**故意中性的**：门禁会扫密闭层源码里有没有本机状态的名字
// （`~/.dsh` 之类），这里只是要一个会经过 HTML 转义的假路径，不必长得像真的。
const overview = {
  ok: true,
  source: 'profile',
  active: 'me',
  file: 'C:/Users/x/visible-ssh/connections.json',
  defaultSession: 'default',
  profiles: [{ id: 'me', label: 'LAN box', host: 'lan-box.local', port: 22, user: 'me', session: 'default', hasPassword: true, passwordStore: 'credentials' }],
}
// panel 路由的载荷：同一台主机，外加它有权操作的那些行。
const panelPayload = {
  ok: true,
  source: 'profile',
  active: { id: 'me', label: 'LAN box', target: 'me@lan-box.local:22', session: 'default' },
  profiles: [{ id: 'me', label: 'LAN box', target: 'me@lan-box.local:22', session: 'default', active: true }],
  defaultSession: 'default',
  file: 'C:/Users/x/visible-ssh/connections.json',
  // `exists: null` 是契约，不是疏忽：只有镜像知道。
  sessions: [{ name: 'default', exists: null }],
}
planResponse(200, panelPayload)
await settle()

hooks.render(body, { sessionId: 'session-42' })
eq('poll: a configured connection starts exactly one mirror timer', timersOf(2000).length, 1)
eq('poll: the mirror asks its own endpoint', gets(SCREEN).length, 1)
eq('poll: the mirror endpoint is the host route', gets(SCREEN)[0].url, SCREEN)
eq('poll: and it also asks for no caching', gets(SCREEN)[0].options.cache, 'no-store')
eq('poll: the panel payload keeps its own slower timer', timersOf(5000).length, 1)

// --- 慢抓取**绝不**能叠加 --------------------------------------------------
const tick = timersOf(2000)[0][1].fn
/** 推进一次 tick，并在它的 fetch 还没落地时就作答。 */
async function tickAndAnswer(plan) {
  const running = tick()
  plan()
  await running
  await settle()
}
await tick()
eq('poll: a tick during an in-flight capture does not stack', gets(SCREEN).length, 1)

const shot = {
  ok: true, session: 'default', exists: true, lineCount: 2,
  screen: 'me@lan-box:/opt $ ls\ndocs  plugin',
  width: 80, height: 24, cursorX: 12, cursorY: 3, lastLine: 'docs  plugin',
  connection: { source: 'profile', id: 'me', label: 'LAN box', target: 'me@lan-box.local:22' },
  cached: false, shared: false, ageMs: 0, now: Date.now(),
}
// 第一次取屏就失败：这一格**不能**留成空白。空白看起来只是"什么都没发生"，而原因
// （连不上、认证被拒、配置缺密码、宿主 502）就在那次失败的话里。
planNetworkError('connect ECONNREFUSED')
await settle()
tree = hooks.render(body, { sessionId: 'session-42' })
check('boot: a failed first capture says why instead of showing nothing',
  textOf(find(tree, 'pre')).includes('取屏失败：connect ECONNREFUSED'), JSON.stringify(textOf(find(tree, 'pre'))))
check('boot: and it points at the retry that is already armed',
  textOf(find(tree, 'pre')).includes('「↻」'), JSON.stringify(textOf(find(tree, 'pre'))))
eq('boot: the failure reaches the status line too',
  textOf(findAll(tree, 'div')[1]).includes('读取出错'), true)

// 失败不是终点：下一次 tick 自己会再发一次，读到就照旧把屏幕画出来。
await tickAndAnswer(() => planResponse(200, shot))

tree = hooks.render(body, { sessionId: 'session-42' })
eq('render: the screen reaches the <pre>', textOf(find(tree, 'pre')), shot.screen)
const statusLine = textOf(findAll(tree, 'div')[1])
check('render: the status line names session, geometry and cursor', statusLine.includes('session "default"') && statusLine.includes('80×24') && statusLine.includes('cursor 12,3'), statusLine)
check('render: the status line names the connection it is mirroring', statusLine.includes('LAN box'), statusLine)
// 面板会渲染一个头部、一行 session、一行提示和镜像外壳；这条检查要说的
// 是：一个好回答**不会**加上任何错误条。
eq('render: no error strip once an answer arrived', errorStrips(tree).length, 0)

// --- 只有读者停在尾部时才跟随尾部 ------------------------------------------
const preNode = find(tree, 'pre').props.ref.current
eq('scroll: new output sticks to the bottom', preNode.scrollTop, preNode.scrollHeight)
preNode.scrollTop = 0
find(tree, 'pre').props.onScroll()
preNode.scrollHeight = 2000
hooks.render(body, { sessionId: 'session-42' })
eq('scroll: a reader who scrolled up is left where they are', preNode.scrollTop, 0)

// --- 失败时保留上一份好屏幕 ------------------------------------------
// 一次 tick 要等它的 fetch 被作答才会落定，所以响应要在请求还开着的时候就
// 预备好，而不是 await 之后再预备。
{
  const before = gets(SCREEN).length
  await tickAndAnswer(() => planNetworkError('connect ECONNREFUSED'))
  eq('poll: the next tick asked again', gets(SCREEN).length, before + 1)
}
tree = hooks.render(body, { sessionId: 'session-42' })
check('error: the reason is shown', textOf(tree).includes('ECONNREFUSED'), textOf(tree).slice(0, 200))
eq('error: and exactly one strip carries it', errorStrips(tree).length, 1)
eq('error: the last good screen survives the failure', textOf(find(tree, 'pre')), shot.screen)

// --- 兜底超时：一条永远不回答的取屏不能把这条轮询钉死 ----------------------
// 客户端那侧的时限是 20s（bundle 里的 `FETCH_TIMEOUT_MS`），这里把时钟拨过去。
{
  eq('timeout: nothing is in flight before we outlive one', waiting.length, 0)
  const realNow = Date.now
  const running = tick()
  eq('timeout: the capture is out and unanswered', waiting.length, 1)
  const before = gets(SCREEN).length
  Date.now = () => realNow() + 60000
  await tick()
  Date.now = realNow
  tree = hooks.render(body, { sessionId: 'session-42' })
  check('timeout: a capture that never answers is declared dead, not left in flight',
    textOf(tree).includes('取屏超时'), textOf(tree).slice(0, 300))
  eq('timeout: and it counts as a read failure', errorStrips(tree).length, 1)
  // 下一条 tick 照常再发 —— 被放弃的那条请求还挂在队列里，所以两条一起喂掉（先旧后新）。
  const again = tick()
  eq('timeout: the poll is not stuck — it asks again', gets(SCREEN).length, before + 1)
  planResponse(200, shot)
  planResponse(200, shot)
  await running
  await again
  await settle()
  tree = hooks.render(body, { sessionId: 'session-42' })
  eq('timeout: and a good answer after that puts the screen back', textOf(find(tree, 'pre')), shot.screen)
}

// --- 宿主返回的 502 用路由自己的话报出来 --------------------------
await tickAndAnswer(() => planResponse(502, { ok: false, error: { kind: 'protocol', message: 'the CLI printed no JSON (exit 1)' } }))
tree = hooks.render(body, { sessionId: 'session-42' })
check('error: a 502 shows kind and message', textOf(tree).includes('protocol: the CLI printed no JSON'), textOf(tree).slice(0, 240))

// --- 手动刷新按钮 ---------------------------------------------------
const refresh = buttonNamed(tree, '↻')
check('refresh: a refresh control exists', refresh !== null)
{
  const before = gets(SCREEN).length
  refresh.props.onClick()
  await settle()
  eq('refresh: it asks the host again immediately', gets(SCREEN).length, before + 1)
  planResponse(200, shot)
  await settle()
}

// --- 页面隐藏：轮询停止 ---------------------------------------------
document.visibilityState = 'hidden'
document.fire('visibilitychange')
eq('visibility: hiding the page stops the mirror timer', timersOf(2000).length, 0)
tree = hooks.render(body, { sessionId: 'session-42' })
check('visibility: the status line says it is paused', textOf(tree).includes('已暂停'), textOf(findAll(tree, 'div')[1]))

document.visibilityState = 'visible'
document.fire('visibilitychange')
eq('visibility: returning restarts exactly one timer', timersOf(2000).length, 1)
// 回到前台还会立刻触发一次 tick；若把它留着不答，后面每一次 plan/request
// 的配对都会错位。
planResponse(200, shot)
await settle()

// --- 面板：一个选择器，外加它自己拥有的两个动作 ----------------------
{
  /** 点击一个带标签的控件，失败时记下丰富的细节而不是直接崩掉。 */
  const click = (node, label) => {
    const button = buttonNamed(node, label)
    if (button === null) {
      check(`panel: a "${label}" control exists`, false, textOf(node).slice(0, 500))
      return false
    }
    button.props.onClick()
    return true
  }

  tree = hooks.render(body, { sessionId: 'session-42' })
  check('panel: the session row is listed', textOf(tree).includes('会话 default'), textOf(tree).slice(0, 300))
  check('panel: existence is the mirror\'s claim, not the route\'s', !textOf(tree).includes('不存在'), textOf(tree).slice(0, 400))
  const selector = find(tree, 'select')
  check('panel: the host selector offers the active profile', selector !== null && selector.props.value === 'me', selector === null ? null : selector.props)
  // 远端「有哪些会话」是**引擎**枚举出来的，所以面板为它单独问了一次宿主，而且
  // 只问一次：这几次渲染之间供数的主机没变。
  eq('list: the panel asks the host to enumerate the sessions',
    [listPosts().length, JSON.parse(listPosts().at(-1).options.body)], [1, { action: 'list' }])
  check('list: every enumerated session gets its own row', textOf(tree).includes('会话 scratch'), textOf(tree).slice(0, 400))
  check('list: a session with readers says how many', textOf(tree).includes('1 人已接入'), textOf(tree).slice(0, 400))

  // 打开：**引擎**负责开窗口，所以客户端半只转发名字。
  click(tree, '打开')
  await settle()
  eq('open: it posts to the panel route', [posts().at(-1).url, JSON.parse(posts().at(-1).options.body)], [SESSIONS, { action: 'open', session: 'default' }])
  planResponse(200, { ok: true, opened: { session: 'default', target: 'me@lan-box.local', title: 'LAN box · AI session', tmuxCommand: 'tmux …' } })
  await settle()
  tree = hooks.render(body, { sessionId: 'session-42' })
  check('open: the answer is reported in words', textOf(tree).includes('已在本机打开终端「LAN box · AI session」'), textOf(tree).slice(0, 400))

  // 杀掉要点两次：第一次点击只是让按钮进入待确认状态。
  const postsBefore = posts().length
  click(tree, '杀掉')
  tree = hooks.render(body, { sessionId: 'session-42' })
  eq('kill: the first click only arms the button', [posts().length === postsBefore, buttonNamed(tree, '确认杀掉？') !== null], [true, true])
  click(tree, '确认杀掉？')
  await settle()
  eq('kill: the second click sends the action', JSON.parse(posts().at(-1).options.body), { action: 'kill', session: 'default' })
  planResponse(200, { ok: true, killed: { session: 'default', killed: true } })
  await settle()
  tree = hooks.render(body, { sessionId: 'session-42' })
  check('kill: the outcome is reported', textOf(tree).includes('已杀掉远端会话 "default"'), textOf(tree).slice(0, 400))

  // 切换主机走同一条路由，并重新取它自己的载荷。
  find(tree, 'select').props.onChange({ target: { value: 'me' } })
  await settle()
  eq('hosts: changing the selector activates that profile', JSON.parse(posts().at(-1).options.body), { action: 'activate', id: 'me' })
  planResponse(200, panelPayload)
  await settle()
  tree = hooks.render(body, { sessionId: 'session-42' })
  eq('hosts: the refreshed payload keeps the mirror running', timersOf(2000).length, 1)

  // --- 会话选择器：屏幕一次只照一个会话，但人可以挑是哪一个 -------------
  {
    const screenGets = () => requests.filter((entry) => String(entry.url).indexOf(SCREEN) === 0)
    const sessionGets = () => screenGets().filter((entry) => String(entry.url).indexOf('?session=') !== -1)
    const plainGets = () => screenGets().filter((entry) => entry.url === SCREEN)
    /** 那一行本身：按会话名认行，取**最内层**那个（外层容器也以第一行开头）。 */
    const rowFor = (node, session) => findAll(node, 'div')
      .filter((div) => textOf(div).indexOf('会话 ' + session) === 0 && buttonNamed(div, '打开') !== null)
      .sort((left, right) => textOf(left).length - textOf(right).length)[0] ?? null
    /** 第二个下拉（会话）。按 title 认，因为它与「服务器」那个形状完全一样。 */
    const sessionSelect = (node) => findAll(node, 'select')
      .find((select) => String(select.props.title).indexOf('这块屏幕照哪个') === 0) ?? null
    /** 选中某一项 —— 这就是浏览器里改一个 <select> 会做的事。 */
    const pick = (node, value) => {
      const select = sessionSelect(node)
      if (select === null) {
        check('mirror: the session dropdown exists', false, textOf(node).slice(0, 500))
        return false
      }
      select.props.onChange({ target: { value } })
      return true
    }
    const chosen = (node) => (sessionSelect(node) === null ? null : sessionSelect(node).props.value)
    /** 那一行自己的话里有没有说"正在镜像"（被照着的永远只有一行）。 */
    const mirroredRow = (node, session) => {
      const row = rowFor(node, session)
      return row !== null && textOf(row).includes('正在镜像')
    }
    const marked = () => textOf(tree).split('· 正在镜像').length - 1

    // 没人挑过的时候 URL 上**不带**参数：还是让宿主说该照哪一个 —— 与加这个选择器
    // 之前逐字相同。
    eq('mirror: with nobody picking, the poll carries no session', sessionGets().length, 0)
    eq('mirror: and the row the host is shooting says so', marked(), 1)
    check('mirror: the panel offers a session dropdown', sessionSelect(tree) !== null, textOf(tree).slice(0, 400))
    // 默认**不是**"谁都没选"：它跟着当前连接自己的那个会话。所以下拉的第一项就是那个
    // 会话（它不写 `?session=`，让宿主自己决定照哪个），而不是一个空占位。
    eq('mirror: the default selection is the follow option', chosen(tree), '')
    check('mirror: and that option names the session being followed',
      textOf(sessionSelect(tree)).includes('跟随当前连接 · default'), textOf(sessionSelect(tree)).slice(0, 300))
    check('mirror: every enumerated session can be picked from it',
      textOf(sessionSelect(tree)).includes('scratch'), textOf(sessionSelect(tree)).slice(0, 300))
    eq('mirror: the row being shot is the one drawn as selected',
      [mirroredRow(tree, 'default'), mirroredRow(tree, 'scratch')], [true, false])
    check('mirror: the panel spells out which session it shoots and why',
      textOf(tree).includes('正在镜像：会话 default · 跟随当前连接'), textOf(tree).slice(0, 300))

    const shotsBefore = sessionGets().length
    pick(tree, 'scratch')
    tree = hooks.render(body, { sessionId: 'session-42' })
    eq('mirror: picking from the dropdown re-arms the poll with that session in the URL',
      [sessionGets().length - shotsBefore, sessionGets().at(-1)?.url], [1, SCREEN + '?session=scratch'])
    const scratchShot = {
      ...shot, session: 'scratch', lineCount: 1,
      screen: 'me@lan-box:/srv $ tmux ls\nscratch: 2 windows (created now)',
    }
    planResponse(200, scratchShot)
    await settle()
    tree = hooks.render(body, { sessionId: 'session-42' })
    eq('mirror: the picked session is the one on screen', textOf(find(tree, 'pre')), scratchShot.screen)
    eq('mirror: and the dropdown shows the picked session', chosen(tree), 'scratch')
    eq('mirror: the selection moved to the row now being shot',
      [mirroredRow(tree, 'scratch'), mirroredRow(tree, 'default')], [true, false])
    eq('mirror: exactly one row claims to be on screen', marked(), 1)
    check('mirror: and the summary line says the shot is pinned',
      textOf(tree).includes('正在镜像：会话 scratch · 已钉住'), textOf(tree).slice(0, 300))

    // 选回第一项（「跟随…」）就退回「跟着主机走」。
    const plainBefore = plainGets().length
    pick(tree, '')
    tree = hooks.render(body, { sessionId: 'session-42' })
    eq('mirror: going back makes the poll ask the host again', plainGets().length, plainBefore + 1)
    planResponse(200, shot)
    await settle()
    tree = hooks.render(body, { sessionId: 'session-42' })
    eq('mirror: and the host\'s own session is back on screen', textOf(find(tree, 'pre')), shot.screen)
    eq('mirror: going back is following again, and both the dropdown and the row say so',
      [chosen(tree), mirroredRow(tree, 'default')], ['', true])

    // 换服务器就丢掉钉住的那个名字：新服务器上多半根本没有这个会话。
    pick(tree, 'scratch')
    tree = hooks.render(body, { sessionId: 'session-42' })
    planResponse(200, scratchShot)
    await settle()
    const plainAfter = plainGets().length
    find(tree, 'select').props.onChange({ target: { value: 'me' } })
    tree = hooks.render(body, { sessionId: 'session-42' })
    // activate 的 POST 先入队，随后才是那次「跟着主机走」的 GET —— 按同一顺序回答。
    planResponse(200, panelPayload)
    planResponse(200, shot)
    await settle()
    eq('mirror: switching servers drops the pin',
      [sessionGets().at(-1).url, plainGets().length - plainAfter], [SCREEN + '?session=scratch', 1])
    eq('mirror: and the dropdown is back on the follow option', chosen(tree), '')

    // 宿主说不出"当前连接"时（payload 的 `active === null`：换主机的间隙、或宿主侧还是
    // 启动时那份旧代码），屏幕那一侧仍然照着一个会话 —— 那时"跟着谁"只能听**屏幕自己
    // 回报的那个名字**。旧写法在这里把 `hostSession` 算成 null，于是摘要写成
    // 「正在镜像：会话 （主机还没报出会话名）」，而下面那块屏明明在照 default。
    {
      const panelTick = timersOf(5000)[0][1].fn
      const running = panelTick()
      planResponse(200, { ...panelPayload, source: 'cli-config', active: null })
      await running
      await settle()
      tree = hooks.render(body, { sessionId: 'session-42' })

      check('fallback: with no active connection the summary still names the session on screen',
        textOf(tree).includes('正在镜像：会话 default · 跟随宿主默认'), textOf(tree).slice(0, 300))
      check('fallback: and the follow option says it follows the host default',
        textOf(sessionSelect(tree)).includes('跟随宿主默认 · default'), textOf(sessionSelect(tree)).slice(0, 300))
      eq('fallback: that session\'s row is still the one marked as being shot',
        [chosen(tree), mirroredRow(tree, 'default')], ['', true])

      // 把 payload 摆回"有当前连接"，别把这个状态留给后面的区块。
      const restored = panelTick()
      planResponse(200, panelPayload)
      await restored
      await settle()
      tree = hooks.render(body, { sessionId: 'session-42' })
      check('fallback: back to a named connection, and the summary says so again',
        textOf(tree).includes('正在镜像：会话 default · 跟随当前连接'), textOf(tree).slice(0, 300))
    }
  }
}

// --- 枚举失败：退回 GET 给出的那一行，并**单独**说明 ------------------
{
  // 切换主机会立刻重取一次列表，让那一次以网络错误告终。
  planListNetworkError('list exploded')
  find(tree, 'select').props.onChange({ target: { value: 'me' } })
  await settle()
  planResponse(200, panelPayload)
  await settle()
  tree = hooks.render(body, { sessionId: 'session-42' })
  check('list: a failed enumeration says so, in its own strip',
    textOf(tree).includes('列出远端会话失败：list exploded'), textOf(tree).slice(0, 400))
  check('list: it does NOT blame the mirror', !textOf(tree).includes('connect ECONNREFUSED'), textOf(tree).slice(0, 400))
  check('list: and the row it already had survives', textOf(tree).includes('会话 default'), textOf(tree).slice(0, 300))
  check('list: a session it cannot vouch for is not claimed to exist', !textOf(tree).includes('会话 scratch'), textOf(tree).slice(0, 300))
  planList()
}

// --- 什么都没配置：面板**说出来**，而不是变成一张表单 ----------------
{
  const panelTick = timersOf(5000)[0][1].fn
  const before = gets(SCREEN).length
  const running = panelTick()
  planResponse(200, { ok: true, source: 'none', active: null, profiles: [], file: '/tmp/connections.json', defaultSession: 'default', sessions: [] })
  await running
  await settle()
  tree = hooks.render(body, { sessionId: 'session-42' })

  eq('empty: with nothing configured the mirror stops entirely', timersOf(2000).length, 0)
  eq('empty: and it opens no further SSH connection', gets(SCREEN).length, before)
  eq('empty: the panel is NOT a second copy of the settings form', findAll(tree, 'input').length, 0)
  check('empty: it says so', textOf(tree).includes('还没有可用的远端连接'), textOf(tree).slice(0, 240))
  check('empty: it points at the settings page', textOf(tree).includes('设置 → visible-ssh'), textOf(tree).slice(0, 400))
  check('empty: it names the file it manages', textOf(tree).includes('/tmp/connections.json'), textOf(tree).slice(0, 400))
  eq('empty: the status line says there is no connection yet', textOf(findAll(tree, 'div')[1]).includes('未配置远端连接'), true)

  // 把主机放回去，好让下面的区块从一个已配置好的面板开始。
  const restored = panelTick()
  planResponse(200, panelPayload)
  await restored
  await settle()
  // 恢复配置会在**下一次**渲染时重启镜像，那会触发一次 tick——effect 是在
  // render() 里跑的，所以响应必须在 render 之后再预备。
  hooks.render(body, { sessionId: 'session-42' })
  planResponse(200, shot)
  await settle()
  eq('empty: configuring again resumes the mirror', timersOf(2000).length, 1)
}

// --- 设置区块：表单的**唯一**一份拷贝 -----------------------------
{
  const mirrorTimers = timersOf(2000).length
  const configGets = gets(CONNECTION).length
  // 这一次渲染只为了副作用：effect 会去读连接路由（下面那条 eq 测的就是它），
  // 返回值随后会被下一次渲染覆盖，所以不做赋值。
  hooks.render(section, {}, 'section')
  let sectionTree
  eq('section: mounting it reads the connection route, not the panel route', [gets(CONNECTION).length, gets(SESSIONS).length], [configGets + 1, gets(SESSIONS).length])
  eq('section: it never starts mirror polling', timersOf(2000).length, mirrorTimers)
  planResponse(200, { ok: true, source: 'none', active: null, file: '/tmp/connections.json', defaultSession: 'default', profiles: [] })
  await settle()
  sectionTree = hooks.render(section, {}, 'section')
  check('section: it is where the form lives now', findAll(sectionTree, 'input').length >= 5, findAll(sectionTree, 'input').length)
  check('section: it explains what it configures', textOf(sectionTree).includes('visible-ssh'), textOf(sectionTree).slice(0, 200))
  // 这个控件只有在 canClose 为真时才会渲染，而本来唯一可能这样调用的面板
  // 已经不再承载表单了。在**源码**里断言它不存在，它才真的回不来；只在
  // 某一次渲染里断言，会空洞地通过。
  check('section: the dead "back to the mirror" control is gone for good', !source.includes('返回屏幕'), null)

  const inputs = findAll(sectionTree, 'input')
  inputs[0].props.onChange({ target: { value: 'lan-box.local' } })
  inputs[2].props.onChange({ target: { value: 'me' } })
  inputs[3].props.onChange({ target: { value: 'a-secret' } })
  sectionTree = hooks.render(section, {}, 'section')
  buttonNamed(sectionTree, '保存').props.onClick()
  await settle()
  const saved = JSON.parse(posts().at(-1).options.body)
  eq('section: saving sends the typed profile and password', [saved.action, saved.profile.host, saved.profile.user, saved.password], ['save', 'lan-box.local', 'me', 'a-secret'])
  planResponse(200, overview)
  await settle()
  sectionTree = hooks.render(section, {}, 'section')
  check('section: the save is acknowledged in place', textOf(sectionTree).includes('已保存'), textOf(sectionTree).slice(0, 240))
  check('section: the profile is listed afterwards', textOf(sectionTree).includes('me@lan-box.local'), textOf(sectionTree).slice(0, 300))

  // 这些控件现在只存在于表单里，所以它们的覆盖也放在这里：测试会报出引擎
  // 的回答，而一次编辑会保住那份密码。
  buttonNamed(sectionTree, '测试').props.onClick()
  await settle()
  eq('section: test asks for that profile', JSON.parse(posts().at(-1).options.body), { action: 'test', id: 'me' })
  planResponse(200, { ok: true, test: { ok: true, session: 'default', exists: false, lastLine: null, configPath: 'host.toml' } })
  await settle()
  sectionTree = hooks.render(section, {}, 'section')
  check('section: a passing test is reported in words', textOf(sectionTree).includes('连上了'), textOf(sectionTree).slice(0, 300))

  buttonNamed(sectionTree, '编辑').props.onClick()
  sectionTree = hooks.render(section, {}, 'section')
  check('section: editing does not pre-fill the secret', findAll(sectionTree, 'input').every((input) => input.props.type !== 'password' || input.props.value === ''), null)
  buttonNamed(sectionTree, '保存修改').props.onClick()
  await settle()
  const editPost = JSON.parse(posts().at(-1).options.body)
  check('section: an edit keeps the stored password (field omitted)', !('password' in editPost), editPost)
  planResponse(200, overview)
  await settle()
  sectionTree = hooks.render(section, {}, 'section')
  check('section: the edit is acknowledged too', textOf(sectionTree).includes('已保存'), textOf(sectionTree).slice(0, 240))
}

// --- 设置区块：本机 ssh 配置里那些远端（只读候选） -------------------
// 宿主把 `~/.ssh/config` 解析成候选清单塞进连接那份响应；客户端只负责列出来、
// 让人一键填进表单。这里用假的响应证明：列得出来、填得进去、**从不去读那个文件**。
{
  const aliases = {
    path: 'C:/Users/x/.ssh/config',
    hosts: [
      { alias: 'box', hostName: '10.0.0.9', user: 'ops', port: 2222, identityFile: 'C:/Users/x/.ssh/k' },
      { alias: 'plain', hostName: 'plain', user: null, port: null, identityFile: null },
    ],
    error: null,
  }
  const overviewWith = (sshConfig) => ({
    ok: true, source: 'none', active: null, file: '/tmp/connections.json', defaultSession: 'default', profiles: [], sshConfig,
  })
  // 设置区块那个 effect 的 deps 是空的：一个实例只为它读一次路由。替身里换一个
  // root 就是换一个实例，所以第一份配置这么喂进去；后两份走它自己那条 5 秒
  // 轮询，也就是真实世界里配置更新的路径。
  const SSH_ROOT = 'section-ssh'
  const timersBefore = new Set(timers.live.keys())
  hooks.render(section, {}, SSH_ROOT)
  const poller = [...timers.live.entries()].find(([id]) => !timersBefore.has(id))
  check('ssh: mounting the section arms its own 5s re-read', poller !== undefined && poller[1].ms === 5000, timersOf(5000).length)
  const reread = poller[1].fn

  planResponse(200, overviewWith(aliases))
  await settle()
  let tree = hooks.render(section, {}, SSH_ROOT)
  check('ssh: the candidates are listed with the file they came from', textOf(tree).includes('本机 ssh 配置里的远端（2 条）') && textOf(tree).includes('C:/Users/x/.ssh/config'), textOf(tree).slice(0, 300))
  check('ssh: a row shows the alias, the user@host and the port', textOf(tree).includes('box — ops@10.0.0.9:2222'), textOf(tree).slice(0, 400))
  check('ssh: a row with no HostName falls back to the alias itself', textOf(tree).includes('plain — plain:22'), textOf(tree).slice(0, 400))
  check('ssh: it says the ssh config is never written to', textOf(tree).includes('绝不改你的 ssh 配置'), textOf(tree).slice(0, 600))

  buttonNamed(tree, '填入').props.onClick()
  tree = hooks.render(section, {}, SSH_ROOT)
  check('ssh: filling says where the alias will expand to', textOf(tree).includes('ssh 会展开成 10.0.0.9'), textOf(tree).slice(0, 400))
  buttonNamed(tree, '保存').props.onClick()
  await settle()
  const filled = JSON.parse(posts().at(-1).options.body)
  eq('ssh: the alias goes in as the host, not the IP ssh would expand it to', [filled.profile.host, filled.profile.user, filled.profile.port, filled.profile.label], ['box', 'ops', 2222, 'box'])

  // 空清单与读不动都要说清是什么情况，而不是一声不吭。第一次借保存的回复
  // 送回来（保存的回复本来就是新的 config），第二次走那一格轮询。
  planResponse(200, overviewWith({ path: 'C:/Users/x/.ssh/config', hosts: [], error: null }))
  await settle()
  tree = hooks.render(section, {}, SSH_ROOT)
  check('ssh: an empty list explains itself instead of looking broken', textOf(tree).includes('没有读到可用的 Host 段'), textOf(tree).slice(0, 400))
  void reread()
  planResponse(200, overviewWith({ path: 'C:/Users/x/.ssh/config', hosts: [], error: 'EACCES: permission denied' }))
  await settle()
  tree = hooks.render(section, {}, SSH_ROOT)
  check('ssh: a file it cannot read is reported, not swallowed', textOf(tree).includes('EACCES: permission denied'), textOf(tree).slice(0, 400))

  // 「刷新」：那一圈 5 秒轮询只够「迟早能看到」，这一格按钮是人刚在别处改完磁盘上
  // 那份文件、想立刻确认插件已经看见的把手。它做的事**只**是再读一次同一个路由。
  const readsBefore = gets(CONNECTION).length
  const refresh = buttonNamed(tree, '刷新')
  check('ssh: the section offers an on-demand re-read', refresh !== null, findAll(tree, 'button').map((node) => textOf(node)))
  refresh.props.onClick()
  tree = hooks.render(section, {}, SSH_ROOT)
  check('ssh: while it is reading, the control says so', textOf(tree).includes('刷新中…'), textOf(tree).slice(0, 400))
  planResponse(200, overviewWith({
    path: 'C:/Users/x/.ssh/config',
    hosts: [{ alias: 'fresh', hostName: '10.1.1.1', user: 'me', port: 22, identityFile: null }],
    error: null,
  }))
  await settle()
  tree = hooks.render(section, {}, SSH_ROOT)
  eq('ssh: pressing it re-reads the route exactly once', gets(CONNECTION).length - readsBefore, 1)
  check('ssh: a Host block added seconds ago shows up without waiting for the next poll', textOf(tree).includes('fresh — me@10.1.1.1:22'), textOf(tree).slice(0, 400))
}
// --- 对话框里那格：服务器 ＋ 会话 ---------------------------------------------
// 「当前连接」的**第二个**落点，而且是它的两半：服务器那格写的是设置页「使用」
// 按钮的同一条 `activate`（换机器），会话那格写的是「AI 在这台机器上干活用的那个
// tmux 会话」（工具与镜像都读它）。两个下拉都只读那一份 GET，只有人动手才写；
// 于是三处（这里、设置页、面板）永远不会各说各话 —— 在别处换了，下一次轮询自己跟上。
//
// 会话**名**只能问远端要，而一次枚举＝一条 SSH 连接，所以它不挂在轮询上：只有挂载、
// 换机器、以及人点那个 ↻ 才读一次。下面用 `listPosts()` 的差值把这件事钉住。
const COMPOSER_ROOT = 'composer-root'
{
  const composerReads = gets(SESSIONS).length
  const listsBefore = listPosts().length
  const timersBefore = new Set(timers.live.keys())
  // 一台都没存过：那一格不占地方。空的下拉框只会看起来像坏了。
  planResponse(200, { ok: true, source: 'none', active: null, profiles: [], defaultSession: 'default', file: null, sessions: [] })
  let composerTree = hooks.render(composer, {}, COMPOSER_ROOT)
  eq('composer: nothing is drawn before the host answers', composerTree, null)
  const composerPoller = [...timers.live.entries()].find(([id]) => !timersBefore.has(id))
  check('composer: mounting it arms its own slow re-read', composerPoller !== undefined && composerPoller[1].ms === 5000, timersOf(5000).length)
  /**
   * 推进到「稳定」。这份替身和 React 一样是**先建树、再跑这次渲染排下的 effect**
   * （见 hooks.render 里 `expand` 与 `state.pending` 的先后），而且它不会自己重画。
   * 于是凡是「某个 effect 会再发一次请求」的状态变化（挂载后第一次读到当前连接、
   * 换了机器）都得再渲染一轮才看得见结果。
   */
  const repaint = async () => {
    await settle()
    composerTree = hooks.render(composer, {}, COMPOSER_ROOT)
    await settle()
    composerTree = hooks.render(composer, {}, COMPOSER_ROOT)
  }
  await repaint()
  eq('composer: with nothing saved it draws nothing at all', composerTree, null)
  eq('composer: it reads the same route the panel reads', gets(SESSIONS).length - composerReads, 1)
  eq('composer: and with no host it enumerates no sessions', listPosts().length - listsBefore, 0)

  // 两份载荷：同一对机器，只是「当前」换了一台。
  const hosts = [
    { id: 'me', label: 'LAN box', target: 'me@lan-box.local:22' },
    { id: 'edge', label: 'Edge', target: 'me@edge.local:22' },
  ]
  const pickerPayload = (activeId, session = 'default') => ({
    ok: true,
    source: 'profile',
    active: activeId === null ? null : {
      id: activeId,
      label: activeId === 'me' ? 'LAN box' : 'Edge',
      target: activeId === 'me' ? 'me@lan-box.local:22' : 'me@edge.local:22',
      session,
    },
    profiles: hosts.map((entry) => ({ ...entry, session, active: entry.id === activeId })),
    defaultSession: 'default',
    file: 'C:/Users/x/visible-ssh/connections.json',
    sessions: activeId === null ? [] : [{ name: session, exists: null }],
  })
  const composerTick = composerPoller[1].fn
  /** 两个下拉，按渲染顺序：服务器在前、会话在后。 */
  const selects = (tree) => findAll(tree, 'select')
  const optionsOf = (node) => findAll(node, 'option').map((option) => textOf(option))

  void composerTick()
  planResponse(200, pickerPayload('edge'))
  await repaint()
  composerTree = hooks.render(composer, {}, COMPOSER_ROOT)
  eq('composer: the cell is two selects — server, then session', selects(composerTree).length, 2)
  const serverSelect = selects(composerTree)[0]
  const sessionSelect = selects(composerTree)[1]
  eq('composer: the server options name every saved server', optionsOf(serverSelect),
    ['LAN box — me@lan-box.local:22', 'Edge — me@edge.local:22'])
  eq('composer: it shows the current connection, not the first row', serverSelect.props.value, 'edge')
  check('composer: the tooltip says this is the connection the AI will use',
    String(serverSelect.props.title).includes('当前连接'), serverSelect.props.title)
  eq('composer: the session options are the ones the host enumerated', optionsOf(sessionSelect), ['default', 'scratch'])
  eq('composer: the session dropdown sits on the session the AI is on now', sessionSelect.props.value, 'default')
  check('composer: its tooltip says this is the session the AI works in',
    String(sessionSelect.props.title).includes('干活'), sessionSelect.props.title)
  eq('composer: reading the host list is free, so it is one enumeration after the host answers',
    listPosts().length - listsBefore, 1)

  // 在人手底下换机器：一次 POST，然后**重新读一遍**（不猜）。写的是会话路由 ——
  // 那条路由回来的就是这份 payload 的形状（`active` 是对象、每行带 `target`），
  // 一次往返就能重画，不必再问一次。
  const postsBefore = posts().length
  const listsBeforeSwitch = listPosts().length
  serverSelect.props.onChange({ target: { value: 'me' } })
  composerTree = hooks.render(composer, {}, COMPOSER_ROOT)
  eq('composer: while the host is switching, the server control is locked', selects(composerTree)[0].props.disabled, true)
  const switchPost = posts()[posts().length - 1]
  eq('composer: switching is one activate POST on the sessions route',
    [posts().length - postsBefore, switchPost.url, JSON.parse(switchPost.options.body)],
    [1, SESSIONS, { action: 'activate', id: 'me' }])
  planResponse(200, pickerPayload('me'))
  await repaint()
  eq('composer: the answer re-seats the control on the new current', selects(composerTree)[0].props.value, 'me')
  eq('composer: and it is usable again', selects(composerTree)[0].props.disabled, false)
  eq('composer: another machine means another session list — it re-enumerates once',
    listPosts().length - listsBeforeSwitch, 1)

  // 选中的就是当前那台：不必打扰宿主。
  const settled = posts().length
  selects(composerTree)[0].props.onChange({ target: { value: 'me' } })
  eq('composer: picking what is already current sends nothing', posts().length - settled, 0)

  // 换会话：一次 POST，回到来的 payload 重画。它改的是 AI 干活用的那个会话，
  // 与面板里那个「会话」下拉（只改这一格屏幕照谁）是两件事。
  const beforeSession = posts().length
  selects(composerTree)[1].props.onChange({ target: { value: 'scratch' } })
  composerTree = hooks.render(composer, {}, COMPOSER_ROOT)
  eq('composer: while the switch is in flight the session control says how it is doing',
    [selects(composerTree)[1].props.disabled, String(selects(composerTree)[1].props.title).includes('正在枚举')],
    [true, true])
  const sessionPost = posts()[posts().length - 1]
  eq('composer: changing the session is one POST with the chosen name',
    [posts().length - beforeSession, sessionPost.url, JSON.parse(sessionPost.options.body)],
    [1, SESSIONS, { action: 'session', session: 'scratch' }])
  planResponse(200, pickerPayload('me', 'scratch'))
  await repaint()
  eq('composer: the answer re-seats the session dropdown on the new session', selects(composerTree)[1].props.value, 'scratch')
  eq('composer: and the session dropdown is usable again', selects(composerTree)[1].props.disabled, false)

  // 远端这一轮没提当前那个会话（它可能刚被人改名、或正开着）——它仍然得在清单里，
  // 否则下拉的 `value` 会落到不存在的 option 上，显示成空白。这也顺带钉住那个 ↻：
  // 会话清单**不**跟着 5 秒轮询走，因为一次枚举＝一条 SSH 连接。
  const refreshButton = buttonNamed(composerTree, '↻')
  check('composer: the session list has its own refresh, because reading it costs an SSH login',
    refreshButton !== null, textOf(composerTree))
  const listsBeforeRefresh = listPosts().length
  planList(200, {
    ok: true, session: 'scratch', exists: true,
    sessions: [{ name: 'default', attached: 1, windows: 1, current: false }],
  })
  refreshButton.props.onClick()
  await repaint()
  eq('composer: pressing it enumerates exactly once', listPosts().length - listsBeforeRefresh, 1)
  eq('composer: the current session stays on the list even when the remote did not name it',
    optionsOf(selects(composerTree)[1]), ['scratch', 'default'])
  eq('composer: so the dropdown still shows a real option', selects(composerTree)[1].props.value, 'scratch')
  planList()

  // 在别处换了（设置页、面板、别的人）：下一次轮询自己跟上，而且**顺手**换掉会话清单。
  const listsBeforePoll = listPosts().length
  void composerTick()
  planResponse(200, pickerPayload('edge'))
  await repaint()
  eq('composer: a switch made elsewhere arrives on the next poll', selects(composerTree)[0].props.value, 'edge')
  eq('composer: and that new machine gets its own session list', listPosts().length - listsBeforePoll, 1)

  // 读失败**要说**，而不是把旧列表继续当真的画下去。
  void composerTick()
  planNetworkError('route exploded')
  await repaint()
  check('composer: a failing read says so instead of silently freezing',
    String(selects(composerTree)[0].props.title).includes('route exploded'),
    selects(composerTree)[0].props.title)
}

// --- 卸载 ------------------------------------------------------------------
hooks.unmount()
eq('unmount: the timers are cleared', timers.live.size, 0)
eq('unmount: the visibility listener is detached', listeners.size, 0)

for (const dispose of disposers) dispose()
check('unload: both registrations were undone', calls.filter((c) => c.startsWith('dispose')).length >= 2, calls.slice(-4))

delete globalThis.document

// --- 汇报 ------------------------------------------------------------------
const failed = results.filter((entry) => !entry.ok)
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed,
  verdict: failed.length === 0 ? 'OK: the mirror, the panel actions and the settings form behave as documented' : 'FAILURES above',
}, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
