# 基线（2026-10-02）

这份文件是「这一组引擎产物 + 这一版插件」的**已验证基线**。任何目录重组、产物刷新
之后，跑下面同一批命令并逐行对照：**对不上的地方就是改坏的地方**，除非这里补一条
说明它为什么该变。

产物本身不受版本管理（`packages/engine-win32-x64/visible-ssh*.exe` 被 `.gitignore` 忽略），
所以「这一组 exe 到底是什么」受版本管理的记录只有平台包里的 `engine.lock`；这份文件记的是
「它们表现如何」。

## 一、当前基线

| 命令 | 期望结果 |
|---|---|
| `./packages/engine-win32-x64/visible-ssh.exe version` | exit 0，`{"ok":true,"version":"v0.0.1","commit":"4d729fe","verbs":[…11 个…]}`（换组记录见 §十六） |
| `./packages/engine-win32-x64/visible-ssh.exe status` | exit 0，`config_path` = `E:\GitHub\me\ssh\scripts\config\host.toml`，`exists:true`，`last_line:"me@lan-box:/opt $"` |
| `./packages/engine-win32-x64/visible-ssh.exe doctor` | exit 0，`known_hosts` = **`%USERPROFILE%\.ssh\known_hosts`**（v0.0.1 起改了默认，旧构建才是 `--config` 同目录那份 —— 见 §十六）；`host_key`/`host_key_type`/`dial_ms` **仍为 `null`**（已知缺口，见 `docs/engine-test-protocol.md` §7） |
| `node test/run.mjs` | exit 0，`OK: 7 hermetic suites green, unit specs green`（unit 127 项 ＋ 密闭 401 项），`notRun` = 4 个 OPT_IN |
| `node test/live-route.mjs` | exit 0，`verdict:"OK: the live routes behave as documented"`（需要可达远端主机；DSH 运行时默认取**仓内** `test/env/host` 那份，本机没装 DSH 也能跑） |

⚠️ flag 必须写在 verb **之前**：`status --json` 与 `--json status` 都是 exit 2
（usage）。`--json` 不是 C 引擎的 flag；对 `engine: 'go'` 插件也会把它丢掉
（`plugin/src/engine/locate.ts` 的 `engineCommand()`）—— **go 版的 exe 自己也不认它**
（`--json version` 与 `version --json` 都是 exit 2），所以 `engine-fetch.mjs` 读自报身份时
只发一条光秃秃的 `version`。

## 二、验收判据（这三条比「测试全绿」更硬）

1. **`skipped` 记失败。** OPT_IN 套件在前提不满足时打印 `{skipped: …}` 并 exit 0；
   把那个 0 当成通过，等于把「没跑」记成「跑过」。验收时必须单独看 skipped。
2. **`--check` 比差集，不比颜色。** 允许它 exit 1，但漂移集合必须与基线一致；
   **出现新条目**才算被改坏（`new-in-repo` / `source-gone` 尤其要看）。
   （这条判据出自 `sync_skill.py`，那个工具已在 §二十八 随 skill 交付线一起删除 ——
   判据本身留着，给任何「比差集」的检查用；编号不动。）
3. **报错必须自证。** 凡是「找不到引擎 / 找不到配置」的失败，输出里必须能看到
   具体路径（`config_path` / `exeEntry`），否则一次路径改名会伪装成「连不上」。

## 三、产物刷新流程

`docs/engine-artifacts.md` 讲「这组产物是什么」；刷新时要跑的命令在这里再留一份，
方便直接对着基线表逐行比（三个 exe 整个被忽略，光看提交区看不出该跑什么）：

1. **常规路（上游发了 Release）**：`node plugin/scripts/engine-fetch.mjs --tag <vX.Y.Z> --flavor lite
   --install --lock` —— 它取附件、按三把锚核对（锁里同 tag 的 `release.sha256`、`--asset-sha256`、
   API 的 `digest`）、把三个 exe 装进 `packages/engine-win32-x64/`、读产物的 `version` 自报身份，
   再交给 `engine-lock.mjs` 重算锁。**不带 `--install` 只报告**（P 档起，见 §十六）。
2. **上游只给了散文件**：在引擎项目（omnibus 的 vssh）里构建 → 把**三个** exe 整组拷进
   `packages/engine-win32-x64/`（覆盖旧的；三个必须同目录）→ `node plugin/scripts/engine-lock.mjs`
   重算包里的 `engine.lock`（字节数 + sha256；上游 commit 与版本号从旧锁里继承，必要时用
   `--built` / `--version` 覆盖）。
3. 再按需更新 `docs/engine-artifacts.md`。
4. 跑 `node test/run.mjs`（其中的 `artifact-check.mjs` 会校验身份）。

第 4 步之外还有一个**故意**的失败：`bin/` 不存在（新克隆）时
`artifact-check.mjs` 会红 —— 这是要的，插件在没有引擎时不该静默降级。

## 四、重组/改名前后的用法

改动前先跑上面两张表并存档，改动后跑同一批再比：差集为空才算没改坏。涉及
`bin/`、`scripts/`、`plugin/` 的搬动，另有 `plugin/AGENTS.md` 与根 `AGENTS.md`
里的硬约束（哪些名字不许改、为什么）；`--check` 的发布面变化另见
`docs/engine-test-protocol.md`。本次 `engine/` → `bin/` 就是照这套
做的：改前的基线是上面两张表，改后的实测在 §五。

## 五、`engine/` → `bin/`（2026-10-02，copy-then-cut 实测）

产物目录改名的每一步都真跑过，不是计划：

| 步骤 | 实测 |
|---|---|
| 三个 exe 拷进 `bin/` | `sha256sum` 与 `engine/` 里那三个**逐一相同**（没有重新构建，只是搬家） |
| `node test/run.mjs` | exit 0，`OK: 7 hermetic suites green` |
| `node test/artifact-check.mjs` | exit 0，`12/12`，`binDir` = `E:\GitHub\me\ssh\bin` |
| 从新位置跑真机 | `./bin/visible-ssh.exe status` → `config_path` 仍是 `E:\GitHub\me\ssh\scripts\config\host.toml`、`exists:true`（**配置发现不受改名影响**，因为它按 exe 目录向上找） |
| `live-route.mjs` | exit 0，`verdict:"OK: the live routes behave as documented"` |
| **回滚演练** | 只把 `plugin/src/engine/config.ts` 的 `exeEntry` 改回 `engine/…`：`artifact-check` **红**（11/12，唯一缺的正是 `config: and it resolves to <repo>/bin/visible-ssh.exe`），其余 11 项照旧绿 —— 两个目录里是同一批产物，存在性与 sha256 都拦不住"改了一半"。**能拦住半途而废的只有那条显式断言**，`engine-check.mjs`（只比字符串）更不会红。改回 `bin/` 后 12/12 恢复绿。 |

回滚办法：`engine/` 在 copy-then-cut 期间一直留着，把 `src/engine/config.ts` 的 `exeEntry`
与 `test/engine-check.mjs`、`artifact-check.mjs` 里那两处路径改回 `engine` 即可；
确认新布局站稳之后才删掉旧目录。

## 六、`plugin/tests/` → `test/`（2026-10-02，测试设施归一棵树）

起因：① 去掉 `plugin/node_modules` 这个指向仓外的符号链接（本地测试一律在项目
隔离环境里跑）② 统一那套隔离环境 ③ 测试相关的东西全挪进一个目录，源码树保持干净。
测试设施现在全在 `test/`，`plugin/` 里只剩源码。

| 旧位置 | 新位置 |
|---|---|
| `plugin/tests/*.mjs` | `test/*.mjs` |
| 散在 `scratch/tools/` 的一次性工具 | `test/tools/` |
| `scratch/env/pw/`（driver ＋ 浏览器 profile） | `test/env/browser/` |
| `scratch/env/dsh-home/`（手搓的隔离家） | `test/env/home/`（由 `test/env/home.seed/` 重建） |
| `scratch/env/dsh-latest/` ＋ `run-dsh.mjs` shim | `test/env/host/`（`@deepseek-ai/dsh@0.2.0-rc.2`，入口它自己的 `node_modules/@deepseek-ai/dsh/lib/bin.js`） |
| `plugin/node_modules` → 符号链接到 `~/.dsh/profiles/node_modules`（**仓外绝对路径**） | junction → `test/node_modules`（仓内） |

回收站规矩：`test/env/{home,tmp,evidence,browser}` 全是生成物、全被 gitignore；
受版本管理的是 `test/package.json`、`test/env/host/package.json` 与 `test/env/home.seed/`。
`sync_skill.py` 的 `SKIP_DIRS` 加了 `test`（发布面不变）与 `plugin`（原本就有）。

| 本次实测 | 结果 |
|---|---|
| `node --check` 全部 `test/*.mjs` ＋ `test/tools/*.mjs` | 无输出（语法全过） |
| `node test/tools/setup-env.mjs --check` | exit 0，`OK: the test environment is complete` |
| 重建演练：`mv test/env/home test/env/home.bak` → `setup-env.mjs` → `own-host-check.mjs` | exit 0，**8/8 全绿**（`origin http://127.0.0.1:8764`，`verdict:"OK: 8 browser-level checks green (browser half skipped: no shared browser driver answered on /status …)"`）→ 只靠种子就能重建出能起宿主的家；隔离家里**不需要** `.credentials.yaml`（`web --port 0` 时宿主自己打印 token） |
| `setup-env.mjs --force` | 删旧家 `{"links":1,"dirs":6,"files":9}`（唯一那个链接就是 profile 里的 `dsh-visible-ssh`，**只删链接**）；重建后 `plugin/lib` 11 个文件仍在、`plugin/node_modules` 仍是指向 `test/node_modules` 的 junction |
| `python sync_skill.py --dry-run` | `files: 13 (0.2 MB)`，`would copy: 0, unchanged: 13` |
| `python sync_skill.py --check` | exit 0，`OK: 13 files match, no drift` |

命令改名对照（本仓文档已同步）：`node plugin/tests/run.mjs` → `node test/run.mjs`，
其余套件同理（`live-route` / `live-late-carrier` / `boot-graph` / `own-host-check` /
`manifest-check` / `artifact-check`）；`cd plugin && npm test` 仍可用
（`plugin/package.json` 的 `scripts.test` ＝ `node ../test/run.mjs`）。

回滚办法：旧位置在提交区里（`git checkout 9b0fa67 -- plugin/tests` 能拿回来，
改名前的路径引用也都在那一笔里）。`scratch/env/` 下那两棵**从未提交**，回滚不了 ——
它们的替代品是「重跑 `setup-env.mjs`」，家是新建的，不是原来那个。

## 七、环境自足性：测试不要求本机装过 DSH（2026-10-02）

要求（用户原话）：测试环境应当是**当前项目自己的完整环境**，不依赖本机装了什么 —— 本机没装 DSH 也应该能跑。

**官方口径**（`@deepseek-ai/dsh@0.2.0-rc.2` 的 `README.zh.md`）：`dsh` 是唯一受支持的 Node
应用启动器；`dsh web` 等 profile **首次使用**时从随附模板在 `$DSH_HOME/profiles/<name>` 自动初始化；
`dsh.profile.bundles` 里的 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 先从 **dsh 安装目录**
解析，树外插件再从 profile 自己的 `node_modules` 解析；`DSH_HOME` 决定 profile 与 home 的位置；
「未启用 HMR 时，更改在重启后生效」。也就是说：**npm 安装的 `@deepseek-ai/dsh` 本身就是完整运行时**，
桌面应用只是它的一个载体 —— 桌面版与 CLI 共用同一套 profile 生命周期（`@deepseek-ai/dsh/profile-boot`）。

审计发现的**三处本机依赖**，已全部改掉：

| 位置 | 原来 | 现在 |
|---|---|---|
| `test/live-route.mjs` / `test/live-late-carrier.mjs` 的 `DSH_APP` 默认值 | 写死桌面应用检出 `E:\software\…\DSH Desktop\resources\app` | 默认 `join(HERE,'env','host')` ＝ **仓内**那份运行时；`DSH_APP` 仍可换成别的安装树 |
| `test/tools/driver.mjs` 的 Chrome 候选表 | 写死 `C:\Users\me\AppData\Local\…\chrome.exe` | `join(process.env.LOCALAPPDATA ?? '', …)` |
| `test/run.mjs` 台账 `needs` 文案、`test/README.md` 前提表 | 说 `DSH_APP` 默认指桌面应用 | 说默认取仓内 `test/env/host`，`DSH_APP` 是覆盖开关 |

改用仓内运行时**没有降低保真度**：逐一核对过版本，两边完全一致 ——
`test/env/host/node_modules/@deepseek-ai/`：`dsh 0.2.0-rc.2`、`dsh-host-webserver 0.2.0-rc.2`、`cordis 4.0.4`；
桌面应用检出：`dsh-host-webserver 0.2.0-rc.2`、`cordis 4.0.4`。`mod()` 只用到安装树的 `node_modules`，
而 `dsh-host-webserver` 本来就是 `@deepseek-ai/dsh` 的传递依赖，所以仓内安装已经自带它。

复跑（**都不设** `DSH_APP`）：`node test/live-route.mjs` → `OK: the live routes behave as documented`；
`node test/live-late-carrier.mjs` → `OK: the registration lifecycle holds on real cordis`；
`node test/run.mjs` → `OK: 7 hermetic suites green`。

**自足边界**（这些是"没装就没有"的部分，全部只在 opt-in 里出现，密闭 7 套离线全绿）：

- Node/npm 本身 —— 唯一无法进仓的东西（工具链，不是 DSH）。
- 浏览器半边（`own-host-check` 的人机协同部分、`driver.mjs`）：要系统 Edge/Chrome 里的一个。缺了不失败：`own-host-check` 照旧 8 项全绿并在 verdict 里注明 `browser half skipped`。
- `boot-graph.mjs`：读 Electron 的 user-data 缓存（`DSH_USERDATA` 或 argv，默认 `%APPDATA%\DSH Desktop`），它回答的是"桌面宿主真的往渲染进程发了什么"，所以本来就只能在装过桌面版的机器上问；找不到目录就打印 `skipped` 并 exit 0。
- `live-*` 与 `own-host-check` 的 SSH 部分：要一台可达的远端主机，**凭据一律显式给** —— `SSH_HOST`/`SSH_USER`（＋可选 `SSH_PORT`/`SSH_PASSWORD`），或 `VISIBLE_SSH_USE_REPO_CONFIG=1` 明说就用本仓 `scripts/config/host.toml`（真值，gitignore）那份。检查的对象就是这台机器，伪造不了；没给就打印 `{skipped: …}` 并 exit 0。

## 八、`plugin/lib/*.js` → `plugin/src/<子系统>/`（2026-10-02，S1：纯搬运的目录重排）

起因：用户问「把 plugin 按模块名（或者按 Linux 内核那种结构）整理一下，便于阅读学习」。方向先写成
`docs/target-architecture.md`（**目标，非现状**），然后只做其中零行为变化的那一步（S1）。

规矩：`src/` 按**子系统**分目录，目录名＝那一层的职责；只有目录的入口才叫 `index.js`。
搬迁一律用 `git mv`（11 条，git 全部识别为 `R` 重命名，历史不丢）。

| 旧 | 新 |
|---|---|
| `lib/index.js` | `src/index.js` |
| `lib/config.js` | `src/engine/config.js` |
| `lib/bridge.js` | `src/engine/bridge.js` |
| `lib/project.js` | `src/engine/project.js` |
| `lib/connections.js` | `src/connection/connections.js` |
| `lib/settings-namespace.js` | `src/connection/settings.js` |
| `lib/screen.js` | `src/routes/index.js` |
| `lib/approve.js` | `src/approval/index.js` |
| `lib/tools.js` | `src/tools/index.js` |
| `lib/session-name.js` | `src/shared/session-name.js` |
| `lib/client.js` | `src/client/index.js` |

