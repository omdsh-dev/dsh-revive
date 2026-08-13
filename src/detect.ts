/**
 * Interruption detection: decide whether a persisted session was interrupted
 * and should receive a「继续」prompt after DSH restarts.
 *
 * A session counts as interrupted when:
 * - its log ends inside an open turn (DSH was killed mid-run — the case this
 *   plugin exists for), or
 * - a user message was admitted but never got a turn (killed before the turn
 *   started), or
 * - its last turn ended for any reason other than `completed`
 *   (aborted / interrupted / error / max-tokens / blocked).
 *
 * A session whose last turn completed cleanly is left alone: the user does
 * not want every idle session to wake up and burn tokens.
 * @module
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Why a session is considered interrupted. */
export type InterruptReason =
  | 'killed-mid-turn'
  | 'pending-user-message'
  | 'aborted'
  | 'interrupted'
  | 'error'
  | 'max-tokens'
  | 'blocked'

/** Detection outcome for one session log. */
export type SessionHealth =
  | { readonly state: 'interrupted'; readonly reason: InterruptReason }
  | { readonly state: 'clean' }
  | { readonly state: 'empty' }

const TURN_END_KINDS = new Set(['aborted', 'interrupted', 'error', 'max-tokens', 'blocked'])

/**
 * Fold one session's raw event log into a health verdict.
 *
 * Pure and side-effect free: works on live Session.events and on replayed
 * persisted logs alike.
 * @param events - the complete event log in ascending seq order.
 * @returns the health verdict; `empty` sessions (no turn, no user message)
 *   are never revived.
 */
export function detectHealth(events: readonly SessionEvent[]): SessionHealth {
  let lastTurnStartSeq = -1
  let lastTurnEndSeq = -1
  let lastTurnEndKind: string | undefined
  let lastUserMessageSeq = -1

  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        lastTurnStartSeq = event.seq
        break
      }
      case 'turn/end': {
        lastTurnEndSeq = event.seq
        lastTurnEndKind = event.data.reason.kind
        break
      }
      case 'user/message': {
        lastUserMessageSeq = event.seq
        break
      }
    }
  }

  const hasTurn = lastTurnStartSeq >= 0 || lastTurnEndSeq >= 0

  if (!hasTurn) {
    // A user message that never opened a turn: killed between admission and
    // turn start. A log with no turn and no message is an untouched session.
    return lastUserMessageSeq >= 0
      ? { state: 'interrupted', reason: 'pending-user-message' }
      : { state: 'empty' }
  }

  // An open turn at the tail of the log: the process died mid-turn.
  if (lastTurnStartSeq > lastTurnEndSeq) {
    return { state: 'interrupted', reason: 'killed-mid-turn' }
  }

  // A user message after the last closed turn: admitted but never run.
  if (lastUserMessageSeq > lastTurnEndSeq) {
    return { state: 'interrupted', reason: 'pending-user-message' }
  }

  if (lastTurnEndKind === undefined) return { state: 'empty' }
  if (lastTurnEndKind === 'completed') return { state: 'clean' }

  if (TURN_END_KINDS.has(lastTurnEndKind)) {
    return { state: 'interrupted', reason: lastTurnEndKind as InterruptReason }
  }

  // Unknown future reason kinds: err on the side of reviving.
  return { state: 'interrupted', reason: lastTurnEndKind as InterruptReason }
}

/**
 * Fold the last persisted request config (provider/model) out of a log, so a
 * resumed agent keeps running on the exact model it used before the kill
 * instead of whatever the deployment default happens to be today.
 * @param events - the complete event log in ascending seq order.
 * @returns the last logged provider/model pair, or undefined when the log
 *   never recorded one.
 */
export function lastRequestConfig(
  events: readonly SessionEvent[],
): { readonly provider: string; readonly model: string } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'request/header') continue
    const { config } = event.data.header
    if (config.provider && config.model) return { provider: config.provider, model: config.model }
  }
  return undefined
}
