import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { ReviveService } from '../src/service.ts'

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: 1,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd: '/tmp/proj',
    ...extra,
  } as SessionHeader
}

function ev(type: string, seq: number, data: Record<string, unknown> = {}): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

/** A session that died mid-turn. */
const KILLED_EVENTS: readonly SessionEvent[] = [
  ev('turn/start', 1, { turn: 1 }),
  ev('user/message', 2, {}),
  ev('assistant/message', 3, {}),
  ev('tool/call', 4, { name: 'bash' }),
]

/** A cleanly finished session. */
const CLEAN_EVENTS: readonly SessionEvent[] = [
  ev('turn/start', 1, { turn: 1 }),
  ev('assistant/message', 2, {}),
  ev('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
]

interface HarnessOptions {
  records: SessionRecord[]
  logs: Map<string, readonly SessionEvent[]>
  live?: Map<string, { status: 'idle' | 'running'; events: readonly SessionEvent[] }>
}

/** Assemble a fake host ctx + service around it. */
function harness(options: HarnessOptions) {
  const followed: Array<{ sessionId: string; text: string }> = []
  const resumed: string[] = []
  const resolveAgent = vi.fn(async (sessionId: SessionId, inspected: { meta: SessionHeader; events: readonly SessionEvent[] }) => {
    resumed.push(sessionId)
    return {
      id: sessionId,
      status: 'idle',
      session: { header: inspected.meta, events: inspected.events },
      followup: (message: { content: Array<{ text?: string }> }) => {
        followed.push({ sessionId, text: message.content.map(block => block.text ?? '').join('') })
      },
    } as unknown as Agent
  })
  const persistence = {
    list: vi.fn(async () => options.records.map(record => record.header)),
    inspect: vi.fn(async (sessionId: SessionId) => {
      const record = options.records.find(candidate => candidate.header.id === sessionId)
      if (record === undefined) throw new Error('not found')
      return { meta: record.header, events: options.logs.get(sessionId) ?? [] }
    }),
  }
  const ctx = {
    sessionQuery: {
      listSessions: vi.fn(async () => [...options.records]),
      readSession: vi.fn(async (sessionId: SessionId) => ({ events: options.logs.get(sessionId) ?? [] })),
      readTitleSnapshots: vi.fn(async (ids: readonly SessionId[]) => ids.map(sessionId => ({
        sessionId,
        status: 'fulfilled' as const,
        value: { title: { title: `标题 ${sessionId}` } },
      }))),
    },
    agents: {
      get: (sessionId: SessionId) => {
        const entry = options.live?.get(sessionId)
        if (entry === undefined) return undefined
        return {
          id: sessionId,
          status: entry.status,
          followup: (message: { content: Array<{ text?: string }> }) => {
            followed.push({ sessionId, text: message.content.map(block => block.text ?? '').join('') })
          },
        } as unknown as Agent
      },
      resume: vi.fn(),
    },
    sessions: {
      get: (sessionId: SessionId) => {
        const entry = options.live?.get(sessionId)
        if (entry === undefined) return undefined
        return { events: entry.events }
      },
    },
    get: (name: string) => (name === 'sessionPersistence'
      ? persistence
      : name === 'agentPresets'
        ? { mount: vi.fn() }
        : undefined),
  }
  const service = new ReviveService(ctx as never, {
    prompt: () => '继续',
    scanTtlMs: 0,
    resolveAgent,
  })
  return { ctx, service, followed, resumed, resolveAgent }
}

describe('ReviveService.scan', () => {
  it('reports only interrupted project-backed sessions', async () => {
    const { service } = harness({
      records: [
        { header: header('a'), live: false, persisted: true },
        { header: header('b'), live: false, persisted: true },
        { header: header('c', { cwd: undefined }), live: false, persisted: true },
        { header: header('d', { origin: 'subagent' }), live: false, persisted: true },
      ],
      logs: new Map([
        ['a', KILLED_EVENTS],
        ['b', CLEAN_EVENTS],
      ]),
    })
    const snapshot = await service.scan(true)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]).toMatchObject({
      sessionId: 'a',
      reason: 'killed-mid-turn',
      live: false,
      title: '标题 a',
    })
    expect(snapshot.skipped).toBe(2)
    expect(snapshot.totalPersisted).toBe(4)
  })

  it('includes live idle agents whose last turn was interrupted', async () => {
    const { service } = harness({
      records: [{ header: header('a'), live: true, persisted: true }],
      logs: new Map(),
      live: new Map([['a', { status: 'idle', events: KILLED_EVENTS }]]),
    })
    const snapshot = await service.scan(true)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0].live).toBe(true)
  })

  it('leaves live running agents alone', async () => {
    const { service } = harness({
      records: [{ header: header('a'), live: true, persisted: true }],
      logs: new Map(),
      live: new Map([['a', { status: 'running', events: KILLED_EVENTS }]]),
    })
    const snapshot = await service.scan(true)
    expect(snapshot.items).toHaveLength(0)
    expect(snapshot.runningLive).toBe(1)
  })
})