代码改动只有两处（其余是把 `import` 的相对路径按新位置重算）：

- `src/engine/config.js` 的 `PLUGIN_DIR` 多走一级：`resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')`。
  少走一级，`repoRoot` 会变成 `plugin/src`、`exeEntry` 指向 `plugin/src/bin/visible-ssh.exe`，
  `artifact-check` 里那条显式断言会当场变红。
- `package.json`：`main` → `src/index.js`、`exports["."]` → `./src/index.js`、
  `exports["./client"]` → `./src/client/index.js`。

**两类漏网点，都是实测踩出来的**：

1. 按名字替换够不到**构造式**路径。`test/manifest-check.mjs:96` 是
   `read(join('lib', 'screen.js'))`，症状是 `Error: ENOENT … plugin\lib\screen.js`
   → 改成 `read(join('src', 'routes', 'index.js'))`。
2. 按名字替换会**误伤别人的包**。规则 `lib/index.js` → `src/index.js` 顺手把
   `test/live-route.mjs`、`test/live-late-carrier.mjs` 里
   `mod('@deepseek-ai/cordis/lib/index.js')`、`mod('@deepseek-ai/dsh-host-webserver/lib/index.js')`
   也改了，症状是 `ERR_MODULE_NOT_FOUND … cordis/src/index.js`（cordis 只发 `lib/`，
   它的 `src/` 里是 `.ts`）→ 4 行已改回。
   **教训：搬目录时引用清单要按"这个路径是谁的"筛一遍，不能只看文件名。**
   刻意保留的外来提法：`test/tools/mint-dsh-cookie.mjs`（dsh 自己的 cookie 格式）、
   `plugin/README.md` 里 `@deepseek-ai/dsh/lib/plugin-*.js`、`own-host-check.mjs` 的
   `@deepseek-ai/dsh/lib/bin.js`。

| 本次实测（`plugin/lib` 已删、`plugin/src` 生效） | 结果 |
|---|---|
| `node --check` 全部 `plugin/src/*.js` | 无输出（语法全过） |
| `node test/run.mjs` | exit 0，`OK: 7 hermetic suites green`（manifest / engine seam / artifacts 12 / connection 61 / settings 36 / mirror route / client half） |
| `node test/live-route.mjs`（不设 `DSH_APP`） | exit 0，`verdict:"OK: the live routes behave as documented"` |
| `node test/live-late-carrier.mjs` | exit 0，`verdict:"OK: the registration lifecycle holds on real cordis"` |
| `node test/own-host-check.mjs` | exit 0，**8/8**，`verdict:"OK: 8 browser-level checks green (browser half skipped …)"` |
| `node test/tools/preflight-dsh-tools.mjs` | 9 个 schema 全被真 `defineTool` 接受；status `exists:true, attachedClients:1`、list `[default(1), e2e(0)]`、doctor `hostKey:null`（已知缺口）、capture 真屏幕 |
| `./bin/visible-ssh.exe status` | exit 0，`config_path` 仍是 `E:\GitHub\me\ssh\scripts\config\host.toml` |
| `python sync_skill.py --prune` → `--check` | `copied: 4, unchanged: 9` → `OK: 13 files match, no drift` |

回滚办法：旧位置全在提交区里，`git checkout 69a95c4 -- plugin/lib`（S1 之前那一笔）能拿回来；
`plugin/package.json` 的 `main`/`exports` 与 `src/engine/config.ts` 的层数要一起改回去。

## 九、`src/**/*.js` → `src/**/*.ts` ＋ `lib/` 构建（2026-10-02，S2：宿主侧转 TypeScript）

起因：用户「继续按照目标架构实现」（`docs/target-architecture.md` 的 S2）。这一步第一次让
**仓库里的源码**和**宿主真正加载的东西**分开：源码在 `plugin/src/`，产物在 `plugin/lib/`。

### 9.1 构建与依赖：从"包内自带 `node_modules`"改成仓根 workspace

- 仓根有了 `package.json`（`private`，`workspaces: ["plugin", "test"]`）与 `package-lock.json`；
  依赖由 npm 提升到**仓根** `node_modules/`，`plugin/` 与 `test/` 靠向上查找命中，都不再需要符号
  junction 去指别人家（`test/package-lock.json` 已删）。
- `plugin/package.json`：`main: lib/index.js`、`exports["."]` 带 `types: ./lib/index.d.ts`、
  新增 `files` 白名单（`lib/`、`src/`、`cordis.patch.yml`、`README.md`）、scripts 变成
  `build`（`node scripts/build.mjs`）/`watch`/`typecheck`/`prepare: npm run build`；
  devDependencies：`typescript 5.9.3`、`@types/node 24.19.1`、
  `@deepseek-ai/dsh-host-webserver ^0.2.0-rc.2`（只为 `import type { WebRoute }`）。
- **本仓任何 `npm install` 都必须带 `--ignore-scripts`**：workspace 的 `prepare` 会触发 build，
  类型没写全时会中途炸掉安装。`test/tools/setup-env.mjs` 里就是这么调的。
- 构建的唯一入口是 `plugin/scripts/build.mjs`（先找 `node_modules/typescript/bin/tsc`，缺了就给出
  "install the workspace first" 的明确失败，然后跑 `tsc -p plugin/tsconfig.json`，最后
  `await import('./copy-client.mjs')`）。`plugin/scripts/copy-client.mjs` 把
  `src/client/index.js` 逐字拷成 `lib/client/index.js`（39846 字节）—— 浏览器半是**唯一的 `.js`
  源码**，故意不进 tsc（它用 `require` 拿 `react`）。

### 9.2 测试侧改读产物 ＋ 新鲜度门禁

- `test/*.mjs`、`test/tools/*.mjs` 的 21 处 import 全部从 `../plugin/src/…` 改成 `../plugin/lib/…`：
  套件加载的必须是**宿主真正会加载的那份**。`test/manifest-check.mjs` 的构造式路径也一起改成
  `read(join('lib', 'routes', 'index.js'))`。注释里描述"逻辑住在哪、该改哪"时仍写 `src/`。
- `test/run.mjs` 新增**产物新鲜度门禁**（位置：台账守卫之后、跑套件之前）：递归取 `plugin/src/`、
  `plugin/scripts/`、`plugin/tsconfig.json` 的最新 `mtimeMs`，与 `plugin/lib/index.js`、
  `plugin/lib/client/index.js` 的最旧比 —— `lib/` 缺了或更旧就自己调 `plugin/scripts/build.mjs`
  （`stdio: 'inherit'`），构建失败直接 `FAILED: the plugin could not be built — the suites read
  plugin/lib/, so there is nothing to test` 并 exit 1。这样"忘了 build"不会变成一堆莫名的红。

### 9.3 十个宿主侧模块转 TS（零 `any`）

- 逐个文件都补了命名类型（`ResolvedConfig`、`EngineCommand`、`RunResult`、13 个 `Raw*Envelope` ＋
  12 个 `Projected*`、`ConnectionsDoc`、`ProfileSave`、`SettingsAdoption`、`WebRoute` 用法…）。
- 关键一处：`plugin/src/tools/index.ts` 的 6 处 `satisfies`（`ValueSchemaSpec` /
  `ParameterPropertySpec` / `ParameterSchemaSpec`）**不是风格**：没有它，`defineTool` 的
  `InferValue<O>` 会把 schema 推成 `never`，9 个工具的注册会全线报错。
- `unknown` 108 次、约 40 处运行期收窄、22 处落信任边界的擦除 `as`（都带注释）；
  **`any` / `as any` / `!` / `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` 零处**；
  `plugin/tsconfig.json` 一字节未动（没有放宽任何严格性开关）。
- 被迫写弱的地方（记录在案）：`renderStatus` 的字面返回类型（`@deepseek-ai/dsh-tools` 不
  re-export `ContentBlock`，它在未声明的可选 peer `@deepseek-ai/dsh-llm` 里）；`mount` 不能标
  `: void`（TS2322，保留 Disposable 返回值）；三处 cordis `Context` 增补
  （`settings`/`credentials`/`connection`）；`settings.ts` 用本地结构化接口顶替 schemastery 类型。
- **那条断链已修（S2 收尾）**：`plugin/src/approval/index.ts` 的 `import type { ApprovalOutcome }
  from '@deepseek-ai/dsh-user-approval'` 原先只靠仓根 `node_modules` 里的**传递**依赖解析
  （它是 `@deepseek-ai/dsh-tools` 的 peer）。现在 `plugin/package.json` 的 devDependencies 里
  显式钉了 `"@deepseek-ai/dsh-user-approval": "^0.2.0-rc.2"`，`npm ls -w dsh-visible-ssh` 里它
  是**直接**边。它仍然是**纯类型**依赖：`import type` 被 tsc 擦除，`plugin/lib/**` 里所有
  `.js` 都 grep 不到这个包名（唯一命中是 `plugin/lib/approval/index.d.ts` —— 我们公开导出的
  `ApprovalFailure = ApprovalOutcome | 'no-service' | 'no-agent'` 本来就把它写在签名里）。
  也就是说运行时一行耦合都没有；devDependencies 也不随包发布。
- 这份 devDependency 是从 registry 下载的（`package-lock.json` 里有它的 tarball URL 与
  integrity），与该机器上 DSH 桌面版/真家 `~/.dsh` 里的任何副本无关。

### 9.4 行为等价性怎么独立验的（可复用的做法）

`tsc` 会重排/改名局部变量，光跑测试不足以回答"这次转换动没动行为"。做法：

1. `git show HEAD:plugin/src/<f>.js` 把 S1 时期的 10 个 **JS** 源文件取到 `test/env/tmp/s2check/oldsrc/`
   （补一个 `{"type":"module"}`，否则 `nodenext` 会按 CJS 发射）。
2. 用临时 `test/env/tmp/s2check/tsconfig.json`（`rootDir: oldsrc`、`outDir: oldlib`、`allowJs: true`、
   `checkJs: false`、`strict: false`、`declaration: false`）编译。
3. `diff -r -u oldlib plugin/lib --exclude='*.d.ts' --exclude=client`。

结果：841 行差，**逐条看过，无行为变化**，只有三类 —— 参数/局部变量改名（`payload`→`doc`、
`input`→`raw`、`parsed`→`doc`）、类型标注被擦除后留下的等价重构（`const doc = payload`、
`asEnvelope(payload)` 取代 `payload?.ok === false`、新增私有 `errorDetailOf`/`errorCodeOf` 取代
`error?.message ?? error` 与 `error?.code`）、注释位置移动（`approval/index.js` 头顶的模块注释消失，
是因为它现在挂在**被擦除的** `import type` 上 —— 源码里注释仍在）。
逐文件改动行数：`engine/project.js` 135、`routes/index.js` 82、`connection/connections.js` 82、
`engine/bridge.js` 47、`index.js` 31、`approval/index.js` 17、`connection/settings.js` 11、
`tools/index.js` 10。
**唯一一处退化差异**（可接受、已记录）：`engine/bridge.ts` 的 flag 前移循环改成先
`const value = argv[index + 1]`、`undefined` 就 `break` —— 旧代码在"标志位是最后一个参数"这种
退化输入下会 push 一个 `undefined`，新代码直接停止扫描。

### 9.5 本次实测

| 命令 | 结果 |
|---|---|
| `npm run typecheck --workspace dsh-visible-ssh` | exit 0，`error TS` **0 个** |
| `npm run build` | exit 0，`copy-client: 39846 bytes -> plugin\lib\client\index.js` |
| `plugin/lib/` 内容 | 21 个文件 ＝ 10 个宿主模块 × {`.js`,`.d.ts`} ＋ `client/index.js` |
| `cmp plugin/src/client/index.js plugin/lib/client/index.js` | 相同（逐字节） |
| `node test/run.mjs` | exit 0，`OK: 7 hermetic suites green` ＝ **284 项**（manifest 11 / engine 17 / artifacts 12 / connection 61 / settings 36 / **route 69** / **client-half 78**） |
| `node test/live-route.mjs` | exit 0，`OK: the live routes behave as documented`（**第一次跑出现过 `FAILURES above`，重跑即全过** —— 原因是和另一个进程里并发的 `live-route` 抢真 SSH/webServer 端口。**教训：`live-*` 不要并发跑**） |
| `node test/live-late-carrier.mjs` | exit 0，`OK: the registration lifecycle holds on real cordis` |
| `node test/own-host-check.mjs` | exit 0，**8/8**（`browser half skipped`） |
| `node test/tools/preflight-dsh-tools.mjs` | 9 个 schema 全被真 `defineTool` 接受；status `exists:true, attachedClients:1`、list `[default(1), e2e(0)]`、doctor `hostKey:null`、capture 真屏幕（`lsusb` 输出） |
| `./bin/visible-ssh.exe status` | exit 0，`config_path` 仍是 `E:\GitHub\me\ssh\scripts\config\host.toml` |
| `python sync_skill.py --prune` → `--check` | `copied: 5, unchanged: 9`（files 14）→ `OK: 14 files match, no drift` |

计数变化：受版本管理的断言项 **275 → 284**（`route-check` 67 → 69、`client-half-check` 71 → 78，
因为产物里多了 `.d.ts` 兄弟文件与新的源码路径；README 里那张表已同步）。

回滚办法：`plugin/lib/` 是产物（gitignore），删掉即可；`npm run build` 用 `src/` 重新生成。
`src/*.js` 的旧内容在 `git show 81a585f:plugin/src/…` 里（S1 那一笔）。

## 十、S3：unit 层（vitest）＋ engine 接缝拆细（2026-10-02）

### 10.1 代码侧：`engine/` 从 2 个文件变成 7 个，`bridge.ts` 被删

拆的依据是"把这几个问题分开"：谁开进程、该开哪个、拆信封、谁来替身。

| 文件 | 一件事 |
|---|---|
| `plugin/src/engine/port.ts` | `EnginePort` 接口：**零 import**（连包外的都不 import）—— 这是"谁开进程"与"谁用引擎"之间唯一的边界 |
| `plugin/src/engine/exec.ts` | **唯一开进程的地方**（原 `bridge.ts` 的 spawn、`EPERM` 时落盘 spool 回退都搬到这里） |
| `plugin/src/engine/locate.ts` | 决定该跑哪个 CLI：`exeEntry`/`pythonEntry` 的解析与 argv 翻译（`engineCommand()`） |
| `plugin/src/engine/envelope.ts` | 纯函数：`parseEngineOutput()` / `failureOf()` / `BridgeError` |
| `plugin/src/engine/fake.ts` | `createFakeEngine()` —— 内存替身，**只给测试**（不 spawn、不联网） |
| `plugin/src/engine/config.ts`、`project.ts` | 未动（配置默认值与信封投影） |

注入缝只有两处：`plugin/src/index.ts` 造**一次**真端口，`registerTools(ctx, cfg, connections, engine)`
与 `registerWebRoutes(ctx, cfg, connections, engine)` 各收一个端口参数。测试传假端口，
所以 unit 层不需要 SSH、不需要宿主、不需要网络。

### 10.2 测试侧：新增 unit 层，`run.mjs` 变成两段

`test/unit/*.test.mjs` 由 **vitest** 自己发现（依赖钉在 `test/package.json` 的 devDependencies：
`vitest ^5.0.3`）。5 个 spec：

