# 引擎产物 —— 它们是哪个包、怎么刷新、怎么发给别人

本仓库（插件仓库）只负责**用**引擎：产物由**引擎项目**构建、发成 Release，本仓用
`plugin/scripts/engine-fetch.mjs` 取进来放进平台包；本仓不保存引擎源码、不保存构建脚本，
也不在这里编译。**三个 exe 不进 git 跟踪**
（`.gitignore` 按文件名逐个忽略），所以新克隆的仓库里没有它们 —— 那正是插件会
**明确报错**（而不是静默降级）的情况。

```
packages/engine-win32-x64/          # 包名 dsh-visible-ssh-engine-win32-x64
  package.json                      # name / version / os:["win32"] / cpu:["x64"] / files[]   ← 进 git
  engine.lock                       # 产物身份锁：字节数 + sha256 + 上游 commit
                                    #   + 来自哪个 Release 附件（含附件 sha256）              ← 进 git
  README.md                         # 这个包自己的说明（给人看的刷新流程）                 ← 进 git
  visible-ssh.exe                   # 主程序：CLI，11 个 verb（up watch status list capture
                                    #   reset down run doctor t version）+ 三条 /visible-ssh/* 路由
  visible-ssh-askpass.exe           # 替 ssh 回答密码提示（由主程序经 SSH_ASKPASS 拉起）
  visible-ssh-launch.exe            # 平台接缝：为人眼弹一个可见的终端窗口（watch 用）
```

（2026-10-02 之前这组产物先在 `engine/`、再在仓根 `bin/`；现在它们是**一个包**。）

| 文件 | 字节 | sha256（前 16 位） |
|---|---|---|
| `visible-ssh.exe` | 128512 | `e26ad23a89aae028` |
| `visible-ssh-askpass.exe` | 11264 | `07c9edc6dee3abe1` |
| `visible-ssh-launch.exe` | 28672 | `aeb1bad09503883e` |

三个文件都来自同一次构建：上游 **Release `v0.0.1`** 的
`omnibus-vssh-v0.0.1-win64-lite.zip`（89396 字节，sha256 `09323559…746f`），
上游 commit **`4d729fe`**（`upstream.commit`）。
**权威记录是包里的 `engine.lock`**（完整 sha256 ＋ 字节数 ＋ 上游 commit ＋ Release 附件 sha256，
受版本管理），`test/artifact-check.mjs`、插件的 `verify.ts` 与 `plugin/scripts/engine-lock.mjs`
都只看它 —— 本文件只是给人读的说明。

这一版起，产物**自己会报身份**：`visible-ssh.exe version` 打出
`{"ok":true,"version":"v0.0.1","commit":"4d729fe","verbs":[…11 个…]}`（旧那版自报的是
`0.0.1-c1` / `no-vcs`）；`engine-fetch.mjs` 取件时把它读出来，写进锁里的
`upstream` 与 `reported_version`。

## 插件怎么找到它

1. `plugin/package.json` 把它写进 **`optionalDependencies`**（`dsh-visible-ssh-engine-win32-x64: ^0.0.1`），
   包自己的 `os`/`cpu` 决定它只在 win32-x64 上被装 —— 别的平台**自动跳过**，插件在那上面
   照样能加载（只是引擎跑不起来，报的是一句明确的话）。
2. `plugin/src/engine/locate.ts` 的 `resolveEngine(cfg)`：`exeEntry` 没配 → 用
   `createRequire(...).resolve('dsh-visible-ssh-engine-<platform>-<arch>/package.json')`，
   取它的目录当产物目录。**开发期** 这个解析落到 workspace 链接
   （`node_modules/dsh-visible-ssh-engine-win32-x64 -> packages/engine-win32-x64`），
   装到别的机器上落到同层的 `node_modules/` —— **两边的解析路径是同一条**。
3. spawn **之前** `plugin/src/engine/verify.ts` 的 `verifyPayload()` 按锁逐文件核对字节数与
   sha256（按目录缓存一次）：不匹配就**拒绝启动**，报
   `the engine payload does not match engine.lock: … — the drop-in is stale or partial`。

两条逃生口：显式 `exeEntry: '<path to visible-ssh.exe>'`（那摊产物旁边**有** `engine.lock`
才会被校验，没有就只查存在性）；或 `{ engine: 'python', pythonEntry: '…' }` 走参照实现。

## 来历

