/**
 * Bounded-memory interruption detection over a raw JSONL session artifact.
 *
 * The scan walks records from the tail and stops at the newest turn boundary.
 * It never splits the complete artifact or materializes a SessionEvent array.
 * @module
 */

import type { InterruptReason, SessionHealth } from './detect.ts'

const RELEVANT_TYPE = /"type"\s*:\s*"(?:turn\/start|turn\/end|user\/message|steering\/message)"/

/** Return an object record, or reject a malformed relevant JSONL value. */
function relevantRecord(line: string, offset: number): Record<string, unknown> | undefined {
  if (!RELEVANT_TYPE.test(line)) return undefined

  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw new Error(`malformed relevant session JSONL record at byte ${offset}`, { cause })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`malformed relevant session JSONL record at byte ${offset}: expected an object`)
  }
  return value as Record<string, unknown>
}

/** Read and validate the reason kind carried by a raw turn/end record. */
function turnEndKind(record: Record<string, unknown>, offset: number): string {
  const data = record.data
  const reason = typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>).reason
    : undefined
  const kind = typeof reason === 'object' && reason !== null && !Array.isArray(reason)
    ? (reason as Record<string, unknown>).kind
    : undefined
  if (typeof kind !== 'string') {
    throw new TypeError(
      `malformed relevant session JSONL record at byte ${offset}: turn/end reason.kind must be a string`,
    )
  }
  return kind
}

/**
 * Detect whether a raw JSONL session ended in an interrupted state.
 *
 * Only the newest turn boundary and any user message after it affect the
 * verdict. Packed chunk rows, the session header, and all other records are
 * skipped without parsing. The removed `steering/message` event is treated as
 * its modern `user/message` equivalent, and the removed `disposed` turn-end
 * reason is normalized to `aborted` as persistence migration does.
 *
 * @param content - complete decompressed JSONL artifact text.
 * @returns the same health vocabulary as {@link detectHealth}.
 * @throws when a relevant JSON record is invalid or a turn/end lacks a string
 *   `data.reason.kind`.
 */
export function detectRawHealth(content: string): SessionHealth {
  let sawTailUser = false
  let lineEnd = content.length

  while (lineEnd > 0) {
    const newline = content.lastIndexOf('\n', lineEnd - 1)
    const lineStart = newline + 1
    let recordEnd = lineEnd
    if (recordEnd > lineStart && content.charCodeAt(recordEnd - 1) === 0x0D) recordEnd -= 1
    const line = content.slice(lineStart, recordEnd)
    const record = relevantRecord(line, lineStart)

    if (record !== undefined) {
      switch (record.type) {
        case 'user/message':
        case 'steering/message':
          sawTailUser = true
          break
        case 'turn/start':
          return { state: 'interrupted', reason: 'killed-mid-turn' }
        case 'turn/end': {
          if (sawTailUser) return { state: 'interrupted', reason: 'pending-user-message' }
          const kind = turnEndKind(record, lineStart)
          if (kind === 'completed') return { state: 'clean' }
          if (kind === 'disposed') return { state: 'interrupted', reason: 'aborted' }
          return { state: 'interrupted', reason: kind as InterruptReason }
        }
        default:
          // A nested relevant-looking `type` may have triggered the cheap
          // lexical filter; the top-level record remains unrelated.
          break
      }
    }

    lineEnd = newline
  }

  return sawTailUser
    ? { state: 'interrupted', reason: 'pending-user-message' }
    : { state: 'empty' }
}
