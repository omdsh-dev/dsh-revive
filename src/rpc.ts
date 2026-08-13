/**
 * `/revive` RPC channel (loopback): the browser widget's snapshot endpoint
 * and the one-click revive action.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ReviveService } from './service.ts'

export const REVIVE_RPC_CHANNEL = '/revive'

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

export function registerReviveRpc(ctx: Context, service: ReviveService): () => void {
  const handle = ctx.connection.rpc.handle(REVIVE_RPC_CHANNEL, async (endpoint, payload, _signal) => {
    try {
      switch (endpoint) {
        // `refresh: true` bypasses a completed snapshot cache. Widget mount
        // and ordinary polls reuse the cache; explicit user actions refresh.
        case 'snapshot': {
          const refresh = (payload as { refresh?: boolean } | undefined)?.refresh === true
          return ok(await service.scan(refresh))
        }
        case 'run': return ok(await service.reviveAll())
        default: return transportError<unknown>(new Error(`dsh-revive RPC 未知端点: ${endpoint}`))
      }
    } catch (error) {
      return transportError<unknown>(error)
    }
  }, { authority: 'loopback' })
  return () => { void handle() }
}