| spec | 覆盖什么 |
|---|---|
| `envelope.test.mjs` | 信封解析与失败文案（含 stderr detail 截断到 **400 字符**、`exit 3` 的 `the CLI printed no JSON`） |
| `locate.test.mjs` | 该跑哪个 CLI ＋ 两条失败路径，以及 `pythonEntry` 被 `resolveConfig` 解析成绝对路径 |
| `fake.test.mjs` | 内存替身自己（测试的地基也得被测） |
| `sessions-route.test.mjs` | 路由层：假 req/res ＋ 内存端口，含"显式 session 时以引擎回答为准" |
| `tools.test.mjs` | 9 个工具的注册与执行，走**真** `defineTool` |

`test/run.mjs` 现在的顺序是：**台账守卫 → 产物新鲜度门禁（必要时调 `plugin/scripts/build.mjs`）
→ unit 段（vitest）→ 7 个密闭套件**；报告里多一个 `unit: { specs, code }`，
verdict 变成 `OK: 7 hermetic suites green, unit specs green`。

- 台账守卫只比对**顶层** `test/*.mjs`，所以 `test/unit/*.test.mjs` 既不必登记、也不会被误判成漏登记。
- 目标架构里写的 `tests/e2e/` **没有**新建：真层套件（`live-route`、`live-late-carrier`、`own-host-check`、
  `boot-graph`）留在 `test/` 原地 —— 它们已经在共用 driver/host 工具与 `test/env/`，再分一层只是搬家。

### 10.3 本次实测

| 命令 | 结果 |
|---|---|
| `node test/run.mjs` | exit 0，先 `running the unit specs (test/unit/**)`：`Test Files 5 passed (5)`、`Tests 48 passed (48)`（约 0.6 s），随后七个套件 `verdict: "OK: 7 hermetic suites green, unit specs green"` |
| `node node_modules/vitest/vitest.mjs run --root test` | 只跑 unit 段，48/48 |
| `npm run typecheck --workspace dsh-visible-ssh` | exit 0，`error TS` 0 个 |
| `node test/live-route.mjs` | exit 0，`OK: the live routes behave as documented` |
| `node test/live-late-carrier.mjs` | exit 0，`OK: the registration lifecycle holds on real cordis` |
| `node test/own-host-check.mjs` | exit 0，**8/8**（`browser half skipped`；`hostStopped:true`、enumerated `["default","e2e"]`） |
| `node test/tools/preflight-dsh-tools.mjs` | 9 个 schema 全被真 `defineTool` 接受；status `attachedClients:1`、list `[default(1), e2e(0)]`、doctor `hostKey:null`、capture 真屏幕（`lsusb` 输出） |
| `./bin/visible-ssh.exe status` | exit 0，`config_path` 仍是 `E:\GitHub\me\ssh\scripts\config\host.toml` |
| `python sync_skill.py --check` | `OK: 14 files match, no drift` |

计数变化：**284 → 332**（＝ unit 48 ＋ 密闭 284）。`plugin/README.md` 的项数表、
根 `AGENTS.md`、`test/README.md`、`plugin/AGENTS.md`、`docs/engine-test-protocol.md` 已同步。

回滚办法：unit 层是新增文件，`git revert 该笔` 即可；代码侧 `bridge.ts` 的旧内容在
`git show c6fe583:plugin/src/engine/bridge.ts`（G 档那一笔）里。

## 十一、S4：引擎产物依赖化（平台包 ＋ sha256 校验）（2026-10-02）

> §九、§十 里记的计数（284 / 332）与 `./bin/…` 路径是**当时**的样子，保留不改；
> 本节起 `bin/` 已退役，路径换成平台包。

### 11.1 产物从一个目录变成一个包

| 之前 | 现在 |
|---|---|
| 仓根 `bin/`（gitignore 的普通目录，三个 exe 手抄进去） | `packages/engine-win32-x64/`，目录名＝包名 `dsh-visible-ssh-engine-win32-x64`，`os:["win32"]`/`cpu:["x64"]` |
| 仓根 `engine.lock` | 包里的 `engine.lock`（`git mv` 过去，内容未变；已用 `git cat-file -e` 确认旧路径在 G 档存在） |
| 三个 exe 全部不进 git | 依旧不进 git（`.gitignore` 改成 `packages/engine-win32-x64/visible-ssh*.exe`，并保留旧名 `bin/`、`engine/` 兜底） |
| 位置靠 `config.ts` 拼 `repoRoot/bin/` | `exeEntry` 默认 **`null`** → `locate.ts` 的 `resolveEngine()` 按包名解析（开发期解到 workspace 链接，装出去解到同层 `node_modules/`）；显式 `exeEntry` 仍可覆盖，`engine:'python'` 仍在 |
| 产物对不对只能事后发现 | `verify.ts` 在 **spawn 之前**按包里的 `engine.lock` 核对字节数与 sha256，对不上就拒绝启动（并指出未登记的多余 exe） |

`packages/engine-win32-x64/package.json` 的 `files` 只列三个 exe ＋ `engine.lock` ＋ `README.md`；
插件在 `optionalDependencies` 里申报 `dsh-visible-ssh-engine-win32-x64: ^0.0.1-c1`
（别的平台装不上、也不会因此失败）。

### 11.2 换 exe 的入口只有两个脚本

| 脚本 | 干什么 |
|---|---|
| `plugin/scripts/engine-lock.mjs` | 重算包里的 `engine.lock`（`--check` 只比、`--commit` 写回；上游 commit 与版本号从旧锁继承，`--built` / `--version` 可覆盖）。**它不执行 exe**，只 stat + hash |
| `plugin/scripts/engine-pack.mjs` | 打平台包 tarball（`--out` 改落点，默认 `scratch/dist/`；**不跑 prepare**，因为 exe 是手工放的）。根 `package.json` 里有 `npm run pack:engine` |

### 11.3 本次实测

| 命令 | 结果 |
|---|---|
| `npm install --ignore-scripts`（仓根） | `added 1 package`；`node_modules/dsh-visible-ssh-engine-win32-x64 -> packages/engine-win32-x64`（workspace 链接，没走 registry） |
| `packages/engine-win32-x64/visible-ssh.exe version` | exit 0，`{"ok":true,"version":"0.0.1-c1","commit":"no-vcs",…}`（搬完三个 exe 的字节数/sha256 逐条与旧锁相同） |
| `packages/engine-win32-x64/visible-ssh.exe status` | exit 0，`config_path` 仍是 `E:\GitHub\me\ssh\scripts\config\host.toml`——配置是**从 exe 目录上溯两级**找到的，三种位置（包目录、`node_modules` 链接后、仓根）实测一致 |
| `npm run typecheck --workspace dsh-visible-ssh` | exit 0，`error TS` 0 个 |
| `node node_modules/vitest/vitest.mjs run --root test` | `Test Files 6 passed (6)`、`Tests 68 passed (68)` |
| `node test/run.mjs` | exit 0，`OK: 7 hermetic suites green, unit specs green` |
| `node plugin/scripts/engine-lock.mjs` | 重算后三个文件的字节数/sha256 与旧锁完全一致（等于顺带验证了搬运没碰过产物） |
| `node plugin/scripts/engine-pack.mjs` | 六件（三个 exe ＋ `engine.lock` ＋ `package.json` ＋ `README.md`），`scratch/dist/dsh-visible-ssh-engine-win32-x64-0.0.1-c1.tgz` **72478 字节**，sha256 `087d87d4805ef0f1a6dd80e14f9cdfa5e1362124da79a1623820a359ddc1d816`；`tar -tzf` 逐条核对六件都在 |
| `python sync_skill.py --prune` → `--check` | `copied: 13, unchanged: 3, removed: 4`（副本里旧的 `engine.lock` 与 `bin/` 三个 exe 被清掉，新增 `packages/`；files **14 → 16**）→ `OK: 16 files match, no drift` |

计数变化：**332 → 365**（＝ unit 48→**68** ＋ 密闭 284→**297**）。其中
`artifact-check` 12→**23**（新增：按包名解析出的目录就是 `packages/engine-win32-x64`、
包清单的名字与 `os`/`cpu`/`files`、锁存在且可解析、三个 exe 都在、`verifyPayload` 放行、
锁里列的每个文件都对得上字节与 sha256、包里没有未登记的 exe），`engine-check` 17→**19**
（`exeEntry` 默认 `null`、显式相对/绝对路径两种覆盖），unit 新增 `verify.test.mjs` **16 项**、
`locate.test.mjs` 从 5 项扩到 **12 项**。

一个小插曲（已修）：第一次打包漏了 `--pack-destination`，tarball 落在了**仓库根**；
脚本当天就补上默认落到 `scratch/dist/`，并把仓根那个散落文件删掉了。

回滚办法：`git revert 该笔`；`bin/` 是 gitignore 目录、已 `rmdir`（空目录不出版本管理），
三个 exe 现在在 `packages/engine-win32-x64/` 下，名字没变。

## 十二、密闭层与本机完全解耦（2026-10-03，K 档）

起因是用户的两条指令（原话）：「1、skills相关的需要先暂时存放到本项目的临时目录下 2、插件相关的先继续实现，确保插件测试与本机实际文件完全解耦」。

### 12.1 skill 副本的默认落点改成仓内临时区

`sync_skill.py` 的默认目标从 `~/.agents/skills/visible-ssh` 改成
`scratch/dist/skill/visible-ssh`（另加常量 `INSTALLED_SKILL`，只在 `--skill` 的 help 里
告诉人真装位置在哪；`--skill` / `VISIBLE_SSH_SKILL_DIR` 覆盖机制不变）。理由：副本里带着
`scripts/config/host.toml`（机密闸门的白名单例外）——**那是真密码**；项目期内它只该当
打包与漂移检查对象。实测 `python sync_skill.py --prune` → `files: 16 (0.3 MB)`、
`copied: 16, unchanged: 0`；`--check` → `OK: 16 files match, no drift`。
旧的真装位置（`C:\Users\me\.agents\skills\visible-ssh`，309 KB／17 个文件，里面那份
`scripts/config/host.toml` 与仓里同大小同时间戳、**带真密码**）已在 **2026-10-03 按操作者确认删除**：
`node test/tools/rmtree.mjs` 报 `{"links":0,"dirs":6,"files":17}`，`~/.agents/skills` 下已无此目录，
工作树与仓库无关。要装回去随时 `python sync_skill.py --skill C:\Users\me\.agents\skills\visible-ssh`
（它会带着真密码 —— 那是它作为"打包对象"的本性；这也是把默认落点挪进仓内的原因）。

### 12.2 密闭层：静态门禁 ＋ 动态剥环境

`test/run.mjs` 在跑任何套件**之前**扫 7 个密闭套件与 `test/unit/*.test.mjs` 的源码，
命中六个 token 之一（`homedir()`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`.agents`、
`\.dsh[\\/]`）就打印 `FAILED: a hermetic suite touches this machine` 并 exit 1。token 用
**路径续接**形式是必须的：裸 `\.dsh` 会撞上 `test/manifest-check.mjs` 里的 `pkg.dsh?.client`
（`test/client-half-check.mjs` 的两处假载荷也因此改成中性路径 `C:/Users/x/visible-ssh/…`）。

跑的时候环境被削过：`HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 指向空的
`test/env/tmp/decoupled/home`，`TMPDIR`/`TMP`/`TEMP` 指向空的 `decoupled/tmp`，并且删掉继承来的
`DSH_HOME`/`DSH_OWN_HOST_HOME`/`DSH_SESSION_ID`/`DSH_WEB_URL`/`DSH_SHELL`/`DSH_PATH_DIALECT`/
`DSH_APP`/`DSH_USERDATA`/`SSH_HOST`/`SSH_PORT`/`SSH_USER`/`SSH_PASSWORD`/`SSH_CONFIG`/
`HOSTCFG_ENV_CONFIG`。收尾 JSON 里多一个 `decoupled` 段说明剥了什么、扫了哪些文件。

三个探针证明它不是装饰：`node -e "require('node:os').homedir()"` → `C:\Users\me`；同一条命令
带上 `USERPROFILE=<decoupled home>` → 返回那个目录（Windows 上 Node 的 `homedir()` 认
`USERPROFILE`）；临时放一个只 `import { homedir }` 的 spec 进 `test/unit/` → 门禁在跑任何
套件之前就报了上面那句判词（探针已删）。`node test/run.mjs` → 仍 `OK: 7 hermetic suites green, unit specs green`。

### 12.3 live 层：凭据一律显式（新增 `test/lib/live-credentials.mjs`）

`live-route` 与 `own-host-check` 现在只有两条**显式**凭据来源：① `SSH_HOST`＋`SSH_USER`
（＋可选 `SSH_PORT`/`SSH_PASSWORD`）→ 在 `test/env/tmp/<name>/config/host.toml` 现写一份
**只含 host/port/user、不含密码**的配置；② `VISIBLE_SSH_USE_REPO_CONFIG=1` → 明说就用本仓
`scripts/config/host.toml` 那份。都没有就打印 `{skipped: …}` 并 exit 0。环境变量 `SSH_CONFIG`
指向那份文件，于是套件既不读操作者
家目录，引擎也不会"从 exe 目录向上"找到仓里那份带真密码的配置。
（这里原本还写了引擎侧的 `HOSTCFG_ENV_CONFIG` —— 后来实测**引擎根本不读那个变量**，
那条已从代码与文档里撤掉，套件现在只设 `SSH_CONFIG`。）

三个只读探针定下了形状：配置**必须有 `[host]` 段头**（第一次跑 `live-route` 就因为漏了它
拿到 `missing or malformed [host] section …`，29 项里那条转 502）；`known_hosts` **不必**
同迁（带与不带结果完全一样）；密码**只走 `SSH_PASSWORD` 就够了**，生成的配置里不必落密码。
（第三条后来有个尾巴：引擎 v0.0.1 起改读 `%USERPROFILE%\.ssh\known_hosts`，仓里那份默认用不上了 —— 见 §十六 与 §十八，结论"不必同迁"不变。）

同批改掉的隐式耦合：`own-host-check.mjs` 删掉"从操作者真家借 profile 字段"的捐赠者分支
（`VISIBLE_SSH_BORROW_HOME` 一并消失，`REAL_HOME` 只剩两个拒绝守卫在用）；
`boot-graph.mjs` 不再默认猜 `%APPDATA%\DSH Desktop`，不给 `DSH_USERDATA`（或 argv）就 `skipped`；
`test/tools/mint-dsh-cookie.mjs` 改成必须 `DSH_CREDENTIALS=<path>` 或 `--credentials <path>`
（否则打印用法、exit 1），不再隐式读 `~/.dsh/.credentials.yaml`；`test/tools/driver.mjs` 支持
`VISIBLE_SSH_BROWSER` 显式指定浏览器、不再把空的 `LOCALAPPDATA` 拼成相对路径。

### 12.4 本次实测

| 命令 | 结果 |
|---|---|
| 显式凭据 → `node test/live-route.mjs` | exit 0，**29/29**，`credentials.how` ＝ `SSH_HOST/SSH_USER/SSH_PASSWORD → …\test\env\tmp\live-route\config\host.toml`，`overview.source:"cli-config"` |
| 显式凭据 → `node test/own-host-check.mjs` | exit 0，**8/8**（`browser half skipped`），`hostStopped:true`，`connectionSource:"SSH_HOST/SSH_USER/SSH_PASSWORD"`，enumerated `["default","e2e"]` |
| `VISIBLE_SSH_USE_REPO_CONFIG=1 node test/live-route.mjs` | exit 0，**29/29**，`how` ＝ `this machine's E:\GitHub\me\ssh\scripts\config\host.toml (VISIBLE_SSH_USE_REPO_CONFIG=1)` |
| 两个 live 检查都不给凭据 | 都打印 `{skipped:"no remote host given. These checks never guess: …"}` 并 exit 0 |
| `env -u DSH_USERDATA node test/boot-graph.mjs` | `{skipped:"no Electron user-data root given — this tool never guesses where your machine keeps it. …"}` |
| `node test/run.mjs` | exit 0，`OK: 7 hermetic suites green, unit specs green`（收尾 JSON 里已有 `decoupled` 段） |
| `python sync_skill.py --prune` → `--check` | `files: 16`，`copied: 16` → `OK: 16 files match, no drift` |

