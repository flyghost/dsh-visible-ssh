/**
 * 破坏性 verb 走宿主自己的审批缝，而不是自制的关卡。
 *
 * 这个服务是 `ctx.approval`（**不是** `ctx.userApproval`——P0 的 live 探针实测它
 * 不存在）；它是 cordis 服务，所以用 `ctx.get('approval')` 去查，而不是按属性
 * 直接解引用。
 *
 * **fail-closed 才是重点**：授予时这个缝返回 `allowed-once`，否则返回
 * `rejected` / `cancelled` / `unavailable` 之一，而没有配置应答方的部署会得到
 * `unavailable`。因此**绝不能**把「无人应答」读成同意——它会拒绝，并且要让模型
 * 把这件事挑明，而不是重试。
 *
 * 请求里带的是工具**名字**、理由和调用 id——**不带参数**——所以「理由」是人唯一
 * 能看到「即将销毁的是哪个 session」的地方。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

/** 唯一会授权这次调用的那个结果。 */
const GRANT = 'allowed-once'

/**
 * 拒绝的成因：缝合上的封闭结果，以及本模块自己判定的两种「没人可问」。
 *
 * `no-service` / `no-agent` 不是缝合的词汇 —— 它们是**请求根本没发出去**的两种情形，
 * 由本模块伪造出来，好让上层只处理一种错误形状。
 */
export type ApprovalFailure = ApprovalOutcome | 'no-service' | 'no-agent'

/** 调用未获授权时抛出；它的 message 就是模型读到的东西。 */
export class ApprovalDeniedError extends Error {
  /** 成因，见 {@link ApprovalFailure}。 */
  readonly outcome: ApprovalFailure

  /**
   * @param verb - 被拒绝的那个工具。
   * @param outcome - 缝合上的封闭结果，或 `no-service` / `no-agent`。
   * @param reason - 随请求提交上去的那条理由。
   */
  constructor(verb: string, outcome: ApprovalFailure, reason: string) {
    super(
      `refusing ${verb}: the approval request was not granted (${outcome}). `
      + `Reason submitted: ${reason}. `
      + (outcome === 'unavailable'
        ? 'No approval answerer is composed in this deployment, so the request fails closed — '
          + 'tell the user to approve or perform the action themselves; do not retry.'
        : 'The user denied or cancelled this action — do not retry it.'),
    )
    this.name = 'ApprovalDeniedError'
    this.outcome = outcome
  }
}

/**
 * 在一个破坏性 verb 执行之前，向宿主索取一次性的决定。
 *
 * @param ctx - 宿主插件 context。
 * @param exec - 工具执行 context（提供 agent、callId、signal）。
 * @param toolName - 发起请求的工具名，按人会看到的样子。
 * @param reason - 一行字，说明即将被销毁的是什么。
 * @returns 获授权的那个结果（`allowed-once`）。
 * @throws {ApprovalDeniedError} 请求未获授权时。
 */
export async function requireApproval(
  ctx: Context,
  exec: ToolRunContext,
  toolName: string,
  reason: string,
): Promise<ApprovalOutcome> {
  const approval = ctx.get('approval')
  if (approval === undefined) throw new ApprovalDeniedError(toolName, 'no-service', reason)
  if (exec.agent === undefined) throw new ApprovalDeniedError(toolName, 'no-agent', reason)
  const outcome = await approval.request({
    agent: exec.agent,
    callId: exec.callId,
    toolName,
    reason,
    signal: exec.signal,
  })
  if (outcome !== GRANT) throw new ApprovalDeniedError(toolName, outcome, reason)
  return outcome
}
