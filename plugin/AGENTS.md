# plugin/ — dsh-visible-ssh 这一层的规矩

这一层是**生产代码**：`src/` 是插件本体，按子系统分目录 —— `engine/`（与引擎之间的接缝：
`port.ts` 只有接口、`exec.ts` 是唯一开进程的地方、`locate.ts` 决定跑哪个 CLI（按包名解析平台包，
并把选中的 `host.toml` 作为 `--config` 插到 argv 最前）、
`verify.ts` 按 `engine.lock` 核对产物、`envelope.ts` 拆信封与失败、
`fake.ts` 是给测试用的内存替身、另有 `config.ts`（**配置解析**：`chooseHostConfig()` 决定这次读
插件配置／`SSH_CONFIG`／用户目录／仓内这四者中的哪一份）与 `project.ts`）、`connection/`（连接与设置：`connections.ts` 是档案存储与 `source()`、`settings.ts` 是面板字段、
`ssh-config.ts` **只读**本机 `~/.ssh/config` 把配好的 Host 段列成候选）、
`routes/`（三条浏览器路由）、`approval/`（破坏性动作的审批）、`tools/`（9 个模型工具的声明）、
`shared/`（跨子系统的小工具）、`client/`（手写的客户端半）。
宿主侧是 **TypeScript**（`tsconfig.json` 管着），**产物在 `lib/`** —— 那个目录被 gitignore，
由 `plugin/scripts/build.mjs`（经 `npm run build`）生成；`scripts/` 下只放**本层的脚本** ——
构建（`build.mjs`、`copy-client.mjs`）、取件（`engine-fetch.mjs`）、身份锁（`engine-lock.mjs`）、
打包（`engine-pack.mjs`）、配置（`host-config.mjs`）。
`package.json` 是它的清单；依赖不住在这里（npm workspaces 把 `plugin/`、`test/`、
`packages/engine-win32-x64` 三个成员的依赖都提升到**仓根** `node_modules/` ——
开发期解到的引擎就是那个包目录，与装到别的机器同一条路径）。
**引擎本体不在本包里**：它在平台包 `packages/engine-win32-x64/`（三个 exe 不进 git），
本包只在 `optionalDependencies` 里申报它，`src/engine/locate.ts` 按包名解析，
`src/engine/verify.ts` 在 spawn 前按包里的 `engine.lock` 核对。
取一组／换一组产物走 `node plugin/scripts/engine-fetch.mjs --tag <vX.Y.Z> --install --lock`
（从上游 Release 取件、按三把锚核对、顺手刷锁；上游只给散文件时才手工整组拷 ＋ `engine-lock.mjs`）。
每个文件负责什么、按什么顺序读，见 `plugin/README.md` 的 §1。
它的测试**不在这里** —— 2026-10-02 起全部在仓库顶层的 `test/`（入口 `test/README.md`），
`plugin/` 下不再有 `tests/`。改这一层之前先读完这份文件 —— 里面每一条都是踩过一次才写下来的。

## 插件层通用（改 `src/` 时同样成立）

- **改完什么时候生效**：宿主加载的是**产物** `lib/`，所以任何改动都先 `npm run build`
  （`node test/run.mjs` 会替你检查产物是否比源码旧、必要时自动构建）。之后：`lib/client/index.js`
  （客户端半）在桌面版宿主里约 1 秒热更，普通 `dsh web` 宿主必须**刷新页面**；其余
  `lib/**` 与 `package.json` **必须重启宿主** —— 细节见 `plugin/README.md` 的 2.4 节。
- **客户端半是手写的**：没有打包器、没有 React 依赖树，全靠 `React.createElement`
  与宿主给的钩子；改之前先读 `plugin/README.md` 的「契约备忘（改客户端半之前先读）」。
  它是**唯一的 `.js` 源文件**（`src/client/index.js`）：故意**不进 tsc**（它用 `require`
  拿 `react`，类型体系只会把它改坏），由 `plugin/scripts/copy-client.mjs` 逐字拷成
  `lib/client/index.js` —— 所以它没有 `.d.ts`，也不需要类型检查。
- **起宿主做测试必须用隔离的 development home**：见下面「起宿主的 home」一节。
- 下面「三条硬性约束」里的 **#1（不用管道收子进程输出）** 与 **#3（绝不跑破坏性动作）**
  对 `src/` 同样成立 —— 它们是宿主与环境的事实，不是测试层的洁癖。

**以下各节讲的是 `test/` 里的套件（仓库顶层），除非那节明说讲的是插件本身。**