记账没变（解耦只改门禁与 opt-in 层）：unit **68** ＋ 密闭 **297** ＝ **365**。

回滚办法：`git revert 该笔`；被删的捐赠者分支可以从上一笔（`1cf49fd`，J 档）里取回来，
但它是"隐式读操作者真家"的那条，取回来等于把刚解掉的东西再接回去。

## 十三、配置出仓（2026-10-03，M 档）

S5 的目标（`docs/target-architecture.md`）是「配置走用户目录 ＋ 引擎收 `--config`」，风险记的是
「**唯一会碰本机目录的阶段**」。开工前先用只读探针钉契约，结论把计划改掉了一半。

### 13.1 探针：引擎本来就认 `--config`（所以引擎侧一行没改）

| 探针 | 结果 |
|---|---|
| `visible-ssh.exe --config <不存在的绝对路径> status` | exit 2，`{"ok":false,"error":{"kind":"config","message":"config file not found: …\ncopy config\\host.toml.example to config\\host.toml and fill it in"}}` |
| `visible-ssh.exe --config <不存在的绝对路径> version` | exit 0，`{"ok":true,…}` —— **`version` 不加载配置**，拿它验 `--config` 会得到假绿灯 |
| 插件侧端到端 | 临时造一份只含 `[host]` 段与 `host`/`port`/`user` 的 `test/env/tmp/s5-proof/host.toml`，`resolveConfig({configPath:…})` → `configSource:"config"`；再 `createEnginePort(cfg).run(['status'])` 抛 `config \| missing required setting(s) in E:/GitHub/me/ssh/test/env/tmp/s5-proof/host.toml: password` —— 引擎报的是**那份临时配置的路径**，证明 `--config` 真被吃下去 |
| 同上、补上 `password` 再跑 | `console \| transport failed during read: banner exchange: Connection to UNKNOWN port -1: Connection refused`（过了配置校验、真去连 127.0.0.1） |
| 一个候选都没有 | `resolveConfig({}, {}, () => false)` → `{configPath:null, configSource:null}`，`run(['version'])` 照常 |

顺带纠正一处**错的旧记载**：引擎**不看** `HOSTCFG_ENV_CONFIG`（旧文档与 `live-credentials.mjs`
都写过它）。它认的是 `--config <路径>` 与 `SSH_CONFIG=<路径>`；"从 exe 目录向上找
`scripts/config/host.toml`"是**它自己的兜底**，不是插件依赖的路径。

### 13.2 落地（全在插件侧）

- `plugin/src/engine/config.ts`：新增 `systemConfigRoots()`／`userConfigPath()`／
  `chooseHostConfig()` 与 `HostConfigSource`（`config`/`env`/`user`/`repo`）；`resolveConfig()`
  多两个注入参（`env`、`exists`）；`ResolvedConfig` 多 `configPath` 与 `configSource`。
  优先级：插件配置 `configPath` > `SSH_CONFIG` > 用户目录那份 > 仓内 `scripts/config/host.toml`
  （**后两个"存在才用"**，所以新克隆的仓库开箱可用）。
- `plugin/src/engine/locate.ts`：`engineCommand()` 在 `configPath` 非空且调用方没自带 `--config`
  时，把 `--config <绝对路径>` 插在**最前**（`--timeout` 与 verb 之前）；python 分支不插。
- `plugin/src/connection/connections.ts`：选项 `repoRoot` → `configPath`（`source()` 仍只回答
  `profile` / `cli-config` / `none`）。
- `plugin/scripts/host-config.mjs`：`path` / `show` / `install [--force]`，**从不打印配置内容**。
- `scripts/config/host.toml.example` 头部重写成真契约；目标树里那个 `config/host.toml.example`
  有意**没有**落成（理由见 `docs/target-architecture.md` 的 §4.1 与 §4.2）。

### 13.3 本次实测

| 命令 | 结果 |
|---|---|
| `npm run typecheck --workspace dsh-visible-ssh` | exit 0，`error TS` 0 个 |
| `node test/run.mjs` | exit 0，`OK: 7 hermetic suites green, unit specs green` |
| `node node_modules/vitest/vitest.mjs run --root test` | `Test Files 7 passed (7)`、`Tests 85 passed (85)` |
| `python sync_skill.py --check` | `OK: … files match, no drift` |

计数变化：**365 → 389**（unit 68→**85** ＋ 密闭 297→**304**）。其中 unit 新增
`config.test.mjs` **13 项**、`locate.test.mjs` ＋**4 项**；密闭层 `engine-check` 19→**25**
（`--config` 的位置、不重复插、没有候选就不插、python 分支不插），`connection-check` 61→**62**
（`source()` 四档来源，以及"哪儿都没有就是 `none`"）。

一个插曲（已修）：`test/unit/locate.test.mjs` 首跑红 —— `join('E:/repo', …)` 在 Windows 上给的是
**反斜杠**，而那条 spec 的存在性谓词与断言写的是正斜杠字面量，于是 `configPath` 恒为 `null`。
修法是把这个路径提成 `const GO_CONFIG_PATH = join('E:/repo', 'scripts', 'config', 'host.toml')`，
谓词与断言共用。教训：**要求"路径相等"的断言必须由同一个 `join` 造出来**。

回滚办法：`git revert 该笔`；配置真源回到"引擎从 exe 目录向上找 `scripts/config/host.toml`"
（仓内那份一直没动，所以回滚后立刻可用）。

## 十四、本机 CI 与 lint（2026-10-03，N 档）

S6 的目标（`docs/target-architecture.md`）原本是「CI ＋ 发布流程」。开工前先钉环境事实：
`git remote -v` **空**（没有远端可推）、这台机器上**没有 `make`**、npm registry 可达。于是这一阶段
缩成**本机形态**：一条 `npm run ci`，加一套 ESLint。发布会碰 npm 账号和另一个团队编的 exe，
**有意不做**（理由见那篇文档的 §4.2）。

### 14.1 落地

- 仓根 `package.json` 新增脚本：`lint: "eslint ."`、
  `typecheck: "npm run typecheck --workspace dsh-visible-ssh"`、
  `ci: "npm run build && npm run typecheck && npm run lint && node test/run.mjs"`（末段自己还会再查一次
  产物新鲜度，重复一次不会错）。
- 仓根 `eslint.config.mjs`（flat config）：`@eslint/js` 的 recommended ＋ `typescript-eslint` 的
  recommended，**不启用需要类型信息的规则集**（类型已由 `tsc --noEmit` 兜着，再养一套编译路径不划算）。
  忽略 `**/node_modules/**`、`plugin/lib/**`（产物）、`test/env/**`（生成与下载出来的树）、`scratch/**`
  与 `packages/engine-win32-x64/*.exe`（三个 exe 的身份由 `artifact-check` 按 `engine.lock` 的 sha256 管）。
  `no-undef` **全局关掉**，理由写在文件里：名字的真门禁是 `tsc --noEmit`，而这份代码依赖的 Node 全局
  （`process`/`console`/`Buffer`/`fetch`…）随 Node 版本变，客户端半还故意用 `require` 拿 `react`。
  文件名是 **`.mjs`**：仓根 `package.json` 没有 `"type": "module"`，叫 `.js` 会让 Node 先按 CJS 解析、
  再按 ESM 重解析，为此打印一条 `MODULE_TYPELESS_PACKAGE_JSON` 警告。
- 依赖：`eslint@^10.12.0`、`@eslint/js@^10.0.1`、`typescript-eslint@^8.71.0`（peer 要
  `typescript >=4.8.4 <6.1.0`，仓内 `5.9.3` 满足），全在**仓根** `devDependencies`（`added 101 packages`）。

### 14.2 首次 lint 查出的 20 条（全部改代码，没有关规则）

| 位置 | 问题 |
|---|---|
| `plugin/src/engine/envelope.ts` | 死 import（`EnginePort`） |
| `plugin/src/routes/index.ts:39` | 死 import（只用得到 `ProjectedCapture`） |
| `plugin/src/tools/index.ts:117` | `no-useless-escape` ×6：schema description 里多余的 `\"`（JS 里 `'\"' === '"'`，改完值不变） |
| `test/tools/driver.mjs:53-67` | **整段死代码** `channelsToTry()`（`--channel` 早被 `browserCandidates(name)`／`--browser-name`／`VISIBLE_SSH_BROWSER` 取代） |
| `test/tools/driver.mjs` | 抛新错时漏了 `cause`；另一处未用的 `const wanted = new URL(target)` |
| `test/client-half-check.mjs` | 三处 `tree = hooks.render(…)` 的赋值随后从不读（**渲染的副作用才是断言对象**）→ 只留调用；`sectionTree` 的死初值同理 |
| `test/connection-check.mjs:28` | 未用 import `writeConnections` |
| `test/own-host-check.mjs` | 未用 `const PLUGIN = join(ROOT, 'plugin')`；`let failed = 0` 的死初值 |

### 14.3 本次实测

| 命令 | 结果 |
|---|---|
| `npm run lint` | exit 0（无输出；修之前是 20 errors / 0 warnings） |
| `npm run ci` | exit 0，四段全过：build（`copy-client: 39846 bytes`）→ typecheck 0 error → lint 0 problem → `node test/run.mjs` 收尾 `verdict: "OK: 7 hermetic suites green, unit specs green"` |

记账**没变**：unit **85** ＋ 密闭 **304** ＝ **389**（lint 只删死代码，不动断言）。

回滚办法：`git revert 该笔`；lint 配置与那三条脚本都在仓根，删掉就回到"只能手动跑 `node test/run.mjs`"。

## 十五、逐阶段的"测试隔离"影响（S1–S6 收口）

前提不变：测试只活在本仓的 DSH 环境里（`test/env/host` ＋ `test/env/home`，真家被硬拒绝），
见 §十二。这一节是从 `docs/target-architecture.md` 迁过来的 —— 那份文档现在只留"目标"与
"明确不做的事"，不再挂已完成清单。

| 阶段 | 对隔离的影响 | 当时的实测 |
|---|---|---|
| **S1** 目录重排 | 无 | 7 个密闭套件 ＋ `live-route` ＋ `live-late-carrier` ＋ `own-host-check` 全绿 |
| **S2** 源码转 `.ts` ＋ 构建出 `lib/` | 无，但**多一条前提**：跑测试前得先有 `lib/` | 这条已由 `test/run.mjs` 的新鲜度门禁兜住（产物缺了或比源码旧就自动构建），所以照旧 `node test/run.mjs` 一条命令 |
| **S3** vitest ＋ `engine/fake.ts` ＋ 分层 | **更隔离**：unit 层靠假引擎完全不碰 SSH | unit 当时 5 个 spec / 48 项（S4 后 6/68，S5 后 7/85），约 0.6 s，不起进程、不联网；三个 live 套件照旧全绿（它们仍要真 SSH 与仓内宿主） |
| **S4** 引擎产物依赖化 | 依赖落进仓内 `node_modules`（平台包走 workspace 链接），**仍然不出仓** | `node test/run.mjs` 全绿；`live-route` / `own-host-check` 驱动的还是那个 exe，只是换了位置 |
| **S5** 配置出仓 | 唯一会碰本机目录的阶段，碰的是我们自己的 `%APPDATA%\visible-ssh\`（**只在人显式跑 `host-config.mjs install` 时写**） | `node test/run.mjs` 全绿（unit 85 ＋ 密闭 304）；live 套件把配置路径**显式**交给引擎，凭据仍只从 `SSH_HOST`/`SSH_USER`（或 `VISIBLE_SSH_USE_REPO_CONFIG=1`）来，**测试自己不去读用户目录**（`test/unit/config.test.mjs` 用的是假 roots） |
| **S6** 本机 CI ＋ lint | 无，但**新增两条本机门禁**（`npm run lint`、`npm run typecheck`）：只读本仓源码，不装东西、不联网、不 spawn 任何东西 | `npm run ci` 一条命令跑完四段全绿（build → typecheck → lint → `node test/run.mjs`，末段仍是 unit 85 ＋ 密闭 304） |

另：桌面那份 `link:` 只是"让桌面里看得见插件"，开发与测试都不需要它（隔离家的 profile 已经挂了
同一个插件）。它已在 2026-10-02 摘除，命令与四步核验见 `plugin/README.md` §2.2。

回滚办法：本节只是记录，没有可回滚的东西；要还原成"计划文档里的那一节"，看 `git show 75217df:docs/target-architecture.md`。

## 十六、引擎产物升到 v0.0.1 ＋ 取件脚本（2026-10-03，P 档）

`docs/engine-artifacts.md` 讲的是"怎么取、怎么记身份"；这一节只记**这次换组**的实测，
和两条环境事实。

### 16.1 换的是什么

| | 换之前 | 换之后 |
|---|---|---|
| 自报身份（`visible-ssh.exe version`） | `0.0.1-c1` / `no-vcs` | **`v0.0.1` / `4d729fe`** |
| `visible-ssh.exe` | 110080 B / `c7f44ed6…` | **128512 B / `e26ad23a…`** |
| `visible-ssh-askpass.exe` | 11264 B / `f25d8114…` | **11264 B / `07c9edc6…`**（同尺寸、不同字节） |
| `visible-ssh-launch.exe` | 28160 B / `76120082…` | **28672 B / `aeb1bad0…`** |
| 上游那份主 exe 的名字 | `visible-ssh.exe` | **`visible-ssh-c.exe`**（取件时改名） |
| 平台包 `version` | `0.0.1-c1` | **`0.0.1`** |

来源：上游私有仓 `flyghost/omnibus` 的 Release `v0.0.1`，附件
`omnibus-vssh-v0.0.1-win64-lite.zip`（89396 B，sha256 `09323559…746f`）—— 与 GitHub API
自己返回的 `digest` 逐字节一致。换下来的那一组整组归档在仓外
`E:\GitHub\me\_archive\engine-exe-ceff647-20261003\`（含当时那份 `engine.lock`）。

### 16.2 取件脚本 `plugin/scripts/engine-fetch.mjs`

流程、三把锚、令牌与改名规则写在 `docs/engine-artifacts.md`；这里只记实测：

| 命令 | 结果 |
|---|---|
| `--tag v0.0.1 --from-zip <本地附件>`（离线那次） | exit 0，`NO PIN: first pull of this tag`；`entries in the zip: 7`；CRC 全过；三个 payload 都 `CHANGED` |
| `--tag v0.0.1 --flavor lite --install --lock`（带 `GH_TOKEN`，真 API） | exit 0：`ok engine.lock release.sha256`、`ok GitHub API digest`、`self-report: version v0.0.1 commit 4d729fe`；再跑一次变成 `(pinned in engine.lock)` |
| `node plugin/scripts/engine-pack.mjs` | `dsh-visible-ssh-engine-win32-x64-0.0.1.tgz`，**82181 B**，sha256 `3ceb1643d5328dfb…`，六件，解包 172.7 kB |

踩到并修掉的两处（注释都写进脚本了）：
1. **`--json` 不是 go 引擎的旗标** —— `--json version` 与 `version --json` 都是 exit 2，
   能跑的是光一条 `version`。第一版 `readSelfReport()` 带了 `--json`，于是出现
   "`--install` 成功、`--lock` 失败、锁还是旧的"这一步。
2. **`upstream.built` 的语义** —— 上游的包只自报 version/commit，**没有构建时间**，所以它记的是
   那次**发布对外**的时间（`2026-10-03T06:24:53Z (release published; no build time is recorded)`），
   与锁里 `release.published` 是同一个时刻；`engine-lock.mjs` 的 `_comment` 写了这一条。

### 16.3 实测与记账

| 命令 | 结果 |
|---|---|
| `npm run ci` | exit 0，四段全过，`verdict: "OK: 7 hermetic suites green, unit specs green"` |
| `node test/run.mjs` | exit 0；`artifact-check` **一个字没改**就跟着新锁走（它只读 `engine.lock`，从不硬编码字节数/hash） |

记账**没变**：unit **85** ＋ 密闭 **304** ＝ **389**（这一版没有增删 spec）。

⚠️ **一条环境事实**：`npm run ci` 的单元层（vitest 5.0.3）会 fork worker —— 在"把子进程 spawn
掐掉"的沙箱里（本仓的开发期 agent 宿主就是），它以
`[vitest-pool]: Failed to start forks worker … Caused by: Error: spawn EPERM` 失败，而
**build / typecheck / lint 三段照旧能过**。那时换到普通终端跑，或让那个工具放开一次 spawn；
**这不是测试红了**，别拿它当回归。

回滚办法：把 `E:\GitHub\me\_archive\engine-exe-ceff647-20261003\` 那组整组拷回平台包，
再 `git revert` 本笔（锁、版本号、文档会一起回去），最后 `node test/run.mjs`。

## 十七、配置里的缺省会话窗口（2026-10-03，Q 档）

起因（m06580/m06581）：仓库里保存的远程机器要收进**单独一份配置文件**，而且配置里要有
"会话窗口"这一项（默认 `default`）。在这之前，tmux 会话名只能由插件配置 `defaultSession`
给；既然"连哪台机器"已经由选中的那份 `host.toml` 决定，会话名写在同一份文件里更自然。

| 落地 | 位置 |
|---|---|
| `parseHostConfigSession(text)` | `plugin/src/engine/config.ts:314` —— 只扫 `[host]` 段里的 `session`：容忍空行、`#` 注释（引号里的 `#` 算值）、单双引号、裸值、CRLF；别的段里的 `session` 不算；看不懂就 `null`，**从不抛错**（一份陌生文件不该让插件起不来）。**故意不引 TOML 依赖**（本包 `dependencies` 是空的） |
| 三档来源 | `SessionSource = 'config' \| 'file' \| 'default'`（`plugin/src/engine/config.ts:259`）＋ `ResolvedConfig.sessionSource`（`:99`，默认 `'default'` 在 `:159`） |
| 顺序 | 插件配置 `defaultSession` ＞ **选中那份文件**的 `[host] session` ＞ 内置 `'default'`（`:429`）。只有插件没配时才去读文件，而且只读这一次**选中**的那份（没选中就不读） |
| 模板 | `scripts/config/host.toml.example:34-37` 加了注释掉的 `session = "default"` 与解释（引擎不认这个键，未知键照旧被忽略） |

