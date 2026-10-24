/**
 * dsh-visible-ssh —— 宿主侧那一半。
 *
 * 这个插件的重点**不是**「通过 SSH 跑一条命令」，而是命令落进一个人正 attach 着的
 * tmux pane 里，于是旁观的人能看见模型敲的每一个键，并能在任意时刻 Ctrl-C 或接管。
 * 这个性质来自 tmux，不是来自本插件——所以插件只是驱动既有的引擎，而不是重新实现
 * 传输层。
 *
 * 值得留下的设计说明：
 *
 *   * 插件**不**拥有 SSH，也**不**做解析。它调用编译好的引擎
 *     （平台包里的 `visible-ssh.exe --json`，按包名解析）并投影那份 envelope。空闲门禁、
 *     按 session 隔离的退出码槽、prompt 解析器都留在它们各自测试所在的地方
 *     ——引擎项目。
 *   * 破坏性 verb（`reset`、`down`）走宿主的 `ctx.approval` 缝，而不是自制的
 *     门禁：于是由人在权限 UI 里决定，而没有应答者的部署会 fail closed。
 *   * Cordis 对 PROPERTY 访问按 `inject` 把关，所以会被解引用的服务必须在这里
 *     列出来；`ctx.get(name)` 不受这道门禁管，可选服务正是用它来探测的。
 *   * 注册被包在 `ctx.effect(...)` 里，这样卸载（HMR、disable、切换 profile）不会
 *     在注册表里留下一件过期的 tool。
 *   * 浏览器 route（mirror、连接表单、面板的 session 操作）是覆盖同一批 CLI verb 的
 *     READ 路径；它们住在 routes/index.ts 里，是**等待**一个 web carrier 而不是要求必须有，
 *     所以无头的组合也照样拿到全部面向模型的 tool。面板唯一一条偏 WRITE 的路径通过
 *     引擎自己的 `watch` verb 打开终端、通过 `down` 结束，因为人点一下按钮就是这些
 *     verb 本来要向 approval 缝索要的那份同意。
 *   * tool 与 mirror 跟哪台机器对话，由 connections.js 决定：有面板管理的 profile 就
 *     用它，否则用 CLI 自己的 `host.toml`。这一点不是必须的，而且密码**绝不**交给
 *     浏览器或模型。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './engine/config.js'
import type { PluginConfig } from './engine/config.js'
import { createEnginePort } from './engine/exec.js'
import { createConnections, defaultConnectionsFile } from './connection/connections.js'
import type { CredentialsService } from './connection/connections.js'
import { registerWebRoutes } from './routes/index.js'
import { adoptSettings } from './connection/settings.js'
import { registerTools } from './tools/index.js'
import { registerRemoteHostSection } from './prompt/section.js'
import { registerRuntimeContext } from './prompt/runtime.js'
import { refreshRuntime } from './state/view.js'

/** 宿主的凭据缝；没有 provider 被组合时它整个不存在。 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    credentials?: CredentialsService
  }
}

export { resolveConfig, DEFAULTS } from './engine/config.js'
export { BridgeError } from './engine/envelope.js'
export { createEnginePort } from './engine/exec.js'
export type { ChildEnv, EngineOptions, EnginePort } from './engine/port.js'
export { ApprovalDeniedError, requireApproval } from './approval/index.js'
export {
  projectCapture,
  projectDown,
  projectReset,
  projectRun,
  projectStatus,
  projectUp,
  projectWatch,
} from './engine/project.js'
export {
  CONNECTION_ROUTE_PATH,
  SCREEN_ROUTE_PATH,
  SESSIONS_ROUTE_PATH,
  createConnectionHandler,
  createScreenCache,
  createScreenHandler,
  createSessionsHandler,
  parseSession,
  registerWebRoutes,
} from './routes/index.js'
export {
  CONNECTIONS_VERSION,
  createConnections,
  defaultConnectionsFile,
  passwordRefFor,
  readConnections,
  validateProfile,
  writeConnections,
} from './connection/connections.js'

/** cordis.yml 行用的插件标识。 */
export const name = 'dsh-visible-ssh'

/** 挂载前需要的服务：面向模型的 tool 注册表。 */
export const inject = ['tools']

/**
 * @param ctx - 宿主插件上下文。
 * @param config - 本插件那条 loader 行的 `config` 块，如果有的话。
 */
export function apply(ctx: Context, config: PluginConfig | undefined): void {
  const cfg = resolveConfig(config)

  // 引擎端口在这里造**一次**，往下传给两半：tool 注册表与三条 route 都用它，而它是
  // 唯一启动进程的地方（engine/exec.ts，真实实现；engine/fake.ts，内存实现）。这层
  // 间接就是 S3 的目的——路由与工具能完全不 spawn、不碰 SSH 地被测。
  const engine = createEnginePort(cfg)

  // credentials provider 可能比本插件挂载得晚，所以它只通过惰性适配器访问，而不是
  // 在这里一次性捕获。没有 provider 被组合时 `set` 会抛错，正是这一点让 store 回退
  // 到自己的文件，而不是以为某次写入成功了（见 connections.js）。
  const credentials: CredentialsService = {
    resolve: async (ref: string) => ctx.get('credentials')?.resolve(ref),
    set: async (ref: string, value: string) => {
      const service = ctx.get('credentials')
      if (service === undefined) throw new Error('no credentials provider is composed')
      return service.set(ref, value)
    },
    unset: async (ref: string) => ctx.get('credentials')?.unset(ref),
  }

  const connections = createConnections({
    file: cfg.connectionsFile ?? defaultConnectionsFile(),
    credentials,
    logger: ctx.logger,
    env: process.env,
    configPath: cfg.configPath,
  })

  // 主机列表是一项 SETTING，所以只要 DSH 组合了 settings namespace，它就住在那里；
  // 否则住在本插件自己的文件里。与上面的 credentials provider 是同一个故事：服务
  // 可能比本插件挂载得晚，所以它通过 ctx.inject 访问、就地被采纳——`useStore` 把既有
  // 文件的 profile 恰好搬过去一次，而缺少 schemastery 或注册失败会降级成用文件加一条
  // warning，而不是把插件拖垮（见 connection/settings.ts）。
  ctx.inject(['settings'], (settingsCtx: Context) => {
    void adoptSettings({ settingsCtx, owner: ctx, connections, logger: ctx.logger })
  })

  ctx.effect(() => registerTools(ctx, cfg, connections, engine), 'dsh-visible-ssh: tools')
  registerWebRoutes(ctx, cfg, connections, engine)

  // 「这条路存在」与「此刻是谁」两段文本，落进模型**做决定之前**就读得到的位置：
  // 前者是系统提示里的静态规则段（逐字节恒定，不打穿前缀缓存），后者是每轮刷新的
  // 运行时快照。缺了它们，本插件全部知识只存在于工具描述里——而那要等模型决定去
  // 读那个工具之后才被展开，对一个"根本没想到有这条路"的模型毫无作用。
  //
  // `systemPrompt` 可能没有出现在某个组合里（headless/极简装配），所以走与 settings
  // 同一条可选路径：缺失时插件其余部分照常工作，只是这两段文本不存在。
  ctx.inject(['systemPrompt'], (promptCtx: Context) => {
    // 先算一份事实，好让第一轮组装就有快照可读（之后每次工具调用与路由都会刷新）。
    void refreshRuntime(cfg, connections)
    promptCtx.effect(() => registerRemoteHostSection(promptCtx), 'dsh-visible-ssh: prompt section')
    promptCtx.effect(() => registerRuntimeContext(promptCtx), 'dsh-visible-ssh: prompt context')
  })
}