## 台账：新套件必须登记，否则等于没写

`test/run.mjs` 是唯一的入口，它维护两张名单：

- `HERMETIC` —— `npm test` / CI 会跑的。**只许依赖 node 和本仓库**：不碰网络、
  不碰 DSH、不碰操作者的 `~/.dsh`、不弹窗口。现役：`manifest-check`、
  `engine-check`、`artifact-check`、`connection-check`、`settings-check`、
  `route-check`、`client-half-check`。
- `OPT_IN` —— **只登记、不自动跑**，每条要写 `needs`（缺什么就跑不了）和
  `what`（它证明的是哪一件事）。现役：`live-route`、`live-late-carrier`、
  `boot-graph`、`own-host-check`。

`test/run.mjs` 会核对台账：`test/*.mjs`（除 `run.mjs`）若在两张名单里都没有，
或者名单里写的文件不存在，它就直接判 `FAILED: the suite ledger is out of date`
并退出 1。**所以新增一个套件后忘了登记，门禁会替你发现** —— 这是故意的。

往 `OPT_IN` 里塞东西前先问自己：它需要网络、需要一台真主机、需要 DSH、需要
浏览器、还是会在别人屏幕上留下东西？只要沾一样就是 `OPT_IN`，不要进 `HERMETIC`。

