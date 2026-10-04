# 引擎测试规程（本仓已不再包含的测试设施）

> **状态**：本文件记录的是**现状 + 迁移地图**。这里列出的设施**已经不在本仓**：
> 引擎源码、构建脚本与它的测试在 2026-10-01 的"只留插件"重构中被整棵移出，
> 归档在仓外 `E:\GitHub\me\_archive\engine-2026-10-01\`（2026-10-01 从本仓 `scratch/_archive/` 整棵剪走），**真源在引擎项目 omnibus**
> （`E:\GitHub\me\omnibus`）。本仓保留的是**插件**与它驱动的产物（在平台包
> `packages/engine-win32-x64/` 里，见 `docs/engine-artifacts.md`）。
>
> 为什么还要写下这份规程：这些设施是判"引擎换了一颗产物之后还对不对"的依据，
> 它们搬走不等于作废。等它们落进引擎项目自己的测试文档之前，这里是唯一的索引。
> 表里凡标「记录」的都是搬迁前实测过、但**没有**在本仓重新跑过的条目。

## 0. 先分清三件事

| | 在哪 | 谁跑 |
|---|---|---|
| **插件**的测试（unit 127 项 ＋ 7 个密闭套件 401 项 ＋ live-route ＋ own-host-check） | 本仓 `test/` | `node test/run.mjs`；规矩见 `test/README.md`（改 `plugin/` 下文件另见 `plugin/AGENTS.md`）。密闭层由 `run.mjs` **强制解耦**（扫本机状态、剥 `DSH_*`/`SSH_*` 环境）；两个 live 检查的**凭据一律显式给**（`SSH_HOST`/`SSH_USER` 或 `VISIBLE_SSH_USE_REPO_CONFIG=1`），缺就 `skipped` 退出 |
| **引擎产物**的形状断言 | 本仓 `test/engine-check.mjs`（位置推导）＋ `test/artifact-check.mjs`（身份锁） | 随 `run.mjs` 跑；断言解析出的平台包里三个 exe 存在、配置推导正确、字节与 sha256 与包里的 `engine.lock` 一致 |
| **引擎自己**的测试（下面全部） | 引擎项目 / 归档 | 引擎项目里跑；本文件是索引 |

引擎产物是什么、怎么刷新，见 `docs/engine-artifacts.md`。

## 1. 构建 + 冒烟（证明"产物起得来、参数形状没坏"）

| 设施 | 类型 | 证明什么 | 怎么跑 | 需要什么 | 绿判据 / 已知缺口 |
|---|---|---|---|---|---|
| `scripts\build.cmd` | 构建＋冒烟 | 出 `visible-ssh.exe`（＋sha256、`build-info.json`），**末尾自动跑 exe 冒烟 12 项** | `scripts\build.cmd` | Go 工具链（缓存目录必须落在工作区内，否则 `Access is denied`） | 12/12；**缺口**：它 `pushd src\go`，产物是 **Go** 引擎 —— 在插件仓里跑它会把已验好的 C 产物覆盖掉，这正是它被移走的原因 |
| `scripts\build-c.cmd` | 构建 | 出 `visible-ssh-launch.exe` ＋ `visible-ssh-c.exe` ＋ `visible-ssh-askpass.exe` | `scripts\build-c.cmd` | CMake ＋ VS 生成器（脚本自己找 MSVC，**不用先进 vcvars**） | 构建树在 `scratch\cache\cbuild`；产物原先落 `dist\`，现在插件仓用的是整组拷进 `packages\engine-win32-x64\` 后的名字（三个 exe 必须同目录，见 `docs/engine-artifacts.md`） |
| `python scripts\tests\smoke_exe.py` | 冒烟 | 产物起得来、参数形状、`--out` 去处 | 单跑 | **不需凭据/网络**（用闭端口） | 12 项 |
| `cmake -S src\c -B scratch\cache\cbuild-libssh2 -A x64 -DVSSH_TRANSPORT=libssh2` → `cmake --build … --config Release` → `ctest --test-dir … -C Release` | 构建＋单测 | 进程内 SSH 后端（libssh2）这一支也能编译并通过 | 见左 | 与 C 构建相同；那时多编 `vendor/`、少编 askpass 目标 | ctest **8 项**（`engine-t-with-stub` 用替身 ssh，不属于这条路）；独立构建树，不动默认产物 |
| `scripts\test-c.cmd` | 单测 | C 的 ctest：**启动器 3 ＋ 引擎 6 = 9 项** | `scripts\test-c.cmd` | 同上；**离线、不弹窗** | 9/9；**改 `src/c` 后必跑** |

## 2. 单元 + 与参照实现对拍（证明"语义没变"）

| 设施 | 类型 | 证明什么 | 怎么跑 | 绿判据 / 已知缺口 |
|---|---|---|---|---|
| `scripts\test.cmd` | Go 单测 | `go vet` ＋ `go test`（离线，约 5 秒） | `scripts\test.cmd` | 全绿；**改 Go 后必跑**。里面有一条 `TestLeakFixWritesThePythonScriptVerbatim` —— 它是**债的看门人**，见 §6 |
| `python src\c\engine\tests\compare_with_go.py` | 对拍 | C 引擎与 Go 引擎在同一会话上**逐字段对拍** `capture` / `status` | 需要目标机在线 | 两个角色各自跑一次、逐字段 diff。**已知缺口**：它把 GO 角色写死为 `dist\visible-ssh.exe`、C 角色写死为 `dist\visible-ssh-c.exe`（后者在现树里已不存在）—— 复用时先改这两个路径 |
| `src\c\engine\tests\ssh_stub.c` | 测试替身 | 让 C 的 `t` verb 有一个可控的假 ssh（不进产物） | 由 ctest 驱动 | ctest 里 `engine-t-with-stub` 就是它 |
| 明文 JSON 契约 | 约定 | `capture` / `status` 的**键集与值**与参照实现逐字段一致；**只追语义，不追字节**（Go 紧凑 `{"a":1}` vs Python `{"a": 1}`） | 对拍 | 契约之外的字段（host key、geometry、config 摘要）进 `doctor`；插件的 `project.js` 按字段名投影 —— 往这两个 verb 多加一个键等于顺手改了契约 |

## 3. 参照实现（Python）的离线套件

| 设施 | 类型 | 证明什么 | 怎么跑 | 需要什么 | 绿判据 |
|---|---|---|---|---|---|
| `python scripts\tests\run_tests.py` | 离线套件 | 参照实现的行为：**125 项**，约 3 秒，**不连目标机** | 单跑 | `scripts/.pylibs/`（paramiko 等），用 `scripts\tools\fetch_deps.py` 落盘（沙箱里 `pip install` 会被拒） | 125/125。Python 只作**测试驱动** |
| `scripts\tests\checks.py` | 共享定义 | 两个真机 runner 的检查项都定义在 `STEPS` 里 —— **加检查项只改这一处**，两个 profile 自动都有 | — | — | `python scripts\tests\test_checks.py` 断言两个 profile 的差异**只有** `shell_death` |

## 4. 真机端到端

| 设施 | 类型 | 证明什么 | 用哪个会话 | 绿判据 / 备注 |
|---|---|---|---|---|
| `python scripts\tests\e2e_remote.py` | 真机自动 | 端到端 **30 项**，含 `exit` / respawn 等**破坏性**步骤 | 私有 `e2e` 会话 | 快；**不要**对着人的 `default` 跑 |
| `python scripts\tests\watch_remote.py` | 真机可见 | 有人看着的那条路 | **人的 `default` 会话** | 慢，**跳过**破坏性步骤 |
| `python scripts\tests\record_fixtures.py` ＋ `scripts\tests\fixtures\` | 录制/回放 | 把真机应答录成 fixture，供离线回放（避免每次都连目标机） | — | 录完即可离线跑；`probe_echo.py` 是探针脚本 |

**写测试的硬规矩**：任何"发完就立刻断言"都不可靠 —— `send-keys` 与 `capture-pane` 之间是异步的（实测 1/4 概率假失败）。要断言的状态变化都**轮询到稳定**再断言。

## 5. 文档类（与测试互为参照）

`scripts/docs/` 下：`adr/0001..0003`（设计决策：共享 pane／选项必须一次调用设置／退出码槽按 session 隔离）、`local-environment.md`（本机与目标机环境事实）、`pitfalls.md`（踩坑叙事与实测数据）、`tmux-console-flow.md`（流程）、`architecture-target.html`（计划类）、`tmux-console-stages.md`、`SSH固化方案-ABCD评估.md`（固化形态评估：Skill / MCP / Cordis 插件）。全部随 `scripts/` 归档。

## 6. 随引擎离开本仓的**未了事项**

这三条在搬迁时都**没做完**，真源在引擎项目；本仓不再有改动它们的位置。

1. **密码认证（配置债）**：`host.toml` 里目前是 `password`。建议改密钥登录，然后删掉该键、改用 `password_env` 或纯密钥。当时的唯一改动位置是 `src/go/internal/hostcfg`（Python 侧的 `host_config.py` 只是参照实现，不该改）。**插件面板的「打开」之所以要人工输一次密码，就是这条的后果。**
2. **`InstallLeakFix()` 改纯 shell（代码债，唯一一处真 Python 依赖）**：原在 `src/go/internal/session/session.go` —— 它把一段 Python 脚本 base64 到远端临时文件再 `python3 <tmp>` 执行（剪掉重复的补丁块、备份 `~/.bashrc.tmuxbak`、追加 payload），**所以目标机必须装 python3**。按新规要改成纯 shell：`grep -n -m1 -E '<markers>'` 取首个标记行号 → `head -n $((n-1))` 截断 → `base64 -d` 追加 payload。**移植时必须保住现有语义**：标记是**子串**分割（不是行首锚定）、结尾 `rstrip()` 后补**一个**换行、备份路径不变；并同步改 `TestLeakFixWritesThePythonScriptVerbatim`（它现在断言脚本里出现 `python3`）。C 引擎那侧**已经是**纯 shell、远端不需要 python3（不背这笔债）。眼下目标机有 python3，所以这是**规矩上的债**，不是当下故障。
3. **`compare_with_go.py` 的路径**：它引用的 `dist\visible-ssh-c.exe` 与 `dist\visible-ssh.exe` 在新布局里都不存在；复活对拍前先把它指向实际产物。

## 7. 搬迁时已知但**未验证/未修**的缺口（测试没盖住的地方）

- **读类 verb 把传输失败当成"没有会话"**：`transport_result` 带 `exit_code` / `timed_out`，但读类路径（`status` / `capture`）**从不看 `exit_code`** —— 于是 ssh 认证失败与"确实没有该会话"不可区分，返回 `ok:true, exists:false`、退出码 0。要修就在读类 verb 上补一条"传输非零退出即失败"的判决，并补一条**断言认证失败不被吞掉**的测试。
- **`doctor` 的 host key 字段为空**：插件侧实跑 `ssh_console_doctor` 时拿到 `hostKey:null, hostKeyType:null`（而 `known_hosts`、`config`、几何尺寸、`dial_ms`、`total_ms` 都正常）。插件的投影读的是 `host_key` / `host_key_type`，所以这是一个**只在实机才看得见**的缺口，离线套件盖不到。
- **Go 读类 verb 在传输失败时可能打两份 JSON（待确认）**：`cmd/visible-ssh/main.go` 的 `run()` 在 `capture`/`status` 分支先 `emit` 一份降级载荷，随后 `console.Err()` 非空时又 `fail(...)` 打一份错误文档 —— 同一个 stdout 上两份 JSON，而消费者只读第一份（`ok:true`），于是**把失败当成了成功**。C 引擎有意只打错误那一份（`cli.c` 读类 verb 的注释）。要么在 Go 侧修成一份，要么确认无人依赖双文档。
- **`read_context` 与 `console.c` 两份"持有传输层"的结构并存**：读类 verb 仍用 `cli.c` 里的 `read_context`（已与 Go 逐字段对拍通过），写类 verb 用的是新的 `engine/console.c`。下一步把读类折进 `console`、删掉 `read_context` —— 纯机械改动，**改完必须重跑对拍**。
- **并发**：同一 session 被两个进程同时驱动时仍会串号（rc 槽按 session 隔离，所以**同 session** 内的两个 `run()` 共用一个槽，可能互相消费对方的退出码）。空闲门禁只是收窄、并非消除。彻底解决需要锁或所有权令牌（`tmux-console-flow.md` 里画过 `flock`，**从未实现**）。多项目各自独立 session 不受影响。
- 其余引擎侧的坑（tmux 选项必须与 `new-session` 串在同一次调用、`remain-on-exit on`、`TERM` 缺失或 `dumb` 会让远端拒绝建会话、C 程序 argv 编码、两个后端的退出码语义差异、known_hosts 整文件重写丢注释……）记在 `pitfalls.md` 与 `AGENTS.md` 的旧版本里，随引擎走了。

## 8. 可整体搬走的东西（引用计数）

整棵搬走，**不需要**改插件：`src/`（Go ＋ C ＋ 各自测试）、`scripts/tests/`、`scripts/tools/`、`scripts/.pylibs/`、`scripts/docs/`、`scripts/build*.cmd`、`scripts/test*.cmd`、`SSH固化方案-ABCD评估.md`。

搬走后**必须**跟着改引用的地方（当时全部处理完）：插件侧的 `plugin/src/engine/config.ts`
（`exeEntry`）、`plugin/src/engine/locate.ts`（按包名解析 ＋ 错误文案）、`plugin/src/engine/verify.ts`
（`engine.lock` 对账）（S3 之前这三件事都在 `plugin/src/engine/bridge.ts` 里，S2 起是 `.ts`）、
`test/engine-check.mjs`、`test/artifact-check.mjs`、`test/live-route.mjs`、`plugin/README.md`、
`plugin/cordis.patch.yml`，以及本仓的 `AGENTS.md`、`.gitignore`、
`scripts/监控主机.bat`。**S4 起换 exe 的入口只有三个**：`node plugin/scripts/engine-fetch.mjs --tag <vX.Y.Z> --install --lock`
（P 档起：从上游 Release 取件、按三把锚核对、顺手重算包里的 `engine.lock`）、
`node plugin/scripts/engine-lock.mjs`（**上游只给散文件时**手工重算）与
`npm run pack:engine`（打平台包 tarball）。

**留在本仓的**：`scripts/config/{host.toml,host.toml.example,known_hosts}`（引擎**自己的兜底**会从 exe 目录向上找这个相对路径，所以它是部署的一部分；插件运行时则由插件先把该读哪份解析好、作为 `--config <绝对路径>` 传进去，见 `docs/engine-artifacts.md`）与 `scripts/监控主机.bat`（人双击即 attach）。
