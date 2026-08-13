/**
 * dsh-revive host half (cordis plugin body).
 *
 * Host-plane capability: enumerates persisted sessions, detects which ones
 * died mid-work, cold-resumes them with their recorded preset composition
 * and model, and admits a「继续」prompt. Trigger surfaces:
 *
 * - `/revive` slash command (list / revive all / revive one);
 * - `revive_sessions` model-facing tool;
 * - `/revive` loopback RPC consumed by the browser one-click widget;
 * - optional auto-revive shortly after startup (`autoReviveOnStartup`).
 *
 * Export shape: function/namespace plugin (name/inject/apply, NO default —
 * a stray `export default` would collapse the module via the Loader's
 * unwrapExports and drop `inject`).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import { registerReviveCommand } from './command.ts'
import { registerReviveRpc } from './rpc.ts'
import { registerReviveTool } from './tool.ts'
import { ReviveService } from './service.ts'

export const name = 'dsh-revive'

/** Host-plane services the plugin consumes. */
export const inject = ['sessionQuery', 'sessions', 'agents', 'commands', 'connection', 'tools', 'timer']

/** Row configuration (bundle patch `config:`), all optional. */
export interface Config {
  /** The prompt admitted to every revived session. Default 继续. */
  resumePrompt?: string
  /** Revive all interrupted sessions shortly after startup. Default false. */
  autoReviveOnStartup?: boolean
  /** Startup delay for auto-revive in milliseconds. Default 5000. */
  startupDelayMs?: number
  /** Snapshot cache TTL in milliseconds. Default 5000. */
  scanTtlMs?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const service = new ReviveService(ctx, {
    prompt: () => config.resumePrompt ?? '继续',
    ...config.scanTtlMs === undefined ? {} : { scanTtlMs: config.scanTtlMs },
  })

  ctx.effect(() => registerReviveCommand(ctx, service), 'dsh-revive: command')
  ctx.effect(() => registerReviveRpc(ctx, service), 'dsh-revive: rpc')
  ctx.effect(() => registerReviveTool(ctx, service), 'dsh-revive: tool')

  if (config.autoReviveOnStartup === true) {
    ctx.effect(() => {
      const timer = ctx.setTimeout(() => {
        void service.reviveAll().catch((error: unknown) => {
          console.error('[dsh-revive] 自动复活失败:', error)
        })
      }, config.startupDelayMs ?? 5_000)
      return () => { timer() }
    }, 'dsh-revive: auto-revive')
  }
}
