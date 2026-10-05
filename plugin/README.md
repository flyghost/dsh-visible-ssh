# dsh-visible-ssh

把 AI 在远端主机上执行的命令，**送进一个人正附着的 tmux pane**。

重点不是「通过 SSH 跑命令」，而是：模型敲的每个字符都落在人能实时看见、随时能 Ctrl-C 接管的那个 pane 里。
这个性质来自 tmux 本身，所以本插件不自己实现传输，只驱动那个编译好的引擎（平台包 `packages/engine-win32-x64/visible-ssh.exe`）。

```
   DSH 宿主（本机）                          远端主机
   ┌──────────────────────────────────┐      ┌────────────────────────────┐
   │ 插件宿主半  src/**/*.ts → lib/    │      │  tmux server               │
   │   9 个工具 ＋ 3 条浏览器路由       │ SSH  │   └─ pane (bash)            │
   │   engine/exec = 唯一的开进程点   │ ───► │        AI 用 send-keys 打字 │
   ├──────────────────────────────────┤      │        再用 capture-pane 读 │
   │ 插件客户端半  src/client/          │      └────────────────────────────┘
   │   右侧栏面板（2s 轮询 screen）     │
   └──────────────────────────────────┘
   人：ssh -t … tmux attach —— 附着的是**同一个 pane**，看得见每个字符，随时能接管
```

## 目录

