/**
 * 共享的 pane 法规：**禁令与出口必须在同一句里**。
 *
 * 这条常量存在的唯一理由，是消灭本插件曾经犯过的一个错：`"default"` 的禁令被
 * 散写在四条工具描述里，而**只有一条**（`ssh_console_status`）写出了同一份文档
 * 里给出的第三条路——新建私有会话。于是真正用来执行命令的
 * `ssh_console_run` 只留下「别在 default 上做破坏性操作」，读者（模型或人）
 * 按字面回避整个工具，而不是换个会话名。失败模式不是「更谨慎」，是「绕过」，
 * 而且方向恰恰是这条禁令想防的方向：`rm -rf` 从可见的 tmux 挪进了看不见的本机
 * `ssh`。
 *
 * 所以：
 *
 *   * 任何提到 `"default"` 是人的 pane 的描述，**必须**在同句给出私有会话出口；
 *   * 出口要具体到能立刻照做（`ssh_console_up` + `session: "agent-<topic>"`），
 *     而不是一句抽象的「另想办法」——抽象出口等于没有出口；
 *   * 只写禁令、不写出口的地方，一律视为缺陷（本仓当前有测试守着，见
 *     `test/unit/law.spec.ts`）。
 */
/** **人**的那个 pane 的名字。它是禁区的名字，也是一切告警的判据。 */
export const HUMAN_PANE = 'default'

export const PANE_LAW =
  'The pane named "default" belongs to the human watching it: read from it freely, but never '
  + 'type destructive work into it. To change anything, use a private session instead — '
  + 'ssh_console_up creates one with session: "agent-<topic>", and every other tool accepts that name.'
