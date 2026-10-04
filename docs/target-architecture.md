# 目标架构：把这套东西当正常的 npm 包工程

> **这是目标，不是现状。** 现状看 `plugin/README.md`（插件本体）、根 `AGENTS.md`（仓库地图与规矩）、
> `test/README.md`（测试设施）、`docs/engine-artifacts.md`（引擎产物）；
> 已经走过的路、当时的决定与实测，看 `docs/test-baseline.md` —— 它的 §十–§十六 就是 S3–S6 与引擎产物取件（P 档）的落地记录。
>
> 分阶段的 S1–S6 **已经全部落地**，所以这份文档从此只剩两件事：
> **§3 目标树里还没做的部分**，和 **§4 明确不做的事**（含目标树里"有意没落成"的那几行）。

## 0. 一句话

把这套东西当**一个正常的 npm 包工程**来写：TypeScript 源码住 `src/`，构建产物住 `lib/`，
测试分 `unit` 与 `e2e`，配置有一个明确真源，引擎产物当**依赖**而不是当手抄的二进制。

## 1. 参照物：生态里真实存在的那个包

`dsh-better-sidebar@0.19.1`（第三方、已发布；仓库里留了一份上游参考 clone 在
`scratch/better-sidebar/`）。它不是官方样板，但它是**同一套宿主、同一代 DSH、真的发出去过**的
第三方插件，所以它的形状比任何想象都可靠：

- 顶层：`src/ tests/ scripts/ docs/ Makefile eslint.config.js playwright.config.ts
  tsconfig.json tsconfig.build.json tsdown.config.ts vitest.config.ts package.json
  pnpm-workspace.yaml pnpm-lock.yaml cordis.patch.yml dsh.plugin.json README*.md`
- `package.json`：`main: lib/index.js`、`types: lib/types/index.d.ts`，`exports` 的每条子路径都
  带 `types`/`default` 条件，`files` 是**白名单**，`dsh: { bundle: { patch }, client: { inject: […],
  platform: "web" } }`，`packageManager: pnpm@11.8.0`，`engines.node >= 20`。
- `scripts`：`build`（先删 `lib/`，再 `tsc -p tsconfig.build.json && tsdown`）、`prepare: tsdown`、
  `watch: tsdown --watch`、`test: vitest run`、`lint: eslint .`。
- `dsh.plugin.json`：`{ id: "dsh-external/<name>", version, main: "./lib/index.js",
  engines: { dsh: ">=…" }, contributes: { … }, client: { main: "./lib/client-registry.js" } }`。
- `src/` 下**真的住着 TS 源码**，客户端那半是几十个 `.tsx`（还带 `.css`），发出去的是 4 个 client
  bundle —— 也就是说"客户端半必须手写、不能有构建步骤"是我们这一代的**限制**，不是终态。

要点：它把「一个 DSH 插件」当成一个普通 npm 包来工程化。我们缺的不是能力，是这层工程化。

## 2. 目标目录树