`sessionSource` 目前**只被单测断言，没有运行时消费者** —— 它是诊断用的（"这个会话名是哪来的"），
要显示给用户随时可以接。引擎侧零改动；`[host]` 里多一个键不影响它（未知键照旧忽略）。

回滚办法：`git revert` 本笔。

## 十八、设置页列出本机 ssh 配好的远端（2026-10-03，R 档）

起因（m07106）：设置界面里的 visible-ssh 为什么**不列**本机 ssh 里配好的服务器？能不能加上。

前提是实测出来的（见 §十六 与 `docs/engine-artifacts.md`）：引擎**自己从不解析** `~/.ssh/config`，
它只把 `user@host` 丢给 `ssh.exe`，是 ssh 去展开别名、挑密钥、加 `-i`。所以"拿 ssh 里配好的机器来用"
**本来就通**（实测：`host = "key-host-01"` 这种别名＋一个占位密码，用 `~/.ssh/*.pem` 就登进去了），
缺的只是**看得见**。R 档补的就是那张只读清单。

| 落地 | 位置 |
|---|---|
| 解析器 | 新增 `plugin/src/connection/ssh-config.ts`（173 行）：`parseSshConfig(text, home)` ＋ `loadSshHosts(path, read)`；`SshConfigHost { alias, hostName, user, port, identityFile }`、`SshHostList { path, hosts, error }` |
| 路径 | `plugin/src/engine/config.ts:247-249` 的 `sshConfigPath(roots)` —— **不是可配键**，由 `roots.home` 推出（家目录拿不到就是 `null`）；`resolveConfig` 里挂在 `:425` |
| 路由 | `GET /visible-ssh/connection` 的应答**多一项** `sshConfig: { path, hosts, error }`；注入缝 `ConnectionHandlerOptions.sshHosts?: () => SshHostList`（`plugin/src/routes/index.ts:445-450`），默认 `() => loadSshHosts(cfg.sshConfigPath ?? null)`（`:474`） |
| 界面 | `plugin/src/client/index.js`：`SshHosts`（`:343-373`）画在 设置 → visible-ssh 的表单**上方**（`:301`），每行 `别名 — [user@]hostName[:port] · 密钥 <路径>` ＋ 一个「填入」 |

列什么、不列什么（故意画得很小，目标是"给人一份能挑的清单"，不是替代 ssh 的解析器）：
只列不带 `*`/`?`/`!` 的 `Host` 段（单个 `Host *` 只当默认值补空）；每段只取
`HostName`/`User`/`Port`/`IdentityFile` 的**第一处**值（段内第一个胜出是 ssh 的规矩）；
`Key value` 与 `Key=value` 都认、键名不分大小写、`#` 之后剥掉（引号里的 `#` 算值）；
`port` 只认 1–65535 的纯数字；`~` 只用于**展示**（按家目录展开）；**私钥内容一律不读**；
`Include` 与 `Match` **不展开**，也不处理续行。文件不在是**正常状态**（空清单、`error: null`，
界面直说"没配过"），真读不动（权限等）才把错因显示成一行红字。
「填入」**只写表单**：别名原样进「主机」（仍由 ssh 展开）、`User`/`Port` 写了才填、密钥路径只展示
（引擎不认这个键）、密码要自己填（纯密钥登录时填占位即可，不会被使用）。

测试（**一行都不碰真机**）：新增 `test/unit/ssh-config.test.mjs`（喂文本与假读取器）；
`test/unit/config.test.mjs` 补 `sshConfigPath` 的落点；`test/connection-check.mjs` ＋2
（注入缝只被调用一次、结果原样下发）；`test/client-half-check.mjs` ＋9
（渲染、`填入` 写进「主机」、三种"空/错"说法、旧宿主不给这个字段时整块不画）。

### 18.1 记账

| 命令 | 结果 |
|---|---|
| `npm run ci` | exit 0，四段全过（build → typecheck → lint → `node test/run.mjs`） |
| `node test/run.mjs` | exit 0，`verdict: "OK: 7 hermetic suites green, unit specs green"` |

| | 项数 |
|---|---|
| unit（`test/unit/**`，8 个 spec） | **122** |
| 密闭套件（7 个） | **315**：manifest 11 ／ engine 25 ／ artifacts 23 ／ connection **64** ／ settings 36 ／ route 69 ／ client-half **87** |
| **合计** | **437**（Q＋R 之前是 85 ＋ 304 ＝ 389） |

回滚办法：`git revert` 本笔 —— 那张表会随客户端半与路由一起消失；配置解析、门禁与
引擎产物都不受影响。

## 十九、设置页那张候选表加一个「刷新」（2026-10-03，S 档）

起因：用户的原话是"增加一个刷新按钮，防止后台用户自己编辑 ssh config 文件，导致插件还
检测不到"（存储设计本身维持不变，见 §十八）。

先说**实测**到的现状，免得把这件事当 bug 修：设置区块 `ConnectionSection` 挂着的时候，
本来就每 **5000 ms** 重读一次 `GET /visible-ssh/connection`（`plugin/src/client/index.js`
的 `CONNECTION_POLL_MS`，定义在 `:68`、`setInterval` 在 `:406`），而宿主是**每次请求**
现读磁盘的（`plugin/src/routes/index.ts:474` 默认 `() => loadSshHosts(cfg.sshConfigPath ?? null)`）。
所以在别处改完 `~/.ssh/config`，设置页开着时 ≤5 s 就会自己出现，打开设置页那一刻也会
立刻读一次。⇒ 这个按钮的定位是**「立刻重读 ＋ 明确反馈」**，不是"补上一个缺失的检测"。

落地（**只动客户端半，宿主侧一行未改**，`plugin/src/client/index.js`）：

| 位置 | 改动 |
|---|---|
| `SshHosts` `:343` | 签名变 `({ sshConfig, onPick, onReload, reloading })`；`:353` 那行标题从整块 `div` 改成 flex 行（`span` 拿 `flex: '1 1 auto'`）＋ 右边一个 `button`：`disabled: reloading === true`、`onClick: () => onReload()`、文案 `reloading === true ? '刷新中…' : '刷新'`、title 写清"立刻重读一遍磁盘上的连接清单与 `~/.ssh/config`（刚在别处改完文件时用）" |
| `ConnectionForm` `:196` | 签名变 `({ config, configError, onChanged, onReload = () => {}, reloading = false })`，把它俩透传给 `SshHosts`（`:301`） |
| `ConnectionSection()` `:388` | 加 `reloading` state ＋ `loadRef`/`liveRef` 两个 ref；effect 的 deps **仍是 `[]`**（清单的真相来源永远是宿主，重挂载＝重读，所以不把 `load` 提出来、也不用 `useCallback`）——只把 `load` 存进 `loadRef`、把闭包里的 `live` 换成 `liveRef.current`；新增 `reload()`：正在读就直接返回（防连点），否则 `setReloading(true)` → `void load().finally(…)` 复位 |

测试（**一行都不碰真机**）：`test/client-half-check.mjs` 的 ssh 区块 ＋4 —— 按钮在；
按下时文案变 `刷新中…`；按一下只多发**一次** `GET /visible-ssh/connection`；**新加的
Host 段立刻出现在表里**，不用等下一个 5 s。⇒ client-half **87 → 91**。

### 19.1 记账

| 命令 | 结果 |
|---|---|
| `npm run ci` | exit 0，四段全过（build → typecheck → lint → `node test/run.mjs`） |
| `node test/run.mjs` | exit 0，`verdict: "OK: 7 hermetic suites green, unit specs green"` |
| `node test/client-half-check.mjs` | `{"total":91,"passed":91,"failed":[],"verdict":"OK: …"}` |

| | 项数 |
|---|---|
| unit（`test/unit/**`，8 个 spec） | **122** |
| 密闭套件（7 个） | **319**：manifest 11 ／ engine 25 ／ artifacts 23 ／ connection 64 ／ settings 36 ／ route 69 ／ client-half **91** |
| **合计** | **441** |

回滚办法：`git revert` 本笔 —— 只影响那张表的表头一格，候选表其余行为、路由与宿主侧
都不变。**§十八 里的 315 ／ 437 是 R 档那笔的记账，按规矩不回改。**

## 二十、面板的会话选择器：一次照一个，照谁由人挑（2026-10-03，T 档）

起因：用户原话是"右侧的面板，没法显示多个服务器，多个会话，用户也没法显示选择，这个怎么
弄呢"。当时只在对话里回答（按"不产出文档"的默认），把三处"缺"都归到客户端半，并给了三条
阶梯 —— Tier 1 一个屏幕 ＋ 会话选择器（只改客户端半）／Tier 2 多窗格并排（跨主机要动宿主侧，
且 N 格 ≈ 每秒 N/2 次**完整 SSH 登录**）／Tier 3 引擎保住一条连接 ＋ SSE（属引擎侧，R5 那条
SSE 长连接探针至今没跑）。用户选了 **Tier 1**。

一个关键事实（正是它让 Tier 1 能在客户端半里做完）：宿主侧的屏幕路由**本来就认** `?session=` ——
`plugin/src/routes/index.ts:318` `parseSession(url.searchParams.get('session'), view.session)`，
应答回带 `session` 与 `requestedSession`（`:341-342`）；缓存键是 `keyOf(id, session)`（`:285`），
TTL 300 ms ＋ 同会话单飞。`plugin/src/shared/session-name.ts` 的 `parseSession()` 校验的是**格式**
（`SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,63}$/`，`:17`），不是"必须在 profile 里" ——
所以这台主机上任意合法会话名都能照。

落地（**只动客户端半，宿主侧一行未改**，`plugin/src/client/index.js`）：

| 位置 | 改动 |
|---|---|
| `RemotePaneTab` | 新 state `mirror`（`null` ＝ 跟着主机走）；`hostSession`（＝ `panel.active.session`）、`mirrorSession`、`screenUrl` —— `mirror === null` 时**不带**查询串（与改动前逐字相同），否则 `?session=<encodeURIComponent(mirror)>`；镜像 effect 改成 `fetch(screenUrl, …)`，依赖 `[mirrorReady, mirrorSession]`（换钉＝换一条轮询） |
| 会话行 | 每行第一个按钮「镜像」（钉住时文案变「镜像中」＋ `MIRRORING_STYLE`，再点一下解钉）；小字行尾在 `pinned || following` 时带 ` · 正在镜像`（`following` ＝ 没钉住且就是主机自己那个会话）；`activeSession` 改成 `hostSession`；主机下拉 `onChange` 先 `setMirror(null)`（换主机丢掉钉住的名字） |

测试（**一行都不碰真机**）：`test/client-half-check.mjs` 的 panel 区块 ＋10 —— 默认那次
`GET /visible-ssh/screen` **不带**查询串、且全表只有一行被标记；点某一行的「镜像」后那次取屏
带上 `?session=<该会话>`、`<pre>` 换成它的屏、那一行读作「镜像中」且只有一行这么读；再点回去
回到不带参数；换主机丢掉这个选择。⇒ client-half **91 → 101**。

### 20.1 记账

| 命令 | 结果 |
|---|---|
| `npm run ci` | exit 0，四段全过（build → typecheck → lint → `node test/run.mjs`） |
| `node test/run.mjs` | exit 0，`verdict: "OK: 7 hermetic suites green, unit specs green"` |
| `node test/client-half-check.mjs` | `{"total":101,"passed":101,"failed":[],"verdict":"OK: …"}` |

| | 项数 |
|---|---|
| unit（`test/unit/**`，8 个 spec） | **122** |
| 密闭套件（7 个） | **329**：manifest 11 ／ engine 25 ／ artifacts 23 ／ connection 64 ／ settings 36 ／ route 69 ／ client-half **101** |
| **合计** | **451** |

回滚办法：`git revert` 本笔 —— 只影响会话行上多出来的那个按钮与取屏 URL 上的查询串；
不带参数的旧路径逐字未改。**§十八／§十九 里的 315 ／ 437 ／ 319 ／ 441 是前两笔的记账，
按规矩不回改。**

---

## 二十一、面板：说清它在照谁、失败不留白、超时自己重来（2026-10-03，U 档）

起因（操作者原话，m08176）：**「默认都是未跟随，然后下面的终端的面板，不显示任何东西，
只有跟随中才显示」**。

查下来是两件事叠在一起：

1. **"没显示任何东西"是字面意义上的空白。** 屏幕框的内容只由
   `plugin/src/client/index.js` 的 `placeholder(shot, error)` 决定，而它在
   `shot === null && error !== null` 时**返回空串** —— 也就是"那次取屏**抛错**了"。
   下面那两条错误条（`panelError`／`listError`）说的是另一条路由的事，屏幕框本身不说话，
   于是 502／网络失败在界面上长得和"什么都没发生"一样。
