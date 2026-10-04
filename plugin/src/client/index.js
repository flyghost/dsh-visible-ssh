/**
 * dsh-visible-ssh —— client half（浏览器侧）。
 *
 * 刻意手写：没有打包器、没有 TypeScript。它只有一步「逐字拷贝」（`plugin/scripts/`
 * `copy-client.mjs`）把它送到 `lib/client/index.js` —— 宿主加载的是那一份，源码这份
 * 不参与任何编译。DSH 的客户端模块系统会原样提供包的
 * `exports["./client"]` 文件，只要求它通过 `window.__ModuleLoader__.load`
 * 注册一个惰性 CJS 工厂；工厂里的 `require` 针对 shell 冻结的平台表解析
 * （react / react-dom / cordis / ui-slots / ui-primitives）。source map 是
 * 可选的（「缺少 map 不会阻止插件执行」，`@deepseek-ai/dsh-client-modules` 自己的
 * `lib/index.js:223`——**那是别人的包**，与本包的 `src/` 无关）。
 * 所以真实插件需要构建才能得到的一切 —— JSX、TypeScript、CSS modules ——
 * 这里都绕开而不是去编译：用 `React.createElement` 代替 JSX，用行内样式
 * 代替 CSS modules。
 *
 * 三件事，一个 panel，外加对话框里的一格：
 *
 *   1. **选择器**。`GET /visible-ssh/sessions`（见 `src/routes/index.ts` —— 这里的
 *      路径字面量重复了一份，因为浏览器 bundle 无法 import 宿主模块）给出
 *      当前生效的 host、选择器可以切换过去的其他 host，以及 session 行。
 *      它是宿主上的**本地**读取 —— session 是否存在本来就由下面的镜像回答
 *      —— 所以轮询很便宜。
 *   2. **两个动作**。同一个路由上的 `POST` 打开人旁观的那个窗口（引擎自己的
 *      `watch` verb），或者杀掉 session（`down`）。client half 绝不拼 ssh
 *      命令行，也绝不看见密码。
 *   3. **镜像**。`GET /visible-ssh/screen` 渲染状态行加上可见屏幕。页面被隐藏
 *      时以及未配置 host 时轮询都会停止，因为每次轮询在宿主上都要花掉一条
 *      SSH 连接。
 *
 * 连接**表单**刻意**不**属于 panel：编辑 host 该待在别的设置都在的地方
 * （设置 → visible-ssh）。它是同一个组件，由本文件底部的 settings section
 * 承载，而密码依然单向流动 —— 宿主绝不把它发回来，所以该字段永远是空的，
 * 「留空即保持已保存的那个」就是编辑路径。
 *
 * 对话框里那一格（`conversation.input.left`）是同一个「当前连接」的**第二个**
 * 落点，而且是它的两半：它只列设置里存过的那些连接，选中即换机器（与设置页的
 * 「使用」是同一次写入），旁边那格换的是**当前连接干活用的 tmux 会话**（工具与
 * 镜像都读它，除非人在 panel 里钉住了别的会话）。两处永远不会各说各话，人也不必
 * 为了换一台机器离开对话。它落在输入框**下面那一排**的左半边（紧挨着「工作区内
 * 修改」那个下拉），就是 `conversation.input.left` 这个 list 槽位。
 *
 * 值得留下的决策：
 *
 *   * **滚动位置归 pane 所有，不归这个组件**。只有读者本来就在底部时，新输出
 *     才贴住底部，所以往上翻着读不会被下一个 tick 拽回去。
 *   * **镜像在知道自己镜像的是哪台机器之前不轮询**。连接概览是一次本地文件
 *     读取（不走 SSH），在未配置的情况下等它，能省掉每次打开 panel 的一次
 *     无意义 capture。
 *   * **这里没有任何东西是真相来源**。每个答案都来自宿主：profile 列表、当前
 *     生效的是哪一个、以及是不是 CLI 自己的 host.toml 在提供服务。保存是重新
 *     读一遍，而不是猜。
 */