- 引擎项目：**omnibus**（`E:\GitHub\me\omnibus`），产品 `vssh`；本组产物来自它的
  **Release `v0.0.1`**（2026-10-03 发布，附件 `omnibus-vssh-v0.0.1-win64-lite.zip`），
  对应上游 commit `4d729fe`。平台包的 `version` 镜像产物自报的版本（因此是 `0.0.1`）。
  上游把主 exe 叫 `visible-ssh-c.exe`，本仓的运行时名字是 `visible-ssh.exe` —— 改名只发生在
  装进平台包的那一刻（见上一节）。上一组（commit `ceff647`、自报 `0.0.1-c1`）已整组归档到
  仓外 `E:\GitHub\me\_archive\engine-exe-ceff647-20261003\`（含当时那份 `engine.lock`），
  要回滚就整组换回去再 `node plugin/scripts/engine-lock.mjs`。
- 本仓曾经的 `src/`（Go 引擎 + C 引擎源码）、`scripts/{build,build-c,test,test-c}.cmd`
  与 `scripts/{tests,tools}/` 已整棵归档到仓外 `E:\GitHub\me\_archive\engine-2026-10-01\`
  （2026-10-01 从本仓 `scratch/_archive/` 剪走，索引见那里的 `README.md`）；
  真源在 omnibus，归档只是本地留痕。
- 更早的 `visible-ssh-go.exe`（Go 版引擎）与 `visible-ssh.exe.bak-old-cbuild`
  也进了同一个归档 —— 全仓无任何引用，只是不再删而已。

## 为什么三个文件必须同目录

引擎**按 exe 所在目录**找它的助手，绝不从 `PATH` 或 `cwd` 里捡
（`transport_ssh.c` 的 `resolve_askpass()`）：它只认 `<exe_dir>\visible-ssh-askpass.exe`，
**没有**「退回引擎自己 `--askpass`」这条退路（已删除）；找不到就在传输准备阶段
带明确错误失败，报出它期望的路径 `the askpass helper is not next to the engine: …`。所以：

- 三个文件必须一起搬、一起留、一起打包。少一个不会"静默降级"，而是响亮失败。
- 包清单 `files` 里列的就是这三个 exe ＋ `engine.lock` ＋ `README.md`；`npm pack` 只认
  清单，**根 `.gitignore` 的忽略规则不影响打包**（实测：tarball 里六件齐全）。
- askpass 只在**密码认证**时才会被拉起（密钥认证走不到它），但交付单元仍是三个文件；
  它的位置由 exe 目录决定，与目录里有没有空格无关（旧版那条「含空格目录」限制随退路一起消失）。

## 配置怎么被找到

引擎自己**不找"用户目录"**。它认两条路，谁给就用谁的配置、完全不看别处：

1. `--config <路径>`（相对路径按**当前工作目录**解析，所以插件只传绝对路径）；
2. 环境变量 `SSH_CONFIG=<路径>`。

两条都没给时，它才退到自己那套兜底：从 exe 目录**向上逐级**找 `<…>/scripts/config/host.toml`
（`hostcfg.c` 里 `DEFAULT_CONFIG_REL = "scripts/config/host.toml"`，最多上溯 4 层），最后退到
`cwd + scripts/config/host.toml`。本仓的形状（`<repo>/packages/engine-win32-x64/…exe` ＋
`<repo>/scripts/config/host.toml`）正好落在那条兜底上：从包目录上溯两级就是仓根，所以产物从
`dist/` 挪到 `engine/`、再到 `bin/`、再到平台包，都**不影响**兜底解析（几种位置都实测过）。

**"用户目录"这件事是插件侧做的**（S5）：`plugin/src/engine/config.ts` 的 `chooseHostConfig()`
决定这次用哪一份 —— 插件配置 `configPath` > `SSH_CONFIG` > 用户目录（Windows
`%APPDATA%\visible-ssh\host.toml`，其它平台 `$XDG_CONFIG_HOME/visible-ssh/host.toml`）> 仓内
`scripts/config/host.toml`（后两个候选**存在才用**）；`locate.ts` 把选中的绝对路径作为
`--config` 插到 argv 最前面。用 `node plugin/scripts/host-config.mjs path` 看这次是哪一份，
`… show` 看全部候选，`… install` 把 `.example` 种到用户目录（它**从不打印配置内容**）。

插件**另外**只读同一份文件里引擎不认的那一项：`[host] session`（缺省 tmux 会话窗口，
`parseHostConfigSession()`，见 `docs/test-baseline.md` §十七）。除此之外它还会**只读**本机
`~/.ssh/config`，把配好的 `Host` 段列成设置页的候选（`plugin/src/connection/ssh-config.ts`，
见 §十八）—— 那份文件是 `ssh.exe` 的地盘，插件从不写、不改。

## 怎么取件（`engine-fetch.mjs`）

常规路径是**从上游的 Release 取**：上游每发一版，附件里就是那组 exe。
取件脚本一条命令走完"下载 → 核对 → 改名 → 装进平台包 → 刷锁"：

```powershell
# 只报告，不写盘（这也是默认行为 —— 不给 --install 就什么都不动）
node plugin/scripts/engine-fetch.mjs --tag v0.0.1

