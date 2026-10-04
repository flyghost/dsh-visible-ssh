# dsh-visible-ssh

**让 AI 的 SSH 远端操作对人可见** —— 实时看着 AI 在远端 tmux 里干活，随时接管。DSH（DeepSeek Harness）插件。

**Make your AI agent's SSH work visible** — watch the remote tmux pane live, take over anytime. A DSH plugin.

---

## 中文

### 这是什么

AI 在远端主机上跑命令，通常你只能看到一段黑盒日志。这个插件把模型敲的每个字符**送进一个你正附着的 tmux pane**：
你在自己机器上 `ssh -t … tmux attach` 到同一个 pane，就能实时看见它在干什么，任何时候 Ctrl-C 接管。

重点不是"通过 SSH 跑命令"，而是那个 pane 是**双方共用的**。这个性质来自 tmux 本身，所以插件不自己实现传输，
只驱动一个编译好的引擎（`visible-ssh.exe`，动词式 CLI、JSON 信封输出）。

### 装好之后有什么

- **设置 → visible-ssh**：连接清单（服务器、端口、用户、密码、要用哪个会话名）。密码**可以留空** —— 走密钥的机器不需要它；密码只留在本机，插件从不把它写进 `host.toml`。
- **输入框左边两格**：选「服务器」和「会话」。换掉之后，这次会话里的模型工具与右侧镜像都跟着走。
- **右侧栏面板**：实时镜像远端那个 pane 的屏幕（2 秒轮询）；每个存在的会话一行，`打开` 用来附着/复用、`杀掉` 结束它，`↻` 刷新列表。
- **9 个模型工具**：`ssh_console_up` / `watch` / `status` / `list` / `capture` / `run` / `reset` / `down` / `doctor`。

### 快速上手

```powershell
npm install                                                          # 工作区依赖（构建工具）
npm run build                                                        # src/**/*.ts → lib/
node plugin/scripts/engine-fetch.mjs --tag v0.0.1 --install --lock   # 取引擎三个 exe（exe 不进 git）
npm run ci                                                           # build + typecheck + lint + node test/run.mjs
dsh plugin --profile web add link:E:/path/to/dsh-visible-ssh/plugin  # 挂进 DSH profile 后重启宿主
```

改 `plugin/src/client/index.js`（面板那一半）约 1 秒自动热更；宿主侧 `src/**/*.ts` 改完要先 `npm run build` 再重启宿主。

### 目录

| 路径 | 是什么 |
|---|---|
| `plugin/` | 插件本体：宿主半 `src/**/*.ts` 编到 `lib/`，客户端半是手写的 `src/client/index.js` |
| `packages/engine-win32-x64/` | 引擎平台包：三个 exe ＋ `engine.lock`（exe 不进 git，用 `engine-fetch.mjs` 取） |
| `scripts/config/` | `host.toml.example`（引擎的连接配置模板）与 `site-profile.md.example`（站点标识对照表模板） |
| `test/` | 测试设施：单元测试 ＋ 7 个密闭套件 ＋ 隔离家（不碰你这台机器的 `~/.dsh`） |
| `docs/` | 目标架构、测试基线、引擎产物与协议 |

细节都在 [`plugin/README.md`](plugin/README.md)（安装、排错、行为契约），架构与账本见
[`docs/target-architecture.md`](docs/target-architecture.md) 与 [`docs/test-baseline.md`](docs/test-baseline.md)。

### 远端需要什么

一台 Linux/Unix 主机，装了 `tmux`，有一个能密码或密钥登录的账号；本机是 Windows ＋ OpenSSH 客户端即可。

### 许可证

以 **Apache License 2.0** 发布，见 [`LICENSE`](LICENSE)（英文原文为唯一有效文本）与
[`LICENSE.zh-CN`](LICENSE.zh-CN)（中文参考译文）。Copyright 2026 flyghost。

---

## English

### What it is

When an AI runs commands on a remote host, all you normally get is an opaque log. This plugin sends every character the
model types **into a tmux pane you are attached to**: run `ssh -t … tmux attach` on your own machine and you watch the
agent work live in that same pane, ready to Ctrl-C and take over at any moment.

The point is not "running commands over SSH" — it is that the pane is **shared**. That property comes from tmux itself,
so the plugin does not implement transport; it drives a compiled engine (`visible-ssh.exe`, a verb-style CLI with
JSON-envelope output).

### What you get

- **Settings → visible-ssh**: the connection list (host, port, user, password, session name). The password **may be left
  empty** — machines that authenticate by key do not need one. It is stored locally only; the plugin never writes it into
  `host.toml`.
- **Two cells left of the composer**: pick the server and the session. Switching moves this session's tool calls and the
  mirrored pane with it.
- **Side panel**: mirrors the remote pane's screen live (polled every 2 s). One row per existing session; `打开` attaches
  or reuses it, `杀掉` ends it, `↻` refreshes the list.
- **9 model tools**: `ssh_console_up` / `watch` / `status` / `list` / `capture` / `run` / `reset` / `down` / `doctor`.

### Quick start

```powershell
npm install                                                          # workspace deps (build tooling)
npm run build                                                        # src/**/*.ts → lib/
node plugin/scripts/engine-fetch.mjs --tag v0.0.1 --install --lock   # fetch the three engine exes (not in git)
npm run ci                                                           # build + typecheck + lint + node test/run.mjs
dsh plugin --profile web add link:E:/path/to/dsh-visible-ssh/plugin  # install into a DSH profile, then restart the host
```

Edits to `plugin/src/client/index.js` (the panel half) hot-reload in about a second; changes under `src/**/*.ts` (the host
half) need `npm run build` followed by a host restart.

### Layout

| Path | What it is |
|---|---|
| `plugin/` | The plugin: host half `src/**/*.ts` compiled to `lib/`, client half hand-written in `src/client/index.js` |
| `packages/engine-win32-x64/` | The engine platform package: three exes + `engine.lock` (exes are not tracked; fetch them with `engine-fetch.mjs`) |
| `scripts/config/` | `host.toml.example` (engine connection template) and `site-profile.md.example` (site-identifier template) |
| `test/` | Test facilities: unit specs + 7 hermetic suites + an isolated home (never touches your `~/.dsh`) |
| `docs/` | Target architecture, test baseline, engine artifacts and protocol |

Details live in [`plugin/README.md`](plugin/README.md) (install, troubleshooting, behaviour contract); architecture and the
running account are in [`docs/target-architecture.md`](docs/target-architecture.md) and
[`docs/test-baseline.md`](docs/test-baseline.md).

### Remote requirements

A Linux/Unix host with `tmux` and an account you can log into by password or key; on the local side, Windows with an
OpenSSH client is all you need.

### License

Licensed under the **Apache License, Version 2.0** — see [`LICENSE`](LICENSE) (the authoritative English text) and
[`LICENSE.zh-CN`](LICENSE.zh-CN) (a Chinese reference translation). Copyright 2026 flyghost.