describe('ReviveService.reviveAll', () => {
  it('cold-resumes each interrupted session and follows up with the prompt', async () => {
    const { service, followed, resumed, ctx } = harness({
      records: [
        { header: header('a'), live: false, persisted: true },
        { header: header('b'), live: false, persisted: true },
      ],
      logs: new Map([
        ['a', KILLED_EVENTS],
        ['b', KILLED_EVENTS],
      ]),
    })
    const result = await service.reviveAll()
    expect(result.revived).toHaveLength(2)
    expect(result.failed).toHaveLength(0)
    expect(resumed.sort()).toEqual(['a', 'b'])
    expect(followed).toHaveLength(2)
    for (const entry of followed) expect(entry.text).toBe('继续')
    expect(ctx.sessionQuery.readSession).toHaveBeenCalledTimes(2)
  })

  it('pokes a live idle agent without resuming from persistence', async () => {
    const { service, followed, resumed } = harness({
      records: [{ header: header('a'), live: true, persisted: true }],
      logs: new Map(),
      live: new Map([['a', { status: 'idle', events: KILLED_EVENTS }]]),
    })
    const result = await service.reviveAll()
    expect(result.revived).toHaveLength(1)
    expect(result.revived[0]).toMatchObject({ sessionId: 'a', resumedFromCold: false })
    expect(resumed).toHaveLength(0)
    expect(followed[0]?.text).toBe('继续')
  })

  it('collects per-session failures without stopping the sweep', async () => {
    const boom = new Error('resume exploded')
    const records = [
      { header: header('a'), live: false, persisted: true },
      { header: header('b'), live: false, persisted: true },
    ]
    const logs = new Map([
      ['a', KILLED_EVENTS],
      ['b', KILLED_EVENTS],
    ])
    const resolveAgent = vi.fn(async (sessionId: SessionId) => {
      if (sessionId === 'a') throw boom
      return { id: sessionId, status: 'idle', followup: vi.fn() } as unknown as Agent
    })
    const ctx = {
      sessionQuery: {
        listSessions: vi.fn(async () => records),
        readSession: vi.fn(async (sessionId: SessionId) => ({ events: logs.get(sessionId) ?? [] })),
        readTitleSnapshots: vi.fn(async (ids: readonly SessionId[]) => ids.map(sessionId => ({
          sessionId, status: 'fulfilled' as const, value: {},
        }))),
      },
      agents: { get: () => undefined, resume: vi.fn() },
      sessions: { get: () => undefined },
      get: (name: string) => (name === 'sessionPersistence'
        ? {
            list: vi.fn(async () => records.map(record => record.header)),
            inspect: vi.fn(async (sessionId: SessionId) => ({
              meta: records.find(record => record.header.id === sessionId)!.header,
              events: logs.get(sessionId) ?? [],
            })),
          }
        : undefined),
    }
    const service = new ReviveService(ctx as never, { prompt: () => '继续', scanTtlMs: 0, resolveAgent })
    const result = await service.reviveAll()
    expect(result.revived).toHaveLength(1)
    expect(result.revived[0].sessionId).toBe('b')
    expect(result.failed).toEqual([{ sessionId: 'a', error: 'resume exploded' }])
  })
})