# 真装：--install 覆盖平台包里的三个 exe，--lock 顺带把 engine.lock 刷成新的
node plugin/scripts/engine-fetch.mjs --tag v0.0.1 --flavor lite --install --lock
```

- **私有仓要令牌**：`GITHUB_TOKEN` / `GH_TOKEN` / `VISIBLE_SSH_GH_TOKEN` 任一即可
  （只读 Release 权限够用）。不给令牌时它说的是一句明确的话，不是 404 谜语；
  令牌**从不打印、也从不落盘**。完全没网时用 `--from-zip <本地附件>` 也行。
- **三把锚，装之前逐一核对**（任一"有值且不匹配"就拒绝安装）：
  1. `engine.lock` 里**同一个 tag** 的 `release.sha256`（换 tag 是新锚；同 tag 却换了字节，
     必须显式 `--repin` 才放过）；
  2. `--asset-sha256 <hex>`（人手里那份）；
  3. GitHub API 自己返回的附件 `digest: sha256:…`。
  三者一个都没有 → 打印 `NO PIN: first pull of this tag`，只报告不安装。
- **改名**：上游主 exe 叫 `visible-ssh-c.exe`，本仓的运行时名字是 `visible-ssh.exe`；
  改名只发生在装进平台包那一刻（脚本里的 `RENAME`），zip 本身一个字节不动。
- **顺带自检**：解压每条都核 **CRC32**；`--install` 之后还会读一次
  `visible-ssh.exe version`，把自报的 version/commit 写进锁；装完若目录里留着锁**没点名**的
  `visible-ssh*.exe`，它会明确警告（`test/artifact-check.mjs` 会因为那些文件失败）。
- 下载的附件留在 `scratch/cache/engine/`（gitignore 内），只有 sha256 命中某个锚时才复用。

## 怎么刷新（上游只给了散文件，或要手工弄）

`engine-fetch.mjs` 不在场时（例如上游没发 Release、只递来三个 exe）：

1. 在引擎项目里构建（那边的 README 讲了怎么构建 `vssh` 产品）。
2. 把**三个** exe 一起拷进 `packages/engine-win32-x64/`（覆盖旧的；主 exe 记得改回
   `visible-ssh.exe` 这个名字）。
3. `node plugin/scripts/engine-lock.mjs --commit <上游 commit> --version <自报版本>
   --built "<时间> (…)"` —— 重算并写回包里的 `engine.lock`（字节数 ＋ 完整 sha256；
   `--check` 只比对不写）。**别手工改锁里的数字**：脚本自己写 `_comment`，是这条流程的单一真源。
   它**不执行** exe（受限宿主里捕获子进程输出会被拒），所以人手里也能跑。
4. 跑一遍插件侧的检查：`node test/run.mjs`（含 `artifact-check`，它按 `engine.lock`
   校验字节数与 sha256），再跑
   `node test/live-route.mjs`（默认用仓内 `test/env/host` 那份 DSH 运行时）
   与 `node test/own-host-check.mjs`（后者需要可达的远端主机）。这两个 live 检查
   **凭据必须显式给**：`SSH_HOST=… SSH_USER=… [SSH_PORT=…] [SSH_PASSWORD=…]`，
   或 `VISIBLE_SSH_USE_REPO_CONFIG=1` 明说就用本仓 `scripts/config/host.toml` 那份；
   没给就打印 `{skipped: …}` 并 exit 0（见 `test/README.md` 的「与本机完全解耦」）。

## 怎么发给别人

```powershell
npm run pack:engine            # = node plugin/scripts/engine-pack.mjs
npm run pack:engine -- --dry-run   # 只看清单
npm run pack:engine -- --out E:\somewhere
```

出的是 `scratch/dist/dsh-visible-ssh-engine-win32-x64-<version>.tgz`（当前实测
82181 字节 / 六件文件 / 解包 172.7 kB / sha256 `3ceb1643d5328dfb…`）。别人
`npm install <tarball>` 或直接 `npm install` 这个仓，平台对得上就自动装、对不上就跳过。
**还没发到任何 registry，而且发版是有意不做的**（S6 只落地了本机 CI ＋ lint）：
要一个 npm 账号，包里的 exe 又是引擎团队编的，得他们先首肯。

## 不在这个包里的东西

- **源码**与**构建**：在 omnibus。本仓的测试规程与"随引擎离开本仓的未了事项"
  （密码认证、`InstallLeakFix()` 改纯 shell）写在 `docs/engine-test-protocol.md`。
  取件的东西反过来在本仓：`plugin/scripts/engine-fetch.mjs`（取）、
  `engine-lock.mjs`（记身份）、`engine-pack.mjs`（打包给别人）。
- **参照实现**（Python 版 `tmux_console.py`、`host_config.py`、`host_probe.py` 等）：
  随引擎源码留在引擎项目。代码里保留的 `engine: 'python'` 只是一条**待命**路径，
  要用得显式给 `pythonEntry`。
- `visible-ssh-launch.exe` 的 `watch` 依赖本机 **Windows Terminal（`wt.exe`）**；
  其余工具与三条镜像路由在任何平台都能跑。
