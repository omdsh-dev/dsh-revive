import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { detectHealth } from '../src/detect.ts'
import { detectRawHealth } from '../src/raw-health.ts'

function event(type: string, seq: number, data: Record<string, unknown> = {}): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

function raw(events: readonly SessionEvent[], trailingNewline = true): string {
  const rows = [
    JSON.stringify({ type: 'session', version: 1, id: 'raw-health', createdAt: 0, delegationDepth: 0 }),
    ...events.map(item => JSON.stringify(item)),
  ].join('\n')
  return trailingNewline ? `${rows}\n` : rows
}

describe('detectRawHealth', () => {
  it('matches detectHealth over many ordinary event sequences', () => {
    let seed = 0x4D595DF4
    const next = (): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return seed >>> 0
    }
    const reasons = ['completed', 'aborted', 'interrupted', 'error', 'max-tokens', 'blocked', 'future-reason']

    for (let sample = 0; sample < 250; sample += 1) {
      const events: SessionEvent[] = []
      const length = next() % 80
      for (let seq = 0; seq < length; seq += 1) {
        switch (next() % 7) {
          case 0:
            events.push(event('turn/start', seq, { turn: seq + 1 }))
            break
          case 1: {
            const kind = reasons[next() % reasons.length] as string
            events.push(event('turn/end', seq, { turn: seq + 1, reason: { kind } }))
            break
          }
          case 2:
            events.push(event('user/message', seq, { content: [] }))
            break
          default:
            events.push(event('assistant/chunk', seq, { chunk: { type: 'text-delta', text: 'x' } }))
            break
        }
      }

      expect(detectRawHealth(raw(events, sample % 2 === 0))).toEqual(detectHealth(events))
    }
  })

  it('accepts both a trailing newline and no trailing newline', () => {
    const events = [
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(detectRawHealth(raw(events, true))).toEqual({ state: 'clean' })
    expect(detectRawHealth(raw(events, false))).toEqual({ state: 'clean' })
  })

  it('ignores headers, packed rows, and unrelated records', () => {
    const content = [
      JSON.stringify({ type: 'session', version: 1, id: 'packed', createdAt: 0, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }),
      JSON.stringify({ type: 'text-chunks', seq0: 1, time0: 0, data: { texts: ['a'], dt: [] } }),
      JSON.stringify({ type: 'todo/write', seq: 2, time: 0, data: {} }),
      JSON.stringify({ type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n')
    expect(detectRawHealth(content)).toEqual({ state: 'clean' })
  })

  it('recognizes legacy steering messages and normalizes disposed', () => {
    const header = JSON.stringify({ type: 'session', version: 1, id: 'legacy', createdAt: 0, delegationDepth: 0 })
    const completed = JSON.stringify({
      type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'completed' } },
    })
    const steering = JSON.stringify({ type: 'steering/message', seq: 2, time: 0, data: {} })
    expect(detectRawHealth(`${header}\n${completed}\n${steering}\n`)).toEqual({
      state: 'interrupted', reason: 'pending-user-message',
    })

    const disposed = JSON.stringify({
      type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'disposed' } },
    })
    expect(detectRawHealth(`${header}\n${disposed}`)).toEqual({ state: 'interrupted', reason: 'aborted' })
  })

  it('stops at the newest turn boundary after a very large irrelevant tail', () => {
    const heapBefore = process.memoryUsage().heapUsed
    const header = '{"type":"session","version":1,"id":"large","createdAt":0,"delegationDepth":0}\n'
    const start = '{"type":"turn/start","seq":0,"time":0,"data":{"turn":1}}\n'
    const irrelevant = '{"type":"assistant/chunk","seq":1,"time":0,"data":{}}\n'.repeat(500_000)
    expect(detectRawHealth(header + start + irrelevant)).toEqual({
      state: 'interrupted', reason: 'killed-mid-turn',
    })
    expect(Math.max(0, process.memoryUsage().heapUsed - heapBefore)).toBeLessThan(256 * 1024 * 1024)
  })

  it('reports pending and empty logs without any turn boundary', () => {
    expect(detectRawHealth(raw([event('user/message', 0, { content: [] })]))).toEqual({
      state: 'interrupted', reason: 'pending-user-message',
    })
    expect(detectRawHealth(raw([]))).toEqual({ state: 'empty' })
  })

  it('throws for malformed relevant records', () => {
    expect(() => detectRawHealth('{"type":"turn/end","data":\n')).toThrow(/malformed relevant session JSONL/)
    expect(() => detectRawHealth('{"type":"turn\/end","data":{}}'))
      .toThrow(/reason\.kind must be a string/)
  })
})