**密闭层的解耦是强制的**（2026-10-03 起，用户要求"插件测试与本机实际文件完全解耦"）：
`test/run.mjs` 在跑任何套件**之前**静态扫 7 个密闭套件与 `test/unit/**`，命中
`homedir(`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`.agents`/`.dsh/` 任一就打印
`FAILED: a hermetic suite touches this machine` 并 exit 1；跑的时候还把
`HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 指到空的 `test/env/tmp/decoupled/home`、
`TMP*` 指到空的 `decoupled/tmp`，并删掉继承来的 `DSH_*`/`SSH_*`（收尾 JSON 里有
`decoupled` 段）。扫的是**路径续接**形式（`\.dsh[\\/]`），不是裸 `\.dsh` —— 后者会
撞上 `pkg.dsh?.client`。需要本机东西的检查一律进 `OPT_IN`，并在 `needs` 里写清怎么给。

### unit 层不在台账里

`test/unit/*.test.mjs` 由 **vitest** 自己发现（依赖与脚本在 `test/package.json`），
`test/run.mjs` 把它接在密闭套件**之前**作为第一段 —— 它只碰纯函数、内存引擎端口
与假 req/res，不 spawn、不联网、不碰 SSH、不起宿主（实测 127 项、约 0.6 s）。
台账守卫比对的是**顶层** `test/*.mjs`，所以 unit 的 spec 文件既不必登记、也不会
被误判为"漏登记"。写 unit spec 时用 `plugin/src/engine/fake.ts` 的 `createFakeEngine()`
换掉真端口，**不要**为了测一条分支去起真进程或连真主机。

## 三条硬性约束（都是环境逼出来的，不是洁癖）

1. **不要用管道收子进程输出。** 受限宿主拒绝命名管道，`child_process` 的
   `stdio: 'pipe'` 会以 EPERM 失败，而 `stdio: 'inherit'` 正常。所以 `test/run.mjs`
   用 `inherit`；需要留日志的套件（`own-host-check`）把 stdout/stderr 接到一个
   **文件描述符**（`openSync` 出来的 fd），不要接管道。
2. **临时目录一律落在 `test/env/tmp/` 下**（那个目录被 gitignore），开头
   `rmSync(..., {recursive:true, force:true})` 清一次，结尾视情况留或删 —— 失败的运行
   **要留下日志**，那是唯一能说出被测进程当时说了什么的东西（`own-host-check` 用
   `test/env/tmp/own-host/host.log`，全绿才把整个 `own-host/` 删掉）。
   仓库根、`plugin/` 和别处**不要**写临时文件 —— 那是提交区的边界，一次性文件很容易被
   `git add -A` 顺手带上；临时区只有一个地方，就是 `test/env/tmp/`。
   临时区的规矩见 `scratch/AGENTS.md`。
3. **绝不跑破坏性动作。** 真宿主上的 `open` 会在操作者屏幕上弹终端窗口、`kill`
   会毁掉正在被照着的 pane —— 两者都**故意**不调。共享 tmux 会话里名叫
   `default` 的那个是操作者自己的，永远不要在它上面跑东西。套件只做只读调用。

## 起宿主的 home：隔离的 dev home，永远不碰操作者的 `~/.dsh`

根 `AGENTS.md` 的「起宿主做测试：**必须**用隔离的 development home（硬性）」在
`test/own-host-check.mjs` 里是**代码钉住**的，不是靠自觉：

- 默认 home = `test/env/home`（仓库内、被 gitignore，由 `test/tools/setup-env.mjs`
  从 `test/env/home.seed/` 重建；本插件以 junction 挂在那个 profile 的 `node_modules` 下）。
- **继承来的 `DSH_HOME` 只当线索，不当命令。** 桌面宿主会把它自己的
  `DSH_HOME=C:\Users\<user>\.dsh` 透给每个子进程（连 `DSH_SESSION_ID`、`DSH_WEB_URL`、
  `DSH_SHELL`、`DSH_PATH_DIALECT` 一起），所以 `process.env.DSH_HOME ?? join(homedir(), '.dsh')`
  这种写法**永远走不到后半段** —— 套件宿的其实是操作者真实的家：浏览器里出现的是
  **桌面 app 的历史会话与工作区**，面板一加载还会写真实的 `storages/workspace.json`。
  真家**永远**被忽略；继承值只在「它不是真家」时才被采用，并被记进收尾 JSON 的
  `home.ignored`。
- 想指定别的 home 用 `DSH_OWN_HOST_HOME`；**它指到真家就直接 skip 退出**（这不是命令，
  是操作者写错了）。
- spawn 前删掉宿主塞进来的 `DSH_SESSION_ID` / `DSH_WEB_URL` / `DSH_SHELL` /
  `DSH_PATH_DIALECT`：它们指的是**宿主自己的世界**，留着只会把噪声引进来。
- 隔离 home 里没有 `dsh-visible-ssh/connections.json` 时，套件只用**当场给的**凭据种一条
  profile（`SSH_HOST`/`SSH_USER`/`SSH_PORT`/`SSH_SESSION`，写出 `secrets: {}`，绝不含密码），
  或就用隔离家里本来已有的那条 —— **绝不从操作者真家借任何字段**。密码只经 `SSH_PASSWORD`
  到引擎；引擎读的那份配置由 `test/lib/live-credentials.mjs` 生成在 `test/env/tmp/` 下
  （不含密码，插件把它作为 `--config <绝对路径>` 交给引擎，见 `plugin/README.md` 的配置一节），
  所以引擎不会"向上找"到仓里那份带真密码的 `scripts/config/host.toml`。两处都没有就打印
  `{skipped: …}` 并 exit 0。
- 第一条断言就是这条规矩本身：`isolation: the host boots a development home, never the
  operator's ~/.dsh` —— 宿主起没起来都能判定，所以它总是先跑。

## 写一个套件的形状

照抄现役套件的骨架，别发明新形状：

```js
const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, ...(condition === true ? {} : { detail }) })
}
```

`route-check.mjs` 另有 `eq(name, actual, expected)`（`JSON.stringify` 比较）。
**前提不满足时**打印 `{ skipped: reason }` 的 JSON 并 `process.exit(0)`
（`boot-graph.mjs:17-20`、`live-route.mjs:40-43`）—— 在别的机器上没装东西是环境
的事实，不是这个插件的失败；把它做成 FAIL 只会让人把断言删掉。
收尾打印一个 JSON 对象（含 `checks` 与 `verdict`），`verdict` 形如
`OK: N …cheap green` / `FAILED: …`，`process.exitCode` 0/1。

## 两层各自的活，别混

- **密闭层**（`route-check`、`client-half-check`）拿**假的** req/res 与假的
  fetch/hook 驱动我们自己的半，证明逻辑分支对，副作用是快、稳、能进 CI。
  它证明不了：路由真的挂在宿主上、真的浏览器真的把它渲染出来。
- **真层**（`live-route`、`own-host-check`、`live-late-carrier`、`boot-graph`）
  证明的正是上面那两件。代价是慢、要环境、要人开。

`own-host-check.mjs` 里浏览器那一半是「可选的第二层」：driver 不通就记
`browser: {ran:false, reason}`，**不算失败**，但那个 `reason` 会出现在收尾 JSON 里
—— 别把它当噪声，它说明这一层没被检验。

## 共享浏览器与 driver（浏览器级检查靠它）

- 浏览器：用 `test/tools/launch-agent-browser.ps1` 启动（内部走
  `Invoke-CimMethod -ClassName Win32_Process -MethodName Create`）。**必须**这样
  起：直接在受限沙箱 job 里 `Start-Process` 的话，进程会随 job 一起被收走
  （表现是 15–30 秒内 9222 掉线；edge 日志里会留下
  `FATAL:mojo\public\cpp\platform\platform_channel.cc:170] Check failed: . : 拒绝访问。 (0x5)`）。
  参数含 `--remote-debugging-port=9222` 与 `--user-data-dir=…/.agent-browser-profile`。
- driver：`node test/tools/driver.mjs`（后台），控制口默认
  `http://127.0.0.1:7743/`，可用 `DSH_DRIVER` 覆盖；套件也会去读
  `test/env/browser/.driver-control.json` 里的 `port`。可用的动作：
  `GET /status`、`GET /events`（`{events, consoleErrors, pageErrors, failedRequests}`）、
  `POST /attach {cdp}`、`POST /goto {url}`、`POST /reload`、`POST /eval {js}`
  （实现就是 `page.evaluate(String(body.js))`）、`POST /shot {name}`、
  `POST /watch {paths}`、`GET /tabs`。CDP 地址默认 `http://127.0.0.1:9222`
  （`DSH_CDP` 覆盖）。
- 浏览器中途死掉时的症状：driver 的动作报
  `no page: the browser was closed or restarted. POST /attach to reconnect…`。
  重新跑 `launch-agent-browser.ps1`，再 `POST /attach` 就恢复；**不需要**重启 driver。

## 那两道门（别再把它们搞混）

同一个端口号上的 403 曾经花掉一整个会话，所以写在这里：

- **桌面宿主**（`DSH Desktop.exe`）对外部浏览器**一律 403** + body `forbidden`
  （`resources/app/lib/webserver.js:16-22 rejectBrowserRequest`）。它只认 Electron
  渲染进程带的那枚头 `x-dsh-desktop-renderer`，值是宿主启动时随机生成、只活在进程
  里的 32 字节 token —— 不落盘、不在 argv、不在 env。切到 compatibility 模式
  并打开「允许在浏览器中打开」才会放行普通浏览器。**提权、铸 cookie 都没用**
  （试过：拿 `.credentials.yaml` 里持久的 browser-session secret 铸合法
  `dsh-auth-*` cookie，桌面宿主照样 403 —— 门在 browser-auth **之前**）。
- **项目自带的 web 宿主**（`node test/env/host/node_modules/@deepseek-ai/dsh/lib/bin.js web`）
  **没有那道门**，只有它自己打印的 token 栅栏：无 token → 401
  `dsh web authentication required; reopen the URL printed by dsh web.`；
  `GET /?token=…` → 303 + `dsh-auth-*` cookie（`HttpOnly`）。`--port 0` 让系统挑
  端口，宿主再把**真端口连着 token** 打印出来（`dsh web: http://127.0.0.1:<port>/?token=…`），
  所以套件不必猜端口，也不会撞上操作者开着的宿主。

结论：**浏览器级检查一律对着项目自带的 web 宿主做**，不要试图绕过桌面宿主的门。

## 怎么跑

```sh
npm install                                  # 仓根：工作区依赖（typescript、cordis、dsh-tools…）
npm run build                                # plugin/src -> plugin/lib（改完源码后；门禁也会自动补）
npm run ci                                   # 仓根一条命令：build → typecheck → lint → node test/run.mjs
npm run lint                                 # 仓根 ESLint（eslint.config.mjs；产物、test/env、scratch 已忽略）
node test/run.mjs                            # 门禁两段：unit 148 项（vitest）＋ 全部密闭套件（401 项）
node node_modules/vitest/vitest.mjs run --root test   # 只跑 unit 段（约 0.6 s，改纯函数时用这个）
node node_modules/vitest/vitest.mjs run --root test --pool=threads   # 同上；受限宿主里默认 forks 池 spawn EPERM，换线程池才跑得完
node test/own-host-check.mjs                 # 需要：自带 web 宿主 + 一个挂了本插件的 home
                                             #   （默认 test/env/home，由
                                             #    test/tools/setup-env.mjs 从 env/home.seed 重建；
                                             #    用 DSH_OWN_HOST_HOME 换）
                                             #   + 显式凭据（list 真过 SSH）：
                                             #    SSH_HOST=… SSH_USER=… [SSH_PORT=…] [SSH_PASSWORD=…]
                                             #    或 VISIBLE_SSH_USE_REPO_CONFIG=1 明说就用仓里那份
                                             #    （没给就打印 {skipped: …} 并 exit 0）
                                             #   浏览器那半还要共享浏览器与 driver 在跑
```
