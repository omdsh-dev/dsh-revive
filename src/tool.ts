/**
 * revive_sessions model tool: any agent can list or revive interrupted
 * sessions when asked. The tool only ever drives OTHER sessions; it never
 * revives the calling session, so no recursion loop is possible.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ReviveCandidate, ReviveFailure, ReviveOutcome } from './service.ts'
import type { ReviveService } from './service.ts'

export function registerReviveTool(ctx: Context, service: ReviveService): () => void {
  const tool = defineTool({
    name: 'revive_sessions',
    description:
      '一键复活：扫描所有被打断（进程被杀/停止/出错/阻塞）的会话，并给它们发送「继续」指令让它们接着干活。' +
      '用 action=scan 只查看不复活；action=revive（默认）执行复活；session_id 只操作指定会话。' +
      '会话被打断通常发生在 DSH 进程崩溃重启之后。',
    parameters: {
      action: {
        type: 'string',
        enum: ['scan', 'revive'],
        description: 'scan 只列出被打断的会话；revive 给它们发送继续指令（缺省 revive）',
      },
      session_id: {
        type: 'string',
        description: '只操作这一个会话 id（与 action=revive 搭配）；缺省操作全部被打断的会话',
      },
    },
    output: {
      schema: { type: 'json' } as const,
      render(_args, value) {
        const v = value as Record<string, unknown>
        if (v.action === 'scan') {
          const items = (v.items ?? []) as Array<Record<string, unknown>>
          const rows = items.map(item => [
            String(item.sessionId),
            String(item.reason ?? ''),
            String(item.live === true ? 'live' : 'cold'),
            String(item.title ?? ''),
          ])
          return [{
            type: 'text',
            text: `被打断的会话 ${items.length} 个：\n` + table(['会话', '原因', '状态', '标题'], rows),
          }]
        }
        const revived = (v.revived ?? []) as Array<Record<string, unknown>>
        const failed = (v.failed ?? []) as Array<Record<string, unknown>>
        const lines = [`已复活 ${revived.length} 个会话。`]
        if (revived.length > 0) {
          lines.push(table(['会话', '冷恢复', '标题'],
            revived.map(item => [String(item.sessionId), item.resumedFromCold === true ? '是' : '否', String(item.title ?? '')])))
        }
        if (failed.length > 0) {
          lines.push(`失败 ${failed.length} 个：` + table(['会话', '错误'],
            failed.map(item => [String(item.sessionId), String(item.error)])))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args): Promise<JsonValue> {
      const action = args.action ?? 'revive'
      if (action === 'scan') {
        const snapshot = await service.scan(true)
        return {
          action: 'scan',
          items: snapshot.items.map(candidateToJson),
          runningLive: snapshot.runningLive,
        }
      }
      if (args.session_id !== undefined) {
        const outcome = await service.reviveOne(args.session_id as SessionId)
        if (outcome.status === 'revived') {
          return { action: 'revive', revived: [outcomeToJson(outcome.outcome)], failed: [] }
        }
        if (outcome.status === 'skipped') {
          return {
            action: 'revive',
            revived: [],
            failed: [{ sessionId: String(args.session_id), error: `无需复活：${outcome.reason}` }],
          }
        }
        return { action: 'revive', revived: [], failed: [{ sessionId: String(args.session_id), error: outcome.error }] }
      }
      const result = await service.reviveAll()
      return {
        action: 'revive',
        revived: result.revived.map(outcomeToJson),
        failed: result.failed.map(failureToJson),
      }
    },
  })
  return ctx.tools.register(tool)
}

function candidateToJson(candidate: ReviveCandidate): JsonValue {
  return {
    sessionId: String(candidate.sessionId),
    title: candidate.title ?? null,
    reason: candidate.reason,
    live: candidate.live,
    createdAt: candidate.createdAt,
  }
}

function outcomeToJson(outcome: ReviveOutcome): JsonValue {
  return {
    sessionId: String(outcome.sessionId),
    title: outcome.title ?? null,
    resumedFromCold: outcome.resumedFromCold,
  }
}

function failureToJson(failure: ReviveFailure): JsonValue {
  return { sessionId: String(failure.sessionId), error: failure.error }
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [head.join(' | '), head.map(column => '-'.repeat(Math.max(2, column.length))).join(' | ')]
  for (const row of rows) lines.push(row.join(' | '))
  return lines.join('\n')
}