```
dsh-visible-ssh/
├─ package.json                  exports 带 types 条件、files 白名单、dsh.bundle / dsh.client
├─ dsh.plugin.json               插件身份清单：id / main / engines.dsh / client.main
├─ cordis.patch.yml              往 profile 里插入的那一条
├─ tsconfig.json  tsconfig.build.json  tsdown.config.ts
├─ vitest.config.ts  playwright.config.ts  eslint.config.js
├─ pnpm-workspace.yaml  pnpm-lock.yaml  Makefile
├─ src/
│  ├─ index.ts                   组合根：注册 tools 与 routes、采纳 settings
│  ├─ engine/                    与引擎之间的接缝（整块可以被换成一个 port）
│  │  ├─ port.ts                 接口：status/capture/run… 的形状（类型就是契约）
│  │  ├─ exec.ts                 真实现：spawn、argv 顺序、超时、无管道回退
│  │  ├─ envelope.ts             信封：ok / error.kind / 退出码 → 类型化错误
│  │  ├─ locate.ts               产物定位：exe 在哪（按包名解析平台包）
│  │  ├─ verify.ts               身份校验：按 engine.lock 核字节数与 sha256，对不上就拒绝启动
│  │  └─ fake.ts                 假引擎：喂一段 JSON，得到确定的投影（测试用）
│  ├─ connection/
│  │  ├─ store.ts                连接档案与密码域
│  │  └─ settings.ts             「设置 → visible-ssh」命名空间
│  ├─ routes/                    三条浏览器路由，一条一文件
│  │  ├─ mirror.ts  panel.ts  connection.ts
│  ├─ approval/index.ts          破坏性动作的审批接缝
│  ├─ tools/                     9 个模型工具，一个 verb 一个文件
│  │  ├─ status.ts  capture.ts  run.ts  up.ts  reset.ts  down.ts  list.ts  doctor.ts  watch.ts
│  │  └─ index.ts                汇总注册
│  ├─ shared/
│  │  ├─ paths.ts                路由路径常量：宿主半与客户端半共用的唯一天源
│  │  ├─ session-name.ts
│  │  └─ errors.ts
│  └─ client/                    浏览器半：真 TSX，打包成 bundle
│     ├─ index.tsx  panel.tsx  connection-form.tsx  sgr.ts   （SGR＝ANSI → 样式）
├─ lib/                          构建产物（**gitignore**）
├─ scripts/                      人跑的入口：install.ps1 / install.sh / watch.cmd
├─ config/host.toml.example      配置模板（真配置在用户目录，靠 `--config` 指过去）
├─ tests/
│  ├─ unit/                      vitest：纯函数、假引擎、假 req/res
│  └─ e2e/                       playwright ＋ 真宿主：401/303、面板渲染
└─ docs/
```

上面这些行**不全是目标**：`plugin/src/engine/` 的六个文件、`lib/`、`exports` 的 `types` 条件与
`files` 白名单、配置出仓（用户目录 ＋ `--config`）、平台包（引擎产物当依赖）、ESLint、本机 CI
**都已经落地**（S1–S6，见 `docs/test-baseline.md`）；剩下没落成的在 §3；有意不落成的在 §4.2。

## 3. 还没做的

| # | 今天的现象 | 目标做法 | 为什么值得动 |
|---|---|---|---|
| 1 | `src/tools/index.ts` 一口气 9 段注册 | `src/tools/<verb>.ts`，一个 verb 一个文件 | 加一个 verb 只碰一个文件；diff 不再互相打架 |
| 2 | `src/client/index.js` 828 行单文件、零构建、全靠 `React.createElement` | `src/client/*.tsx` ＋ 打包器 | JSX/TS 的类型检查能在写的时候抓错；单文件正在逼近可维护上限 |
| 3 | 三条路由路径在宿主半与客户端半各写一份（靠 `test/manifest-check.mjs` 守漂移） | `src/shared/paths.ts` 单一真源 | 把"靠测试守"变成"结构上不会漂" |
| 4 | 浏览器半没有类型检查（宿主侧 S2 已落地：`src/**/*.ts` 过 tsc） | 同第 2 条 | 同上 —— 这一行是"宿主侧做了、浏览器半还没做"的另一个切面 |
| 5 | e2e 仍是手写 runner ＋ 两张台账名单（unit 层 S3 已用 vitest） | playwright 接管 e2e | 台账由文件系统决定，不再手维护 |

第 4、5 条分别是原表第 6、8 行落地后**剩下的那一半**；第 1–3 行至今没动过。

## 4. 明确不做的事

### 4.1 结构上的