window.__ModuleLoader__.load({
  id: 'dsh-visible-ssh',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** 我们的页面标签占用的 kind。绝不能与内置 kind 撞车。 */
    const KIND = 'visible-ssh:console'
    /** 唯一的实现 id（better-sidebar 用的是 `dsh-better-sidebar:<id>`）。 */
    const ID = 'dsh-visible-ssh:console'
    /** 这个 panel 用来轮询 pane 的宿主路由。与 `src/routes/index.js` 保持同步。 */
    const SCREEN_ENDPOINT = '/visible-ssh/screen'
    /** 连接信息读写所经过的宿主路由。同一份契约。 */
    const CONNECTION_ENDPOINT = '/visible-ssh/connection'
    /** 主机选择器与 session 行所作用的宿主路由。 */
    const SESSIONS_ENDPOINT = '/visible-ssh/sessions'
    /** 镜像的轮询间隔，单位毫秒。见上面的 SSH 成本说明。 */
    const POLL_MS = 2000
    /** 连接概览的轮询间隔：本地文件读取，不走 SSH。 */
    const CONNECTION_POLL_MS = 5000
    /**
     * 一次取屏在自己这一侧最多算多久。
     *
     * 宿主侧也有超时，但那不能救这一条轮询：一条**永远不回答**的请求（ssh 卡在
     * 认证提示上、宿主进程被冻住）会把 `inFlight` 留在 true，从此一次都不再发请求
     * ——面板于是永远停在"还没读到"上。所以越过这个时限，我们自己判它死了：中止它、
     * 把这次失败说出来，下一次 tick 照常再发。
     */
    const FETCH_TIMEOUT_MS = 20000
    /** 距底部多近仍算「读者还在跟着看」。 */
    const STICK_SLACK_PX = 24

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    const LIVE_COLOR = '#3fb950'
    const STALE_COLOR = '#d29922'
    const PAUSED_COLOR = 'rgba(127,127,127,0.6)'
    const INPUT_STYLE = {
      border: '1px solid rgba(127,127,127,0.35)', borderRadius: '4px', background: 'transparent',
      color: 'inherit', font: 'inherit', fontSize: '12px', padding: '3px 6px', minWidth: 0, width: '100%',
      boxSizing: 'border-box',
    }
    const BUTTON_STYLE = {
      border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
      borderRadius: '4px', cursor: 'pointer', fontSize: '12px', lineHeight: '18px', padding: '1px 8px',
    }
    /** panel 两步杀掉的第二步：要肉眼可见地不是第一次点击。 */
    const DANGER_STYLE = {
      ...BUTTON_STYLE, borderColor: 'rgba(248,81,73,0.7)', color: '#f85149',
    }
    /** 屏幕正照着的那个会话那一行：它是一块屏幕，不是一次动作，所以画成"已选中"。
     *  它只用在行容器上，所以只借颜色与边框，别把按钮的内边距也套上去。 */
    const MIRRORED_ROW_STYLE = {
      borderColor: 'rgba(63,185,80,0.7)', color: LIVE_COLOR, background: 'rgba(63,185,80,0.06)',
    }
    /** 主机选择器：形状和 input 一样，但它必须不能拉伸。 */
    const SELECT_STYLE = {
      ...INPUT_STYLE, width: 'auto', maxWidth: '180px', padding: '1px 4px', cursor: 'pointer',
    }
    /** panel 是密排的，所以它那两格的下拉保持 12px；对话框那一排的邻居是 13px/20px 的
     *  按钮（「工作区内修改」）与 14px 的输入框 —— 同样的一格放进去就成了"不是一家人"，
     *  所以对话框单独用这一档规格（字族仍旧是继承来的那一套）。
     *  注意 `lineHeight` 这一条对原生 `<select>` 是**无效**的：Chromium 自己接管了它的
     *  文本盒，实测 computed style 仍报 `normal`（真宿主页面上量过）。真正把两者对齐的是
     *  字号 13px 与高度 24px —— `lineHeight` 留着是为了和同一档的按钮声明保持一致，
     *  别指望它去挪 select 里的那行字。 */
    const COMPOSER_CONTROL_STYLE = {
      ...INPUT_STYLE, width: 'auto', maxWidth: '160px', fontSize: '13px', lineHeight: '20px',
      height: '24px', padding: '0px 4px', cursor: 'pointer',
    }
    /** 对话框那一格的标签：比控件小一号，且别抢眼。 */
    const COMPOSER_LABEL_STYLE = { flex: '0 0 auto', fontSize: '12px', opacity: 0.55 }
    /** 重新枚举会话的那个小按钮：与两个下拉同高，方一点。 */
    const COMPOSER_REFRESH_STYLE = {
      ...BUTTON_STYLE, fontSize: '13px', lineHeight: '18px', height: '24px', padding: '0px 6px',
    }

    /** panel 能展示的一种失败：HTTP 状态加上宿主说的一切。 */
    function explainFailure(status, body) {
      const detail = body && body.error && body.error.message ? String(body.error.message) : ''
      const kind = body && body.error && body.error.kind ? String(body.error.kind) : ''
      if (status === 401 || status === 403) return '本机宿主拒绝了这次读取（未认证或 Host 不被信任）。'
      if (detail !== '') return kind === '' ? detail : kind + ': ' + detail
      return '请求失败（HTTP ' + status + '）。'
    }

    /** JSON 进，JSON 出，由一个地方决定失败长什么样。 */
    async function requestJson(url, options) {
      const response = await fetch(url, {
        headers: { accept: 'application/json', ...(options && options.body === undefined ? {} : { 'content-type': 'application/json' }) },
        cache: 'no-store',
        ...(options ?? {}),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body === null || body.ok !== true) {
        const failure = new Error(explainFailure(response.status, body))
        failure.status = response.status
        throw failure
      }
      return body
    }

    /** 屏幕上方那一行摘要。 */
    function statusText({ shot, error, paused, busy, at, unconfigured }) {
      const bits = []
      if (unconfigured) bits.push('未配置远端连接')
      else if (shot === null) bits.push('visible-ssh')
      else bits.push('session "' + shot.session + '"')
      if (shot !== null && shot.exists === true) {
        if (shot.width !== null && shot.height !== null) bits.push(shot.width + '×' + shot.height)
        if (shot.lineCount) bits.push(shot.lineCount + ' 行')
        if (shot.cursorX !== null && shot.cursorY !== null && shot.cursorX >= 0) {
          bits.push('cursor ' + shot.cursorX + ',' + shot.cursorY)
        }
      } else if (shot !== null && shot.exists !== true) {
        bits.push('不存在')
      }
      if (shot !== null && shot.connection) {
        if (shot.connection.source === 'profile') bits.push('→ ' + (shot.connection.label || shot.connection.target || shot.connection.id))
        else if (shot.connection.source === 'cli-config') bits.push('→ host.toml')
      }
      if (error !== null) bits.push('读取出错')
      else if (paused) bits.push('已暂停（页面在后台）')
      else if (busy) bits.push('读取中…')
      else if (!unconfigured) bits.push('每 ' + POLL_MS / 1000 + 's 刷新')
      if (at > 0) bits.push(new Date(at).toLocaleTimeString())
      return bits.join(' · ')
    }

    /**
     * 没有屏幕可展示时，`<pre>` 里显示什么。
     *
     * 这里**绝不返回空串**去代表"读不到"：空白的 `<pre>` 看起来只是"什么都没发生"，
     * 而真正的原因（连不上、认证被拒、配置缺密码、宿主 502）就在那次失败的话里。
     */
    function placeholder(shot, error) {
      if (shot === null) {
        if (error === null) return '正在读取远端 pane…'
        return '取屏失败：' + error + '\n'
          + '面板每 ' + POLL_MS / 1000 + 's 会自己再试一次；也可以按上面那个「↻」立刻重试。'
      }
      if (shot.exists !== true) {
        return 'tmux session "' + shot.session + '" 不存在。\n'
          + '点上面的「打开」会在本机弹出真终端并创建/接入它（attach-or-create），\n'
          + '也可以让模型调用 ssh_console_up。'
      }
      if (shot.screen === '') return '（这个 pane 的可见屏是空的）'
      return ''
    }

    /** 表单编辑的那份草稿；`id` 存在表示「更新这个 profile」。 */
    function blankDraft(config) {
      return {
        id: '',
        label: '',
        host: '',
        port: '22',
        user: '',
        session: config && config.defaultSession ? config.defaultSession : 'default',
      }
    }

    /** 一行带标签的输入项。 */
    function Field({ label, value, onChange, hint, type, placeholder, autoFocus }) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
        h('span', { style: { opacity: 0.7 } }, label),
        h('input', {
          type: type ?? 'text',
          value,
          placeholder: placeholder ?? '',
          onChange,
          autoFocus: autoFocus === true,
          spellCheck: false,
          autoComplete: 'off',
          style: INPUT_STYLE,
        }),
        hint === undefined ? null : h('span', { style: { opacity: 0.5, fontSize: '11px' } }, hint),
      )
    }

    /**
     * 连接表单：挑一个已保存的连接，或者填一个新的。
     *
     * 只由 settings section 渲染 —— panel 不再自带一份副本
     * （原因见 ConnectionSection）。
     */
    function ConnectionForm({ config, configError, onChanged, onReload = () => {}, reloading = false }) {
      const profiles = config === null ? [] : config.profiles
      const [draft, setDraft] = useState(() => blankDraft(config))
      const [password, setPassword] = useState('')
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)

      // 刻意用函数式更新：在 React 重新渲染之前改动的两个字段（一次粘贴触发
      // 两个 change 事件，或者一次测试连调两次 onChange）绝不能通过一个过期的
      // `draft` 闭包互相覆盖。
      const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }))
      const editingId = draft.id === '' ? null : draft.id
      const editing = profiles.find((profile) => profile.id === editingId) ?? null

      const act = async (label, payload) => {
        setBusy(label)
        setNotice(null)
        try {
          const body = await requestJson(CONNECTION_ENDPOINT, { method: 'POST', body: JSON.stringify(payload) })
          if (body.test !== undefined) {
            setNotice({
              ok: body.test.ok === true,
              text: body.test.ok === true
                ? '连上了：session "' + body.test.session + '" ' + (body.test.exists === true ? '已存在' : '不存在')
                  + (body.test.lastLine === null || body.test.lastLine === undefined ? '' : ' · ' + body.test.lastLine)
                : '连接失败：' + body.test.message,
            })
          } else {
            setNotice({ ok: true, text: '已保存到 ' + (body.file ?? '配置文件') })
            setPassword('')
            setDraft(blankDraft(body))
            onChanged(body)
          }
        } catch (reason) {
          setNotice({ ok: false, text: String((reason && reason.message) || reason) })
        } finally {
          setBusy(null)
        }
      }

      const save = () => act('save', {
        action: 'save',
        profile: { ...draft, port: draft.port === '' ? 22 : Number(draft.port) },
        // 字段为空表示「保持已存的那份」；一台从没存过密码的机器，不带这个字段就是
        // 「这台不用密码」（宿主仍然拒绝空字符串，所以绝不能发一个空值过去）。
        ...(password === '' ? {} : { password }),
      })
      const test = (id) => act('test', { action: 'test', ...(id === null ? {} : { id }) })
      const activate = (id) => act('activate', { action: 'activate', id })
      const remove = (id) => act('remove', { action: 'remove', id })

      // 「填入」= 把 ssh 配置里那个别名搬进表单。`host` 写**别名**而不是展开后的
      // HostName：ProxyJump、密钥、端口这些都得让 ssh 自己去解析，写死 IP 就把
      // 那些丢掉了。id 清空，于是保存出来的是一个新 profile（不覆盖正在编辑的）。
      const pick = (entry) => {
        setDraft((current) => ({
          id: '',
          label: entry.alias,
          host: entry.alias,
          port: String(entry.port === null ? 22 : entry.port),
          user: entry.user ?? '',
          session: current.session,
        }))
        setPassword('')
        setNotice({
          ok: true,
          text: '已把「' + entry.alias + '」填进下面（主机用别名，ssh 会展开成 ' + entry.hostName + '）'
            + (entry.identityFile === null
              ? '；有密码就填在密码那一格，没有就留空（本机 ~/.ssh 里的密钥照样生效）。'
              : '；密码那一格留空即可 —— ssh 会用 ' + entry.identityFile + '。'),
        })
      }

      const rowStyle = { display: 'flex', flexDirection: 'column', gap: '2px', padding: '5px 6px', border: '1px solid rgba(127,127,127,0.25)', borderRadius: '5px' }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'auto', minHeight: 0, flex: '1 1 auto', fontSize: '12px' } },
        h('div', { style: { opacity: 0.75 } },
          profiles.length === 0
            ? '还没有可用的远端连接。填下面几项保存后，这个面板就开始镜像那台主机的 tmux pane。'
            : '选择要镜像的连接，或修改下面几项后保存。'),
        configError === null ? null : h('div', { style: { color: STALE_COLOR } }, configError),
        config !== null && config.file !== undefined
          ? h('div', { style: { opacity: 0.45, fontFamily: MONO, fontSize: '11px', wordBreak: 'break-all' } }, '配置：' + config.file)
          : null,

        profiles.map((profile) => h(
          'div',
          { key: profile.id, style: rowStyle },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              profile.label + ' — ' + profile.user + '@' + profile.host + ':' + profile.port + ' · session ' + profile.session),
            config.active === profile.id
              ? h('span', { style: { color: LIVE_COLOR, flex: '0 0 auto' } }, '● 当前')
              : h('button', { type: 'button', style: BUTTON_STYLE, disabled: busy !== null, onClick: () => activate(profile.id) }, '使用'),
          ),
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', opacity: 0.9 } },
            h('span', { style: { flex: '1 1 auto', opacity: 0.55 } },
              profile.hasPassword ? '密码已保存（' + (profile.passwordStore === 'credentials' ? '凭据域' : '插件文件') + '）' : '没有保存密码：走本机 ~/.ssh 里的密钥'),
            h('button', { type: 'button', style: BUTTON_STYLE, disabled: busy !== null, onClick: () => test(profile.id) }, '测试'),
            h('button', {
              type: 'button',
              style: BUTTON_STYLE,
              disabled: busy !== null,
              onClick: () => { setDraft({ id: profile.id, label: profile.label, host: profile.host, port: String(profile.port), user: profile.user, session: profile.session }); setPassword(''); setNotice(null) },
            }, '编辑'),
            h('button', { type: 'button', style: BUTTON_STYLE, disabled: busy !== null, onClick: () => remove(profile.id) }, '删除'),
          ),
        )),

        h(SshHosts, { sshConfig: config === null ? undefined : config.sshConfig, onPick: pick, onReload, reloading }),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid rgba(127,127,127,0.25)', paddingTop: '8px' } },
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('div', { style: { flex: '2 1 0' } }, h(Field, { label: '主机', value: draft.host, onChange: set('host'), placeholder: '192.168.1.20 或 pi.local' })),
            h('div', { style: { flex: '1 1 0' } }, h(Field, { label: '端口', value: draft.port, onChange: set('port') })),
          ),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('div', { style: { flex: '1 1 0' } }, h(Field, { label: '用户名', value: draft.user, onChange: set('user'), placeholder: 'pi' })),
            h('div', { style: { flex: '1 1 0' } }, h(Field, {
              label: '密码',
              type: 'password',
              value: password,
              onChange: (event) => setPassword(event.target.value),
              placeholder: editing !== null && editing.hasPassword ? '留空 = 保持已保存的密码' : '可留空（走本机密钥的机器不需要）',
            })),
          ),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('div', { style: { flex: '1 1 0' } }, h(Field, { label: '显示名（可空）', value: draft.label, onChange: set('label'), placeholder: draft.host === '' ? '例：树莓派' : draft.user + '@' + draft.host })),
            h('div', { style: { flex: '1 1 0' } }, h(Field, { label: 'tmux 会话名', value: draft.session, onChange: set('session') })),
          ),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
            h('button', { type: 'button', style: BUTTON_STYLE, disabled: busy !== null, onClick: save }, busy === 'save' ? '保存中…' : (editing === null ? '保存' : '保存修改')),
            editing !== null
              ? h('button', { type: 'button', style: BUTTON_STYLE, disabled: busy !== null, onClick: () => test(editing.id) }, busy === 'test' ? '测试中…' : '测试连接')
              : h('span', { style: { opacity: 0.5 } }, '（先保存再测试）'),
            h('button', { type: 'button', style: BUTTON_STYLE, disabled: busy !== null, onClick: () => { setDraft(blankDraft(config)); setPassword(''); setNotice(null) } }, '清空'),
          ),
          notice === null ? null : h('div', { style: { color: notice.ok ? LIVE_COLOR : STALE_COLOR, wordBreak: 'break-word' } }, notice.text),
          h('div', { style: { opacity: 0.45, fontSize: '11px' } },
            '密码只写不读：宿主不会把它发回浏览器，也不会进模型上下文。留空即保持原值；'
            + '一台从没存过密码的机器就按「不用密码」处理 —— ssh 会拿本机 ~/.ssh 里的密钥去连。'),
        ),
      )
    }

    /**
     * 本机 `~/.ssh/config` 里已经配好的远端（宿主**只读**它，从不写）。
     *
     * 这一块存在的理由：引擎自己不解析 ssh 配置，是 ssh.exe 去读的 —— 所以
     * 「拿 ssh 里配好的那台机器来用」本来就是通的，缺的只是让人**看见**有哪些。
     * 点「填入」只动下面的表单：别名原样进 `host`，剩下的交给 ssh。
     *
     * 宿主**每次请求都现读磁盘**（不缓存），而我们自己那圈 5 秒轮询只够「迟早能看
     * 到」。右边那一格「刷新」就是为此存在的：人刚在别处改完 `~/.ssh/config`，想立刻
     * 确认插件已经看见。它只重读，什么都不写。
     */
    function SshHosts({ sshConfig, onPick, onReload, reloading }) {
      // 宿主还没答（或是个不懂这个字段的旧宿主）时什么都别画：这里既不是"没有
      // 家目录"也不是"没有别名"，那两种情形都由宿主用 `path: null` / 空清单说清。
      if (sshConfig === null || sshConfig === undefined) return null
      const hosts = sshConfig.hosts ?? []
      const path = sshConfig.path
      const error = sshConfig.error
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid rgba(127,127,127,0.25)', paddingTop: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { opacity: 0.75, flex: '1 1 auto' } }, '本机 ssh 配置里的远端' + (hosts.length === 0 ? '' : '（' + hosts.length + ' 条）')),
          h('button', {
            type: 'button',
            style: BUTTON_STYLE,
            disabled: reloading === true,
            title: '立刻重读一遍磁盘上的连接清单与 ~/.ssh/config（刚在别处改完文件时用）',
            onClick: () => onReload(),
          }, reloading === true ? '刷新中…' : '刷新'),
        ),
        path === null
          ? h('div', { style: { opacity: 0.5 } }, '这台机器没有可用的家目录，读不到 ~/.ssh/config —— 填下面的表单一样能用。')
          : h('div', { style: { opacity: 0.45, fontFamily: MONO, fontSize: '11px', wordBreak: 'break-all' } }, path),
        error === null ? null : h('div', { style: { color: STALE_COLOR, fontSize: '11px', wordBreak: 'break-word' } }, 'ssh 配置读取失败：' + error),
        hosts.length === 0 && path !== null
          ? h('div', { style: { opacity: 0.55 } }, '没有读到可用的 Host 段（文件不在，或里面只有通配段）。')
          : null,
        hosts.map((entry) => h(
          'div',
          { key: entry.alias, style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            entry.alias + ' — ' + (entry.user === null || entry.user === '' ? '' : entry.user + '@') + entry.hostName + ':' + (entry.port === null ? 22 : entry.port)
              + (entry.identityFile === null ? '' : ' · 密钥 ' + entry.identityFile)),
          h('button', { type: 'button', style: BUTTON_STYLE, onClick: () => onPick(entry) }, '填入'),
        )),
        h('div', { style: { opacity: 0.45, fontSize: '11px', lineHeight: '1.4' } },
          '「填入」只写进下面的表单，绝不改你的 ssh 配置；别名原样进「主机」，展开成 IP、挑密钥这些仍是 ssh 自己做。'
          + '密码那一格「可以留空」：上面写了「密钥 …」的那几台根本不需要密码，ssh 会自己拿那把密钥去连；真需要密码的机器才填。'),
      )
    }

    /**
     * 连接表单，由设置页承载。
     *
     * 它是这个表单**唯一**的副本。panel 过去在一个「连接」按钮后面还带着第二
     * 份，那意味着同一个 host 有两个地方可编辑，而且未配置的部署不管读者想不
     * 想要，都会直接落在一个表单上。现在编辑发生在别的设置都在的地方
     * （设置 → visible-ssh，与「通用设置」和「模型」在同一个导航列表里），而
     * panel 对未配置的部署的做法是**直说**，并指到这里。
     *
     * 状态是局部的，按与 panel 自己那份 payload 相同的慢节奏从宿主重读，所以在
     * 这里保存会在一两个 tick 内出现在 panel 里。没有需要维护一致性的共享存储：
     * 宿主始终是唯一的真相来源。
     */
    function ConnectionSection() {
      const [config, setConfig] = useState(null)
      const [configError, setConfigError] = useState(null)
      const [reloading, setReloading] = useState(false)
      // 那一圈 5 秒轮询之外还留一个「立刻重读」的把手：effect 里那个 load 被记进
      // 这个 ref，按钮直接调它。用 ref 而不是把它提到外面，是为了不动 effect 那个
      // 空依赖数组 —— 那份清单的真相来源永远是宿主，重挂载就等于重读。
      const loadRef = useRef(null)
      const liveRef = useRef(true)

      useEffect(() => {
        liveRef.current = true
        const load = async () => {
          try {
            const body = await requestJson(CONNECTION_ENDPOINT)
            if (!liveRef.current) return
            setConfigError(null)
            setConfig(body)
          } catch (reason) {
            if (!liveRef.current) return
            setConfigError(String((reason && reason.message) || reason))
          }
        }
        loadRef.current = load
        void load()
        const timer = setInterval(load, CONNECTION_POLL_MS)
        return () => { liveRef.current = false; loadRef.current = null; clearInterval(timer) }
      }, [])

      // 人点的那一下：立刻重读一次，按钮上显示正在读。轮询还在跑，所以即使这一下
      // 失败，5 秒后也会自己再试；失败照旧由 configError 那一条说。
      const reload = () => {
        const load = loadRef.current
        if (load === null || reloading) return
        setReloading(true)
        void load().finally(() => { if (liveRef.current) setReloading(false) })
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px', fontFamily: 'inherit', fontSize: '13px' } },
        h('div', { style: { opacity: 0.75, lineHeight: '1.5' } },
          '这台机器连到哪台远端主机、用哪个 tmux 会话。这里保存的连接，就是右侧栏「visible-ssh」面板与 7 个远端工具正在用的那一条。'),
        h(ConnectionForm, { config, configError, onChanged: setConfig, onReload: reload, reloading }),
      )
    }

    /**
     * 标签页主体：哪台 host、哪些 session，以及所展示那一个的镜像。
     *
     * 屏幕**一次只照一个**会话（一次 capture 就是一条 SSH 连接），但那个会话由人
     * 在列出来的那些行里挑 —— 每行那个「镜像」把屏幕切过去，没挑过就跟着当前主机
     * 自己那个会话走。
     *
     * 过去住在这里的表单是刻意移走的。编辑 host 该待在别的设置都在的地方，
     * 所以这个 panel 永远只是一个**选择器**加上插件存在的理由 —— 人能看到的那块
     * 屏幕。
     */
    function RemotePaneTab(props) {
      const sessionId = props && props.sessionId ? props.sessionId : null
      const [shot, setShot] = useState(null)
      const [error, setError] = useState(null)
      const [at, setAt] = useState(0)
      const [busy, setBusy] = useState(false)
      const [paused, setPaused] = useState(false)
      const [panel, setPanel] = useState(null)
      const [panelError, setPanelError] = useState(null)
      const [listed, setListed] = useState(null)
      const [listError, setListError] = useState(null)
      const [acting, setActing] = useState(null)
      const [notice, setNotice] = useState(null)
      const [confirming, setConfirming] = useState(null)
      /**
       * 人手工钉住要镜像的那个会话；`null` ＝ 跟着当前主机自己的会话走。
       *
       * 这是「一块屏幕 + 一个选择器」的全部状态：屏幕永远只镜像**一个**会话（一次
       * capture ＝ 一条 SSH 连接），但人可以选择是哪一个。
       */
      const [mirror, setMirror] = useState(null)
      const preRef = useRef(null)
      const tickRef = useRef(null)
      const stickRef = useRef(true)
      /** 上一次枚举会话时是哪台主机在供数；见下面那个 effect。 */
      const listKeyRef = useRef('__unset__')

      const unconfigured = panel !== null && panel.source === 'none'
      // 镜像只有在宿主说出要镜像哪台机器之后才跑起来；在那之前回答一次就是
      // 白花一条 SSH 连接。
      const mirrorReady = panel !== null && !unconfigured
      /**
       * 上一次取屏**真的**照了哪个会话。
       *
       * 宿主在应答里明说（`session`），而它就是路由按 `active?.session ??
       * cfg.defaultSession` 定下来的那一个。所以当 payload 说不出"当前连接"时
       * （`active === null`：换主机的间隙、或宿主侧还是启动时那份旧代码），只有
       * 这一条能告诉我们屏幕在照谁 —— 否则面板会写出"（主机还没报出会话名）"，
       * 而下面那块屏幕明明在照 default。
       */
      const shotSession = shot !== null && typeof shot.session === 'string' && shot.session !== '' ? shot.session : null
      /** 宿主 payload 里那条活跃连接自己要的会话；没有活跃连接时为 null。 */
      const connectionSession = panel !== null && panel.active !== null ? panel.active.session : null
      /**
       * 这块屏幕没被钉住时跟着谁。
       *
       * 优先听**屏幕自己**说的：payload 是宿主上本地文件的一次快照，而屏幕那一侧
       * 是取屏路由的判定结果，两者不一致时以后者为准。
       */
      const hostSession = shotSession !== null ? shotSession : connectionSession
      /** 「跟着谁」这条理由是宿主给的还是兜底给的 —— 只影响那几句小字怎么讲。 */
      const followingConnection = panel !== null && panel.active !== null
      /**
       * 取屏的地址。
       *
       * **不钉**的时候刻意不带参数：让宿主用它自己认定的那个会话（也就是它 payload
       * 里 `active` 的那个），这样"跟着主机走"这条路径与加选择器之前逐字相同。
       */
      const screenUrl = mirror === null
        ? SCREEN_ENDPOINT
        : SCREEN_ENDPOINT + '?session=' + encodeURIComponent(mirror)

      /**
       * 向宿主要一次**远端**会话列表。
       *
       * 这是这个 panel 唯一一次为了「远端到底有哪些会话」而付 SSH 连接的调用，
       * 所以它刻意不跟着任何轮询走：只在挂载、切换主机，以及打开/杀掉一个会话
       * 之后发生。
       *
       * 失败**不**污染镜像的错误位（panelError），而是退回 GET 给出的那一行并单独
       * 说一句：旧引擎不认 `list` 这个 verb 不该让整个 panel 看起来坏掉了。
       */
      const refreshList = useCallback(async () => {
        try {
          const body = await requestJson(SESSIONS_ENDPOINT, { method: 'POST', body: JSON.stringify({ action: 'list' }) })
          if (Array.isArray(body.sessions)) {
            setListed(body.sessions)
            setListError(null)
          }
        } catch (reason) {
          setListed(null)
          setListError(String((reason && reason.message) || reason))
        }
      }, [])

      // panel 的 payload 是宿主上的一次**本地**读取 —— session 是否存在由镜像来
      // 回答 —— 所以它可以按慢节奏轮询。远端会话列表**不**跟着这个节奏走：只在
      // 「供数的主机」变了的时候重取一次（第一次读到也算变）。
      useEffect(() => {
        let live = true
        const load = async () => {
          try {
            const body = await requestJson(SESSIONS_ENDPOINT)
            if (!live) return
            setPanelError(null)
            setPanel(body)
            const source = String(body.source ?? 'none')
            const key = source + '|' + (body.active === null || body.active === undefined ? '' : body.active.id)
            if (source !== 'none' && key !== listKeyRef.current) {
              listKeyRef.current = key
              void refreshList()
            }
          } catch (reason) {
            if (!live) return
            setPanelError(String((reason && reason.message) || reason))
          }
        }
        void load()
        const timer = setInterval(load, CONNECTION_POLL_MS)
        return () => { live = false; clearInterval(timer) }
        // 依赖**故意**留空：这个 effect 只该在挂载时建起那一个定时器。
        // refreshList 更不该进来 —— 它只闭包了模块级的 requestJson 和两个 set*
        // 函数（都是稳定的），而 React 之外的 hook 替身（client-half-check 里那个
        // 极简运行时）会让 useCallback 每次渲染都返回新函数，把 refreshList 写进
        // 依赖就等于每渲染一次就多读一次会话路由。
      }, [])

      useEffect(() => {
        if (!mirrorReady) return undefined
        let live = true
        let timer = null
        let inFlight = false
        let controller = null
        /** 这一次请求是什么时候发出去的；0 表示手上没有在途的请求。 */
        let startedAt = 0
        /** 每次 tick 领一个号。换代之后，旧那次请求的收尾不许再动新一次的状态。 */
        let turn = 0

        const tick = async () => {
          // 一次活得比自己的间隔还久的 capture 绝不能被下一次并上：请求堆起来会
          // 成倍放大宿主正在付出的 SSH 连接数，而且只会让 panel 更卡，而不是
          // 更新。
          if (inFlight) {
            // 但它也不能就这么**永远**在途：一条没有回答、也没有被宿主掐断的请求
            // 会把这个标志留在 true，于是这条轮询从此一次都不再发请求 —— 面板就
            // 永远停在"还没读到"上。所以越过兜底时限就当我们自己判它死了：换代、
            // 中止它，并把这次失败**说出来**。
            if (startedAt !== 0 && Date.now() - startedAt > FETCH_TIMEOUT_MS) {
              const stale = controller
              turn += 1
              inFlight = false
              startedAt = 0
              controller = null
              try { if (stale !== null) stale.abort() } catch { /* 已经收尾了 */ }
              setBusy(false)
              setError('取屏超时（超过 ' + FETCH_TIMEOUT_MS / 1000 + 's 没有回答）')
              setAt(Date.now())
            }
            return
          }
          const mine = ++turn
          inFlight = true
          startedAt = Date.now()
          setBusy(true)
          controller = typeof AbortController === 'function' ? new AbortController() : null
          try {
            const response = await fetch(screenUrl, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
              ...(controller === null ? {} : { signal: controller.signal }),
            })
            let body = null
            try { body = await response.json() } catch { body = null }
            if (!live || turn !== mine) return
            if (!response.ok || body === null || body.ok !== true) {
              setError(explainFailure(response.status, body))
            } else {
              setError(null)
              setShot(body)
            }
            setAt(Date.now())
          } catch (reason) {
            // `stop()` 引起的 abort（切会话、转后台、卸载）是"这次不算数"，不是失败。
            if (!live || turn !== mine || (reason && reason.name === 'AbortError')) return
            setError(String((reason && reason.message) || reason))
            setAt(Date.now())
          } finally {
            if (turn === mine) { inFlight = false; startedAt = 0 }
            if (live && turn === mine) setBusy(false)
          }
        }
        tickRef.current = tick

        const start = () => {
          if (timer !== null) return
          timer = setInterval(tick, POLL_MS)
          void tick()
        }
        const stop = () => {
          if (timer !== null) { clearInterval(timer); timer = null }
          if (controller !== null) { try { controller.abort() } catch { /* 已经收尾了 */ } }
        }
        const onVisibility = () => {
          if (document.visibilityState === 'hidden') { stop(); setPaused(true) } else { setPaused(false); start() }
        }

        if (document.visibilityState === 'hidden') setPaused(true)
        else start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          live = false
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
          tickRef.current = null
        }
        // 钉住的会话换了就得换一条轮询：旧定时器拍的是旧会话的屏。依赖写
        // `screenUrl` 而不是那个会话名 —— URL 才是这次轮询的全部身份，而"跟着
        // 宿主走"这条路径的 URL 是常量（宿主自己决定照谁），屏幕回报的会话名
        // 因此不会把它重启一遍、白花一条 SSH 连接。
      }, [mirrorReady, screenUrl])

      // 读者待在 pane 尾部时就跟着尾部走；他们一旦往上翻去读别的，就不要再动
      // 滚动位置。
      useEffect(() => {
        const node = preRef.current
        if (node === null || stickRef.current !== true) return
        node.scrollTop = node.scrollHeight
      })

      const onScroll = useCallback(() => {
        const node = preRef.current
        if (node === null) return
        stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= STICK_SLACK_PX
      }, [])

      const refresh = useCallback(() => { if (tickRef.current !== null) void tickRef.current() }, [])

      /**
       * 一次 POST 打到 panel 路由，以及它能给出的三种回答。
       *
       * `activate` 会重新取一份 payload，因为切换 host 会改变下一次 capture 读到
       * 的东西；`open`/`kill` 则改用文字回答，因为「开了一个窗口」是一个事件，
       * 不是选择器能反映出来的状态。
       */
      const act = async (label, payload) => {
        setActing(label)
        setNotice(null)
        try {
          const body = await requestJson(SESSIONS_ENDPOINT, { method: 'POST', body: JSON.stringify(payload) })
          if (body.opened !== undefined) {
            setNotice({ ok: true, text: '已在本机打开终端「' + body.opened.title + '」→ ' + body.opened.target })
          } else if (body.killed !== undefined) {
            setNotice({
              ok: true,
              text: body.killed.killed === true
                ? '已杀掉远端会话 "' + body.killed.session + '"'
                : '远端本来就没有 "' + body.killed.session + '" 这个会话',
            })
          }
          if (Array.isArray(body.profiles)) setPanel(body)
          // 打开与杀掉都会改变远端到底有哪些会话，所以动作成功之后就重取一次列表
          //（它只在「供数的主机」真的变了时才多跑一次；见上面那个 effect）。
          void refreshList()
        } catch (reason) {
          setNotice({ ok: false, text: String((reason && reason.message) || reason) })
        } finally {
          setActing(null)
        }
      }

      const dotColor = unconfigured || paused ? PAUSED_COLOR : (error !== null ? STALE_COLOR : LIVE_COLOR)
      const detail = shot === null
        ? '还没有读到屏幕'
        : 'cached=' + String(shot.cached) + ' shared=' + String(shot.shared) + ' ageMs=' + String(shot.ageMs)
          + (sessionId === null ? '' : ' · DSH session ' + sessionId)
      const empty = placeholder(shot, error)
      const profiles = panel === null ? [] : panel.profiles
      const activeId = panel !== null && panel.active !== null ? panel.active.id : ''

      // 引擎枚举出来的那些行（tmux 自己报的），再加上**活跃**会话那一行 —— 后者
      // 即使还没被创建也必须留着，因为「打开」正是人去创建它的入口。
      const activeSession = hostSession
      const discovered = listed ?? (panel === null ? [] : panel.sessions)
      const rowsSource = activeSession === null || discovered.some((row) => row.name === activeSession)
        ? discovered
        : [{ name: activeSession, exists: null }, ...discovered]

      // 会话下拉里能选的名字：引擎枚举出来的那批（`rowsSource` 已经把活跃会话
      // 补在最前）。枚举失败时钉住的那个名字可能不在这一批里 —— 选择器不能因此
      // 显示成一个空值。
      const sessionNames = rowsSource.map((row) => row.name)
      const sessionChoices = mirror !== null && sessionNames.indexOf(mirror) === -1
        ? [...sessionNames, mirror]
        : sessionNames

      const rows = rowsSource.map((row) => {
        // 存在性的优先级：镜像谈的正是这一行时以镜像为准（它最新，而且它是唯一
        // 回答「不存在」的那个），否则听引擎那次枚举的读数；两者都没说，就诚实地
        // 是 null。
        const exists = shot !== null && shot.session === row.name
          ? shot.exists === true
          : (row.exists === true ? true : null)
        const armed = confirming === row.name
        /** 这一行就是屏幕正在照的那一个：钉住的行，或没钉住时主机自己那个会话。 */
        const following = mirror === null && row.name === hostSession
        const pinned = mirror === row.name
        return h(
          'div',
          {
            key: row.name,
            style: {
              display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px',
              border: '1px solid rgba(127,127,127,0.25)', borderRadius: '5px', fontSize: '12px',
              ...(pinned || following ? MIRRORED_ROW_STYLE : {}),
            },
          },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px', flex: '1 1 auto', minWidth: 0 } },
            h('span', { style: { fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              '会话 ' + row.name),
            h('span', { style: { opacity: 0.55, fontSize: '11px' } },
              (exists === null ? '存在性由镜像回答' : (exists ? '存在' : '不存在（「打开」会创建它）'))
                + (row.attached > 0 ? ' · ' + row.attached + ' 人已接入' : '')
                + (pinned || following ? ' · 正在镜像' : ''))),
          h('button', {
            type: 'button',
            disabled: acting !== null,
            onClick: () => { setConfirming(null); void act('open:' + row.name, { action: 'open', session: row.name }) },
            title: '在本机弹出真终端 attach 到该会话（需要时会在那个窗口里问一次密码）',
            style: BUTTON_STYLE,
          }, acting === 'open:' + row.name ? '打开中…' : '打开'),
          h('button', {
            type: 'button',
            disabled: acting !== null,
            onClick: () => {
              if (!armed) { setConfirming(row.name); setNotice(null); return }
              setConfirming(null)
              void act('kill:' + row.name, { action: 'kill', session: row.name })
            },
            title: armed ? '再点一次就真的结束远端这个 tmux 会话' : '结束远端这个 tmux 会话（会先问一次）',
            style: armed ? DANGER_STYLE : BUTTON_STYLE,
          }, acting === 'kill:' + row.name ? '杀掉中…' : (armed ? '确认杀掉？' : '杀掉')),
        )
      })

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: '6px', padding: '10px', fontFamily: 'inherit' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }, title: detail },
          h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: dotColor, flex: '0 0 auto' } }),
          h('span', { style: { opacity: 0.78, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            statusText({ shot, error, paused, busy, at, unconfigured })),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', {
            type: 'button',
            onClick: refresh,
            disabled: !mirrorReady,
            title: paused ? '立即刷新一次（后台暂停中）' : '立即刷新一次',
            style: { ...BUTTON_STYLE, padding: '0 6px' },
          }, '↻'),
        ),
        // 两个下拉，各自回答一个问题：**服务器** = 设置里那份连接清单的「当前」
        // （九个模型工具跟着一起换机器），**会话** = 这一格屏幕在照谁（别的什么都不动）。
        // 会话名优先取屏幕自己回报的那个 —— payload 说不出「当前连接」时
        // （`active === null`）屏幕仍然照着一个会话，那是宿主的默认会话。
        mirrorReady || profiles.length > 0
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', flexWrap: 'wrap' } },
            h('span', { style: { opacity: 0.7 } }, '服务器'),
            profiles.length === 0
              ? h('span', { style: { opacity: 0.55 } }, '（连接清单里还没有服务器）')
              : h('select', {
                value: activeId,
                disabled: acting !== null,
                // 换主机就退回「跟着主机走」：钉住的会话名在新主机上多半根本不存在。
                onChange: (event) => { setMirror(null); void act('activate', { action: 'activate', id: event.target.value }) },
                title: '切换服务器（改的是设置里那份连接清单的「当前」，模型工具也跟着换机器）',
                style: SELECT_STYLE,
              },
              activeId === '' ? h('option', { value: '' }, '（未选择服务器）') : null,
              profiles.map((profile) => h('option', { key: profile.id, value: profile.id },
                (profile.label || profile.target) + (profile.active === true ? ' ✓' : '')))),
            h('span', { style: { opacity: 0.7 } }, '会话'),
            mirrorReady
              ? h('select', {
                value: mirror === null ? '' : mirror,
                disabled: acting !== null,
                // 选空串 = 回到「跟着主机走」，那一次取屏**不带**参数。
                onChange: (event) => {
                  setConfirming(null)
                  setMirror(event.target.value === '' ? null : event.target.value)
                },
                title: '这块屏幕照哪个 tmux 会话（一次只照一个：一次取屏就是一条全新的 SSH 连接；不额外开窗口，也不动本机已经开着的那些）',
                style: SELECT_STYLE,
              },
              h('option', { value: '' },
                (followingConnection ? '跟随当前连接' : '跟随宿主默认')
                  + (hostSession === null ? '（会话名还没读到）' : ' · ' + hostSession)),
              sessionChoices.map((name) => h('option', { key: name, value: name }, name)))
              : h('span', { style: { opacity: 0.55 } }, '（还没有能照的屏幕）'))
          : null,
        // 这一行给「到底在照谁的屏」一个**字面**答案：下面那块屏在照谁，光看两个下拉
        // 是看不出来的（下拉只显示名字），而屏幕还没读到时上面那行摘要只会说
        // `visible-ssh`，所以这里先讲清跟着的是谁、凭什么。会话名优先取屏幕自己回报的
        // 那个：payload 说不出「当前连接」时（`active === null`）屏幕仍然照着一个会话，
        // 那时跟着的就是宿主的默认会话，而不是"不知道"。
        mirrorReady
          ? h('div', { style: { fontSize: '11px', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            mirror === null
              ? '正在镜像：会话 ' + (hostSession === null ? '（还没读到屏幕）' : hostSession)
                + ' · ' + (followingConnection ? '跟随当前连接' : '跟随宿主默认')
              : '正在镜像：会话 ' + mirror + ' · 已钉住')
          : null,
        panelError === null ? null : h('div', {
          style: {
            fontSize: '12px', color: STALE_COLOR, border: '1px solid rgba(210,153,34,0.45)',
            borderRadius: '4px', padding: '4px 6px', wordBreak: 'break-word',
          },
        }, panelError),
        // 枚举失败是**单独**一句话，而不是把上面那个错误位也点亮：镜像可能好好的，
        // 只是这台主机的引擎还不认 `list`。此时面板退回 GET 给的那一行。
        listError === null ? null : h('div', {
          style: {
            fontSize: '12px', color: STALE_COLOR, border: '1px solid rgba(210,153,34,0.45)',
            borderRadius: '4px', padding: '4px 6px', wordBreak: 'break-word',
          },
        }, '列出远端会话失败：' + listError + '（只显示当前会话）'),
        notice === null ? null : h('div', {
          style: { fontSize: '12px', color: notice.ok ? LIVE_COLOR : STALE_COLOR, wordBreak: 'break-word' },
        }, notice.text),
        unconfigured
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', opacity: 0.85, lineHeight: '1.6' } },
            h('div', {}, '还没有可用的远端连接，所以这个面板没有可打开或可镜像的东西。'),
            h('div', { style: { opacity: 0.75 } },
              '在「设置 → visible-ssh」里填主机 / 端口 / 用户名 / 密码 / tmux 会话名并保存；之后这里会列出该会话，并每 '
              + POLL_MS / 1000 + 's 镜像它的屏幕。'),
            panel.file === undefined
              ? null
              : h('div', { style: { opacity: 0.5, fontFamily: MONO, fontSize: '11px', wordBreak: 'break-all' } },
                '配置文件：' + panel.file))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', minHeight: 0, flex: '1 1 auto' } },
            rows,
            h('div', { style: { fontSize: '11px', opacity: 0.55, lineHeight: '1.5' } },
              '上面两个下拉：「服务器」换的是设置里那份连接清单的「当前」（模型工具也跟着换机器），'
              + '「会话」换的是这一格屏幕在照谁（屏幕一次只照一个会话，切回来选「跟随…」那一项；'
              + '选过之后那一次取屏就带上 `?session=`，宿主那 300ms 缓存也按「连接 + 会话」分开 —— '
              + '注意它与对话框里那格的「会话」不是一回事：这里只改屏幕，那里改的是 AI 干活用的会话）；'
              + '「打开」在你本机弹出真终端并 attach 到该会话（attach-or-create，需要时在那个窗口里输一次密码）；'
              + '「杀掉」结束远端那个 tmux 会话，点两次才动手。'),
            error === null ? null : h('div', {
              style: {
                fontSize: '12px', color: STALE_COLOR, border: '1px solid rgba(210,153,34,0.45)',
                borderRadius: '4px', padding: '4px 6px', wordBreak: 'break-word',
              },
            }, error),
            h('pre', {
              ref: preRef,
              onScroll,
              style: {
                flex: '1 1 auto', minHeight: 0, margin: 0, padding: '8px', overflow: 'auto',
                whiteSpace: 'pre', fontFamily: MONO, fontSize: '12px', lineHeight: '1.4',
                border: '1px solid rgba(127,127,127,0.35)', borderRadius: '6px',
                background: 'rgba(127,127,127,0.06)',
              },
            }, empty === '' ? (shot === null ? '' : shot.screen) : empty),
          ),
      )
    }

    /**
     * 对话框里那格：服务器 ＋ 会话。
     *
     * 两个下拉是「当前连接」这件事的两半，各自一次写：
     *   * 「服务器」＝ `activate`：换机器。AI 的九个工具与右侧那块镜像一起改打那台。
     *   * 「会话」  ＝ `session`：换那台机器上干活的 tmux 会话。工具默认打这个会话，
     *     镜像照的也是它 —— 除非人在 panel 里钉住了别的会话。
     *
     * 两者都与设置页、panel 是同一份宿主状态，所以在别处换了，这里下一次轮询就自己
     * 跟上。服务器清单来自 `GET /visible-ssh/sessions`，那是宿主上的**本地**读取（不走
     * SSH），挂在慢轮询上免费；而会话**名**只能问远端要 —— 一次枚举＝一条 SSH 连接 ——
     * 所以它只在挂载、换机器、人点 ↻ 之后读，绝不挂在轮询上。
     *
     * 一台服务器都没存过时整格**不渲染**：一个空格子只会让人以为坏了，而人本来就该
     * 先去设置里填一台。
     */
    function ComposerPicker() {
      const [view, setView] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [names, setNames] = useState(null)
      const [nameError, setNameError] = useState(null)
      const [nameBusy, setNameBusy] = useState(false)

      useEffect(() => {
        let live = true
        const load = async () => {
          try {
            const body = await requestJson(SESSIONS_ENDPOINT)
            if (!live) return
            setError(null)
            setView(body)
          } catch (reason) {
            if (!live) return
            setError(String((reason && reason.message) || reason))
          }
        }
        void load()
        const timer = setInterval(load, CONNECTION_POLL_MS)
        return () => { live = false; clearInterval(timer) }
        // 依赖**故意**留空：这个 effect 只该在挂载时建起那一个定时器（panel 里那段
        // 同样的说明也适用）。宿主换了机器不会被这里漏掉 —— 轮询会读到。
      }, [])

      const profiles = view !== null && Array.isArray(view.profiles) ? view.profiles : []
      const active = view === null ? null : view.active
      const activeId = active !== null && active !== undefined ? active.id : ''
      const current = active !== null && active !== undefined && typeof active.session === 'string' ? active.session : ''

      /** 枚举活跃机器上的 tmux 会话 —— 这条路由上唯一要付 SSH 的读。 */
      const reloadNames = async () => {
        if (activeId === '') { setNames(null); setNameError(null); return }
        setNameBusy(true)
        try {
          const body = await requestJson(SESSIONS_ENDPOINT, {
            method: 'POST',
            body: JSON.stringify({ action: 'list' }),
          })
          setNames(Array.isArray(body.sessions) ? body.sessions.map((row) => String(row.name)) : [])
          setNameError(null)
        } catch (reason) {
          setNames(null)
          setNameError(String((reason && reason.message) || reason))
        } finally {
          setNameBusy(false)
        }
      }

      // 换机器就换会话清单 —— 另一台机器上的 session 名与这台毫无关系；挂载时也走
      // 这里（那会儿 activeId 刚被读到）。依赖只列 activeId：`reloadNames` 每次渲染都
      // 是新的函数，列进去会让这个 effect 每渲染一次就付一条 SSH。
      useEffect(() => { void reloadNames() }, [activeId])

      // 一台都还没有：不占地方，也别装成一个空的下拉框。
      if (profiles.length === 0) return null

      // 宿主说不出「当前」时（换机器的间隙、或它那份状态与列表对不上）就诚实地空着，
      // 而不是把列表第一台假装成当前。
      const selectedServer = profiles.some((profile) => profile.id === activeId) ? activeId : ''

      const pickServer = async (id) => {
        if (id === '' || id === selectedServer) return
        setBusy(true)
        try {
          const body = await requestJson(SESSIONS_ENDPOINT, {
            method: 'POST',
            body: JSON.stringify({ action: 'activate', id }),
          })
          // 换完是**重新读一遍**，不是猜：应答里就是新的当前连接与整张清单。
          if (Array.isArray(body.profiles)) setView(body)
          setError(null)
        } catch (reason) {
          setError(String((reason && reason.message) || reason))
        } finally {
          setBusy(false)
        }
      }

      const pickSession = async (name) => {
        if (name === '' || name === current) return
        setNameBusy(true)
        try {
          const body = await requestJson(SESSIONS_ENDPOINT, {
            method: 'POST',
            body: JSON.stringify({ action: 'session', session: name }),
          })
          if (Array.isArray(body.profiles)) setView(body)
          setNameError(null)
        } catch (reason) {
          setNameError(String((reason && reason.message) || reason))
        } finally {
          setNameBusy(false)
        }
      }

      const serverOptions = profiles.map((profile) => h(
        'option',
        { key: profile.id, value: profile.id },
        profile.label + ' — ' + profile.target,
      ))
      if (selectedServer === '') serverOptions.unshift(h('option', { key: '__none__', value: '' }, '（还没选）'))

      // 当前会话一定在清单里（哪怕远端这一轮没说它 —— 它正是这台机器现在打着的那个），
      // 且排在最前，好让 `value` 有对应的 option 可落。
      const sessionNames = []
      for (const name of (names === null ? [] : names)) if (!sessionNames.includes(name)) sessionNames.push(name)
      if (current !== '' && !sessionNames.includes(current)) sessionNames.unshift(current)
      const sessionOptions = sessionNames.length === 0
        ? [h('option', { key: '__none__', value: '' }, selectedServer === '' ? '（先选一台服务器）' : '（还没读到会话名）')]
        : sessionNames.map((name) => h('option', { key: name, value: name }, name))

      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 } },
        h('span', { style: COMPOSER_LABEL_STYLE }, '服务器'),
        h('select', {
          value: selectedServer,
          disabled: busy,
          style: COMPOSER_CONTROL_STYLE,
          title: error !== null
            ? 'visible-ssh：' + error
            : 'visible-ssh：这一格就是「当前连接」——AI 的工具与右侧镜像面板都打在这台机器上',
          onChange: (event) => { void pickServer(event.target.value) },
        }, serverOptions),
        h('span', { style: COMPOSER_LABEL_STYLE }, '会话'),
        h('select', {
          value: sessionNames.length === 0 ? '' : current,
          disabled: nameBusy || selectedServer === '',
          style: { ...COMPOSER_CONTROL_STYLE, maxWidth: '140px' },
          title: nameError !== null
            ? 'visible-ssh：' + nameError
            : 'visible-ssh：AI 默认在这个 tmux 会话里干活（右侧镜像照的也是它，除非你在面板里钉住了别的会话）'
              + (nameBusy ? ' · 正在枚举远端的会话…' : ''),
          onChange: (event) => { void pickSession(event.target.value) },
        }, sessionOptions),
        h('button', {
          type: 'button',
          disabled: nameBusy || selectedServer === '',
          style: COMPOSER_REFRESH_STYLE,
          title: 'visible-ssh：重新枚举这台机器上的 tmux 会话（一次枚举＝一条 SSH 连接，所以它不跟着轮询走）',
          onClick: () => { void reloadNames() },
        }, '↻'),
      )
    }

    function apply(ctx) {
      // `sidebarRightTabs` 可能在本插件之后才挂载，所以注册由 ctx.inject 驱动
      // （而不是在 apply 时去读那个属性）。
      ctx.effect(() => {
        const stopInjecting = ctx.inject(['sidebarRightTabs'], (scope) => {
          const disposeType = scope.sidebarRightTabs.register({
            id: ID,
            kind: KIND,
            // 扩展的优先级高于产品自带的那些页面 kind。
            priority: 'extension',
            title: () => 'visible-ssh',
            guide: [{ order: 60, title: () => 'visible-ssh' }],
          })
          const disposeBody = ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: ID },
            RemotePaneTab,
          )
          return () => {
            disposeBody()
            disposeType()
          }
        })
        return stopInjecting
      }, 'dsh-visible-ssh: console tab')

      // 同一个表单也作为顶层 settings section，这样它就位于设置导航里那些内置
      // 项旁边（通用设置 order 0、模型 10、插件 15），而不是藏在某个 panel 标签
      // 里。注册方式与随包发布的那些 section 完全一样 —— 回调在 slot 被声明时
      // 执行，无论由谁组合出来；而如果没有组合任何设置 UI，它就干脆永不触发。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'visible-ssh',
        order: 20,
        label: () => 'visible-ssh',
      }, ConnectionSection))

      // 对话框里那一格：输入框下面那一排里的「服务器 ＋ 会话」两个下拉
      // （`conversation.input.left` 是 list 槽位，按 id 占格）。注册方式与设置
      // section 相同 —— 声明式，没有组合出对话输入栏时永不触发。一台连接都没存过时
      // 组件自己渲染成 null；宿主换了机器／会话之后这里由轮询与它自己那次读跟上。
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'visible-ssh:server',
        order: 10,
        label: () => 'visible-ssh',
      }, ComposerPicker))

      // 一旦有 session dock 存在就立刻把标签页露出来，这样镜像（或者创建镜像的
      // 那个表单）就在人本来就会看的地方。`openTab` 在屏幕上一个 session 都没有
      // 时会抛错（没有 dock 可以开进去），所以这里重试到有一个为止；它会在第一次
      // 成功之后、或者一分钟之后停止。删掉这个 effect，就可以改成让 panel 从
      // sidebar 自己的「+」菜单里手动开启。
      ctx.effect(() => {
        let tries = 0
        const stopInjecting = ctx.inject(['sidebarRight'], (scope) => {
          const timer = setInterval(() => {
            tries += 1
            try {
              scope.sidebarRight.openTab(KIND, { revealIfOpened: false })
              clearInterval(timer)
            } catch {
              if (tries >= 60) clearInterval(timer)
            }
          }, 1000)
          return () => clearInterval(timer)
        })
        return stopInjecting
      }, 'dsh-visible-ssh: reveal tab')
    }

    exports.apply = apply
    // 这段本体解引用到的服务名（cordis 会对属性访问设门禁）。
    exports.inject = ['slots']
    return module.exports
  },
})
