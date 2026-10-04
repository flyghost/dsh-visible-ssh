# `dsh-visible-ssh-engine-win32-x64` —— 引擎产物平台包

这个目录**既是一个 npm 包，也是引擎产物的投放点**（2026-10-02 S4 起；此前是仓根 `bin/`）。

| 文件 | 受版本管理？ | 是什么 |
|---|---|---|
| `package.json` | ✅ | 包清单：名字 `dsh-visible-ssh-engine-win32-x64`、`os: win32`、`cpu: x64`、`files` 白名单 |
| `README.md` | ✅ | 本文件 |
| `engine.lock` | ✅ | **产物身份锁**：三个 exe 的字节数/`sha256` ＋ 上游 commit ＋ 来自哪个 Release 附件（含附件 `sha256`）＋ 自报版本（`*.exe` 不进 git，身份只能记在这里） |
| `visible-ssh.exe` | ❌ gitignore | CLI 本体 |
| `visible-ssh-askpass.exe` | ❌ gitignore | 密码助手 —— **引擎按自己的 exe 目录找它** |
| `visible-ssh-launch.exe` | ❌ gitignore | 弹窗助手 |

- 三个 exe **必须同目录**：引擎从自己的 exe 目录找另外两个助手，缺一个就是一次跑不起来的调用。
- 插件**按包名**解析本目录（`plugin/src/engine/locate.ts` 的 `resolveEngine()` 走到
  `require.resolve('dsh-visible-ssh-engine-win32-x64/package.json')`），启动前用 `engine.lock`
  校验字节数与 `sha256`；解析不到时**不回退**到任何仓库内路径，只有显式配置的
  `exeEntry` 能覆盖它。
- **刷新产物（常规）**：从上游的 Release 取，一条命令把三个 exe 装进来并把锁刷成新的 ——
  ```powershell
  node plugin/scripts/engine-fetch.mjs --tag v0.0.1 --flavor lite --install --lock
  node test/run.mjs
  ```
  私有仓要 `GITHUB_TOKEN`/`GH_TOKEN`/`VISIBLE_SSH_GH_TOKEN`（只读够用）；没有网就
  `--from-zip <附件>`。不带 `--install` 时它只报告、不写盘。**手工路**（上游只给了散文件）：
  把三个 exe 整组拷进来、主 exe 改回 `visible-ssh.exe`，再
  `node plugin/scripts/engine-lock.mjs --commit … --version … --built "…"`。逐步说明见
  `docs/engine-artifacts.md`。
- **带走给别人**：`node plugin/scripts/engine-pack.mjs` —— `npm pack` 出一个 tarball，落在
  gitignore 的 `dist/`，里面就是这六个文件（三个 exe ＋ 锁 ＋ 清单 ＋ 说明）。
