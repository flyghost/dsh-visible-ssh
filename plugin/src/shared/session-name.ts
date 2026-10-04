/**
 * tmux 会话名的文法，由两个会从外部接收会话名的宿主模块共用：镜像路由
 * （`/visible-ssh/screen?session=`）与连接存储（保存下来的 profile 自带默认 session）。
 *
 * 它单独成模块**只是**为了不让那两个模块互相 import：路由层需要连接层（才知道该
 * 镜像哪台主机），而连接层需要这个校验器，所以校验器放在任何一边都不行。
 */

/**
 * 可接受的 tmux 会话名。
 *
 * **刻意**比 tmux 本身更窄：首字符必须是字母/数字（前导 `-` 在任何停止引用参数的
 * 消费方眼里都像 flag），其后是 tmux 名字真正会用到的标点，并设了长度上界，免得
 * 缓存被一个无穷长的字符串当键。`.` 与 `:` 仍然放行，尽管 tmux 会把它们归一化成
 * `_`——拒绝 tmux 接受的东西，等于这个文件在推翻引擎。
 */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,63}$/

/** 可接受的最长会话名，与 `SESSION_RE` 对应。 */
export const MAX_SESSION_LENGTH = 64

/**
 * 校验结果。判别式是 `ok`：
 * - 成功时带规范化后的 `session`；
 * - 失败时带给人看的 `message`，以及 `fromConfig` —— 为 `true` 表示**不是**请求里
 *   给的那个名字不合法，而是配置里的默认值不合法（路由层据此回 500 而不是 400）。
 */
export type SessionNameResult =
  | { ok: true, session: string }
  | { ok: false, fromConfig: boolean, message: string }

/** 校验一个名字，不含默认值规则。 */
export function parseSessionName(value: unknown): SessionNameResult {
  const session = String(value)
  if (!SESSION_RE.test(session)) {
    return {
      ok: false,
      fromConfig: false,
      message: `session must be ${MAX_SESSION_LENGTH} characters or fewer, start with a letter or digit, `
        + 'and contain only letters, digits, and . _ : @ + -',
    }
  }
  return { ok: true, session }
}

/**
 * 校验一个会话名，缺省时回退到配置的默认值。
 *
 * @param raw - 候选名字；`null`/`''` 表示「用默认值」。
 * @param fallback - `raw` 缺省时要用的名字。
 * @returns `{ ok: true, session }` 或 `{ ok: false, message, fromConfig }`。
 */
export function parseSession(raw: unknown, fallback: unknown): SessionNameResult {
  if (raw === null || raw === undefined || raw === '') {
    const fallbackCheck = parseSessionName(fallback)
    if (fallbackCheck.ok) return fallbackCheck
    return {
      ok: false,
      fromConfig: true,
      message: `this plugin's configured defaultSession ${JSON.stringify(String(fallback))} is not a usable tmux session name`,
    }
  }
  return parseSessionName(raw)
}