2. **"未跟随"是措辞问题，不是状态。** 默认态（没钉任何行）照的正是当前连接自己的那个会话
   （`plugin/src/routes/index.ts:267` `session: active?.session ?? cfg.defaultSession`，
   取屏 URL 上**不带**参数），可那一行的按钮因为 `pinned === false` 仍读「镜像」，
   只有**被钉住**的行才读「镜像中」；"正在跟着"只体现在行尾一行很淡的小字 ` · 正在镜像`。
   顺带把两个被怀疑的宿主侧原因排除了：真机档案里 `active.session === 'default'` 合法
   （`parseSession(null,'default')` 必 ok，与 `plugin/src/shared/session-name.ts:53-64` 对不上），
   而 `createScreenCache` 只在成功时写 `fresh`、`inFlight` 在 `finally` 里删（`:133-188`），
   失败不会毒化那条键。所以**宿主侧一行未改**。

落地（**全在 `plugin/src/client/index.js`**，另外测试 ＋14）：

| 位置 | 改动 |
|---|---|
| `placeholder()` | **绝不返回空串**：读失败时写 `取屏失败：<原因>` ＋"面板每 2s 会自己再试一次；也可以按上面那个「↻」立刻重试" |
| `RemotePaneTab` | 新常量 `FETCH_TIMEOUT_MS = 20000`。一条永远不回答的请求会把 `inFlight` 永久留在 true（从此一次都不再发），所以 `tick()` 发现上一次已超时就**自己判超时**：丢掉它、写 `取屏超时（超过 20s 没有回答）`、立刻重发。用 `startedAt` ＋ 每轮递增的 `turn` 领号，旧请求晚到的收尾不许动新状态（不是 `setTimeout` 方案 —— 假 fetch 根本不看 `options.signal`） |
| 会话行 | 第一颗按钮在 `following`（没钉住且就是主机自己那个会话）时读**「跟随中」并 `disabled`**，钉住时才读「镜像中」，否则「镜像」；`following` 与 `pinned` 都套 `MIRRORING_STYLE` |
| 面板头部 | 新增一行小字，直接把答案写在脸上：`正在镜像：会话 <名字> · 跟随当前连接` ／ `… · 已钉住`（主机还没报出会话名时写「（主机还没报出会话名）」） |
| 脚注 | 改写成先讲"跟着谁"（「跟随中」／「镜像中」各是哪一行、怎么切回去），再讲「打开」「杀掉」 |

测试（`test/client-half-check.mjs`，**一行都不碰真机**）：`mirrorControl` 认第三种文案「跟随中」；
首次取屏改成失败路径（`<pre>` 里是 `取屏失败：…` 而不是空白、指向已经武装好的重试、状态行读
「读取出错」，随后下一次轮询拿到好回答就恢复）；跟随态三条（按钮读「跟随中」且不可点、
面板那行字写「正在镜像：会话 default · 跟随当前连接」、钉住后改读「已钉住」）；新增超时块
（把 `Date.now` 拨快 60s 后下一次 tick 自己判 `取屏超时` 并重发，随后一条好回答把屏恢复）。
⇒ client-half **101 → 115**。

### 21.1 记账

| 命令 | 结果 |
|---|---|
| `npm run build` | `copy-client: 52240 bytes` |
| `node test/client-half-check.mjs` | `{"total":115,"passed":115,"failed":[],"verdict":"OK: …"}`，exit 0 |
| `npm run lint` | exit 0（无输出） |
| `node test/run.mjs` | exit 0，`verdict: "OK: 7 hermetic suites green, unit specs green"` |

| | 项数 |
|---|---|
| unit（`test/unit/**`，8 个 spec） | **122** |
| 密闭套件（7 个） | **343**：manifest 11 ／ engine 25 ／ artifacts 23 ／ connection 64 ／ settings 36 ／ route 69 ／ client-half **115** |
| **合计** | **465** |

回滚办法：`git revert` 本笔 —— 四处都只是客户端半的措辞与自保逻辑（`placeholder` 的失败文案、
`tick()` 里的超时判定、按钮文案与 `disabled`、头部那行小字），宿主侧与引擎侧都没动。
**§二十 里的 329 ／ 451 ／ 101 是上一笔的记账，按规矩不回改。**

## 二十二、面板：宿主说不出"当前连接"时，跟着屏幕自己回报的那个会话（2026-10-03，V 档）

起因是操作者贴回的一段面板实况（U 档落地的当天）：

```
session "default" · 245×66 · 66 行 · cursor 20,65 · → host.toml · 读取中… · 21:26:50
正在镜像：会话 （主机还没报出会话名） · 跟随当前连接
会话 default   存在 · 1 人已接入   镜像 打开 杀掉
会话 e2e       存在               镜像 打开 杀掉
```

两条读法：`→ host.toml` ⇒ 那次取屏的 `connection.source === 'cli-config'`；
`（主机还没报出会话名）` ⇒ 客户端算出的 `hostSession === null` ⇒ **这一份
`GET /visible-ssh/connection` 的 `active` 是 `null`**，尽管屏幕自己明明回报了
`session "default"`。于是两行会话都读「镜像」，没有任何一行被标成跟随 —— 用户看到的
"默认都是未跟随"就是这个。

诊断：U 档那句 `hostSession` 取自 `panel.active?.session`（`plugin/src/routes/index.ts:639-666`
的 `targets()` 在 `activeId` 落空时把 `active` 报成 `null`），**唯独没听屏幕自己的**。
`shot.session` 一直是有的 —— 屏幕路由的应答里就写着 `session`（与 `requestedSession` 一起，
`plugin/src/routes/index.ts:338-348`）。所以这是客户端侧的取错源，不是宿主坏了。

顺带记下当时的一件环境事实（不构成改动理由，但解释了为什么会撞上）：宿主侧半跑的是
**它自己启动时那份代码** —— 桌面宿主三进程 `DSH Desktop.exe` 启动时间都是 2026/10/2 12:08，
而 `plugin/src/connection/connections.ts` 的最后两次改动（`72c6f4e` F 档、`db60639` M 档）
都在 2026-10-03；客户端半却是现读磁盘的（U 档文案确实出现了）。**结论不是"要不要重启宿主"，
而是客户端必须自己扛住宿主 payload 与屏幕不一致。**

落地（**全在 `plugin/src/client/index.js`**，另外测试 ＋4）：

| 位置 | 改动 |
|---|---|
| `RemotePaneTab` 的"跟着谁" | `shotSession`（应答里的 `session`，非空字符串才算）**优先**，退回 `connectionSession`（`panel.active?.session`）；`hostSession = shotSession ?? connectionSession` |
| 同上 | 新常量 `followingConnection = panel !== null && panel.active !== null`，用来区分"跟随当前连接"与"跟随宿主默认" |
| 镜像 effect 依赖 | `[mirrorReady, mirrorSession]` → **`[mirrorReady, screenUrl]`**：URL 才是这次轮询的完整身份；不钉时 URL 是常量，屏幕回报会话名不会白花一条 SSH。原来的 `mirrorSession` 随之删掉 |
| 面板头部那行小字 | `正在镜像：会话 <名字> · 跟随当前连接` ／ `· 跟随宿主默认`；连屏幕都还没读到才写「（还没读到屏幕）」（旧写法是「（主机还没报出会话名）」） |
| 会话行标题 | `following` 的 title 分两句：有当前连接时说"跟着当前连接自己的会话（设置里那条连接的「tmux 会话名」）"，否则说"跟着宿主的默认会话（眼下没有活跃连接，屏幕按配置文件里的 session 走）" |

测试（`test/client-half-check.mjs` 的会话选择器子块末尾新增一段，**一行都不碰真机**）：
推一次面板轮询并答 `{...panelPayload, source:'cli-config', active:null}`，断言摘要行读
`正在镜像：会话 default · 跟随宿主默认` 且 `default` 那一行读「跟随中」（`disabled`）；
再推一次轮询答回 `panelPayload`，断言读回「跟随当前连接」。
⇒ client-half **115 → 119**。

### 22.1 记账

| 命令 | 结果 |
|---|---|
| `npm run build` | `copy-client: 53655 bytes` |
| `node test/client-half-check.mjs` | `{"total":119,"passed":119,"failed":[],"verdict":"OK: …"}`，exit 0 |
| `npm run lint` | exit 0（无输出） |
| `node test/run.mjs` | exit 0，`verdict: "OK: 7 hermetic suites green, unit specs green"` |

| | 项数 |
|---|---|
| unit（`test/unit/**`，8 个 spec） | **122** |
| 密闭套件（7 个） | **347**：manifest 11 ／ engine 25 ／ artifacts 23 ／ connection 64 ／ settings 36 ／ route 69 ／ client-half **119** |
| **合计** | **469** |

回滚办法：`git revert` 本笔 —— 五处都只是客户端半"跟着谁"的取源、依赖数组与两句文案，
宿主侧、引擎侧、路由都没动。
**§十八／§十九／§二十／§二十一 里的 315 ／ 437 ／ 319 ／ 441 ／ 329 ／ 451 ／ 101 ／
343 ／ 465 ／ 115 是各笔当时的记账，按规矩不回改。**

## 二十三、面板：服务器与会话各一个下拉（2026-10-03，W 档）

起因是操作者在 V 档答复之后直接给的形状（此前我摆的是"甲：服务器下拉保持
'切换当前连接'语义／乙：宿主侧加 `?profile=`"，两条都要动别的东西）：

> 用两个下拉框，一个是服务器列表，一个是会话列表

改动前面板的形状：头部一个 host `<select>`（只在连接清单非空时画；它的语义是
**切换"当前连接"**，写进连接档案，9 个模型工具跟着一起换机器），每个会话行一颗
「镜像」按钮（读「镜像」／「镜像中」／「跟随中」），"正在照谁"只能靠按钮文本 ＋
行尾一行很淡的小字认出来。

落地（**全在 `plugin/src/client/index.js`**，测试随之改写）：

| 位置 | 改动 |
|---|---|
| `MIRRORING_STYLE` | 换成 `MIRRORED_ROW_STYLE = { borderColor: 'rgba(63,185,80,0.7)', color: LIVE_COLOR, background: 'rgba(63,185,80,0.06)' }` —— 按钮没了，高亮搬到**行容器**上（行容器 style 末尾 `...(pinned || following ? MIRRORED_ROW_STYLE : {})`），小字行尾仍写「 · 正在镜像」 |
| 会话行 | 只剩「打开」「杀掉」两个动作（原来那颗「镜像」按钮删掉） |
| 头部那行 | 只剩 状态点 ＋ `statusText` ＋ 撑开 ＋ `↻`（host `<select>` 挪到下面） |
| 头部之后新增的那一行 | `服务器` 标签 ＋ host `<select>`（`value: activeId`；`onChange` 先 `setMirror(null)` 再 `act('activate', {action:'activate', id})`；title 说明它换的是设置里那份连接清单的「当前」，模型工具也跟着换机器；清单为空时改画「（连接清单里还没有服务器）」） |
| 同一行 | `会话` 标签 ＋ 会话 `<select>`（`value: mirror === null ? '' : mirror`；第一项 `value ''`，文本 `(followingConnection ? '跟随当前连接' : '跟随宿主默认') + (hostSession === null ? '（会话名还没读到）' : ' · ' + hostSession)`；`onChange` 先 `setConfirming(null)` 再 `setMirror(值 === '' ? null : 值)`；title 写明"一次只照一个 —— 一次取屏就是一条全新的 SSH 连接"；`!mirrorReady` 时改画「（还没有能照的屏幕）」） |
| `sessionChoices` | 枚举失败时钉住的名字仍留在下拉里（`mirror !== null && sessionNames.indexOf(mirror) === -1` 就补到末尾），否则下拉会显示成空值 |
| 脚注 | 改成"两个下拉各换什么"（服务器 = 换机器；会话 = 换这一格在照谁，选回第一项即不带参数）＋「打开」「杀掉」 |

测试（`test/client-half-check.mjs` 的会话选择器子块整段改写，**一行都不碰真机**）：
helper 从 `mirrorControl` 换成 `sessionSelect`（按 title 前缀「这块屏幕照哪个」认出第二个
下拉）／`pick`／`chosen`／`mirroredRow`；URL 层的断言不变（默认那次 `GET /visible-ssh/screen`
**不带参数**、选过之后带 `?session=`、选回第一项又回到不带参数、换服务器丢掉钉住的名字），
换掉的是"谁被当成正在照的那一行"。
踩过一次坑：`rowFor` 原来取 `findAll(node,'div')` 的**第一个**匹配，而那个是**包着两行的
外层容器**（它的文本也以「会话 default」开头）⇒ scratch 那行的「 · 正在镜像」被算到
default 头上（表现为 `expected [true,false], got [true,true]`）；改成取**文本最短**的那个
（即最内层）后过。⇒ client-half **119 → 123**。

### 23.1 记账

| 命令 | 结果 |
|---|---|
| `npm run build` | `copy-client: 55491 bytes` |
| `node test/client-half-check.mjs` | `{"total":123,"passed":123,"failed":[],"verdict":"OK: …"}`，exit 0 |
| `npm run lint` | exit 0（无输出） |
| `node test/run.mjs` | exit 0，`verdict: "OK: 7 hermetic suites green, unit specs green"` |

| | 项数 |
|---|---|
| unit（`test/unit/**`，8 个 spec） | **122** |
| 密闭套件（7 个） | **351**：manifest 11 ／ engine 25 ／ artifacts 23 ／ connection 64 ／ settings 36 ／ route 69 ／ client-half **123** |
| **合计** | **473** |

回滚办法：`git revert` 本笔 —— 改的全是客户端半的渲染与测试，宿主侧、引擎侧、
路由、连接档案都没动。
**§十八–§二十二 里的 315 ／ 437 ／ 319 ／ 441 ／ 329 ／ 451 ／ 101 ／ 115 ／ 343 ／
465 ／ 347 ／ 469 ／ 119 是各笔当时的记账，按规矩不回改。**

## 二十四、取屏之外的收尾不该把成功变成失败（2026-10-03，X 档）

起因是操作者贴回的真机面板里多了一行：

> bridge: EBUSY: resource busy or locked, unlink
> 'C:\Users\me\AppData\Local\Temp\dsh-glwkLs\dsh-visible-ssh\32028-1791038245086-116814.out'

诊断：受限宿主**不能用管道收子进程输出**（`stdio: 'pipe'` 会 EPERM），所以
`plugin/src/engine/exec.ts` 的 `runSpooled` 把 stdout/stderr 落到临时**三元组**
（`.out`／`.err`／`.cmd`），收尾的 `finally` 里无条件 `rm` 这三个文件。但「打开」那个动作
经由引擎的 `watch` 拉起的**真控制台**（`visible-ssh-launch.exe`）会把 `.out` 一直攥在手里
⇒ `unlink` 报 EBUSY ⇒ 异常从 `finally` 冒出来，**盖掉本来已经成功的返回值**；`exec.ts` 的
`run()` 把非 `BridgeError` 的错抛成 `engineSpawnError`，而路由
（`plugin/src/routes/index.ts` 的 `describeFailure`）对**没有 `kind`** 的错误一律归为
`bridge` —— 面板上那行就是这么来的。宿主 tmpdir 因此堆了几百个没删掉的暂存文件。

落地（**全在 `plugin/src/engine/exec.ts`**）：

