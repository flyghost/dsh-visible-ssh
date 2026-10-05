# visible-ssh —— 让 AI 的远端操作对人可见（插件仓）

> 目标：AI 通过 SSH 在远端主机执行命令时，**人能在同一个终端里实时看见，并随时接管** —— 而不是只拿到一段 stdout。
>
> 本文件 = **本仓（插件仓）**的说明与结论级速查。
> 引擎的源码、构建、参照实现与端到端测试**不在本仓**，在引擎项目 **omnibus**（`E:\GitHub\me\omnibus`）。
> 插件层的全部硬性规矩在 **`plugin/AGENTS.md`** —— 改 `plugin/` 下任何文件前先读它（进 `plugin/` 会自动注入）；
> 引擎测试规程与「随引擎离开本仓的未了事项」在 `docs/engine-test-protocol.md`；产物说明在 `docs/engine-artifacts.md`；
> **测试设施（套件、工具、可重建的测试环境）在 `test/`，入口 `test/README.md`**；
> 临时区规矩 `scratch/AGENTS.md`；插件逐文件说明 `plugin/README.md`。

## 这个仓库是什么

| 路径 | 是什么 |
|---|---|
| `plugin/` | **DSH 宿主插件 `dsh-visible-ssh`**：9 个面向模型的工具 ＋ 三条 `/visible-ssh/*` 路由 ＋ 右侧栏面板。源码在 `src/`（宿主侧 `.ts`，浏览器半边 `src/client/index.js` 是**手写的单文件、故意不进 tsc**），构建产物在 `lib/`（gitignore，`npm run build` 生成）。设置 → visible-ssh 那一节除了管理连接档案，还**只读**本机 `~/.ssh/config`（`src/connection/ssh-config.ts`）把配好的 Host 段列成候选，一键填进表单（别名原样进「主机」，仍由 ssh.exe 自己解析 —— 插件从不碰那个文件）；那张表表头有个「刷新」，按一下立刻重读一遍（那里本来就每 5 s 轮询一次，这格只是省掉等待）；表单里**密码不是必填** —— 留空就等于"这台走本机 `~/.ssh` 里的密钥"（插件只把 `SSH_HOST`／`SSH_PORT`／`SSH_USER` 交给 `ssh.exe`，只有存过密码时才多给一个 `SSH_PASSWORD`；认证真失败时引擎是**响的**）。**对话框里有两格**：输入框下面那一排里的「服务器」与「会话」（插进 `conversation.input.left` 槽位）。「服务器」只列设置里存过的那些连接，选中就换「当前连接」（`POST /visible-ssh/sessions {action:'activate'}`），9 个工具与右侧镜像面板跟着一起换机器；「会话」改的是**当前那条档案自己的 `session`**（`{action:'session'}`），也就是 AI 干活用哪个 tmux 会话 —— 工具与镜像都读它，重启宿主也还在，与面板里那个只改屏幕的「会话」不是一回事；两格旁边还有 `↻`，按一下立刻重读会话清单（一次枚举＝一条 SSH 连接，所以它**不**跟着 5 s 轮询走）；一台都没存就整格不占地方。右侧栏面板一次只照**一个**会话（一次取屏就是一条 SSH 连接），面板里并排两个下拉：**服务器**（= 设置里那份连接清单的「当前」，9 个工具跟着一起换机器）与**会话**（= 这一格屏幕在照谁，别的都不动；选过之后取屏就带上 `?session=`，选回第一项则不带参数，换服务器丢掉钉住的名字）。被照的那一行**整行高亮**并在小字行尾写「 · 正在镜像」（会话行上只剩「打开」「杀掉」两个动作），面板还会用一行字说明「正在镜像：会话 X · 跟随当前连接／已钉住」—— 那个 X 以**屏幕自己回报的**会话名为准（`shot.session`），所以宿主 payload 一时说不出"当前连接"时（`active === null`：换主机的间隙、或宿主侧还是启动时那份旧代码）也照样说得清，那行改读「跟随宿主默认」）。取屏失败**绝不留下空白**：失败原因与"下一次会自动重试"直接写进屏幕框，客户端也在 20 s 无回答时自己判超时并重试。**本仓的主体** |
| `packages/engine-win32-x64/` | **引擎的平台包 `dsh-visible-ssh-engine-win32-x64`**：编译产物 `visible-ssh.exe` ＋ `visible-ssh-askpass.exe` ＋ `visible-ssh-launch.exe`（**三个必须同目录**）＋ 身份锁 `engine.lock` ＋ 它自己的 `README.md`。插件把它写进 `optionalDependencies`，运行时**按包名**解析（`plugin/src/engine/locate.ts` 的 `resolveEngine`），spawn 前用锁校验字节数与 `sha256`（`plugin/src/engine/verify.ts`）。**三个 exe 不进 git 跟踪**（`.gitignore` 按文件名忽略，包清单的 `files` 才是权威），所以新克隆的仓库里没有它们：用 `node plugin/scripts/engine-fetch.mjs --tag … --install --lock` 从上游 Release 取一组进来（现在这组是 Release `v0.0.1` / 上游 commit `4d729fe`），或 `npm run pack:engine` 打成 tarball 发出去 |
| `test/` | **全部测试设施**：unit 层 127 项（vitest，`test/unit/**`，9 个 spec）＋ 7 个密闭套件（401 项）＋ 4 个 opt-in 检查（`run.mjs` 是唯一入口，它会先确认产物不比源码旧）＋ 跑测试用的小工具 ＋ **可重建的测试环境**。依赖树、隔离 DSH home、浏览器 profile 都在 gitignore 的 `test/env/` 下，而清单与模板（`test/package.json`、`test/env/host/package.json`、`test/env/home.seed/`）受版本管理。本机门禁是 `npm run ci`（build → typecheck → lint → `node test/run.mjs`）。见 `test/README.md` |
| `package.json` ＋ `package-lock.json` | **开发期工作区根**（npm workspaces：`plugin`、`test`、`packages/engine-win32-x64` 三个成员）：`npm install` 把依赖提升到仓根 `node_modules/`，所以 `plugin/` 没有也不需要自己的 `node_modules`（那份曾是指向 `~/.dsh/profiles/node_modules` 的符号链接），而平台包在那里被链接成 `node_modules/dsh-visible-ssh-engine-win32-x64` —— **开发期与装到别的机器走的是同一条解析路径** |
| `README.md` ＋ `LICENSE`／`LICENSE.zh-CN` | **对外那一面**（2026-10-04 加）：根 README 是 GitHub 的落地页，中英对照（这是什么、装好之后有什么、快速上手、目录、远端要求、许可证）。许可证是 **Apache License 2.0**，两份文件分工明确：`LICENSE` 是 `apache.org` 的**逐字英文原文**（202 行 / 11358 B / sha256 `CFC7749B…`，**唯一有效文本**，那个 APPENDIX 模板故意没填没改），`LICENSE.zh-CN` 是非官方**中文参考译文**（开头写明译文仅供参考、以英文原文为准）。版权行 `Copyright 2026 flyghost` 写在两个文件的收尾小节与 README 的许可证小节里；四个 `package.json`（根／`plugin/`／`test/`／平台包）都写了 `"license": "Apache-2.0"`。**别翻译/改写 `LICENSE` 本身**，要改就改译文 |
| `engine.lock`（在平台包里）＋ `test/artifact-check.mjs` | **产物身份锁**：三个 exe 的字节数/`sha256`、上游 commit、以及**来自哪个 Release 附件**（含附件 `sha256`）。锁**住在平台包里**（`packages/engine-win32-x64/engine.lock`，本身进版本管理），因为 exe 不进 git，身份只能记在这里；`plugin/scripts/engine-fetch.mjs --install --lock` 取件时顺手刷它（只换散文件时用 `plugin/scripts/engine-lock.mjs`），`artifact-check` 与插件的 `verify.ts` 都按它校验 |
| `scripts/config/` | `host.toml`（真值，gitignore）＋ `.example` —— **引擎自己不找"用户目录"**，它只认 `--config <绝对路径>` 与 `SSH_CONFIG` 两条路。哪份算数由 `plugin/src/engine/config.ts` 的 `chooseHostConfig()` 决定：插件配置 `configPath` > `SSH_CONFIG` > 用户目录（Windows `%APPDATA%\visible-ssh\host.toml`，其它平台 `$XDG_CONFIG_HOME/visible-ssh/host.toml`）> 仓内这份（**后两个候选"存在才用"**）。开发期用仓内这份；装好之后用 `node plugin/scripts/host-config.mjs install` 种到用户目录（`… path`/`… show` 只谈路径，**从不打印内容**）。这份文件里**插件自己读**的只有一项：`[host] session`（引擎不认这个键，未知键照旧忽略），用来定缺省 tmux 会话窗口 —— 插件配置的 `defaultSession` 优先、`[host] session` 其次、都没有才用内置 `default`（`parseHostConfigSession()`，`cfg.sessionSource` 记明是哪一档）＋ `site-profile.md`（真值，gitignore）／`.example`：**站点标识对照表** —— 仓库里的文档与夹具只写 RFC 5737 占位符，哪个占位符当年对应哪台机器记在这里（只为人服务，代码与测试都不读它，见 `docs/test-baseline.md` §二十九） |
| `scripts/install-local.mjs` | **装进本机桌面版 profile 的人运行入口**（2026-10-05 加；此前在 `plugin/scripts/`）：找 `dsh` → 从 `dsh.cmd` 里问出它的 `DSH_HOME` → 构建 → 缺 exe 就取一组 → 按 `link:`（默认）／`--file`／`--tarball` 装进去 → 按运行时同一条路复验。**它只认真实桌面家**：家的路径落在本仓里就一律拒绝（仓内的家只给隔离/测试用 —— 这条判断不点名任何目录）；装之前先把 profile 里那两个包名的 junction 摘掉（pnpm 换掉一条 `link:` 依赖时会顺着它删光目标），装完以 `plugin/src/index.ts` 还在不在作绊线。测试环境在 `test/`，两条路互不认识，见「怎么跑」里的两条 bullet |
| `scripts/监控主机.bat` | 人双击即 attach 到 AI 正在工作的 pane（等价引擎的 `watch`） |
| `scratch/` | 临时区（gitignore）：缓存 `cache/`、证据 `evidence/`，以及个别一次性实验目录。测试环境**已归 `test/env/`**；**备份不在这里**——归档一律放仓外 `E:\GitHub\me\_archive\` |

- **本仓已 git 化**（2026-10-02 `git init`）：删除/移动**可回滚**了，但动手前仍先 `git status` 看清会带上什么；**仓外 `E:\GitHub\me\_archive\` 仍是最后一道保险**，`.gitignore` 的兜底块（位置无关的凭据规则）是第二道。
- **本仓只有一条线 `master`**（2026-10-04）：它是从当时的工作树导出的**孤儿根提交** —— 本地原先那条带真值历史的开发线已按用户要求删掉（"别保存 `main`，防止后期搞混"），只在本机 reflog 里还找得到，`git gc` 之后不可恢复。所以文档与夹具里的机器标识**一律是 RFC 5737 占位符**（`192.0.2.x`／`198.51.100.x`／`lan-box`／`me`／`key-host-01`），真值对照表在 `scripts/config/site-profile.md`（gitignore）；账本 §一…§二十八 里引用的旧提交号属于导出之前那段历史，在库里查不到。见 `docs/test-baseline.md` §二十九。远端 `origin` 是公开库 `https://github.com/flyghost/dsh-visible-ssh.git`（只有这一条线，一笔根提交）。
- **备份只放一处**：仓外 `E:\GitHub\me\_archive\`（2026-10-01 从 `scratch/_archive/` 整棵剪走，约 53 M / 1758 文件）。命名按"是什么 + 什么时候"，并在那里的 `README.md` 登记一行；**仓内不许出现叫 backup/bak 的目录**。
- 引擎源码（Go/C）、`build*.cmd`/`test*.cmd`、Python 参照实现与那 125 项离线测试**已整棵归档**到 `E:\GitHub\me\_archive\engine-2026-10-01\`（索引见同目录 `README.md`），真源在 omnibus。别在插件仓里把它们铺开。

## 为什么不是「执行完返回输出」

普通做法是 `exec_command(cmd)` 然后读 stdout：人看不见过程，也没法中途插手。
这里换成：**PTY 活在远端主机的 tmux server 里**，AI 和人都是它的客户端。

```
   AI (SSH, 无 PTY)  ──send-keys──┐
                                  ├──> tmux server ──> pane (bash)
   人 (SSH -t, 有 PTY) ──attach───┘
