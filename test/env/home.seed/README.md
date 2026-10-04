# `home.seed/` —— 隔离 `DSH_HOME` 的模板

`test/own-host-check.mjs` 会真起一台 DSH web 宿主，为了不让它读写操作者真实的
`~/.dsh`，宿主跑在 `test/env/home/` 这个假家里。那个家是**生成物**：和它旁边的
依赖树、浏览器 profile 一样，被 `.gitignore` 忽略。

这个目录是其中值得留下的部分 —— 让宿主加载本插件的 profile 接线。`setup-env.mjs`
把它拷成 `test/env/home/`，所以新克隆的仓库能自己重建整套环境，而不是继承某台机器上
手搓出来的目录。

| 文件 | 为什么在这里 |
| --- | --- |
| `profiles/web/package.json` | 挂载插件（`dsh-visible-ssh`）并列出 profile 的 bundles。里面的 `__REPO__` 由 setup 换成这个仓库的路径，所以种子里不留任何绝对路径 |
| `profiles/web/cordis.yml` | profile 根：条目为空；整棵树由 bundles ＋ patch 层组成 |
| `profiles/web/cordis.patch.yml` | 这个 profile 的 patch 层（用户改这里，而不是改 bundle 里的文件） |
| `profiles/web/pnpm-workspace.yaml` | profile 怎么解析自己的包（`nodeLinker: hoisted`） |

setup 额外加上的东西都不在 git 里：

- `profiles/web/node_modules/dsh-visible-ssh` → `<repo>/plugin`（一个 junction，bundle
  就是经它被加载的）；
- 宿主第一次启动时自己往家里写的一切 —— sessions、storages、`.credentials.yaml`、
  `.anonymous-user-id`；
- `dsh-visible-ssh/connections.json`，由 `test/own-host-check.mjs` 写入：只用**当场给的**
  `SSH_HOST`/`SSH_USER`（id/label/host/port/user/session），`secrets` 里绝不含密码，
  也**不从操作者真家借任何字段**。密码只经 `SSH_PASSWORD` 环境变量到引擎。

想改隔离 profile 加载什么，就改这个目录然后重跑
`node test/tools/setup-env.mjs --force`。
