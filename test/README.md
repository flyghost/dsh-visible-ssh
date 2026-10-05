# `test/` —— 这个仓库的全部测试设施

`plugin/` 是包本体：源码在 `plugin/src/`（宿主侧是 `.ts`，浏览器半边 `src/client/index.js`
是手写的单文件、故意不进 tsc），构建产物在 `plugin/lib/`（gitignore），另有 `package.json`、
`tsconfig.json`、`cordis.patch.yml`、`scripts/`。测试、测试要用的运行时、以及测试生成的临时物，
全部在这一棵树里。

```
test/
  run.mjs                 唯一入口：先确认构建产物不比源码旧（必要时自己构建），再跑两层：unit 段 → 7 个密闭套件
  unit/                   ★ 127 项  vitest（9 个 spec）：纯函数、内存引擎端口、假 req/res；不 spawn、不联网、约 0.6 s
    envelope.test.mjs        信封与失败：parseEngineOutput / failureOf / BridgeError
    locate.test.mjs          "该跑哪个 CLI"：enginePackageName / resolveEngine / engineCommand 的 flag 重排（含 `--config` 注入）、三条 spawn 失败文案
    verify.test.mjs          "产物有没有被换过"：engine.lock 的缺失/坏 JSON/缺文件/字节与 sha256 不符/未登记的多余 exe
    config.test.mjs          配置解析：userConfigPath 的三个平台落点 / chooseHostConfig 的四档优先级与"存在才用" / resolveConfig 的接线（含 parseHostConfigSession 的三档来源、sshConfigPath 的落点；假 roots，不碰本机）
    ssh-config.test.mjs      只读本机 ssh 配置：Host 段的解析（键名大小写、`Key=value`、同块第一个值胜出、`Host *` 只补空）、哪些段算候选、端口校验、读不动时怎么答（喂文本与假读取器，不碰本机）
    fake.test.mjs            内存替身自身：调用日志、钉住的答复、handler 优先级
    sessions-route.test.mjs  sessions 路由：假 req/res ＋ 内存端口（list / open / kill / activate / session）
    tools.test.mjs           9 个工具注册与执行（真 defineTool ＋ 内存端口）
    spool.test.mjs           暂存目录清理：sweepSpoolDir 只收超龄的 .out/.err/.cmd、非暂存文件不动、删不掉只跳过不抛（真 fs，落 test/env/tmp）
  manifest-check.mjs      11 项  package.json / cordis.patch.yml / 导出面是否与产物一致
  engine-check.mjs        25 项  src/engine/config.ts 解析出的位置与 argv（含 `--config` 必须排在 verb 之前；纯函数级，不执行 exe）
  artifact-check.mjs      23 项  产物身份锁：按包名解析出的平台包里那三个 exe 与 engine.lock 的字节数/sha256，以及包清单
  connection-check.mjs    75 项  src/connection/connections.ts（连接存储、注入、脱敏，含 source() 的四档来源；**首次保存可以不给密码** —— 没有密码就等于这台走本机 ~/.ssh 里的密钥，交给引擎的环境里也确实没有 SSH_PASSWORD；**换当前连接的会话** setSession 只在名字合法时才写盘）＋ connection/ssh-config.ts 接到路由上的那一段（注入缝只读一次）
  settings-check.mjs      36 项  src/connection/settings.ts（面板字段的名字与默认值）
  route-check.mjs         76 项  src/index.ts 注册的 HTTP 路由（用假 ctx 记录注册结果；sessions 路由的 list / open / kill / activate / session 与它们的 400/404/502）
  client-half-check.mjs   155 项 浏览器半边：在假 DOM 上执行 lib/client/index.js（与 src 逐字相同），含面板里并排的两个下拉（「服务器」= 切换设置里那份连接清单的「当前」，「会话」= 这块屏幕在照谁：选过之后那次取屏带上 ?session=，选回第一项则不带参数，换服务器丢掉钉住的名字；不钉时第一项读「跟随当前连接／跟随宿主默认」）、被照的那一行整行高亮且小字行尾写「 · 正在镜像」（会话行上只剩「打开」「杀掉」两个动作）、取屏失败时把原因写进屏幕框而不是留白、20s 无回答就自行判超时重发、设置页那张「本机 ssh 配置里的远端」候选表与它表头的「刷新」，以及**对话框里那两格**（插进 conversation.input.left：「服务器」的 value 跟着「当前连接」、选择时置灰并发一次 {action:'activate'}（打的是 /visible-ssh/sessions）＋ 换机器顺手重读会话清单，「会话」发一次 {action:'session'}、旁边那个 ↻ 立刻重读；一台都没有就渲染 null；再选当前那台不发请求；别处切换后下一次轮询跟上；读失败写进 title）
  live-route.mjs          29 项  opt-in：把路由真的挂到 running cordis 上
  live-late-carrier.mjs    7 项  opt-in：cordis 加载器晚到时的注册生命周期
  own-host-check.mjs       8 项  opt-in：真起一台 DSH web 宿主，用真 token 过一遍门禁
  boot-graph.mjs                 opt-in：从正在跑的宿主抓「哪些东西被加载了」
  lib/                    ★ live 检查的凭据来源：live-credentials.mjs（见「与本机完全解耦」）
  README.md               本文件
  package.json            ★ 工作区成员：套件要解析的 peer 包 ＋ playwright ＋ vitest
  tools/                  跑测试用的小工具（见下）
  env/                    生成物：隔离的 DSH home、自带宿主、浏览器 profile（不进 git）
    home.seed/            ★ 受版本管理：隔离 home 的模板，setup 从这里重建
    host/package.json     ★ 受版本管理：自带宿主的版本钉子（dsh 0.2.0-rc.2）
```

