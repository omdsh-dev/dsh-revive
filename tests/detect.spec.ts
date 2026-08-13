import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { detectHealth, lastRequestConfig } from '../src/detect.ts'

/** Minimal synthetic event factory: only the fields detect.ts reads. */
function ev(type: string, seq: number, data: Record<string, unknown> = {}): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

const TURN_START = (seq: number) => ev('turn/start', seq, { turn: 1 })
const TURN_END = (seq: number, kind: string) => ev('turn/end', seq, { turn: 1, reason: { kind } })
const USER = (seq: number) => ev('user/message', seq, { message: {} })

describe('detectHealth', () => {
  it('empty log is empty (never revived)', () => {
    expect(detectHealth([])).toEqual({ state: 'empty' })
  })

  it('cleanly completed turn is clean', () => {
    expect(detectHealth([TURN_START(1), TURN_END(2, 'completed')])).toEqual({ state: 'clean' })
  })

  it('open turn at the tail is killed-mid-turn', () => {
    expect(detectHealth([TURN_START(1)])).toEqual({ state: 'interrupted', reason: 'killed-mid-turn' })
    expect(detectHealth([TURN_START(1), ev('tool/call', 2, {})])).toEqual({
      state: 'interrupted',
      reason: 'killed-mid-turn',
    })
    // A later completed turn wins over an earlier open one (never happens in
    // a real log, but the fold must stay sane).
    expect(detectHealth([TURN_START(1), TURN_END(2, 'completed'), TURN_START(3)])).toEqual({
      state: 'interrupted',
      reason: 'killed-mid-turn',
    })
  })

  it('user message after the last closed turn is pending', () => {
    expect(detectHealth([TURN_START(1), TURN_END(2, 'completed'), USER(3)])).toEqual({
      state: 'interrupted',
      reason: 'pending-user-message',
    })
  })

  it('user message without any turn is pending', () => {
    expect(detectHealth([USER(1)])).toEqual({ state: 'interrupted', reason: 'pending-user-message' })
  })

  it('every non-completed turn-end reason is interrupted', () => {
    for (const kind of ['aborted', 'interrupted', 'error', 'max-tokens', 'blocked']) {
      expect(detectHealth([TURN_START(1), TURN_END(2, kind)])).toEqual({
        state: 'interrupted',
        reason: kind,
      })
    }
  })

  it('a steering message inside a completed turn does not flag the session', () => {
    // user/message seq 2 sits between turn/start 1 and turn/end 3.
    expect(detectHealth([TURN_START(1), USER(2), TURN_END(3, 'completed')])).toEqual({ state: 'clean' })
  })

  it('ignores non-turn events (chunks, todos, request headers)', () => {
    expect(detectHealth([
      TURN_START(1),
      ev('assistant/chunk', 2, {}),
      ev('todo/write', 3, {}),
      ev('request/header', 4, {}),
      TURN_END(5, 'completed'),
    ])).toEqual({ state: 'clean' })
  })
})

describe('lastRequestConfig', () => {
  it('returns undefined for a log without request headers', () => {
    expect(lastRequestConfig([])).toBeUndefined()
  })

  it('returns the last recorded provider/model pair', () => {
    const events = [
      ev('request/header', 1, { header: { config: { provider: 'a', model: 'm1' } } }),
      ev('request/header', 2, { header: { config: { provider: 'b', model: 'm2' } } }),
    ]
    expect(lastRequestConfig(events)).toEqual({ provider: 'b', model: 'm2' })
  })
})