- **不改 `plugin/` 这个目录名。** 目录名＝包名：宿主 profile 里安装的是这个名字，改名要动宿主侧；
  而且现代工程里"源码目录"是**包内的 `src/`**，所以正确方向是**包里长出一个 `src/`**（S1 已经做了），
  不是把包改名成 `src/`。`lib/` 这个名字要留给**构建产物**（S2）。
  （桌面 profile 里那条 `link:` 的来龙去脉与摘除记录见 `plugin/README.md` §2.2。）
- **不挪 `scripts/`。** 生态里 `scripts/install.ps1|sh` 就是给人跑的入口，并且进 `files` 白名单。
  该挪的是**配置**，而那件事已经由 S5 达成：真配置住用户目录，由插件解析成绝对路径后作为
  `--config` 交给引擎。仓内 `scripts/config/host.toml` 留作**开发期兜底**，模板
  `host.toml.example` 仍在它旁边 —— 那条路径同时是引擎自己"从 exe 目录上溯"的兜底查找点，
  搬它只会多一处要同步的路径。
- **不动引擎的 C 源码。** `hostcfg.c` 里那条查找契约属于另一个仓；S5 实测引擎**本来就认**
  `--config <路径>` 与 `SSH_CONFIG=<路径>`，所以配置出仓一行 C 都没改。真要改引擎，走
  `docs/engine-test-protocol.md` 那条路去谈，别在本仓偷偷绕。
- **保留放宽后的 peer 范围。** 上游生态（含 `dsh-better-sidebar`）全挂 `^0.1.5-rc.1`，
  我们额外接受 `^0.2.0-rc.2`（`plugin/package.json`）。这条不能跟着上游抄回去 ——
  抄回去的后果是打包器在 profile 启动时**静默丢掉**整个 bundle。

### 4.2 目标树里"有意没落成"的那几行

- **`dsh.plugin.json`**：`package.json` 的 `dsh` 段（`bundle.patch` ＋ `client.platform`）宿主就认，
  再加一份身份清单只会多一处要同步的地方。
- **`tsdown.config.ts` / `tsconfig.build.json`**：宿主侧就 10 个 ESM 模块，`tsc -p tsconfig.json`
  一个入口（`plugin/scripts/build.mjs`）编到 `lib/` 就够 —— 零新运行时依赖，也少一层配置面。
  打包器留给"客户端半要 JSX/TS"的那一天（§3 第 2 条）。
- **`vitest.config.ts` / `playwright.config.ts`**：vitest 用默认约定（`test/unit/**/*.test.mjs`）；
  playwright 还没接（§3 第 5 条）。两个配置文件目前都没有要写的东西。
- **`tests/` 这个目录名**：unit 落 `test/unit/`，e2e 就是顶层那批 `test/*.mjs` 原地不动 ——
  台账、路径与文档早围着它们写好了，理由见 `test/README.md`。
- **`config/host.toml.example` 在 `config/`**：仍在 `scripts/config/`，理由见 4.1 第二条。
- **`Makefile`**：这台机器上**没有 `make`**；入口就是根 `package.json` 的 `npm run …`
  （`build` / `typecheck` / `lint` / `test` / `ci` / `pack:engine`）。
- **`pnpm-workspace.yaml`**：仓根是 **npm** workspace；两种包管理器并存只会多一份要同步的清单。
- **`.github/workflows/`**：这个仓库**没有 git remote**（`git remote -v` 空），写一份没人跑过的
  工作流只是多一个文件。本机 CI 就是 `npm run ci`（build → typecheck → lint → `node test/run.mjs`）。
- **真发布流程**：要一个 npm 账号，而且平台包里的 exe 是引擎团队编的，得他们先首肯。
  现在要把插件连同引擎交给别人，靠 workspace 链接或 `npm run pack:engine` 出的 tarball。

---

S6 之后的功能增量（`host.toml` 里多一项插件自己读的 `[host] session`、设置页列出本机 ssh
配好的远端）**不写进这份文档** —— 这里只留"目标"与"明确不做的事"，增量记在
`docs/test-baseline.md` 的 §十七／§十八。