```

AI 用 `send-keys` 把命令**打**进 pane、用 `capture-pane` 读回屏幕；人在 Windows Terminal 里 `tmux attach`，看到的是同一个 pane。
所以 AI 逐字执行的每个字符都可见，人可以自己敲、可以 Ctrl-C 接管、可以关掉窗口走开（会话存活）。
这个性质来自 tmux 本身 —— 所以插件**不自己实现传输**，只驱动编译好的引擎。

## 怎么跑

```powershell
npm install                                    # 仓根：装工作区依赖（plugin/、test/、平台包一起；只装这一次）
npm run build                                  # 构建插件：plugin/src -> plugin/lib（首次与改完源码后）
npm run ci                                     # 本机 CI 一条命令：build → typecheck → lint → node test\run.mjs（四段；末段就是下面那条）
npm run typecheck                              # 只跑 tsc --noEmit（plugin/ 的宿主侧源码）
npm run lint                                   # 只跑 ESLint（仓根 eslint.config.mjs；产物、test\env、scratch 已忽略）
node test\run.mjs                              # 插件：unit 127 项（vitest）＋ 7 个密闭套件（401 项）；离线，不需 DSH/网络/SSH
node node_modules\vitest\vitest.mjs run --root test   # 只跑 unit 段（约 0.6 s，改纯函数时用这个）
node test\live-route.mjs                       # 真 cordis ＋ 真 webServer ＋ 真 SSH ＋ 真引擎（DSH 运行时默认取仓内 test/env/host，可用 DSH_APP 换）；**凭据要显式给**：SSH_HOST=… SSH_USER=… [SSH_PORT=…] [SSH_PASSWORD=…]，或 VISIBLE_SSH_USE_REPO_CONFIG=1 明说就用仓里那份
node test\own-host-check.mjs                   # 自起一台 web 宿主：token 栅栏 ＋ 三条路由 ＋ list 真过 SSH（8 项；浏览器那一半要人先起浏览器）。凭据同上，没给就打印 {skipped: …} 并 exit 0
packages\engine-win32-x64\visible-ssh.exe doctor   # 只连不看屏，打印目标机事实
node plugin\scripts\host-config.mjs path           # 这次引擎会读哪份 host.toml（只打印路径与候选，从不打印内容）
node scripts\install-local.mjs                     # 装进**本机**桌面版 profile（仓根的人运行入口；默认 link，还有 --file／--tarball／--check／--dry-run）
```

- **套件读的是产物 `plugin/lib/`**，所以 `run.mjs` 会先确认它不比 `plugin/src/`（含 `tsconfig.json`、`scripts/`）旧，旧了或缺失就自己跑 `plugin/scripts/build.mjs`；那一步要仓根的 typescript（`npm install` 装的），缺了会给一句明确的失败。改源码时想少跑一遍就 `npm run watch --workspace dsh-visible-ssh`。
- **`link:` 装过之后别再让 pnpm 换掉那条依赖**：桌面 profile 里的 `node_modules/dsh-visible-ssh` 是指向本仓 `plugin/` 的 **junction**，pnpm 把这条 `link:` 换成别的形式（`file:`／tarball／版本号）时会在 Windows 上**顺着 junction 删光目标里的内容**（2026-10-05 实测把 `plugin/` 删空；`git checkout -- plugin` 能救回**已跟踪**的文件，未跟踪的新文件就没了）。换形式走 `node scripts\install-local.mjs`（仓根那个入口，装之前只摘链接、不递归），细节见 `plugin/README.md` §2.5。
- **安装与测试两条路互不认识**：安装入口是仓根 `scripts/install-local.mjs`（人跑的），测试环境是 `test/`（`node test\run.mjs` 是门禁）。安装这条只认真实桌面家 —— 家的路径落在本仓里就一律拒绝（仓内的家只给隔离/测试用，所以它不需要点名任何目录）；反方向由 `test/run.mjs` 的两道静态守卫钉住：密闭套件的源码里不许出现这台机器的家，仓根 `scripts/**` 里不许写出指向测试树的路径。
- **验证降档**（默认工作方式）：只跑目标层测试 ＋ 退出码，不做全仓普查。
- **加检查项只改一处**：新套件放进 `test/` 后**必须登记进 `test/run.mjs` 的台账**（`HERMETIC` 或 `OPT_IN`），否则门禁按名字报 `FAILED: the suite ledger is out of date` —— 漏跑本来是静默的，那条守卫就是为这个存在的。
- `live-*`／`own-host-check`／`boot-graph` 默认不跑，各自的前提与"缺前提时怎么办"列在 `test/README.md` 的表里。
- 引擎侧的对拍与冒烟（`compare_with_go.py`、`smoke_exe.py`、各 `*_test.go`）**随引擎走了**，怎么跑见 `docs/engine-test-protocol.md`。

### 起宿主做测试：**必须**用隔离的 development home（硬性）

**永远不要**用真实的 `~/.dsh` 起测试宿主 —— 那里面有你的设置、会话、凭据与 storages（沙箱也写不进去）。隔离家由**种子**重建，不用手搓：

```powershell
node test\tools\setup-env.mjs          # 装工作区依赖 ＋ 从 test\env\home.seed 重建隔离家（并修好家里那条指向插件的 profile 链接）
node test\tools\setup-env.mjs --check  # 只问「环境还齐吗」，不写任何东西（不齐则 exit 1）
```

- 自带宿主钉在 `test/env/host/package.json`（`@deepseek-ai/dsh@0.2.0-rc.2`，与桌面宿主同版），入口是它自己的 `node_modules/@deepseek-ai/dsh/lib/bin.js`。早先那个手搓的 `scratch/env/dsh-latest` ＋ `run-dsh.mjs` shim 已删：Node 24 有 `import.meta.main`，官方 `bin.js` 直接就能起。
- 启动方式是 `web --port 0 --no-open`：宿主把带 token 的 URL 打到 stdout，`test/own-host-check.mjs` 就是从那里取 token 的（所以隔离家里**不需要** `.credentials.yaml`）。
- **必须用标准 Node 启动**：Electron-as-node shim（`DSH Desktop.exe --expose-internals desktop-cli.js`）在后台 job 里会**静默 exit 0**（前台才报错）。
- **删这个家必须用 `node test\tools\rmtree.mjs <path> [...]`**（链接感知：链接只删链接）。`Remove-Item -Recurse` 会**穿过 junction 删掉真 store**，`rm -rf` 同理。
- 连接资料**没有隐式来源**：`test/own-host-check.mjs` 只用当场给的 `SSH_HOST`/`SSH_USER` 种一条 profile 进隔离家（`secrets:{}`，绝不含密码），或隔离家里本来已有的那条 —— **绝不从操作者真家借**。密码只经 `SSH_PASSWORD` 到引擎。改了 seed 就跑 `setup-env.mjs --force`（它会重装依赖并重建家）。
- `test/run.mjs` 会给密闭层**强制解耦**：跑之前静态扫 7 个密闭套件与 `test/unit/**` 里有没有 `homedir(`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`.agents`/`.dsh/`（命中即 `FAILED: a hermetic suite touches this machine`），跑的时候把 `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 指到空的 `test/env/tmp/decoupled/home` 并删掉 `DSH_*`/`SSH_*`。`live` 层的凭据一律显式（`test/lib/live-credentials.mjs`），见 `test/README.md` 的「与本机完全解耦」。
- `test/own-host-check.mjs` **自己钉住这条规矩**：默认 home = `test/env/home`；继承来的 `DSH_HOME`（桌面宿主会把自己的真家透给每个子进程，连 `DSH_SESSION_ID`/`DSH_WEB_URL` 一起）**只当线索不当命令**，真家永远被忽略；可用 `DSH_OWN_HOST_HOME` 显式换（指到真家则 skip 退出）。

## 改动约定

- **Python 不许出现在 SSH 能力与接入路径上。** 插件只把 argv 交给**编译产物**：`plugin/src/engine/locate.ts` 的 `engineCommand()` 是唯一翻译点、`resolveEngine()` 是唯一位置来源（默认按包名解析平台包，`config.ts` 的 `exeEntry` 只是逃生口）。**解析逻辑属于引擎**（在 omnibus），不要在任何一层里改拼 tmux 语法。
- **flag 必须写在 verb 之前**：`run` 会把 verb 之后的 token **拼进命令字符串**，所以 `run --timeout 30 -- cmd` 不是报错，而是**静默执行错的东西**（实测）。
- **JSON 契约**：`capture` / `status` 的**键集与值**由引擎决定，`plugin/src/engine/project.ts` 按字段名投影。往这两个 verb 多加一个键，等于顺手改了契约 —— 契约之外的字段（host key、geometry、config 摘要）进 `doctor`。
- **现状 vs 计划不许混**：现状类文档（本文件、`plugin/README.md`、`test/README.md`）只写**现在就是**这样；计划类只放未开始实施的条目。**一项改造落地就迁移**：从计划里删掉该条，把结论并进对应的现状文档，计划文档里**不留「已完成」清单**。
- **改动进 `src/`，产物进 `lib/`**：`plugin/lib/` 是 gitignore 的构建产物（`npm run build`），任何"改完就生效"的判断都要先重新构建；`run.mjs` 会替你把这一步补上。**`src/client/index.js` 不进 tsc**（见 `plugin/AGENTS.md`）。
- **引擎产物是"包"，不是"抄进去的文件"**：常规换组走 `node plugin/scripts/engine-fetch.mjs --tag <vX.Y.Z> --install --lock`（从上游 Release 取、按三把锚核对、顺手刷新锁；默认只报告不写盘），完事再跑 `node test/run.mjs`；上游只给了散文件时才手工拷三个 exe ＋ `node plugin/scripts/engine-lock.mjs --commit … --version … --built "…"`（它自己写 `_comment`，不执行 exe）。打包用 `npm run pack:engine`（产物落 `scratch/dist/`）。**别手工改 `engine.lock` 的数字**。
- **本仓已是 git 仓**（2026-10-02 起）：改名/搬家前先 `git status`，并用 `git add -A -n` 预检 —— 输出里**不得**出现 `scripts/config/host.toml`、`known_hosts`、`.credentials*`、`node_modules/` 下的内容、`packages/engine-win32-x64/*.exe`、`plugin/lib/`、`scratch/`、`test/env/home/`。
- **改中文/UTF-8 文件用 `edit`/`write` 工具**，不要用 PowerShell 读写（实测毁过两份文档）。
- **提交前跑 `npm run ci`**（＝ build → typecheck → lint → `node test/run.mjs`）。lint 用仓根 `eslint.config.mjs`（ESLint 10 的 flat config：`@eslint/js` ＋ `typescript-eslint` 的 recommended，**不启用需要类型信息的规则集**），忽略 `plugin/lib/`、`test/env/`、`scratch/`、`node_modules/` 与三个 exe。`no-undef` 是**故意关掉**的：名字的真门禁是 `tsc --noEmit`，而这份代码用的 Node 全局随版本变，客户端半还故意用 `require`。lint 只读本仓源码，不 spawn、不联网。
- **产物只落 gitignore 的目录**（`packages/*/*.exe`、`plugin/lib/`、`scratch/`、`test/env/`）；临时文件按类落进 `scratch/` 的子目录，**不许堆在 `scratch/` 根下**（见 `scratch/AGENTS.md`）。

## 环境与踩坑速查

| 事项 | 一句话 |
|---|---|
| 目标机 | Debian / aarch64，用户与地址在 `scripts/config/host.toml`；**无免密 sudo**，要 `sudo -S` 传密码 |
| 凭据 | 目前是**密码认证**；建议改密钥登录，再把 `host.toml` 里的 `password` 删掉。面板「打开」要人工输一次密码是这条的后果（见 `docs/engine-test-protocol.md`） |
| PowerShell | 本机是 **5.1 不是 7**；本 shell 的 PATH 里**没有 `pwsh`**，要用 `powershell.exe`；中文输出先 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`；`.ps1` 必须存成 UTF-8 with BOM |
| Windows OpenSSH | 9.5p2 **不支持 ControlMaster** → 省不掉那 ~0.5s 握手（引擎每条远端命令各付一次） |
| known_hosts | **引擎 v0.0.1 起**读写的是 `%USERPROFILE%\.ssh\known_hosts`（旧构建用 `--config` 同目录那份）：仓内 `scripts/config/known_hosts` 现在默认用不上，引擎会往操作者真家那条写。引擎支持 `--known-hosts <path>`，但插件目前**不传**（要收口就改 `plugin/src/engine/locate.ts` 的 `engineCommand()`） |
| junction | 判定悬空只能用 `fs.readlinkSync` ＋ `fs.existsSync(目标)`：PowerShell 的 `Test-Path` 对**悬空 junction 返回 `True`**；建 junction 用 `powershell New-Item -ItemType Junction`（MSYS 下 `mklink /J` 的 `/J` 会被当路径转换） |
| Node 起 `.cmd` | 子进程里 `spawnSync('npm.cmd', …)` 在 Node 24 直接失败（`status:null`）——`.cmd`/`.bat` 必须经 `cmd /c` 起（`plugin/scripts/engine-pack.mjs` 就是这么打 tarball 的） |
| DSH 沙箱退化 | 见到第一条 `UNKNOWN: unknown error, open '…tmpdir…'` 就**停止写入并重启宿主**，别换通道连续重试 |
| 浏览器 | 桌面版 GUI 只认 Electron 渲染进程（`dsh-desktop.mode` 不是 `compatibility` 时普通浏览器拿 403）；沙箱里跑不起任何 Chromium（Mojo 要命名管道）→ 浏览器由**人**起，agent 经 TCP 附着（`test/tools/start-agent-browser.cmd` ＋ `driver.mjs`） |
| 受限宿主 | **不能用管道收子进程输出**（`stdio:'pipe'` 会 EPERM）；`inherit` 正常，要留日志就用 `openSync` 的文件描述符。**另外 vitest 的 forks 池要 fork worker（走 IPC）**，在这种沙箱里 `npm run ci` 的单元段会 `Failed to start forks worker … Caused by: Error: spawn EPERM` —— build / typecheck / lint 与 7 个密闭套件都不受影响，单元层请在普通终端跑（或让工具放开 spawn），别当回归 |
| 插件改动生效 | 宿主加载的是产物：改 `src/client/*` 后要 `npm run build`，`plugin/lib/client/index.js` 桌面宿主约 **1 秒热更**、普通 `dsh web` 宿主需**刷新页面**；改其余源码后 `npm run build` ＋**重启宿主**（`package.json`/`plugin/lib` 里的宿主侧文件都是每进程只加载一次） |
| 引擎的运行残渣 | 引擎每跑一次都会在 exe **旁边**留一对 0 字节的 `visible-ssh-c-<pid>.{out,err}`（pid 每次都新，所以宿主一开着面板就会不断冒）：`.gitignore` 已挡住，**别把它们提交** |

> 引擎自己的坑（tmux 选项必须与 `new-session` 串在同一次调用、`remain-on-exit`、按 session 隔离的退出码槽、`TERM`、C 程序的 argv 编码、两个传输后端的差异……）**随引擎走了**，记在 omnibus 与 `docs/engine-test-protocol.md`。本仓只在改插件时关心上面这张表。

## 待办

- **引擎那两条债在引擎项目**（密码认证、`InstallLeakFix()` 改纯 shell），条目抄在 `docs/engine-test-protocol.md` 的「随引擎离开本仓的未了事项」。
- **平台包还没发布**：`packages/engine-win32-x64/` 目前只能靠 workspace 链接或 `npm run pack:engine` 出的 tarball 传给别人。**发布是有意不做的**（S6 只落地了本机 CI ＋ lint）：要一个 npm 账号，而且包里的 exe 是引擎团队编的，得他们先首肯。