带 ★ 的和 `test/*.mjs`、`test/unit/*.test.mjs`、`test/lib/`、`test/tools/` 是源码，进 git；`env/` 下其它一切都能重建。

## 怎么跑

```bash
npm install                             # 仓根：装工作区依赖（plugin/、test/、packages/engine-win32-x64 一起）

node test/run.mjs                       # 两段：test/unit/** 127 项（vitest）＋ 7 个密闭套件（401 项）
cd plugin && npm test                   # 同一件事；plugin/package.json 里指向 ../test/run.mjs

npm run build                           # 只构建插件：plugin/src -> plugin/lib
npm run typecheck --workspace dsh-visible-ssh
npm run lint                            # 仓根 ESLint（eslint.config.mjs；产物、env/、scratch 已忽略）
npm run ci                              # 本机 CI 一条命令：build → typecheck → lint → node test/run.mjs
                                        #   （在“掐掉子进程 spawn”的沙箱里，unit 段会报
                                        #    Failed to start forks worker … Caused by: Error: spawn EPERM；
                                        #    build / typecheck / lint 与 7 个密闭套件都不受影响 ——
                                        #    单元层请在普通终端跑，别当回归）

node test/tools/setup-env.mjs --check   # 测试环境还在不在？（不写任何东西）
node test/tools/setup-env.mjs           # 缺什么补什么
node test/tools/setup-env.mjs --force   # 重装依赖 + 从 seed 重建隔离 home
```

密闭套件不需要 DSH、不需要网络、不需要 SSH，也不需要 SSH 引擎之外的任何东西；它们读的是
**构建产物** `plugin/lib/`，所以 `run.mjs` 会先确认产物不比 `src/` 旧（旧了或缺失就跑
`plugin/scripts/build.mjs`；构建要仓根的 typescript，缺了会给一句明确的失败）。
`live-*`／`own-host-check`／`boot-graph` 都在台账里、但**默认不跑**（它们要么要真 DSH 运行时，
要么要一台能连的远端主机，要么要人先起浏览器）。

## 两层

**unit 层（`test/unit/**`，vitest）** 只碰纯函数与内存端口：信封解析、CLI 定位
（`enginePackageName` / `resolveEngine`）、`verify.ts` 的产物锁校验（字节与 sha256、未登记的多余 exe）、
配置解析（`userConfigPath` / `chooseHostConfig` / `resolveConfig` —— 用假 roots，
**不读本机任何目录**）、
内存引擎替身本身、三条路由里的 sessions 那条（假 req/res ＋ 假连接），以及 9 个工具的注册与执行
（真 `defineTool`）。
不 spawn 进程、不联网、不碰 SSH，也不用起宿主 —— 一整段约 0.6 s。边界就是
`plugin/src/engine/port.ts` 的 `EnginePort`：`plugin/src/index.ts` 造一次真端口，
测试造一次假端口（`plugin/src/engine/fake.ts`），两边走同一批调用点
（`registerTools(ctx, cfg, connections, engine)`、`registerWebRoutes(ctx, cfg, connections, engine)`）。