| 位置 | 改动 |
|---|---|
| 收尾 | 三个 `rm` 换成 `removeBestEffort(path)`：`rm(path, { force: true, maxRetries: 5, retryDelay: 50 })`，失败吞掉并回 `false`（**删不掉是常态，不是错误**） |
| 新增 `sweepSpoolDir(dir, ttlMs = SPOOL_TTL_MS, now = Date.now())` | 导出，只收 `.out`／`.err`／`.cmd` 里 mtime 超过 `SPOOL_TTL_MS = 60 * 60 * 1000` 的；`readdir` 失败回 `[]`；**只有真删掉才把名字放进返回表** |
| 新增 `sweepSpoolOnce(dir)` | `runSpooled` 每次 `mkdir` 之后调一次，`sweptDirs` 这个 Set 保证**每个进程每个目录只扫一次**（否则每次取屏都要 `readdir` 一遍几百个文件） |

测试：新增 `test/unit/spool.test.mjs`（4 项，vitest，全在 `test/env/tmp/unit-spool/` 里
造文件、用 `utimesSync` 把 mtime 推到 TTL 之外）——超龄的三类被收走、新鲜的留下；
非暂存文件（`notes.txt`、`host.toml`）不动；**删不掉的暂存文件不抛**
（用**非空目录**冒充，`rm` 不带 recursive 报 ENOTEMPTY）；目录不存在回空表。
踩过两次坑：`fs.rm` 对**空目录**是会成功的（第一版拿空目录"冒充删不掉"，断言直接失败）；
把"尝试过"和"真删掉"混为一谈的那一版（无条件 push 名字）也被测试逮住。

### 24.1 记账

| 命令 | 结果 |
|---|---|
| `npm run build` | `copy-client: 55491 bytes` |
| `node node_modules/vitest/vitest.mjs run test/unit` | `Test Files 9 passed (9)`／`Tests 126 passed (126)` |
| `npm run lint` | exit 0（无输出） |
| `node test/run.mjs` | exit 0，`verdict: "OK: 7 hermetic suites green, unit specs green"`，`notRun` = 4 个 OPT_IN |

| | 项数 |
|---|---|
| unit（`test/unit/**`，9 个 spec） | **126** |
| 密闭套件（7 个） | **351**：manifest 11 ／ engine 25 ／ artifacts 23 ／ connection 64 ／ settings 36 ／ route 69 ／ client-half **123** |
| **合计** | **477** |

回滚办法：`git revert` 本笔 —— 只动了 `plugin/src/engine/exec.ts` 的收尾（新增两个纯函数
＋ 改三行 `rm`）与一个 unit spec；引擎 argv、路由、连接档案、客户端半都没动。
**§十八–§二十三 里的 122 ／ 473 等数是各笔当时的记账，按规矩不回改。**

## 二十五、密钥机不该被"首次必须给密码"挡住（2026-10-03，Y 档）

起因是操作者在设置里用候选表把一台**密钥机**填进表单、按保存，被拒：

> 在设置里，通过填入按钮的，但是这个服务器是密钥的，怎么保存不了
> bad-profile: a password is required the first time a connection is saved

根因：`plugin/src/connection/connections.ts` 的 `validateProfile()` 里留着旧 C 引擎
（`hostcfg.c:411` 要求 `password` 非空）留下的那道闸门 —— 既没给密码、又没存过密码，
就直接 400 `bad-profile`。而这版（v0.0.1）引擎**不需要**它：插件只把 `SSH_HOST`／
`SSH_PORT`／`SSH_USER` 交给 `ssh.exe`（只有存过密码时才多给一个 `SSH_PASSWORD`），
没有密码就走操作者 `~/.ssh` 里的密钥 —— 这正是 `~/.ssh/config` 里带 `IdentityFile`
的机器本来就该走的路。

实测（`packages/engine-win32-x64/visible-ssh.exe`，只在环境里给 `SSH_*`、不传 `--config`，
与插件交给引擎的形状一致）：

| 场景 | 结果 |
|---|---|
| `key-host-01`（`~/.ssh/config` 里带 `IdentityFile` 的密钥机），**完全不设** `SSH_PASSWORD` | `{"ok":true,"session":"default","exists":true,"sessions":[{"name":"default","attached":0,"windows":1,"current":true}]}`，exit 0 |
| 同一台，给一个占位密码 | 同样 ok ⇒ 有没有密码都不挡 |
| `192.0.2.10` ＋ 正确密码 | ok（`default` attached 1 ＋ `e2e`） |
| `192.0.2.10` ＋ 错密码 | `{"ok":false,"error":{"kind":"console","message":"transport failed during read: me@192.0.2.10: Permission denied (publickey,password)."}}`，exit 3 ⇒ **认证失败是响的**，不是静默 |
| `192.0.2.10` 完全不设密码 | ok（本机默认密钥可用） |
| `key-host-01` ＋ 仓内 `scripts/config/host.toml`（那份密码属于 `192.0.2.10`）跑 `status` | `{"ok":true,…,"last_line":"root@example-host:~#"}`，exit 0 ⇒ 不相关的密码不会破坏密钥登录（ssh 先试公钥） |
| `lan-box` ＋ 任意密码 | 那台当时不可达：`transport failed during read: ssh: connect to host 192.0.2.11 port 22: Connection timed out`，exit 3（与密码无关） |

落地：

| 位置 | 改动 |
|---|---|
| `plugin/src/connection/connections.ts` | `validateProfile(input, { password }: { password?: unknown } = {})` —— 删掉 `hasStoredPassword` 这个参数与那条拒绝分支（原地留注释说明它为何作废）；`saveProfile()` 不再为了算它多读一遍旧档案。**空字符串仍然被拒**（要清掉密码就删档案） |
| `plugin/src/client/index.js` | 档案行改「没有保存密码：走本机 ~/.ssh 里的密钥」；密码格 placeholder 改「可留空（走本机密钥的机器不需要）」；候选表 `pick()` 的提示按那个 Host 段里有没有 `IdentityFile` 分叉（有值就明说"密码那一格留空即可 —— ssh 会用 <IdentityFile>"）；小字说明同步改 |
| `test/connection-check.mjs` | 原「没密码要拒」改成「收下」（`validateProfile(base)`），并补 3 项**路由级**断言：密钥机首次保存 200（`hasPassword:false`）、交给引擎的环境里确实**没有** `SSH_PASSWORD`、删得掉 —— connection 64 → **67** |

### 25.1 记账

| 命令 | 结果 |
|---|---|
| `npm run build` | `copy-client: 56003 bytes` |
| `node test/connection-check.mjs` | `{"total":67,"passed":67,"failed":[],"verdict":"OK: the connection layer behaves as documented"}`，exit 0 |
| `npm run lint` | exit 0（无输出） |
| `node test/run.mjs` | exit 0，`verdict: "OK: 7 hermetic suites green, unit specs green"`，`notRun` = 4 个 OPT_IN |

| | 项数 |
|---|---|
| unit（`test/unit/**`，9 个 spec） | **126** |
| 密闭套件（7 个） | **354**：manifest 11 ／ engine 25 ／ artifacts 23 ／ connection **67** ／ settings 36 ／ route 69 ／ client-half **123** |
| **合计** | **480** |

回滚办法：`git revert` 本笔 —— 改的是连接档案的校验（去掉一条拒绝分支）、客户端半的文案
与 `connection-check` 的断言；引擎、argv、路由、脱敏、取屏都没动。
**§十八–§二十四 里的 64 ／ 351 ／ 477 等数是各笔当时的记账，按规矩不回改。**

**收口补记（同一笔的后续提交）：** 设置页那张候选表下面还留着一句旧话 ——「注意引擎要求密码那一格有值：用密钥登录时随便填一个占位即可，它不会被使用」—— 与本次去掉闸门直接矛盾（那是一道**已经不存在**的引擎约束），已改成「密码那一格「可以留空」：上面写了「密钥 …」的那几台根本不需要密码，ssh 会自己拿那把密钥去连；真需要密码的机器才填」。重跑之后 `copy-client: **56062 bytes**`，unit 126 ／ 密闭 **354** ／ 合计 **480** 不变。

## 二十六、对话框里也有一格：服务器选择器（2026-10-03，Z 档）

起因，User said (m09642) 原话：「是否可以在对话框里，增加一个服务器选择呢，这个选择只是在设置界面里，添加的服务器列表里选择，可以吗」

结论：**可以，而且不必新造机制** —— cordis 的槽位就是给这个用的。挑中的是 `conversation.input.left`：composer 那一排的 **list** 槽位（scope = session，按 `id` 占格，`priority` 再 `order` 排序），实际位置是**输入框下面那一排的左半边**（紧挨「工作区内修改」那个下拉）。没占 `conversation.input.model`（single，模型选择器的座）也没占 `conversation.input.permission`（权限选择器的座）。

两条约束决定了实现形状：

- **列表与「当前」都在 GET 里**：`targets()`（`plugin/src/routes/index.ts:639-666`）是 `GET /visible-ssh/sessions` 的应答（`source` / `active` / `profiles` / `defaultSession` / `file` / `sessions`）；`POST /visible-ssh/sessions` 只有 `activate` 带回 `{...targets()}`（`:701-705`），`list` / `open` / `kill` 只回各自的短应答（`:708-741`）⇒ 选择器读 **GET**；面板那套 `POST {action:'list'}` 是取远端会话行用的，不取连接清单。
- **写只有一条路**：选中 = `POST /visible-ssh/connection {action:'activate', id}` —— 与设置页的「使用」、面板的「服务器」下拉是**同一次**，三处永远不会各说各话。
- 用**原生 `select`**，不引 `@deepseek-ai/dsh-client-ui-primitives`：`manifest-check` 的冻结基座里虽然有它，但 `client-half-check` 的替身只实现了 `require('react')`，用它就得连着造一套替身；面板已经证明原生 select 够用。

落地：

| 位置 | 改动 |
|---|---|
| `plugin/src/client/index.js` | 新增 `ServerPicker()`：挂载时 `GET /visible-ssh/sessions` 一次、随后每 5s 重读；`profiles` 为空渲染 `null`（不占地方）；`value` 取「当前连接」那台而不是第一行；切换时置灰、只发一次 `activate`，应答里带 `profiles` 就整份换掉；读失败把原因写进 `title`。`apply(ctx)` 里 `ctx.slots.inject('conversation.input.left', …)` → `register({ name, id:'visible-ssh:server', order:10, label:()=>'visible-ssh' }, ServerPicker)` |
| `test/client-half-check.mjs` | 替身补 `conversation.input.left` 分支（`ctx.composer` ＋ `composer` 组件）＋ 2 条注册断言，末尾新增 15 项行为断言（空清单不渲染、自己那条 5s 轮询、选项文案与 `value`、切换置灰且只发一次、应答后选中项跟着改、再选当前那台不发请求、别处切换后轮询跟上、读失败写进 `title`）—— client-half 123 → **140** |

### 26.1 记账

| 命令 | 结果 |
|---|---|
| `npm run build` | `copy-client: 61032 bytes` |
| `node test/client-half-check.mjs` | `{"total":140,"passed":140,"failed":[],"verdict":"OK: the mirror, the panel actions and the settings form behave as documented"}`，exit 0 |
| `npm run lint` | exit 0（无输出） |
| `node test/run.mjs` | exit 0，`verdict: "OK: 7 hermetic suites green, unit specs green"`，`notRun` = 4 个 OPT_IN |

| | 项数 |
|---|---|
| unit（`test/unit/**`，9 个 spec） | **126** |
| 密闭套件（7 个） | **371**：manifest 11 ／ engine 25 ／ artifacts 23 ／ connection 67 ／ settings 36 ／ route 69 ／ client-half **140** |
| **合计** | **497** |

真宿主实测（自带 web 宿主 `http://127.0.0.1:7610/` ＋ 共享浏览器 driver；只做只读 DOM 检查，**没有**在真页面上点选切换 —— 那会改掉这台开发宿主的「当前连接」）：

| 看什么 | 看到什么 |
|---|---|
| 页面上的 `<select>` | 3 个：① 对话框里这一格（`value:"key-host-01"`、options `['LAN 机 — me@192.0.2.10:22','key-host-01 — root@key-host-01:22']`、父元素文本以「服务器」开头、`title` 里写着「这一格就是「当前连接」」）② 面板的「服务器」下拉 ③ 面板的「会话」下拉 |
| 位置 | viewport 2560×1305；composer 容器 x=464 y=646 w=754 h=114；输入框（contenteditable）x=464 y=654 w=750 h=52；控制条 x=464 y=718 w=754 h=42 —— 我们那格在其中（组 x=650 y=725 w=217 h=24、select x=687 y=726 w=180 h=21），即**输入框下面那一排的左半边**，紧挨「工作区内修改」 |
| 是否真送达 | `__DSH_BOOT__.entries` 66 条里 1 条含 `visible-ssh`；`POST /reload` 之后它仍在、值仍是 `key-host-01` ⇒ 是打包进被送达的 bundle，不是热更残影 |

回滚办法：`git revert` 本笔 —— 改的是客户端半（多一个组件 ＋ 一次槽位注册）与 `client-half-check` 的替身/断言；路由、连接层、引擎 argv、脱敏、取屏都没动。
**§十八–§二十五 里的 64 ／ 123 ／ 351 ／ 354 ／ 477 ／ 480 等数是各笔当时的记账，按规矩不回改。**

## 二十七、对话框那一格拆成两格：服务器 ＋ 会话；字体对齐邻居（2026-10-03，Z2 档）

起因，User said (m09971) 原话两条：「1、这个对话框的字体，感觉和对话框的其它不太统一，是由什么统一的地方获取字体的吗？ 2、这个只能选择服务器，没法选择会话」

**① 字体没有"统一的地方"可取。** 实测同一排里就有三种规格：我们那一格是 12px / 行高 `normal`，旁边的「工作区内修改」是 13px / 行高 20px，输入框是 14px / 24px；宿主自己也没把它统一。所以只能**对齐最近的邻居**：控件 13px ＋ 高 24px，旁边的小标签 12px。落成三个常量：`COMPOSER_CONTROL_STYLE`、`COMPOSER_LABEL_STYLE`、`COMPOSER_REFRESH_STYLE`（面板那套 `SELECT_STYLE` 的 12px 不动 —— 面板不是 composer）。
**`lineHeight` 那一条对原生 `<select>` 是无效的**：Chromium 自己接管它的文本盒，真页面实测 computed 仍是 `normal`（同档的按钮倒是吃到了 18px）。真正把两者对齐的是**字号 13px 与高度 24px**；`lineHeight` 留着只是与同档按钮的声明一致，别指望它挪 select 里那行字 —— 这一点写进了源码注释。

**② 「会话」那一格做什么，用户拍板选了 A**（ask_user_question）：**让 AI 在这个会话里干活** —— 改的是设置里那台连接**自己的 `session`**，工具与镜像都跟着，重启宿主仍然记得。被否的是 B（只改面板镜像的屏幕）—— 面板里那个「会话」仍然只管屏幕，两者不是一回事，文案里都写明了。