- [1. 由哪几部分组成](#1-由哪几部分组成)
- [2. 安装](#2-安装)
- [3. 环境依赖（本机）](#3-环境依赖本机)
- [4. 远程服务器需要什么](#4-远程服务器需要什么)
- [5. 装好之后得到什么](#5-装好之后得到什么)
- [6. 排错](#6-排错)
- [7. 开发与测试](#7-开发与测试)

---

## 1. 由哪几部分组成

**宿主加载的是产物 `lib/`，不是这里的源码。** 宿主侧源码是 TypeScript（`src/**/*.ts`，
由 `tsconfig.json` 管），`npm run build` 把它编到 `lib/`（gitignore）；浏览器半边是**手写的
`.js`**（`src/client/index.js`），故意不过 tsc，由 `plugin/scripts/copy-client.mjs` 逐字拷到
`lib/client/index.js`。下表写的是**源码**路径；判断「改完什么时候生效」看最后一列。

| 文件 | 角色 | 改完要重启宿主？ |
|---|---|---|
| `src/index.ts` | 宿主半入口：只做注册 | 要 |
| `src/tools/index.ts` | 9 个模型工具的签名/描述/渲染 | 要 |
| `src/routes/index.ts` | 三条浏览器路由：镜像 `GET /visible-ssh/screen`（只读，`?session=` 指定照哪个 tmux 会话）、连接读写 `GET/POST /visible-ssh/connection`、面板动作 `GET/POST /visible-ssh/sessions` | 要 |
| `src/connection/connections.ts` | 连接从哪来：设置页保存的 profile、凭据域里的密码、注入子进程的 `SSH_*` | 要 |
| `src/shared/session-name.ts` | tmux 会话名校验（路由层与连接层共用） | 要 |
| `src/client/index.js` | 客户端半（浏览器）：右侧栏面板 = 两个下拉（服务器／会话）+ 会话行（打开/杀掉）+ 屏幕，**手写、不进 tsc**（由 `scripts/copy-client.mjs` 逐字拷成 `lib/client/index.js`） | **看宿主**，见 [§2.4](#24-什么时候生效) |
| `src/engine/exec.ts` ＋ `src/engine/locate.ts` ＋ `src/engine/verify.ts` | 唯一开进程的地方（`createEnginePort(cfg)`，管道／spool 两条路）＋「该跑哪个 CLI」（按包名解析产物、argv 翻译）＋「产物是不是被换过」（按 `engine.lock` 核字节数与 `sha256`） | 要 |
| `src/engine/port.ts` | 那个接口本身（`EnginePort`/`EngineOptions`，不 import 任何东西）—— 测试靠它换成内存替身 | 要 |
| `src/engine/fake.ts` | 内存替身：喂 argv 得到确定的答复，并记下每次调用（只给测试用） | 不用 |
| `src/engine/envelope.ts` | 信封与失败：`parseEngineOutput`/`failureOf`/`BridgeError`（纯函数） | 要 |
| `src/approval/index.ts`、`src/engine/project.ts`、`src/engine/config.ts` | 审批接缝 / 纯投影 / 配置推导 | 要 |
| `packages/engine-win32-x64/`（**在仓库里，不在本包里**） | **引擎的平台包 `dsh-visible-ssh-engine-win32-x64`**：编译产物（C 引擎，名字沿用历史），空闲门禁 / 按 session 隔离的退出码槽 / 提示符解析都编在里面；包清单的 `files` 只带三个 exe ＋ `engine.lock` ＋ 它的 `README.md`。插件在 `optionalDependencies` 里申报它、**按包名**解析 | **不用** |

### 目录长什么样

`src/` 按**子系统**分目录，目录名就是那一层的职责；文件名不再重复子系统前缀
（`screen.js` → `routes/index.ts`、`tools.js` → `tools/index.ts`、
`settings-namespace.js` → `connection/settings.ts`、`approve.js` → `approval/index.ts`）——
只有目录的入口才叫 `index.js`。所以看到 `routes/` 就知道是浏览器那条路，看到
`engine/` 就知道是跟引擎打交道的地方。

```
plugin/
├─ package.json            清单：main/exports 指向 src/、peer 范围、dsh.bundle 补丁、构建脚本
├─ tsconfig.json           宿主侧的编译设置（NodeNext；`src/client` 被 exclude）
├─ cordis.patch.yml        插件往 profile 里插入的那一条（只有 id 与包名）
├─ scripts/build.mjs       构建入口（调 tsc）→ copy-client.mjs（逐字拷，不做转译）
├─ lib/                    **产物**（gitignore）：宿主侧 .js/.d.ts ＋ client/index.js
├─ README.md  AGENTS.md    这一层的说明与硬性规矩
└─ src/
   ├─ index.ts             组合根：注册 tools 与 routes、采纳 settings、re-export
   ├─ engine/              与引擎之间的接缝（不 import 其他子系统）
   │  ├─ port.ts           接口：EnginePort / EngineOptions / ChildEnv（零 import 的叶子）
   │  ├─ exec.ts           真实现：createEnginePort —— 开进程、管道/spool 两条路、解析
   │  ├─ locate.ts         「该跑哪个 CLI」：engineCommand 的 argv 翻译 ＋ 两条失败文案
   │  ├─ verify.ts         按平台包里的 engine.lock 核对三个 exe 的字节数与 sha256（spawn 之前）
   │  ├─ envelope.ts       信封与失败：parseEngineOutput / failureOf / BridgeError（纯函数）
   │  ├─ fake.ts           内存替身（只给测试用）：钉住答复、记下调用
   │  ├─ config.ts         配置默认值与路径真源：chooseHostConfig() 选哪份 host.toml、sshConfigPath 落在哪、[host] session 怎么读
   │  └─ project.ts        把引擎的 snake_case 信封投影成 camelCase（纯函数）
   ├─ connection/          连接与设置从哪来
   │  ├─ connections.ts    连接档案、密码域、注入子进程的 SSH_*
   │  ├─ settings.ts       「设置 → visible-ssh」命名空间（读写走 connections.ts）
   │  └─ ssh-config.ts     只读本机 ~/.ssh/config，把配好的 Host 段列成设置页的候选（不写、不改）
   ├─ routes/index.ts      三条 /visible-ssh/* 浏览器路由
   ├─ approval/index.ts    破坏性动作的审批接缝（fail-closed）
   ├─ tools/index.ts       9 个模型工具的声明（defineTool）
   ├─ shared/session-name.ts  tmux 会话名校验（路由层与连接层共用）
   └─ client/index.js      浏览器半：不进 tsc，只 require('react')；由 copy-client.mjs 逐字拷到 lib/client/index.js
```

**依赖方向是单向的**（箭头 = "import 了"）：

```
组合根   src/index.ts
           ├─ tools/index.ts ────────────┐
           ├─ routes/index.ts ───────────┼─► 也直接用 engine/* 与 shared/*
           └─ connection/settings.ts ────┴─► connection/connections.ts ─► shared/
              approval/index.ts（审批接缝，被 tools/ 用）
                        │
   基础层   src/engine/{port,envelope,locate,verify,exec,fake,config,project}.ts ＋ src/connection/ssh-config.ts ＋ src/shared/session-name.ts
            —— 只有这些是"叶子"：它们不 import 上面任何东西（`port.ts` 连包外的都不 import）

   旁挂     src/client/index.js  浏览器半：不发 import、只 require('react')，与上图无关
```

改一处时先看它在哪一层：**叶子层的改动影响面最大**（`engine/` 一动，工具与路由同时受影响），
而 `client/` 与宿主侧完全解耦（它拿不到、也不需要宿主模块）。

### 建议的读序

想搞懂这套东西（而不是只改一行），按这个顺序读：

1. `package.json` —— 它声明了什么：`main`/`exports` 指向哪、peer 范围、`dsh.bundle.patch`。
2. `src/index.ts` —— 一百多行，把整套系统接起来的那几行。
3. `src/engine/` 按"读的顺序"—— 「插件怎么和引擎说话」：`config.ts`（配置解析：默认值、两层路径，以及**这次读哪份 `host.toml`**）→ `locate.ts`（该跑哪个 CLI：按包名解析平台包 ＋ argv 翻译 ＋ 把选中的 `host.toml` 作为 `--config <绝对路径>` 插到最前）→ `verify.ts`（按锁核对产物）→ `exec.ts`（唯一开进程）→ `envelope.ts`（信封纯函数）→ `project.ts`（信封投影）。本仓最核心的接缝。
4. `src/connection/connections.ts` → `src/connection/settings.ts` → `src/connection/ssh-config.ts` —— 连接与密码从哪来、怎么进子进程，以及设置页那张"本机 ssh 配好的远端"候选表（只读那个文件，纯便利）。
5. `src/approval/index.ts` —— 哪个 verb 需要人点一次同意。
6. `src/tools/index.ts` → `src/routes/index.ts` —— 两个门面：模型看到的 9 个工具、浏览器看到的 3 条路由。
7. `src/shared/session-name.ts` —— 一个小而关键的校验（顺手看）。
8. `src/client/index.js` —— 828 行、**不进 tsc** 的浏览器半（`scripts/copy-client.mjs` 逐字拷成 `lib/client/index.js`）；**最后读**，它自成一套。

本插件**不打包引擎本体**，而是在 `optionalDependencies` 里申报**平台包** `dsh-visible-ssh-engine-win32-x64`，运行时**按包名**解析到它的目录（`src/engine/locate.ts`）。引擎是**产物**——由引擎项目（omnibus 的 vssh 产品）构建、发成 Release，本仓用 `node plugin/scripts/engine-fetch.mjs --tag <vX.Y.Z> --install --lock` 取一组装进 `packages/engine-win32-x64/`（现在这组是 Release `v0.0.1` / 上游 commit `4d729fe`）；本仓不再存放引擎源码或构建脚本。开发期这个解析落到工作区链接、装到别的机器落到同层 `node_modules/`，**两边走同一条路径**，所以不用配 `exeEntry`。

⚠️ **引擎的三个文件必须同目录**：`visible-ssh.exe` ＋ `visible-ssh-askpass.exe`（替 ssh 回答密码提示）＋ `visible-ssh-launch.exe`（`watch` 弹可见窗口）。引擎按 **exe 所在目录**找这两个助手，少一个会**响亮报错**，不会静默降级。**三个 exe 不进 git 跟踪**——**新克隆的仓库里没有它们**；缺了插件会明确报错，并指向 `docs/engine-artifacts.md`（常规解法是 `engine-fetch.mjs --install --lock`；上游只给散文件时才手工拷齐 ＋ `node plugin/scripts/engine-lock.mjs` 重算锁）。插件在 spawn **之前**还会按包里的 `engine.lock` 核对字节数与 `sha256`（`src/engine/verify.ts`），被换过或拷了一半就**拒绝启动**，而不是拿旧产物静默跑出奇怪结果。

**这条路径不允许 Python**：插件只把 argv 交给编译产物，`src/engine/locate.ts` 的 `engineCommand()` 是唯一翻译点。
`engine: 'python'` 这条**待命**路径仍留在代码里，但参照实现已随引擎源码迁去引擎项目，要用就得显式给 `pythonEntry`。
另外 `--timeout` 这类 flag **必须写在 verb 之前**，否则会被**当成命令的一部分**执行。

---

## 2. 安装

### 2.1 前置（本机）

- DSH **0.1.5-rc.x 或 0.2.0-rc.x**（实测 0.1.5-rc.2 / Desktop 2.0.13 与 0.2.0-rc.2 / Desktop 2.0.17）。本包 peer 要求 `@deepseek-ai/cordis ^4.0.2` 与 `@deepseek-ai/dsh-tools ^0.1.5-rc.1 || ^0.2.0-rc.2`，二者由宿主 bundle 提供 —— **运行时不需要任何 `dependencies`**。开发时要装的是**仓根工作区**（`npm install`，一次；换来 `typescript` 等构建工具），见 [§7](#7-测试)。
  这两条范围**不是装饰**：profile 启动时 `dsh-app-boot` 会拿 peer 里每个 `@deepseek-ai/dsh*` 项去比对当前运行时版本，**不满足就把整个 bundle 静默丢掉**（宿主只打印 `skipping profile bundle "dsh-visible-ssh": … is incompatible with dsh <version>`），插件本身仍安好。所以运行时换 tuple（0.1.5 → 0.2.0）时必须同步放宽这里的范围，否则表现为「插件没加载」。
- **产物**：平台包 `dsh-visible-ssh-engine-win32-x64`（住在 `packages/engine-win32-x64/`，由本包的 `optionalDependencies` 拉进来，`os`/`cpu` 只匹配 win32-x64）：`visible-ssh.exe` ＋ `visible-ssh-askpass.exe` ＋ `visible-ssh-launch.exe`（单文件自包含，无运行时依赖；由引擎项目产出后整组拷入，见 `docs/engine-artifacts.md`）。**三个 exe 不进 git 跟踪**，所以新克隆的仓库要先取一组：常规办法是 `node plugin/scripts/engine-fetch.mjs --tag v0.0.1 --install --lock`（从上游 Release 取，按锁里的三把锚核对），也可以把整组拷进来，或从 `npm run pack:engine` 出的 tarball 装。
- **构建**：宿主与测试加载的都是 `lib/`（`package.json` 的 `exports` 指过去），所以**装之前或改完源码之后要先构建**：仓根 `npm install`（工作区的 `prepare` 会顺带构建一次）或 `npm run build`。`plugin/lib/` 是 gitignore 的产物，不会随仓库一起拿到。
- Node **>= 20**（`engines`）。
- 引擎的**参照实现**与它的测试（Python + paramiko）**不随本仓提供**，随引擎源码在引擎项目里——插件这条路只跑编译产物，不需要 Python。
- 远端凭据写在**插件这次选中的那份 `host.toml`**：开发期就是仓内 `scripts/config/host.toml`（已 gitignore；模板 `scripts/config/host.toml.example`），装好后又住用户目录 `%APPDATA%\visible-ssh\host.toml`（其它平台 `$XDG_CONFIG_HOME/visible-ssh/host.toml`）。哪份算数见下面「可配置项」的 `configPath` 与 §3 的「连接从哪里来」。

### 2.2 用官方 CLI 装（推荐）

```powershell
dsh plugin --profile web add link:E:/GitHub/me/ssh/plugin
```

> **本机现状（2026-10-02）**：桌面 web profile 里曾经有过的那条 `link:` **已经摘除**
> （`dsh plugin --profile web remove dsh-visible-ssh`），所以桌面里在下次启动后**不再有**这个插件；
> 要重挂就照上面这条命令。摘除只影响"桌面里看不看得见"：构建、测试、`own-host-check`
> 都不依赖它（隔离家 `test/env/home` 的 profile 自己挂了同一个插件）。
> 摘它的理由：`link:` 记的是**开发机绝对路径**，而最终要装到别的机器上。

那次摘除的细节（留个可回溯的记录）：

```powershell
node "<DSH app>\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web remove dsh-visible-ssh
# pnpm v11.8.0，离线（downloaded 0），2.1s，exit 0；输出里那一行是：
#   - dsh-visible-ssh link:E:/GitHub/me/ssh/plugin
```

之后核过四件事：profile 的 `dependencies` 与 `dsh.profile.bundles` **两处**条目都没了；
`pnpm-lock.yaml` 与 `node_modules/.pnpm/lock.yaml` 已重写；`node_modules/dsh-visible-ssh` 那个
符号链接**手工删掉**（pnpm 只改清单，链接留在原地）；`--dump-config` 的组合结果里
`visible-ssh` **零命中**（exit 0）。备份在仓外 `E:\GitHub\me\_archive\profile-web-20261002\`
（`package.json` ＋ `pnpm-lock.yaml`）。整机 `~/.dsh` 里剩下的命中全是历史 session 缓存与
`.plugin-manager/logs/*`，不是配置。

> **2026-10-05 更新**：桌面 web profile 里**又有**这个插件了 —— `dsh-visible-ssh:
> link:E:/GitHub/me/ssh/plugin`（用本仓仓根的 `scripts/install-local.mjs` 装的，见 §2.5）。
> 上面那段"已经摘除"只描述当时的状态；桌面里要生效仍然得**完全退出再打开**。

另注：**仓内的隔离 seed 不受影响** —— `test/env/home.seed/profiles/web/package.json` 写的是
`link:__REPO__/plugin`，由 `test/tools/setup-env.mjs:131` 在生成时替换成仓路径，所以提交进版本管理的
种子文件里**没有**开发机绝对路径。

`dsh plugin --profile <name> <args...>` 是一个**薄的 pnpm 转发器**（`@deepseek-ai/dsh/lib/plugin-*.js`）：首次使用会初始化 profile，然后在 profile 目录里跑 `pnpm <args...>`，最后**按安装状态**对账 `dsh.profile.bundles`。

本包声明了 `dsh.bundle.patch`（`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`），所以对账时它会**自动加入 profile 的 bundle 栈**——`cordis.patch.yml` 里那条 `insert` 就是插件自己的挂载行，**不需要手改 profile 的任何文件**：

```yaml
- insert:
    - id: visible-ssh
      name: 'dsh-visible-ssh'
```

`add` 后面的参数原样交给 pnpm，所以下面这些都行：`link:E:/GitHub/me/ssh/plugin`、`E:/GitHub/me/ssh/plugin`、`./plugin-0.0.1.tgz`。

### 2.3 手工装（等价；CLI 不可用时）

在 `<DSH_HOME>/profiles/<name>/package.json` 里加两处（`<DSH_HOME>` 实测为 `C:\Users\<user>\.dsh`，可用环境变量 `DSH_HOME` 覆盖）：

```json
{
  "dependencies": { "dsh-visible-ssh": "link:E:/GitHub/me/ssh/plugin" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-visible-ssh"] } }
}
```

然后在 profile 目录里 `pnpm install`。`bundles` 的顺序就是图层顺序，第三方插件放在官方 bundle 之后。

### 2.4 什么时候生效

分三种情况，**都是实测**（2026-09-23）：

| 改什么 | 生效方式 |
|---|---|
| `src/client/index.js`（客户端半；宿主加载的是 `lib/client/index.js`）· **桌面版宿主** | **约 1 秒自动热更**，不用刷新、不用重启。宿主里的 `dsh-client-hmr` 以 500ms 轮询每个客户端 bundle 的 mtime/size，变了就调 `clientModules.rebuilt(id)` 换掉该 bundle 的 rev，并经 `/plugins/events` 让浏览器半**就地**换掉那个模块（实测：埋点证明 bundle 被重新求值，且 `apply(ctx)` 也重跑了一遍） |
| `src/client/index.js`（客户端半；宿主加载的是 `lib/client/index.js`）· **普通 `dsh web` 宿主** | 宿主半同样会换 rev，但那种宿主的浏览器半**不会自动应用**：**手动刷新页面**即可拿到新字节（实测：改完不刷新看不到；刷新后立刻看到）。⚠️ 反过来说——**没有 HMR 换 rev 时"只刷新"是不够的**：客户端 bundle 在宿主启动时快照，响应带 rev 且声明 immutable，刷新拿到的还是旧字节 |
| 其余 `src/**/*.ts`、`package.json` | 先 `npm run build`（宿主加载的是 `lib/`），再**必须重启宿主**（宿主半的模块在组合期定型，没有 HMR）。Desktop 重启应用；CLI 重启 `dsh --profile web`。改 `src/client/index.js` 也一样要 build，只是 build 之后有 HMR |

改引擎二进制**不用**重启：插件每次调用都新起进程。

### 2.5 一条命令装本机（仓根 `scripts/install-local.mjs`）

上面那几条手工命令的打包版：它自己找到 `dsh`、从 `dsh.cmd` 里问出它用的 `DSH_HOME`、构建产物、
缺 exe 就取一组、按你选的形式装进去，最后**按运行时同一条路**复验一遍。

**双击也行**：`scripts\安装到本机.bat` 只做两件事 —— 看 `node` 在不在，然后把参数原样转给这个
`.mjs`（中文全由 Node 打印，所以那个 `.bat` 自己的正文是纯 ASCII，靠 `chcp 65001` 让中文不乱码；
双击给不出参数时它会 `pause`，用 `--list-dsh`／`--check` 这类带参数的方式跑则直接退出）。
装完记得**完全退出 DSH Desktop 再打开**，宿主才加载新产物。

**它住在仓根 `scripts/`，与测试环境分开**：测试那套在 `test/`（`node test/run.mjs`），安装这条
只认真实桌面家 —— 家的路径只要落在本仓里就一律拒绝（仓内的家只给隔离/测试用）。两个方向各有一道
静态守卫：`test/` 那边不许出现这台机器的家，安装入口这边不许写出指向测试树的路径。

**本机装了不止一个 DSH 时它会先问你装哪个。** 脚本扫两处：PATH 上的 `where dsh`，以及各产品目录下的
`<APPDATA>\<产品>\host-commands\<bucket>\generations\<代>\bin\dsh.cmd`（**产品目录名是通配的**，
不写死 `DSH Desktop`，社区版换个目录名也找得到）。装到哪儿只由选中的那个 `dsh.cmd` 里
`set "DSH_HOME=…"` 决定，所以列表**按「家」归并**：`DSH_HOME` 相同的多个 CLI 只算**一个**目标
（条目下会写"同一个家的另外 N 个 CLI"），组内取最新的那个当代表。每个目标会显示产品名 · 哪个桶 ·
那代的时间 · 产品版本（从 `resources\app\package.json` 读）· 家 · 该家有没有 `profiles/<profile>` ·
是不是已经装过本插件。只有一个目标就直接用，不问你；读不到输入（比如双击时把 stdin 关了）就退出，
**不会静默替你猜一个**。

```powershell
node scripts/install-local.mjs              # link 装进 web（默认；开发用，build 完就热更）
node scripts/install-local.mjs --file       # 拷进 profile（不打包、不碰网络）
node scripts/install-local.mjs --tarball    # 打成两个 tgz 再装（第三方拿到本仓后走的就是这条）
node scripts/install-local.mjs --list-dsh   # 只列出本机所有 DSH（按家归并）与各自装没装，然后退出
node scripts/install-local.mjs --pick 2     # 直接选第 2 个目标（不想回答提问时用）
node scripts/install-local.mjs --check      # 只看装没装、能不能用（不改任何东西）
node scripts/install-local.mjs --dry-run    # 只打印要跑的命令
```

想完全绕开选择就用 `--dsh <dsh.cmd 路径>`：给了它，脚本不扫也不问。

复验查的是：清单里的依赖 ＋ `dsh.profile.bundles` 里那一项 ＋ 装在哪（`realpath`）＋ 客户端产物
字节数 ＋ 按 `realpath` 解析平台包 ＋ 跑一次 `visible-ssh.exe version` 要求 `"ok":true`。
（**必须从 `realpath` 建 `createRequire`**：`link:` 装出来是 junction，从它的字面路径解析平台包会
解不到仓里那份 —— 宿主加载链接里的模块时 Node 解的是真实路径，本脚本第一版就错在这里。）

⚠️ **`link:` 装过之后，别让 pnpm 去"换掉"那条依赖**（2026-10-05 实测；本脚本的第一版就是被它吃掉的）。
profile 里的 `node_modules/dsh-visible-ssh` 是**指向本仓 `plugin/` 的 junction**，而 pnpm 在把这条
`link:` 依赖换成别的形式（`file:`／tarball／版本号）时，会在 Windows 上**顺着 junction 删光链接目标
里的一切**。目标目录本身留着 —— 所以仓库根的 `.git` 活着、`git checkout -- plugin` 能把**已跟踪**
的文件全找回来，但**未跟踪的新文件就没了**。

实测记录（可抛弃现场 `test/env/tmp/junc/`，pnpm v11.8.0，与本机桌面版同一个版本）：

| 现场 | 结果 |
|---|---|
| `add link:<dir>` | 装出一个 **Junction**（`LinkType Junction`，Target = 那个目录） |
| 紧接着 `add <两个 tgz>`（换掉 link 依赖） | **目标里的内容被整个删光**（哨兵文件没了，目录本身还在） |
| 先手工摘掉 junction（只 `rmdir` reparse point），再 `add <两个 tgz>` | 目标**完好** |
| `add file:<dir>` 之后再 `add <两个 tgz>` | 目标**完好**（`file:` 装出来是实体拷贝，不是链接） |
| `remove dsh-visible-ssh` | 目标**完好**，只是清单与 `bundles` 里的条目没了，**junction 留成孤儿** |

所以脚本在装之前，会先对 `node_modules` 下 `dsh-visible-ssh` 与
`dsh-visible-ssh-engine-win32-x64` 两个名字各跑一次"只摘链接"（`lstatSync` → `isSymbolicLink()` →
`rmdirSync`），装完再把 `plugin/src/index.ts` 是否还在当绊线（不在就提示先 `git checkout -- plugin`）。
`link:` 仍然是日常开发的正路，要换形式时先跑这个脚本 —— 别直接手敲 `dsh plugin add`。

---

## 3. 环境依赖（本机）

| 依赖 | 要求 | 说明 |
|---|---|---|
| DSH | 0.1.5-rc.x / 0.2.0-rc.x | 客户端面板需要 **web carrier**（`webServer` + `connection`）。headless/TUI profile 里没有 carrier：**9 个工具照常可用，只是没有面板**（路由会等 carrier，不会把插件整体 park 掉） |
| Node | >= 20 | 宿主半是 ESM（`src/**/*.ts` 编到 `lib/`）；客户端半是裸脚本 bundle（`src/client/index.js`，由 `scripts/copy-client.mjs` 逐字拷到 `lib/client/index.js`，不经 tsc） |
| Python ＋ paramiko | 3.13（实测 3.13.2）／ 5.0.0 | **本仓不需要**：只有引擎的参照实现与它的测试才要（在引擎项目里）。插件驱动的引擎是自包含 exe，**这条接入路径也不允许接 Python** |
| 远端凭据 | 插件这次选中的那份 `host.toml` | 开发期是仓内 `scripts/config/host.toml`（gitignore），装好后是用户目录那份（Windows `%APPDATA%\visible-ssh\host.toml`，其它平台 `$XDG_CONFIG_HOME/visible-ssh/host.toml`）；谁被选中见「可配置项」的 `configPath`。引擎让环境变量压过文件 |
| `ssh_console_watch` | 本机 Windows Terminal（`wt.exe`） | 只有这个工具需要；其它工具在任何平台都能跑 |

### 可配置项

全部有默认值，**不配也能用**：

| 键 | 默认 | 什么时候改 |
|---|---|---|
| `repoRoot` | 由本文件位置推导 | 引擎不在本包的上两级时 |
| `configPath` | （空）——自动解析 | 想钉死读哪份 `host.toml` 时给路径（相对路径按 `repoRoot` 拼，绝对路径原样）。空着时按下面「解析顺序」挑；`configSource` 是解析**结果**（`config` / `env` / `user` / `repo` / `null`），只读，不是配置键 |
| `sshConfigPath` | 由家目录推导（`<home>/.ssh/config`；读不到家目录时是 `null`） | **不是可配键，只读**：插件读它来列设置页那张"本机配好的远端"候选表。跟着 `HOME`/`USERPROFILE` 走，而 Win32-OpenSSH 认的是真实用户 profile —— 两者不同时（把 `HOME` 指到别处，ssh 仍读真家）列出的候选可能与 ssh 实际用的不是同一份，所以它只是**候选** |
| `engine` | `go` | 编译产物，默认也是唯一实现（`go` 这个名字沿用历史，现在指的是 C 引擎）。`python` 这条待命路径仍在代码里，但参照实现已迁去引擎项目，要用得显式给 `pythonEntry` |
| `exeEntry` | （空）——按包名解析平台包 | 只在"产物不在平台包里"时才配：给 `visible-ssh.exe` 的显式路径（相对 `repoRoot` 或绝对）。**它必须与 `visible-ssh-askpass.exe`、`visible-ssh-launch.exe` 同目录**；那个目录里**有** `engine.lock` 就照样会被校验，没有则只查存在性 |
| `pythonEntry` / `python` | — | **待命**：参照实现的入口与解释器，**不作为引擎**，且**不随本仓提供** |
| `defaultSession` | `default` | 想默认驱动别的 tmux 会话名 |
| `timeoutMs` | `60000` | 一次 CLI 进程的外层上限 |
| `commandTimeoutMs` | `120000` | `ssh_console_run` 等待命令结束的上限（工具参数 `timeoutMs` 可覆盖，上限 1 小时） |
| `screenTtlMs` | `300` | 镜像路由复用一次截屏的时长；低于面板 2s 轮询，只吸收突发 |
| `screenTimeoutMs` | `20000` | 一次镜像截屏的上限；比 `timeoutMs` 小，因为「一分钟后才回答的镜子」没有用 |
| `spoolDir` | 系统临时目录 | 宿主禁止管道 stdio 时，回退方案把子进程输出落盘的目录 |
| `connectionsFile` | `<DSH_HOME>/dsh-visible-ssh/connections.json` | 想换位置放面板保存的连接（`DSH_HOME` 未设时为 `~/.dsh`） |

#### 解析顺序（选 `host.toml` 的是插件，不是引擎）

引擎**不找**"用户目录"：它只认 `--config <路径>` 与 `SSH_CONFIG=<路径>`，两条都没有才用它自己的兜底（从 exe 目录上溯 ≤4 层找 `scripts/config/host.toml`，最后退到 `cwd`）。所以"读哪份"由插件先定（`src/engine/config.ts` 的 `chooseHostConfig()`），再作为 `--config <绝对路径>` 交给引擎（`src/engine/locate.ts`，插在 `--timeout` 与 verb **之前**）：

| 顺序 | 候选 | 何时算数 |
|---|---|---|
| 1 | 插件配置 `configPath` | 只要给了就用（**不查存在性**，写错了引擎会报 `config file not found`） |
| 2 | 环境变量 `SSH_CONFIG` | 非空就用（同样不查存在性） |
| 3 | 用户目录 `%APPDATA%\visible-ssh\host.toml`（其它平台 `$XDG_CONFIG_HOME/visible-ssh/host.toml`） | **存在才用** |
| 4 | 仓内 `scripts/config/host.toml` | **存在才用**（开发期的常态） |

四条都不成立时不加任何 `--config`，让引擎走它自己的兜底。给人用的入口是 `node plugin/scripts/host-config.mjs path|show|install [--force]`：`path` 打印这次会读哪一份、`show` 打印全部候选与来源、`install` 从 `scripts/config/host.toml.example` 种一份到用户目录（**存在就拒绝**，除非 `--force`）；三个子命令都**从不打印配置内容**（里面有密码）。Python 待命路径**不做这件事**：`engine: 'python'` 时插件不加 `--config`。

覆盖方式：在 profile 的 `cordis.patch.yml` 里按行 id 覆写（不要改本包自带的 `cordis.patch.yml`）：

```yaml
- id: visible-ssh
  config:
    defaultSession: proj-a
```

### 连接从哪里来（面板里填）

三个来源。**第 2 条那份文件由插件先解析出来**（`chooseHostConfig()`，见上面「解析顺序」），再作为 `--config <绝对路径>` 交给引擎 —— 引擎自己不找"用户目录"。环境变量（第 1 条）由引擎直接读并压过文件（解析顺序在引擎源码 `internal/hostcfg` 里，实测；该源码不随本仓）：

| 优先级 | 来源 | 怎么起作用 |
|---|---|---|
| 1 | **面板里保存的连接** | 宿主把它作为 `SSH_HOST` / `SSH_PORT` / `SSH_USER` / `SSH_PASSWORD` **注入引擎子进程**。引擎让环境变量压过配置文件，并且**每次调用都重读** —— 所以切换连接不需要重启宿主。实测证据：把连接指向一个关闭的端口后，镜像从 200 变成 `502 NoValidConnectionsError`；若注入被忽略，引擎会用 host.toml 并返回 200 |
| 2 | 插件选中的 `host.toml`（开发期仓内 `scripts/config/host.toml`，装好后用户目录那份） | 什么都不注入时引擎读它 —— 插件把选中的那份作为 `--config <绝对路径>` 传进去。**没保存过任何连接时就是这个**，行为与装本插件之前完全一致 |
| 3 | 都没有 | 面板显示**未配置空状态**并指向设置页（面板里已经没有表单） |

面板行为（**编辑连接只有一处：设置 → visible-ssh**，与「通用设置」「模型」「插件」同处一列，注册进 `settings.section` 槽 `order: 20`）：

- 面板 = **两个下拉（服务器／会话）+ 会话行 + 屏幕镜像**；
- **「服务器」下拉**列出已保存的连接，选中即切「当前连接」（`POST /visible-ssh/sessions {action:'activate'}`），9 个工具跟着一起换机器。一条连接都没有、或整条走 `host.toml` 时这里只写「（连接清单里还没有服务器）」；
- **「会话」下拉**是"这一格屏幕在照谁"的开关，**只影响这块屏幕**（不动连接清单，也不动本机已经开着的那些终端）：选一个名字之后那次取屏就变成 `GET /visible-ssh/screen?session=<名字>`（宿主侧的屏幕路由本来就认这个参数），下方小字改读「正在镜像：会话 `<名字>` · 已钉住」；选回第一项（「跟随当前连接」／「跟随宿主默认」）就退回"跟着主机走"，那条 URL 上**不带**参数（与从前逐字相同）。为什么一次只照一个：**一次取屏就是一条全新的 SSH 连接**（实测 ~1.3s），宿主那 300ms 缓存也按 `(连接, 会话)` 分开。换服务器会**丢掉**钉住的名字（新服务器上多半没有这个会话）；引擎枚举失败时，钉住的那个名字仍然留在下拉里（否则选择器会显示成一个空值）；
- **跟着谁不用猜**：没钉任何会话时，下拉第一项写的是「跟随当前连接 · `<名字>`」（或「跟随宿主默认 · `<名字>`」），而正被照的那一行**整行高亮**（绿框 ＋ 极淡绿底）并在小字行尾写「 · 正在镜像」；面板另有一行小字写「正在镜像：会话 `<名字>` · 跟随当前连接／跟随宿主默认／已钉住」。那些 `<名字>` 以**屏幕自己回报的**会话名为准（应答里的 `session`）：宿主 payload 说不出"当前连接"时（`active === null` —— 换主机的间隙，或宿主侧还是它启动时那份旧代码）仍然跟着得起；
- **会话行**显示该主机的 tmux 会话名，带两个动作：
  - **「打开」** → 调引擎的 `watch` verb，在**本机**弹出一个真终端并 attach（attach-or-create）。插件**不自己拼 ssh 命令行**——平台缝在 `internal/launch`。⚠️ 因为是密码认证，那个窗口会**问一次密码**（Windows 上没法把密码交给 `ssh.exe`；换成密钥登录就没这一步）；
  - **「杀掉」** → 调引擎的 `down` verb，**点两次**才真正动手（第一次只把按钮变成「确认杀掉？」）；
  - 行上的"存在/不存在"来自**镜像**的答案，不是这条路由编的——所以面板轮询是**纯本地读、不开 SSH**（实测：路由响应 < 250ms）；
- **会话行**列出该主机**远端全部** tmux 会话：`POST /visible-ssh/sessions {action:'list'}` → 引擎的 `list` verb（一次 SSH 连接；只在挂载、切换主机、以及打开/杀掉**成功之后**发生，**不**跟着 2s 轮询走）。枚举失败时退回 GET 给的那一行并单独说一句 —— 旧引擎不认 `list` 不该让整个面板看起来坏掉了；当前会话即使还没被创建也占一行，「打开」正是创建它的入口；
- 镜像每 2s 轮询 `GET /visible-ssh/screen`（「会话」下拉选了某个名字时是 `?session=<那个会话>`，选回第一项时不带参数）；**未配置时完全不轮询**（不产生 SSH 流量）；
- **取屏失败不留空白**：读失败时屏幕框里写的是失败原因（`取屏失败：<引擎/网络的话>`）＋"下一次轮询会自动重试，也可以按上面的「↻」立刻重试"，状态行同时读「读取出错」——空白看起来只是"什么都没发生"，而连不上、认证被拒、宿主 502 都在那句话里。下一次轮询拿到好回答就照旧画屏；
- **客户端侧 20s 兜底**（`FETCH_TIMEOUT_MS`）：正常一条请求 1–2s，但一条永远不回答的请求会把"本次请求在途"永久留在 true、从此一次都不再发。所以下一次 tick 若发现上一次已超过 20s，就自行判超时、丢掉它并重新发一条（宿主侧的请求仍在跑，只是不再等它）；超时也走上面那条"写进屏幕框"的路；
- 保存的文件是 `connectionsFile`（默认 `<DSH_HOME>/dsh-visible-ssh/connections.json`）。清单正在迁往 `ctx.settings` 的 `visible-ssh` namespace——**截至 2026-09-23 实测仍住在文件里**（`settings.yaml` 里还没有该段）；
- **密码只写不读**：优先写进凭据域 `$DSH_HOME/.credentials.yaml`（0600），没有凭据服务时写进上面那个文件；两张表只回 `hasPassword`，浏览器与模型都拿不到明文。想用环境变量覆盖，导出 `VISIBLE_SSH_<ID>_PASSWORD`（id 大写、非字母数字换成 `_`）即可。
- **对话框里有两格**（`conversation.input.left`，`id: visible-ssh:server`）：输入框**下面那一排**的左半边（紧挨「工作区内修改」）插了一个「服务器」下拉 ＋ 一个「会话」下拉 ＋ 一个 `↻`。「服务器」只列设置里存过的那些连接（读 `GET /visible-ssh/sessions`，与面板同一个 `profiles`/`active`），选中就换「当前连接」—— 与设置页的「使用」、面板的「服务器」下拉是**同一个动作** `POST /visible-ssh/sessions {action:'activate'}`，所以 9 个工具与右侧镜像面板一起换机器。「会话」改的是**当前那条连接档案自己的 `session`**（`{action:'session'}`，写的是 `connections.json` 里的那个字段）：9 个工具不自己指定会话时就干这个会话的活，面板也照它 —— **与面板里那个只改「屏幕照谁」的「会话」是两件事**，重启宿主后它还在。会话清单来自 `{action:'list'}`（一次枚举＝一条 SSH 连接），所以它**不**跟着 5s 轮询走：挂载时读一次、换了机器读一次、按 `↻` 立刻再读一次。一台都没存、或整条走 `host.toml` 时整格**根本不占地方**（渲染 `null`）；读失败时下拉的 `title` 里会说出原因，不拿旧列表冒充。切换在途时下拉置灰，免得连点发出两次。

- **首次保存可以不给密码**（2026-10-03 起）：没有密码的 profile 就是「这台按密钥登录走」—— 引擎只拿到
  `SSH_HOST`/`SSH_PORT`/`SSH_USER`，`SSH_PASSWORD` 缺席时 `ssh.exe` 自己去用操作者 `~/.ssh` 里的密钥。
  ⚠️ 这里有个真踩过的坑：引擎对「环境变量没覆盖的键」仍会读 `host.toml`，所以一条没有密码的 profile
  会变成「新主机 + 旧密码」的组合 —— **实测这个组合是安全的**：在仓内 `scripts/config/host.toml` 在场
  （它带着 `192.0.2.10` 的密码）的情况下，把 `SSH_HOST=key-host-01`/`SSH_USER=root` 交给引擎、
  不带 `SSH_PASSWORD`，`status` 照样 `{"ok":true,…,"last_line":"root@example-host:~#"}` ——
  ssh 先试公钥，成功就不会走到密码那一步。真需要密码而又不对时引擎是**响的**
  （`transport failed during read: … Permission denied (publickey,password)`，exit 3），不会静默连错机器。
  空字符串仍被拒（要清掉就删档案）。

多连接下，9 个工具与面板都跟着**当前连接**走；`ssh_console_status` 的返回里会多一条
`connection: profile "me" — LAN 机 (me@lan-box.local:22)`，模型由此知道自己连的是哪台机器。

#### 设置页那张「本机 ssh 配置里的远端」候选表

引擎**自己不解析 ssh 配置**（它把 `user@host` 丢给 `ssh.exe`，是 ssh 去读 `~/.ssh/config`、展开
`HostName`、挑 `IdentityFile`）—— 所以"拿 ssh 里配好的那台机器来用"本来就是通的，缺的只是**看见**。
这张表就是补那一块：宿主半 `src/connection/ssh-config.ts` **只读**那个文件，结果挂在
`GET /visible-ssh/connection` 的 `sshConfig: { path, hosts, error }` 里下发，浏览器半边在
**设置 → visible-ssh** 的表单上方渲染（`SshHosts`），每行是 `别名 — [user@]hostName[:port] · 密钥 <路径>`
＋ 一个「填入」。

- **「填入」只动下面的表单**：别名原样进「主机」（展开成 IP、挑密钥仍归 ssh），`User`/`Port` 写了才填；
  `IdentityFile` 只**展示路径**，不填进表单（引擎不认这个键，也没有密钥登录支持 —— 见根 `AGENTS.md` 的踩坑表）。
  密码那格**可以留空**：走密钥的机器不需要密码（引擎只把 `SSH_HOST`/`SSH_PORT`/`SSH_USER` 交给 `ssh.exe`，
  密钥由 ssh 自己去挑）；有密码就填上，宿主会把它存进凭据域。**插件从不写、不改那个文件。**
- **列什么、不列什么**（故意画得很小，目标是"给人一份能挑的清单"，不是替代 ssh 的解析器）：只列不带
  `*`/`?`/`!` 的 `Host` 段（`Host *` 只当默认值补空、不单独成条）；每段只取 `HostName`/`User`/`Port`/
  `IdentityFile` 里**第一次**出现的值（ssh 的规矩是段内第一个胜出）；`Key value` 与 `Key=value` 都认、
  键名不分大小写、`#` 之后剥掉。**不支持** `Include` 与 `Match`（那些段列不出来），也不处理反斜杠续行。
- `~` 只用于展示（`IdentityFile` 里的 `~` 按家目录展开），私钥**内容**一律不读。
- 文件不存在是**正常状态**（这台机器没配过别名）：`hosts` 空、`error` 为 `null`，界面直说；真读不动
  （权限、编码）才把错因显示成一行红字。宿主没答（或旧宿主不懂这个字段）时整块不画。
- **表头有一个「刷新」**（2026-10-03 加的）：设置区块本来就每 5 s 重读一次 `GET /visible-ssh/connection`
  （`CONNECTION_POLL_MS`），而宿主是每次请求现读磁盘 —— 所以别处刚改完 `~/.ssh/config`，这里迟早会自己变。
  这一格只是把"迟早"变成"立刻"：按下去重读一遍（读到一半显示「刷新中…」，防连点），**不写任何东西**。
- 测试全靠**注入**：`loadSshHosts(path, read)` 的 `read` 默认才真读，路由层的 `sshHosts` 也能换
  （`ConnectionHandlerOptions.sshHosts`），所以 `test/unit/ssh-config.test.mjs` 与
  `client-half-check.mjs` 都喂假数据，一行都不碰真机。

---

## 4. 远程服务器需要什么

**只需要一个 tmux**。所有解析逻辑、退出码判定都在本机跑，而且跑在**编译产物**里 —— 远端不装任何东西（不需要 Python、不需要 node、不需要本仓库）。

| 远端依赖 | 用途 | 缺失后果 |
|---|---|---|
| `tmux`（实测 3.5a，apt 安装） | 全部：会话、pane、`capture-pane`/`send-keys`/`respawn-pane`、`remain-on-exit`、`mouse on`、滚动缓冲 | 什么都做不了 |
| `bash` | 退出码上报走 `PROMPT_COMMAND`；终端回复 drain 补丁写 `~/.bashrc` | `up`/`run` 的退出码拿不到 |
| coreutils：`grep` `base64` `rm` `stty` `printf` | `.bashrc` 补丁的一次性安装与判定、`stty -echo` 抑制回显 | 补丁装不上（其余功能不受影响） |
| **可写的 `~`** | `~/.bashrc` 及一次性备份 `~/.bashrc.tmuxbak` | 补丁装不上 |
| **可写的 `/tmp`** | 按 session 隔离的退出码槽 `/tmp/.tmux_rc_<session>_<digest>`（tmpfs，不伤 SD 卡） | 退出码拿不到 |
| `python3` | ⚠️ **与新规冲突、待改**：`install_leak_fix` 目前在远端跑一段 python3 改写 `~/.bashrc`（为了避开 sed 引号坑）。**SSH 路径上不该出现 Python**，应改成纯 shell，详见 `docs/engine-test-protocol.md` 的「随引擎离开本仓的未了事项」 | 该修复步骤失败；tmux 本身不需要 python3 |

远端**不需要**：Python 库 / paramiko / pip / node / 本仓库 / root 权限（`sudo` 只在你自己要提权时才用得上，且目标机无免密 sudo）。

引擎自己会做的远端准备（不用你手动做）：建会话时**在同一条 tmux 调用里**设 `history-limit`、`remain-on-exit on`、`mouse on`（pane 的滚动缓冲在创建时固定，事后设无效）。

验证远端可达（只连不看屏，打印目标机事实）：

```powershell
packages\engine-win32-x64\visible-ssh.exe doctor
```

> Python 的 `host_probe.py` 是**参照侧**的同类诊断（它自己会开 SSH）；它随引擎源码在引擎项目里，按新规也不该出现在这条路径上。

---

## 5. 装好之后得到什么

### 9 个模型工具

| 工具 | 作用 |
|---|---|
| `ssh_console_status` | 会话状态、附着人数、是否空闲、末行、滚动缓冲水位（**只读**） |
| `ssh_console_list` | 枚举远端主机上**全部** tmux 会话（名字、附着人数、窗口数、哪个是当前会话；**只读**） |
| `ssh_console_doctor` | 自述诊断：用的哪份配置与 known_hosts、主机密钥结论、会话是否存在、pane 跑的 shell、滚动上限、SSH 拨号耗时（**只读**，代价是多次远端读） |
| `ssh_console_capture` | 现在屏幕上的内容（**只读**镜像，不输入；超时/中断后先看它的那种） |
| `ssh_console_up` | 建会话 / 复活死 shell / 装退出码上报（幂等） |
| `ssh_console_run` | 把命令逐字打进 pane，拿回输出与**真实退出码** |
| `ssh_console_reset` | 重建会话让新滚动上限生效（**破坏性**：断开所有窗口、丢滚动缓冲，走审批） |
| `ssh_console_down` | 杀掉会话（**破坏性**，走审批） |
| `ssh_console_watch` | 在本机弹一个附着到该 pane 的终端窗口（需 `wt.exe`） |

### 右侧栏「visible-ssh」面板

**要先进一个会话**才会看到它——右侧栏是会话内的 UI，欢迎页没有右侧栏（这是 DSH 的结构，不是插件问题）。它做三件事：

- **两个下拉 + 会话行**：见上面的「面板行为」；
- **镜像**：每 2s 轮询 `GET /visible-ssh/screen`（同源、只读、不输入任何东西；`?session=<名字>` 指定照哪个 tmux 会话，不带就是当前连接自己的那个 —— 面板用一行小字把"跟着谁"写出来，被照的那一行整行高亮并在小字行尾写「 · 正在镜像」），显示状态行 + 可见屏；读失败时把那句失败原因写进屏幕框（不留空白），并在 20s 无回答时自行判超时重发；
- **两个动作**（都在会话行上）：`打开` = 引擎的 `watch` verb（本机弹真终端 attach）、`杀掉` = 引擎的 `down` verb（点两次）。换屏幕在照谁**不占会话行**：那是上面「会话」下拉的事（只是把取屏 URL 加上 `?session=`，不写任何东西）；
- 页面切到后台时**暂停轮询**（切回来恢复），另有 `↻` 手动刷新；
- 服务端 300ms TTL + **同 session 单飞**：多个标签页/手动刷新撞在一起只会产生一次 SSH 截屏（实测 3 个并发 → 1 次 capture，另外两个 `shared:true`）；
- 一次截屏 = 一条新的 SSH 连接（实测 ~1.4–1.9s）。

> 成本提醒：面板开着且每次截屏约 1.9s 时，2s 轮询几乎等于**常连**。想省就调大 `src/client/index.js` 里的 `POLL_MS`，或只留 `↻` 手动刷新。

---

## 6. 排错

| 症状 | 先看这里 |
|---|---|
| **工具都在，但右侧栏没有「visible-ssh」标签页** | 客户端半根本没被下发给浏览器。跑 `node test/boot-graph.mjs`：它从渲染器缓存里读真实启动图，看有没有本插件的行。最常见原因是 `package.json` 的 `exports` **没有声明 `"./package.json"`** —— 客户端行扫描用 `require.resolve('<pkg>/package.json')` 定位清单，解析失败时**静默丢弃该行，没有任何 warning**，而宿主半走 `exports["."]` 照常工作。`node test/manifest-check.mjs` 就是守这个的 |
| 工具报 `protocol: the CLI printed no JSON` | 引擎起了但没输出 JSON：多半是 `node plugin/scripts/host-config.mjs path` 打印的那份缺凭据（用 `… show` 看全部候选，确认引擎读的确实是你在改的那份），或平台包里是旧构建（`node plugin/scripts/engine-fetch.mjs --tag <vX.Y.Z> --install --lock` 换一组；上游只给散文件时才手工整组拷进 `packages/engine-win32-x64/` 再跑 `node plugin/scripts/engine-lock.mjs`） |
| 面板显示「读取出错 HTTP 401/403」 | 组合层的 Host/Origin + cookie 栅栏拒绝了这次读取。桌面版还有额外一道：`settings.yaml` 里 `dsh-desktop.mode` 不是 `compatibility` 时，**普通浏览器根本打不开那个 GUI**（裸请求就是 403） |
| 面板显示「读取出错 HTTP 404」 | 宿主半没有这条路由 —— 多半是**宿主还在跑旧代码**：改了 `src/routes/index.ts` 这类宿主半文件就得 `npm run build` ＋重启（见 [§2.4](#24-什么时候生效)） |
| 改了 `src/client/index.js` 没反应 | 看 [§2.4](#24-什么时候生效)：桌面版应当自动热更；普通 `dsh web` 宿主**手动刷新页面**；改了宿主半则要重启 |
| 面板显示「读取出错 HTTP 502」+ `NoValidConnectionsError` / `Authentication failed` | 当前连接指向的主机连不上或密码不对。去**设置 → visible-ssh** 点「测试」看引擎原话，或换「当前连接」 |
| 点「打开」弹出终端却停在密码提示 | 预期行为：外部 `ssh.exe` 拿不到密码（见「面板行为」）。改成密钥登录可免 |
| 点「杀掉」没反应 | 需要点**两次**，第一次只把按钮变成「确认杀掉？」。它走引擎的 `down`，会真的结束远端那个 tmux 会话 |
| 想删掉已存的连接 | **设置 → visible-ssh** 里点「删除」；文件在 `connectionsFile`，密码在凭据域（或同一个文件） |
| 设置页「本机 ssh 配置里的远端」是空的 | 它只读家目录下那份 `.ssh/config`：**文件不在**、里面**只有通配段**（`Host *` 之类）、或这台机器**读不到家目录**，都会是空清单（界面三种情形分得开）。`Include` 与 `Match` **不展开** —— 从那些地方引进来的机器列不出来，手工把别名填进表单一样能用 |
| 换了连接但屏幕像是旧主机的 | 镜像缓存的键是 **(连接, session)**，正常不会串；真遇到就等一个 tick（300ms TTL） |
| 想手工确认路由在不在 | `node test/live-route.mjs`（真 cordis + 真 webServer + 真 SSH） |

---

## 7. 开发与测试

```powershell
npm install                    # 仓根：工作区依赖（typescript、cordis、dsh-tools…；只装这一次）
npm run build                  # plugin/src -> plugin/lib（宿主加载的是产物；门禁也会自动补）
npm run ci                     # 本机一条命令：build → typecheck → lint → node test/run.mjs
npm run lint                   # 仓根 ESLint（eslint.config.mjs；产物、test/env、scratch 已忽略）
node test/run.mjs              # 门禁两段：test/unit/** 127 项（vitest）＋ 密闭 7 套件 / 401 项
cd plugin; npm test            # 同上（scripts.test 已接线）
```

| 套件 | 项数 | 跑什么 |
|---|---|---|
| `test/unit/**`（vitest，9 个 spec） | 127 | **unit 层**：信封锁与失败（`parseEngineOutput`）、CLI 定位（`enginePackageName` ／ `resolveEngine` ／ `engineCommand`，含 `--config` 注入的位置）、**配置解析**（`userConfigPath` 的三处落点 ／ `chooseHostConfig` 的四档顺序与"存在才用" ／ `resolveConfig` 的接线 ／ `parseHostConfigSession` 的三档与 `sshConfigPath` 的落点，全用假 roots，不读本机任何目录）、**只读 ssh 配置**（`parseSshConfig` 的段与通配规则、`Key=value`、段内第一个胜出、端口校验 ／ `loadSshHosts` 喂假读取器的"文件不在就是空清单／真读不动才是 error"）、锁校验（`verifyPayload` 的各种坏法）、内存替身自身、sessions 路由（假 req/res ＋ 假连接，含 `session` 这个只写存储、不碰引擎的动作）、9 个工具的注册与执行（真 `defineTool`）、**暂存目录清理**（`sweepSpoolDir` 只收超龄的 `.out`/`.err`/`.cmd`，非暂存文件不动，删不掉不抛、只跳过，目录不存在回空表）。不 spawn 进程、不联网、不碰 SSH、不起宿主，约 0.6 s |
| `manifest-check.mjs` | 11 | 客户端 bundle 只依赖冻结基座；**三条**路由路径在两半里一致 |
| `engine-check.mjs` | 25 | **引擎缝**：只允许跑编译产物（两条"Python 待命"断言**待拆**）；产物落在平台包里（默认 `exeEntry` 为空 ＋ 两条显式覆盖的逃生口）；`--timeout` 何时前移；**`--config` 选中的那份 `host.toml` 排在所有 flag 与 verb 之前、调用方自带就不重复插、一个候选都没有就不插、Python 分支不插**；以及"不翻译就会静默跑错命令"那条坑的断言 |
| `artifact-check.mjs` | 23 | **产物身份锁**：平台包按包名解析出来的程序就是包里那个 `visible-ssh.exe`；包清单（`name`/`os`/`cpu`/`files`）与三个 exe 对得上；字节数与 `sha256` 与**包里**的 `engine.lock` 逐一相符，且目录里没有锁没登记的 exe（三个 exe 与锁都不进 git，身份只能记在锁里）。**不执行 exe**，受限宿主里也能跑 |
| `connection-check.mjs` | 75 | 连接层：存储缝、凭据、校验、路由动作与全部状态码，`source()` 的四档来源（`profile` / `cli-config` / `SSH_CONFIG` 压过解析结果 / 哪儿都没有就是 `none`），**首次保存可以不给密码**（密钥机的路：路由收下、`hasPassword` 为 false、交给引擎的环境里确实没有 `SSH_PASSWORD`、删得掉），**换当前连接的会话**（`setSession` 只在名字合法时写盘：非字符串/空/带空格的都回 `{ok:false}` 且磁盘不动；没有当前连接时明说），以及本机 ssh 候选表接进 `GET /visible-ssh/connection` 的那一段（`sshHosts` 注入缝被调用一次、结果原样下发） |
| `settings-check.mjs` | 36 | 清单住 `ctx.settings` 的存储缝（含退回插件自己文件的那条路） |
| `route-check.mjs` | 76 | 镜像路由（TTL / 单飞 / 失败不缓存）+ **面板路由**（GET 纯本地、open/kill 转发给引擎的确切 argv、activate 换当前连接、**session 换当前那台的会话**：200 回整张 targets 且不碰引擎，坏名字 400 `bad-session`，未知 action 的文案把五个动作都列出来） |
| `client-half-check.mjs` | 155 | 用假 React / 假 fetch / 假 document **真渲染**客户端半：镜像、暂停、滚动跟随、**两个下拉**（「服务器」= 连接清单的「当前」；「会话」= 这块屏幕照谁：默认选中第一项「跟随当前连接 · default」、`<option>` 里列出枚举到的每个会话；选某一项后那次 `GET /visible-ssh/screen?session=…` 带上该会话、`<pre>` 换成它的屏、下拉与"被照的那一行"都跟着动；选回第一项则 URL 上不再带参数、换服务器则丢掉钉住的名字）、**跟着谁说得明白**（被照的那一行**整行高亮**且小字行尾写「 · 正在镜像」，全表只有一行这么读；面板另有一行「正在镜像：会话 X · 跟随当前连接／已钉住」；宿主 payload 的 `active` 为 `null` 时改跟**屏幕自己回报的**会话名、那行改读「跟随宿主默认」，恢复成有当前连接时又读回「跟随当前连接」）、**取屏失败不留空白**（把失败原因与"下一次自动重试"写进屏幕框，状态行同时读「读取出错」；下一次轮询拿到好回答就恢复）、**客户端侧 20s 兜底超时**（把钟拨快后下一次 tick 自己判超时并重发，旧回答晚到时不许改状态）、两个动作、未配置空状态，以及设置页那张 ssh 候选表（有别名时每行渲染 ＋「填入」把别名写进「主机」、没有别名/没有家目录/读不动三种说法、旧宿主不给 `sshConfig` 时整块不画、表头那个「刷新」按一下只重读一次 `GET /visible-ssh/connection` 并让新加的 Host 段立刻出现），还有**对话框里那两格**（`conversation.input.left` 槽位：「服务器」一台连接都没有时整格渲染 `null` 不占地方、自己那条 5s 轮询、下拉的 `value` 是「当前连接」而不是第一行、选择后置灰并发**恰好一次** `POST /visible-ssh/sessions {action:'activate'}`（**不是** `/connection`：那条路由回的形状里没有 `target`，写错过一次）、应答回来后选中项跟着改、换机器顺手重读一次会话清单、再选已经是当前的那台就不发请求、别处切换后下一次轮询自己跟上、以及读失败时把原因写进 `title`；「会话」下拉列出枚举到的名字并把当前那个钉在清单最前、选中发一次 `{action:'session'}`、旁边 `↻` 按一下只重读一次枚举） |
| **合计** | **528** | ＝ unit 127 ＋ 密闭 401。全部离线：不需要 DSH、不需要网络、不需要 SSH、**不需要构建 exe**（`engine-check` 只验纯函数；`artifact-check` 只读文件与 sha256）；但要存在 `plugin/lib/` —— `run.mjs` 会先比一下产物与源码的新旧，旧了自己构建 |

**门禁自己防止漏跑**：`run.mjs` 里有一份"套件台账"（密闭 + opt-in），比对的是**顶层** `test/*.mjs`。往 `test/` 里加一个既不在密闭列表、也不在 opt-in 列表的 `.mjs`，门禁会**按名字报错并 exit 1**——这类失误本来是静默的（加了套件、门禁照样绿、却没人跑它）。加套件就改这一处。unit 层不在这份台账里：它是 `test/unit/*.test.mjs`，由 vitest 自行发现，`run.mjs` 把它接在密闭套件之前作为第二段。

**lint 与 typecheck 也在门禁里**：`npm run typecheck`（`tsc -p tsconfig.json --noEmit`，只看宿主侧 `src/**/*.ts`）与仓根 `npm run lint`（`eslint.config.mjs` ＝ ESLint 10 的 flat config：`@eslint/js` ＋ `typescript-eslint` 的 recommended，**不启用需要类型信息的规则集**；忽略 `plugin/lib/`、`test/env/`、`scratch/`、`node_modules/` 与三个 exe；`no-undef` 故意关掉，因为名字的真门禁是 tsc，而客户端半故意用 `require`）。两者都只读本仓源码，不 spawn、不联网。`npm run ci` 把四段串起来：build → typecheck → lint → `node test/run.mjs`。首次接上 lint 时它报的 20 条**全部是死代码/多余转义**（逐条见 `docs/test-baseline.md` 的 §十四），一条断言都没动（那时是 unit 85 ＋ 密闭 304；现在的项数见上表）。

**密闭层还强制解耦**：`run.mjs` 跑之前静态扫密闭套件与 `test/unit/**`，命中 `homedir(`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`.agents`/`.dsh/` 任一就 `FAILED: a hermetic suite touches this machine` 并 exit 1；跑的时候把 `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 指到空的 `test/env/tmp/decoupled/home`、`TMP*` 指到空的 `decoupled/tmp`，并删掉继承来的 `DSH_*`/`SSH_*`。完整说明见 `test/README.md` 的「与本机完全解耦」。

可选的集成/取证检查（需要环境；缺环境会打印原因并 **exit 0** 跳过）。
两个 live 检查要真主机，**凭据必须显式给**（没有隐式来源，也不读操作者家目录）：
`SSH_HOST=… SSH_USER=… [SSH_PORT=…] [SSH_PASSWORD=…]`，或 `VISIBLE_SSH_USE_REPO_CONFIG=1`
明说就用本仓 `scripts/config/host.toml` 那份（来源只有这两条，见 `test/lib/live-credentials.mjs`）。

```powershell
SSH_HOST=… SSH_USER=… node test/live-route.mjs   # 29 项：三条路由 + 真 SSH + 连接注入证明（走 exe）；默认取仓内 test/env/host（DSH_APP 可换）
DSH_APP=<another DSH install> node test/live-late-carrier.mjs  # 7 项：先注册后挂 carrier 的生命周期（真 cordis，不连 SSH）
DSH_USERDATA=%APPDATA%\DSH Desktop node test/boot-graph.mjs    # 渲染器真实启动图；不给就 skipped —— 它不替你猜路径
SSH_HOST=… SSH_USER=… node test/own-host-check.mjs  # 8 项：起**本仓库自带**的 web 宿主，验它的 token 栅栏 + 三条路由真挂在宿主上 + list 真过 SSH；共享浏览器在跑时还验面板每行一个会话
```

`live-route.mjs` **故意不跑**面板的 `open`（会在操作者屏幕上弹窗）和 `kill`（会毁掉这个检查正在镜像的那个 pane）；它们的**校验路径**（非法会话名 400、未知动作 400、幽灵 profile 404）是跑了的。

`own-host-check.mjs` 起的是 `test/env/host/node_modules` 里那套自带 DSH（web 宿主，`--port 0` 让系统挑端口），**不是**桌面应用：桌面宿主对外部浏览器一律 403（它只认 Electron 渲染进程带的那枚进程内头），自带宿主只有它自己打印的 token 栅栏。所以浏览器级检查**一律对着自带宿主做**，别再试图绕过桌面宿主那道门——理由与做法都写在 `plugin/AGENTS.md` 里。它**只用仓库内的隔离 home**（`test/env/home`，由 `node test/tools/setup-env.mjs` 从 `test/env/home.seed/` 重建，可用 `DSH_OWN_HOST_HOME` 换）：桌面宿主会把 `DSH_HOME` 透给子进程，直接读该环境变量就等于拿操作者真实的 `~/.dsh` 起宿主——浏览器里会出现桌面 app 的历史会话与工作区，面板一加载还会写真实的 `storages/workspace.json`。

> `DSH_ENGINE` 是 M5 切换时加的（现在只有 `test/live-route.mjs:67` 读这个环境变量），当时用它对照 `go`(22/29) 与 `python`(29/29)，暴露出一个**只有真 exe 才会踩到**的配置路径 bug（`host.toml` 少退了一层目录 → 退回 cwd）。**那条对照已完成使命**：按新规插件不再接 Python 引擎，这个开关**待拆** —— 同批待拆的还有 `test/engine-check.mjs` 里两条"Python 待命"断言（`:49`、`:50`）。

### 契约备忘（改客户端半之前先读）

- 信封：`window.__ModuleLoader__.load({ id, factory: (require) => { …; return module.exports } })`；`require` 只面向外壳播种的**冻结基座**（react / react-dom / cordis / client-store / ui-slots / ui-primitives / ui-dockkit）。
- `factory` 里注册的 `id` **必须等于包名**，否则宿主报 `bundle … loaded without registering "<id>"`。
- `exports` 必须声明 `"./package.json"` 和 `"./client"`（见 [§6](#6-排错)）。
- 三条路由路径（`/visible-ssh/screen`、`/visible-ssh/connection`、`/visible-ssh/sessions`）在 `src/routes/index.ts` 与 `src/client/index.js` **各写一份**（浏览器 bundle 不能 import 宿主模块），`manifest-check` 会逐条断言二者一致。
- 不过打包器：用 `React.createElement` + 内联样式，不用 JSX / CSS modules / TypeScript（源码是 `src/client/index.js`，逐字拷成 `lib/client/index.js`）。