**e2e 层（顶层那批套件，仍是手写 runner ＋ 台账）** 恰好相反：`live-*` 要真 cordis 与真 SSH，
`own-host-check` 要真起一台 web 宿主，`boot-graph` 要一份浏览器 user-data。它们**留在原地**，
没有搬进某个 `tests/e2e/`：台账、路径与文档早已围着它们写，少搬一次就少散一次路径。
unit 段只是被 `run.mjs` 接在这些套件前面的第二段 —— 台账守卫仍只比对 `test/*.mjs` 这一层，
所以 `test/unit/*.test.mjs` 不进 `HERMETIC`/`OPT_IN` 名单。

## 需要人配合的部分

**离线套件与 `live-*` 都不依赖本机装过 DSH**：它们要的 DSH 运行时（`@deepseek-ai/dsh`
及其 `dsh-host-webserver`）装在仓内 `test/env/host/node_modules`，由 `test/tools/setup-env.mjs`
装上；`live-*` 默认就从这个目录取，`DSH_APP` 只是给"换成别的安装树"留的开关。

| 套件 | 前提 | 没有前提时 |
| --- | --- | --- |
| `live-route.mjs` | 仓内 DSH 运行时（`test/env/host`，可用 `DSH_APP` 换）＋ 一台能连的远端主机，**凭据必须显式给**（`SSH_HOST`/`SSH_USER`，或 `VISIBLE_SSH_USE_REPO_CONFIG=1` 明说就用仓里那份） | 打印 `{skipped: …}` 并 exit 0（顺带告诉你怎么给） |
| `live-late-carrier.mjs` | 同上（不需要远端主机） | 打印 `skipped` |
| `own-host-check.mjs` | `test/env/host`（自带宿主）＋ `test/env/home`（隔离 home）＋ 显式凭据（同上）。**浏览器半边**还要有人先起共享浏览器 | 缺宿主/home/凭据则 `skipped`；缺浏览器则 8 项全绿、verdict 里注明 `browser half skipped` |
| `boot-graph.mjs` | `DSH_USERDATA` 指向一个 Chromium user-data 目录，或把缓存目录当第一个参数给它 | 打印 `skipped` —— 它**不替你去猜** `%APPDATA%` |

起浏览器是**必须由人做**的一步，因为 Chromium 的 Mojo IPC 走命名管道，而 agent 的
受限沙箱拒绝命名管道（浏览器会以 `FATAL:mojo/.../platform_channel.cc: Check failed:
拒绝访问 (0x5)` 死掉）。人起、agent 经 TCP 附着：

```
test\tools\start-agent-browser.cmd      # 人：起 Edge/Chrome，开 --remote-debugging-port=9222
node test/tools/driver.mjs              # agent：控制口 http://127.0.0.1:7743/
```

## 与本机完全解耦（可强制）

"密闭层不碰本机"不是自觉，而是 `run.mjs` 在跑任何东西**之前**执行的三道动作
（前两道管"测试层不认识这台机器"，第三道是反过来的：安装入口不许认识测试环境）：

1. **静态扫**：把 7 个密闭套件 ＋ `test/unit/*.test.mjs` 的源码过一遍本机状态名字 ——
   `homedir(`／`USERPROFILE`／`APPDATA`／`LOCALAPPDATA`／`.agents`／`.dsh/`。
   命中就打印 `FAILED: a hermetic suite touches this machine — …` 并 exit 1，
   报告里列出是哪个文件、撞上了哪个词。真需要外部东西的检查属于 OPT_IN 名单，不该躲在密闭层里。