- **宿主侧 `plugin/src/connection/connections.ts`**：门面新增 `async setSession(session: unknown): Promise<{ ok: true; session: string } | { ok: false; message: string }>` —— `parseSessionName()` 校验；**开头那道 `typeof session !== 'string' || session === ''` 是必须的**：`session-name.ts:33` 的 `String(value)` 会把 `undefined` 认成字面量 `'undefined'`，而 `SESSION_RE`（`:17`）**接受**它，那样一个漏字段的请求会静悄悄把当前连接切到名叫 `undefined` 的会话上（第一次跑 `connection-check` 就撞上了）；没有当前连接时回 `'there is no current connection: activate one before changing its session'`；命中才 `mutate()` 写盘。
- **`plugin/src/routes/index.ts`**：sessions 路由 POST 新增 `{action:'session'}` → `connections.setSession(body.session)`，成功回 200 `{ ok: true, ...(await targets()) }`（一次往返刷新整张视图，与 `activate` 同款），失败 400 `{ kind: 'bad-session', message }`；未知 action 的文案改成 `expected list, open, kill, activate or session`。
- **`plugin/src/client/index.js`**：`ServerPicker` → **`ComposerPicker`**，渲染「服务器」＋「会话」两个原生 `select` ＋ 一个 `↻`。会话清单来自 `POST {action:'list'}`，而**一次枚举＝一条 SSH 连接**，所以它**不**跟 5s 轮询走：挂载读一次、`activeId` 变了读一次、按 `↻` 立刻再读一次（`title` 说明这一点，忙碌时含「正在枚举」）。当前会话永远钉在清单最前（远端没报它也得有 option 可落）；一台都没存过仍渲染 `null`（不占地方）。
- 顺手修掉两处旧毛病：① `pick()` 原来打 `POST /visible-ssh/connection`（那条路由的应答里**没有** `target`，选中后显示成 `label — undefined`），现在与设置页、面板同一个 `POST /visible-ssh/sessions {action:'activate'}`；② 面板提示里残留的 `**这一格屏幕**` 星号（客户端字符串是纯文本，星号会照原样显示）—— 并补一句「这里只改屏幕，那里改的是 AI 干活用的会话」。

| 位置 | 改动 |
|---|---|
| `plugin/src/connection/connections.ts` | 新增 `setSession()`（含非字符串/空串那道闸门） |
| `plugin/src/routes/index.ts` | `{action:'session'}` → 200 ＋ `targets()` ／ 400 `bad-session` |
| `plugin/src/client/index.js` | `ComposerPicker`（两格 ＋ `↻`）、三个样式常量、修 `pick()` 端点与面板提示的星号 |
| `test/connection-check.mjs` | ＋8 项（写盘、另一台不动、磁盘上也是、坏名字 400 式拒绝、`undefined` 被拒、被拒后不变、没有当前连接时拒绝）—— 67 → **75** |
| `test/route-check.mjs` | ＋7 项（200 整张视图且不碰引擎、`profiles` 行带新 session、坏名字 400 `bad-session`、没字段 400、未知 action 逐字文案）—— 69 → **76** |
| `test/client-half-check.mjs` | 重写对话框块：两个 select、挂载恰好一次枚举、换机器再枚举一次、`↻` 只读一次、选中发一次 `{action:'session'}`、当前会话钉最前、别处切换后轮询跟上、读失败写进 `title`、没有档案仍渲染 `null` —— 140 → **155** |
| `test/unit/sessions-route.test.mjs` | ＋1 项（`session` 动作 200 回整张视图且 `engine.calls` 为空、空串 400）—— 10 → **11**（unit 126 → **127**） |

### 27.1 记账

| 命令 | 结果 |
|---|---|
| `npm run build` | `copy-client: 66782 bytes`（Z 档是 61032；本档收口时补了一条源码注释，于是 66390 → 66782） |
| `node test/client-half-check.mjs` | `{"total":155,"passed":155,"failed":[],"verdict":"OK: the mirror, the panel actions and the settings form behave as documented"}`，exit 0 |
| `node test/connection-check.mjs` | `{"total":75,"passed":75,…}`，exit 0 |
| `node test/route-check.mjs` | `{"total":76,"passed":76,…}`，exit 0 |
| `npm run lint` / `npm run typecheck` | 都是 exit 0（无输出） |
| `node test/run.mjs` | exit 0，`verdict: "OK: 7 hermetic suites green, unit specs green"`，`notRun` = 4 个 OPT_IN |

| | 项数 |
|---|---|
| unit（`test/unit/**`，9 个 spec） | **127** |
| 密闭套件（7 个） | **401**：manifest 11 ／ engine 25 ／ artifacts 23 ／ connection **75** ／ settings 36 ／ route **76** ／ client-half **155** |
| **合计** | **528** |

真宿主实测（自带 web 宿主 `http://127.0.0.1:4400/` ＋ 共享浏览器 driver；只读 DOM 检查 ＋ 一次 HTTP 往返）：

| 看什么 | 看到什么 |
|---|---|
| 页面上的 `<select>` | **4 个**：① 对话框「服务器」（`value:"192-0-2-11"`、options `['LAN 机 — me@192.0.2.10:22','key-host-01 — root@key-host-01:22']`）② 对话框「会话」（`value:"default"`、options `['default','e2e']` —— 当前会话钉在最前）③ ④ 面板那两个（`['LAN 机 ✓','key-host-01']` 与 `['跟随当前连接 · default','default','e2e']`）；页面上 `↻` 按钮 2 个（对话框一个、面板一个） |
| 字号 | 对话框那两格 13px / 高 24px、标签 12px / 不透明度 0.55、`↻` 13px / 行高 18px / 高 24px；面板那两格仍是 12px / 20.67px；输入框 14px / 24px。select 的 computed `line-height` 一律 `normal`（见上） |
| 新动作真的通了 | 用宿主自己的 token 换 cookie 后 `POST /visible-ssh/sessions {"action":"session","session":"z2check"}` → 200，应答里 `active.session` 变成 `z2check`、`sessions` 是 `[{name:'z2check',exists:null}]`；`{"session":"no spaces"}` → **400**；再改回 `default` → 200。开发宿主的 home 是隔离的，改的是它自己那份 `connections.json` |

回滚办法：`git revert` 本笔 —— 改的是连接层（多一个写 `session` 的方法）、sessions 路由（多一个动作）、客户端半（那一格拆成两格）与三个套件的断言；引擎 argv、脱敏、取屏、设置页字段都没动。
**§十八–§二十六 里的 67 ／ 69 ／ 140 ／ 371 ／ 497 等数是各笔当时的记账，按规矩不回改。**

## 二十八、删掉 skill 交付线（2026-10-03）

起因，User said (m10406)：「这个项目不需要skill了吧，是不是可以删掉了」。核对后确认这条线与插件**零耦合**，
用户选「全删」。

**零耦合的证据**：没有任何代码读 `SKILL.md`（全仓只有 `plugin/src/engine/config.ts` 的 `:15` 与 `:287`
两句**注释**提到"skill 副本"）；`package.json` 里没有相关脚本；`test/run.mjs` 与 7 个密闭套件不碰它；
本机真装副本 `C:\Users\me\.agents\skills\visible-ssh` 早在 §12.1 就已删掉。唯一的损失是
`SKILL.md` 这份**面向模型的引擎操作手册**（要把引擎交给别的机器／ssh 团队时才用得上）。

**删了什么**（都可从历史取回）：

| 东西 | 说明 |
|---|---|
| `SKILL.md`（13901 B） | 引擎操作手册，另一条交付线的正文真源 |
| `sync_skill.py`（17807 B） | 把本仓**单向**复制成自包含 skill bundle 的同步器（含机密闸门） |
| `scratch/dist/skill/visible-ssh/` | 同步产物：`node test/tools/rmtree.mjs` 报 `{"links":0,"dirs":7,"files":17}`（353.5 KB），含一份带真密码的 `scripts/config/host.toml` |

**引用收口**（现状类文档一律删引用，历史章节一律不动）：

| 位置 | 改动 |
|---|---|
| 根 `AGENTS.md` | `:10` 的「skill 正文真源」、`:19` 行尾、那张 `SKILL.md ＋ sync_skill.py` 表行、`:89` 的文档清单、两条 bullet（同步流程与机密闸门）、「引擎的运行残渣」一行里的 `SKIP_PREFIXES` —— 全部删掉 |
| `plugin/README.md` | 删掉「`test/` 与 `plugin/` 不会被同步进副本」整段 |
| `plugin/AGENTS.md` | 硬性约束 2 的理由从"会被发布进副本"改成"那是提交区的边界，`git add -A` 会带上" |
| `test/README.md` | 末句改成「这两棵树只在本仓存在」＋ 各自装着什么 |
| `docs/engine-test-protocol.md` | §8 的「搬走后必须跟着改引用」清单里去掉两个文件名 |
| `.gitignore` | 残渣那条注释只留「别让它进提交区」 |
| `test/run.mjs` | 密闭 token `~/.agents` 留着（隔离仍然不许碰操作者的技能目录），reason 文案改成「names the operator's skill install directory (outside the repository)」 |
| `scratch/AGENTS.md`（gitignore 的本地规矩） | `:4` 去掉"不是 skill 副本的一部分"；`:58` 改成「在仓库根丢一个文件，`git add -A` 就会顺手带上」 |
| 本文件 | §一 基线表删掉 `python sync_skill.py --check` 那行；§三 第 4 步只留 `node test/run.mjs`；§四 去掉 `与 SKILL.md`；§二 判据 2 加一句「这条判据出自 `sync_skill.py`，该工具已在§二十八 删除，判据与编号留着」 |

回滚办法：`git show 6b535cd:SKILL.md`（`sync_skill.py` 同理）即可取回文件本体；`git revert` 本笔能恢复引用。
**§十二（含 §12.1）到 §二十七 里的 `sync_skill.py` 记账是各笔当时的实测，按规矩不回改。**

## 二十九、公开化：把操作者机器的标识换成占位符（2026-10-04）

起因，User said (m10554)：「检查下这个项目，是否还存在密钥等其它的东西，我准备把它提交到远程分支了」。

**先给审计结论：没有任何凭据。** 29 笔提交、86 个受跟踪文件，逐 blob 比对：

| 查什么 | 结果 |
|---|---|
| 拿本机 `scripts/config/host.toml` 里那把真密码比对全历史 | **0 命中** |
| `BEGIN OPENSSH PRIVATE KEY` / `PRIVATE KEY` | 0 |
| `sk-` / `ghp_` / `github_pat_` / `AKIA` / `xox` / JWT(`eyJ…`) | 29 笔里 0 个文件命中 |
| 名字像凭据的受跟踪文件（含历史路径） | 只有模板 `scripts/config/host.toml.example`（`CHANGE_ME`／`192.0.2.10`／`your-user`）与只读环境变量的 `test/lib/live-credentials.mjs` |
| 40+ 字符的长串 | 只出现在 `package-lock.json`（integrity）、`packages/engine-win32-x64/engine.lock`（sha256）、本文件 `:413`（tgz 摘要）、`test/unit/verify.test.mjs:170`（`ba7816bf…f20015ad` = sha256("abc")） |
| 夹具里的字面量口令 | `test/connection-check.mjs:91,109,160,279,288`（`secret`／`a\nb`／`hunter2`／`route-secret`）、`test/live-route.mjs:182`（`not-the-real-one`）—— 全是合成值 |
| `git status --short -uall` | 空（`git add -A` 带不上任何未跟踪文件） |
| 远程 | 没有配置（`.git/config` 里没有 url/token 行），根 `package.json` 也没有 author/url 字段 |

`.gitignore` 的 `:65` `**/host.toml`、`:66` `!**/host.toml.example`、`:67` `**/known_hosts`、
`:68-70` `**/.credentials.yaml|yml`、`**/connections.json`、`:71-72` `**/id_rsa`、`**/id_ed25519`
都在挡位（`git check-ignore -v` 复核过）。

**会随文档一起公开的只有机器标识**，所以本笔把它们换成了占位符 —— 包括本文件历史章节里的字面值。
**这是唯一一次动历史章节的内容**：数字、结构、结论一字未改，只把"哪台机器"换掉；不换的话，
公开出去的账本等于把操作者的内网拓扑、主机名与用户名一起发出去。

**替换对照表**（哪台机器 → 哪个占位符）**只存在于本机**：`scripts/config/site-profile.md`（gitignore，
形状照 `host.toml`／`host.toml.example` 的老规矩）。**这份账本里不写真值** —— 它是要公开的，
写了等于没换。被换掉的类别是：

- 局域网那台与同网段另一台的 IP，以及后者的 profile id（点换成横线）；
- 操作者 `~/.ssh/config` 里另一条别名机，与它的登录用户；
- 走密钥的云主机地址、它的 shell 提示符主机名、它的别名与 `.pem` 名；
- 局域网那台的别名一族与登录用户、以及它的显示名（夹具与文档里那一串 `lan-box*`／`me` 就是它们）；
- 操作者的 Windows 用户目录。

替换后的占位符一律取自 RFC 5737 的文档段（`192.0.2.0/24`、`198.51.100.0/24`）与合成名字
（`lan-box`／`me`／`key-host-01`／`example-host`）—— 看一眼就知道是例子。

**真值对照表留在这台机器上**：`scripts/config/site-profile.md`（gitignored），入库的是模板
`scripts/config/site-profile.md.example`（形状照 `host.toml`／`host.toml.example` 的老规矩，
`.gitignore` 加了 `**/site-profile.md` ＋ `!**/site-profile.md.example`）。
**代码与测试都不读它** —— 一旦有测试去读本机文件，密闭层的静态扫描（`DSH_HOME`／`homedir`／
`USERPROFILE`／`APPDATA`／`LOCALAPPDATA`／`~/.dsh`）会直接判红，那也正是"测试与本机解耦"
这条硬性约束的边界。

**没有换的**：`192.168.1.20`、`10.0.0.1`、`10.0.0.9`、`edge.local` 本来就是教科书的例子；
`plugin/src/client/index.js:358` 的输入框占位符 `192.168.1.20 或 pi.local` 与 `:372` 的
`例：树莓派` 也是通用举例，而且改 `plugin/src/**` 要重建产物、牵动 `copy-client` 的字节数记账。

记账：本笔只换字面值，**项数一个没动**（unit 127 ＋ 密闭 401 ＝ 528，与 §一 一致）；
`git diff --stat` = **11 个文件、＋158／−158**（完全对称）；`node test/run.mjs` 仍
`OK: 7 hermetic suites green, unit specs green`（7 个密闭套件全数通过、`notRun` 仍是 4 个 OPT_IN）；
`npm run lint` 干净。附带一条教训：替换脚本第一次跑还改了 `test/env/host/node_modules/` 下
5 个第三方文件（`@opentelemetry/semantic-conventions` 的 `pi@`、`fontkit` 的 `'pi'`）——
那些被 `.gitignore` 的 `node_modules` 挡住进不了提交，但说明**任何遍历都得排除 `node_modules`**；已按精确计数还原。

**公开线不带历史。** 这些标识在历史里是真实存在的（出现在 4 笔，`df05751` → `6b535cd`；
第一笔 `292339c` 里还没有），而**新提交抹不掉旧 blob**。
`git filter-repo` 本机没装，且本文件引用了 14 个 hex 提交号（重写历史会让它们全部失效）。
所以按用户拍板：**从当前树起一条不带历史的孤儿线**（`git checkout --orphan master` ＋ 单笔根提交；
分支名取 `master`，与远端默认分支一致），**并且不再留那条带真值历史的旧开发线** ——
按用户要求"别保存 `main`，防止后期搞混"，原来那条 29 笔的线连同 `main` 分支一起删了
（它只在本机 reflog 里还找得到，`git gc` 之后不可恢复）。**代价**：库里只有根提交这一个提交号，
本文件 §一…§二十八 里引用的那些 hex id 在库里查不到。

回滚办法：本笔的字面值改动本身可以 `git revert`（它就在 `master` 上）；但**那条带真值历史的旧线回不来了** ——
若在 `git gc` 之前发现还需要它，`git reflog` 里还能翻到号（例如导出前的 `1763f5c`、更早的
`6b535cd`），`git branch <临时名> <号>` 即可复活，复活出来的只是**本机存档**，别推。
**§一–§二十八 里被换掉的标识见上表，条目、数字、结论都没动。**


