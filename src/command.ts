/**
 * `/revive` slash command: one-line access to the revive service from any
 * session's composer.
 *
 *   /revive              — 复活所有被打断的会话
 *   /revive list         — 只列出被打断的会话，不动手
 *   /revive <sessionId>  — 只复活指定会话
 *
 * The command handler runs host-side (no model turn); the result text is
 * logged as a command card in the receiving session.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ReviveService } from './service.ts'

export function registerReviveCommand(ctx: Context, service: ReviveService): () => void {
  return ctx.commands.register({
    name: 'revive',
    description: '一键复活：给所有被打断的会话发送继续指令',
    input: { hint: '[list | <sessionId>]' },
    handler: async ({ rawInput, signal }) => {
      const arg = rawInput.trim()
      try {
        if (arg === '' ) return reviveAllText(service)
        if (arg === 'list' || arg === 'scan') return scanText(service, signal)
        return reviveOneText(service, arg as SessionId)
      } catch (error) {
        return errorResult(error)
      }
    },
  })
}

async function scanText(service: ReviveService, signal: AbortSignal): Promise<CommandResult> {
  const snapshot = await service.scan(true)
  if (snapshot.items.length === 0) {
    return { kind: 'success', text: '没有发现被打断的会话。' }
  }
  const lines = snapshot.items.map(item =>
    `${item.live ? '[live]' : '[cold]'} ${item.sessionId}（${reasonLabel(item.reason)}）${item.title === undefined ? '' : ` ${item.title}`}`)
  return {
    kind: 'success',
    text: `发现 ${snapshot.items.length} 个被打断的会话：\n${lines.join('\n')}`,
  }
}

async function reviveOneText(service: ReviveService, sessionId: SessionId): Promise<CommandResult> {
  const outcome = await service.reviveOne(sessionId)
  if (outcome.status === 'revived') {
    return {
      kind: 'success',
      text: `已向会话 ${sessionId} 发送继续指令${outcome.outcome.resumedFromCold ? '（冷恢复）' : ''}。`,
    }
  }
  if (outcome.status === 'skipped') return { kind: 'error', text: `会话 ${sessionId} 无需复活：${outcome.reason}` }
  return { kind: 'error', text: `复活会话 ${sessionId} 失败：${outcome.error}` }
}

async function reviveAllText(service: ReviveService): Promise<CommandResult> {
  const result = await service.reviveAll()
  const parts: string[] = []
  if (result.revived.length > 0) {
    parts.push(`已复活 ${result.revived.length} 个会话：\n${result.revived.map(outcome =>
      `${outcome.sessionId}${outcome.title === undefined ? '' : `（${outcome.title}）`}`).join('\n')}`)
  } else {
    parts.push('没有需要复活的会话。')
  }
  if (result.failed.length > 0) {
    parts.push(`${result.failed.length} 个会话复活失败：\n${result.failed.map(failure =>
      `${failure.sessionId}: ${failure.error}`).join('\n')}`)
  }
  return { kind: 'success', text: parts.join('\n\n') }
}

function errorResult(error: unknown): CommandResult {
  return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
}

const REASON_LABELS: ReadonlyMap<string, string> = new Map([
  ['killed-mid-turn', '进程被杀，回合未完成'],
  ['pending-user-message', '消息未处理'],
  ['aborted', '已中止'],
  ['interrupted', '已停止'],
  ['error', '出错'],
  ['max-tokens', '达到上限'],
  ['blocked', '被阻塞'],
])

function reasonLabel(reason: string): string {
  return REASON_LABELS.get(reason) ?? reason
}