2. **动态剥**：跑密闭套件与 unit 段时，子进程环境里删掉 `DSH_HOME`/`DSH_OWN_HOST_HOME`/
   `DSH_SESSION_ID`/`DSH_WEB_URL`/`DSH_SHELL`/`DSH_PATH_DIALECT`/`DSH_APP`/`DSH_USERDATA`/
   `SSH_HOST`/`SSH_PORT`/`SSH_USER`/`SSH_PASSWORD`/`SSH_CONFIG`，
   再把 `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 指到空的 `test/env/tmp/decoupled/home`、
   `TMP`/`TEMP`/`TMPDIR` 指到 `test/env/tmp/decoupled/tmp`。于是"偷偷读一次家目录"也只能读到空目录。
   `run.mjs` 的报告里有一节 `decoupled`，写着这次剥了什么、扫了哪些文件。
3. **反向扫**：仓根 `scripts/` 下那几个人运行的安装入口（今天只有 `scripts/install-local.mjs`）
   的源码里不许出现指向测试树的路径写法（正则 `test[\\/]`）。命中就打印
   `FAILED: an install entry writes a path into the test tree — …` 并 exit 1，报告里列出
   哪个文件、撞上哪个词。理由同样是"两条路互不认识"：装桌面 profile 的那条只认真实桌面家、
   家在仓内就整棵拒绝（所以它本来不需要点名任何目录），反过来也不该有任何一个入口把仓内的
   测试家当成真的家 —— 会写成那种路径的，基本就是"顺手拿隔离家试一下"这种幻觉。
   **扫描范围不含 `plugin/scripts/**`**：那些是构建/取件工具，会合法地给人打印
   `next: node test/run.mjs` 这类提示。

**`live` 层的凭据也一律显式**（`test/lib/live-credentials.mjs`，`live-route` 与 `own-host-check` 共用）：

- `SSH_HOST=<host> SSH_USER=<user> [SSH_PORT=<port>] [SSH_PASSWORD=<password>]`：
  把 host/port/user 现写成 `test/env/tmp/<name>/config/host.toml`（**不含密码**），
  再把 `SSH_CONFIG` 指过去 —— 它同时是插件认的"CLI 自己的配置"，也是引擎会拿到的那份
  （插件把它作为 `--config <绝对路径>` 交给引擎；实测 `HOSTCFG_ENV_CONFIG` 这个名字引擎
  根本不看，所以不设它）。密码只走进程环境。实测这样引擎照样连得上，`known_hosts` 也不需要跟着搬。
  **但有一处会外溢**：引擎 v0.0.1 起用的是 `%USERPROFILE%\.ssh\known_hosts`（旧构建才是 `--config`
  同目录那份），所以跑真连接时它可能往操作者真家的 `known_hosts` 添一行主机密钥（`accept-new`）。
  引擎支持 `--known-hosts <path>`，但插件目前不传 —— 要完全封住就把这一条接上。
- `VISIBLE_SSH_USE_REPO_CONFIG=1`：明说就用仓里那份 `scripts/config/host.toml` ——
  它带着真密码，所以这条路必须由人主动打开。
- 两者都没有 → `{skipped: …}`（连"怎么给"一起打出来），**不猜、不借**：没有任何检查
  会去读你的 `~/.dsh` 借一份 profile 的字段。三个小工具同理：`mint-dsh-cookie.mjs`
  要 `DSH_CREDENTIALS` 或 `--credentials`，`boot-graph.mjs` 要 `DSH_USERDATA`，
  `driver.mjs` 可以用 `VISIBLE_SSH_BROWSER` 直说浏览器在哪。

起点是 `plugin/src/connection/connections.ts:597-609` 的 `source()`：它只认"有激活 profile"
或"`SSH_CONFIG`／插件解析出的那份 `host.toml`"，插件自己**从不**去翻家目录找连接档案；
它唯一读家目录的地方是设置页那张**只读**候选表（`plugin/src/connection/ssh-config.ts` 读
`~/.ssh/config`，只列 `Host` 段、只取别名/hostname/user/port/identityFile 路径，绝不读私钥内容），
而那条路在测试里是靠**注入缝**（`ConnectionHandlerOptions.sshHosts`）替换掉的，所以套件碰不到真机。测试侧把这条变成显式的。

## 隔离的含义

隔离指的是**绝不碰操作者真实的 `~/.dsh`**，不是「不碰外部」：密闭套件确实什么都不要，
但 `live-*` 天生要真 DSH 应用和真远端主机，`own-host-check` 要真起一台宿主。

- 宿主只在 `test/env/home/` 里启动（`DSH_HOME` 指向真家时，`own-host-check.mjs` 会
  直接 `skipped`，而不是硬跑）。
- 那个 home 由 `test/env/home.seed/` 重建，里面没有密码：宿主用 `--port 0` 起、
  自己把带 token 的 URL 打到 stdout，检查就是从那里取的。
- 连接资料**没有隐式来源**：`own-host-check.mjs` 只用当场给的 `SSH_HOST`/`SSH_USER`
  （种进隔离 home 的那条 profile 也只含这些字段，`secrets` 里绝不含密码），
  或隔离 home 里本来已有的那条 —— 绝不从操作者真家借。
- 依赖装在仓内（工作区根 `node_modules/`、`test/node_modules/`、`test/env/host/node_modules/`），
  用的是仓内 npm cache（`scratch/cache/npm-cache`），不写操作者的全局 cache。

## `test/tools/` 里都是什么

| 工具 | 用途 |
| --- | --- |
| `setup-env.mjs` | 装依赖、从 seed 重建隔离 home、修好 home 里指向插件的 profile 链接 —— 就是本文档上面那三条命令 |
| `rmtree.mjs` | **删树必须用它**：它遇到目录链接只删链接本身。`rm -rf` 会穿过 junction 删掉目标内容（实测会把插件或 500 MB 依赖树删掉） |
| `driver.mjs` | 驱动共享浏览器（agent 侧）：控制口 7743，`/status /events /tabs`、`POST /attach /goto /reload /eval /shot /watch`；截图落 `test/env/evidence/shots/`。`VISIBLE_SSH_BROWSER=<path to browser.exe>` 可以直接点名，省掉"猜浏览器装在哪" |
| `start-agent-browser.cmd` | 人侧：用专用 profile 起浏览器，开 CDP 9222 |
| `start-chrome-agent.cmd` | 同上，换 Chrome 与另一个 profile |
| `start-chrome-real-profile.cmd` | 用**操作者真实** profile 起浏览器（端口 9223，只做人工对照用） |
| `launch-agent-browser.ps1` | 经 `WmiPrvSE.exe` 起浏览器，绕开 agent 的沙箱 job object |
| `beacon.mjs` | 一个只绑 loopback 的小服务：验证「改了 `plugin/lib/client/index.js` 之后，正在跑的 GUI 会不会重新执行那些字节」（热更） |
| `mint-dsh-cookie.mjs` | 从 `DSH_CREDENTIALS=<path>`（或 `--credentials <path>`）指的 `.credentials.yaml` 派生 `dsh-auth` cookie，用于人工调试（只打印派生名，绝不打印 secret；不给路径就停下，**不猜** `~/.dsh`） |
| `preflight-dsh-tools.mjs` | 用**真的** `defineTool` 过一遍 `registerTools`，再真跑几个只读工具；验证插件与当前 `dsh-tools` 的契约 |
| `loopback-probe.mjs` / `pipe-probe.mjs` | 两个小探针，分别回答「能不能绑 loopback / 能不能用命名管道」 |

## 依赖住在哪

仓根是一个 npm workspaces（三个成员：`plugin`、`test`、`packages/engine-win32-x64`，
加根 `package-lock.json`）。`npm install` 在仓根跑一次，三边的依赖都提升到 `<repo>/node_modules/`：

- `plugin/` 顶层就 `import '@deepseek-ai/dsh-tools'`（`plugin/src/tools/index.ts`），
  Node 从 `plugin/src/` 往上找 `node_modules`，第二站是仓根 —— 插件**没有也不需要**自己的
  `node_modules`。它曾经是指向 `~/.dsh/profiles/node_modules` 的符号链接，那让这个仓库不可移植。
- 引擎平台包 `packages/engine-win32-x64` 也被链到仓根（`node_modules/dsh-visible-ssh-engine-win32-x64`
  → `packages/engine-win32-x64`），所以 `plugin/src/engine/locate.ts` 的按包名解析在开发期
  与"装到别的机器"走的是同一条路：三个 exe 不进 git，只有 `engine.lock` 与包清单在版本里。
- `playwright` 是 npm 不提升的那个（`test/node_modules/`），所以 `test/tools/*.mjs` 从
  `test/tools/` 往上找的第一站 `test/node_modules/` 正好命中。
- 自带宿主是独立的第三棵树（`test/env/host/`，有自己的 `package.json` 与 lock），
  不在 workspaces 里。

`.gitignore` 忽略 `node_modules`（不带斜杠，为的是连链接一起忽略），也忽略 `plugin/lib/`
（构建产物）与 `test/env/` 下的生成物。`test/` 与 `plugin/` 这两棵树**只在本仓存在**：
前者装着几百 MB 依赖树，还有隔离 home 里那份真实凭据副本；后者装着依赖树宿主。
