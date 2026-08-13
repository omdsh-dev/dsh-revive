import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
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
  return { type, seq, time: seq, data } as SessionEvent
}

const KILLED_EVENTS: readonly SessionEvent[] = [
  ev('turn/start', 0, { turn: 1 }),
  ev('user/message', 1, {}),
  ev('assistant/message', 2, {}),
  ev('tool/call', 3, { name: 'bash' }),
]

const CLEAN_EVENTS: readonly SessionEvent[] = [
  ev('turn/start', 0, { turn: 1 }),
  ev('assistant/message', 1, {}),
  ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
]

function rawLog(meta: SessionHeader, events: readonly SessionEvent[]): string {
  return [
    JSON.stringify({ type: 'session', ...meta }),
    ...events.map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

interface HarnessOptions {
  headers: SessionHeader[]
  logs: Map<string, readonly SessionEvent[]>
  live?: Map<string, { status: 'idle' | 'running'; events: readonly SessionEvent[] }>
  revisions?: Map<string, string>
  supportsRawArtifacts?: boolean
  scanTtlMs?: number
  resolveAgent?: (sessionId: SessionId, inspected: { meta: SessionHeader; events: readonly SessionEvent[] }) => Promise<Agent>
}

function harness(options: HarnessOptions) {
  const followed: Array<{ sessionId: string; text: string }> = []
  const resumed: string[] = []
  const defaultResolveAgent = vi.fn(async (
    sessionId: SessionId,
    inspected: { meta: SessionHeader; events: readonly SessionEvent[] },
  ) => {
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
  const resolveAgent = vi.fn(options.resolveAgent ?? defaultResolveAgent)
  const persistence = {
    supportsRawArtifacts: options.supportsRawArtifacts ?? true,
    list: vi.fn(async () => options.headers),
    listSnapshots: vi.fn(async () => options.headers.map(meta => ({
      header: meta,
      revision: (options.revisions?.get(meta.id) ?? `revision:${meta.id}:1`) as never,
    }))),
    readRaw: vi.fn(async (sessionId: SessionId) => {
      const meta = options.headers.find(candidate => candidate.id === sessionId)
      if (meta === undefined) return undefined
      return { meta, filename: 'session.jsonl', content: rawLog(meta, options.logs.get(sessionId) ?? []) }
    }),
    inspect: vi.fn(async (sessionId: SessionId) => {
      const meta = options.headers.find(candidate => candidate.id === sessionId)
      if (meta === undefined) throw new Error('not found')
      return { meta, events: options.logs.get(sessionId) ?? [] }
    }),
    readFrom: vi.fn(() => Promise.reject(new Error('forbidden readFrom'))),
  }
  const forbidden = {
    listSessions: vi.fn(() => Promise.reject(new Error('forbidden listSessions'))),
    readSession: vi.fn(() => Promise.reject(new Error('forbidden readSession'))),
    readTitleSnapshots: vi.fn(() => Promise.reject(new Error('forbidden readTitleSnapshots'))),
  }
  const ctx = {
    sessionPersistence: persistence,
    sessionQuery: forbidden,
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
        return entry === undefined ? undefined : { events: entry.events }
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
    scanTtlMs: options.scanTtlMs ?? 0,
    resolveAgent,
  })
  return { ctx, persistence, forbidden, service, followed, resumed, resolveAgent }
}

describe('ReviveService.scan', () => {
  it('reports only interrupted project-backed sessions from raw artifacts', async () => {
    const headers = [
      header('a'),
      header('b'),
      header('c', { cwd: undefined }),
      header('d', { origin: 'subagent' }),
    ]
    const { service, persistence, forbidden } = harness({
      headers,
      logs: new Map([['a', KILLED_EVENTS], ['b', CLEAN_EVENTS]]),
    })

    const snapshot = await service.scan(true)
    expect(snapshot.items).toEqual([expect.objectContaining({
      sessionId: 'a', reason: 'killed-mid-turn', live: false,
    })])
    expect(snapshot.skipped).toBe(2)
    expect(snapshot.totalPersisted).toBe(4)
    expect(persistence.readRaw).toHaveBeenCalledTimes(2)
    expect(forbidden.listSessions).not.toHaveBeenCalled()
    expect(forbidden.readSession).not.toHaveBeenCalled()
    expect(forbidden.readTitleSnapshots).not.toHaveBeenCalled()
    expect(persistence.readFrom).not.toHaveBeenCalled()
    expect(persistence.inspect).not.toHaveBeenCalled()
  })

  it('uses an interrupted live idle log without reading its raw artifact', async () => {
    const meta = header('a')
    const { service, persistence } = harness({
      headers: [meta],
      logs: new Map(),
      live: new Map([['a', { status: 'idle', events: KILLED_EVENTS }]]),
    })
    const snapshot = await service.scan(true)
    expect(snapshot.items).toEqual([expect.objectContaining({ sessionId: 'a', live: true })])
    expect(persistence.readRaw).not.toHaveBeenCalled()
  })

  it('leaves live running agents alone', async () => {
    const meta = header('a')
    const { service, persistence } = harness({
      headers: [meta],
      logs: new Map(),
      live: new Map([['a', { status: 'running', events: KILLED_EVENTS }]]),
    })
    const snapshot = await service.scan(true)
    expect(snapshot.items).toHaveLength(0)
    expect(snapshot.runningLive).toBe(1)
    expect(persistence.readRaw).not.toHaveBeenCalled()
  })

  it('keeps raw artifact reads strictly serial', async () => {
    const headers = Array.from({ length: 3 }, (_, index) => header(String(index)))
    const { service, persistence } = harness({ headers, logs: new Map() })
    let active = 0
    let maxActive = 0
    let releaseReads!: () => void
    const gate = new Promise<void>(resolve => { releaseReads = resolve })
    persistence.readRaw.mockImplementation(async (id: SessionId) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await gate
      active -= 1
      const meta = headers.find(candidate => candidate.id === id)!
      return { meta, filename: 'session.jsonl', content: rawLog(meta, KILLED_EVENTS) }
    })

    const pending = service.scan(true)
    await vi.waitFor(() => expect(persistence.readRaw).toHaveBeenCalledTimes(1))
    expect(maxActive).toBe(1)
    releaseReads()
    const snapshot = await pending
    expect(persistence.readRaw).toHaveBeenCalledTimes(3)
    expect(maxActive).toBe(1)
    expect(snapshot.items).toHaveLength(3)
  })

  it('reuses revision-matched projections and refreshes only changed revisions', async () => {
    const meta = header('a')
    const revisions = new Map([['a', 'r1']])
    const logs = new Map<string, readonly SessionEvent[]>([['a', KILLED_EVENTS]])
    const { service, persistence } = harness({ headers: [meta], logs, revisions })

    expect((await service.scan(true)).items).toHaveLength(1)
    expect((await service.scan(true)).items).toHaveLength(1)
    expect(persistence.readRaw).toHaveBeenCalledTimes(1)

    revisions.set('a', 'r2')
    logs.set('a', CLEAN_EVENTS)
    expect((await service.scan(true)).items).toHaveLength(0)
    expect(persistence.readRaw).toHaveBeenCalledTimes(2)
  })

  it('retries one changing revision once and adopts only the stable retry', async () => {
    const meta = header('a')
    const { service, persistence } = harness({
      headers: [meta],
      logs: new Map([['a', CLEAN_EVENTS]]),
    })
    persistence.listSnapshots
      .mockResolvedValueOnce([{ header: meta, revision: 'r1' as never }])
      .mockResolvedValueOnce([{ header: meta, revision: 'r2' as never }])
      .mockResolvedValueOnce([{ header: meta, revision: 'r2' as never }])
    persistence.readRaw
      .mockResolvedValueOnce({ meta, filename: 'session.jsonl', content: rawLog(meta, KILLED_EVENTS) })
      .mockResolvedValueOnce({ meta, filename: 'session.jsonl', content: rawLog(meta, CLEAN_EVENTS) })

    const snapshot = await service.scan(true)
    expect(snapshot.items).toHaveLength(0)
    expect(snapshot.skipped).toBe(0)
    expect(persistence.readRaw).toHaveBeenCalledTimes(2)
    expect(persistence.listSnapshots).toHaveBeenCalledTimes(3)
  })

  it('skips a session that changes again during its single retry', async () => {
    const meta = header('a')
    const { service, persistence } = harness({ headers: [meta], logs: new Map([['a', KILLED_EVENTS]]) })
    persistence.listSnapshots
      .mockResolvedValueOnce([{ header: meta, revision: 'r1' as never }])
      .mockResolvedValueOnce([{ header: meta, revision: 'r2' as never }])
      .mockResolvedValueOnce([{ header: meta, revision: 'r3' as never }])

    const snapshot = await service.scan(true)
    expect(snapshot.items).toHaveLength(0)
    expect(snapshot.skipped).toBe(1)
    expect(persistence.readRaw).toHaveBeenCalledTimes(2)
  })

  it('shares an in-flight scan; force bypasses only a completed cache', async () => {
    const meta = header('a')
    const { service, persistence } = harness({
      headers: [meta],
      logs: new Map([['a', KILLED_EVENTS]]),
      revisions: new Map([['a', 'r1']]),
      scanTtlMs: 60_000,
    })
    let releaseList!: (value: Array<{ header: SessionHeader; revision: never }>) => void
    const gate = new Promise<Array<{ header: SessionHeader; revision: never }>>(resolve => { releaseList = resolve })
    persistence.listSnapshots.mockImplementationOnce(() => gate)

    const first = service.scan()
    expect(service.scan()).toBe(first)
    expect(service.scan(true)).toBe(first)
    expect(persistence.listSnapshots).toHaveBeenCalledTimes(1)
    releaseList([{ header: meta, revision: 'r1' as never }])
    const completed = await first

    expect(await service.scan()).toBe(completed)
    const forced = service.scan(true)
    expect(forced).not.toBe(first)
    await forced
    expect(persistence.readRaw).toHaveBeenCalledTimes(1)
  })

  it('clears the in-flight scan after rejection so a later call can retry', async () => {
    const { service, persistence } = harness({ headers: [], logs: new Map() })
    persistence.listSnapshots.mockRejectedValueOnce(new Error('scan exploded'))
    await expect(service.scan(true)).rejects.toThrow('scan exploded')
    await expect(service.scan(true)).resolves.toMatchObject({ totalPersisted: 0 })
  })

  it('skips cold sessions on a backend without raw artifacts and never falls back', async () => {
    const { service, persistence, forbidden } = harness({
      headers: [header('a')],
      logs: new Map([['a', KILLED_EVENTS]]),
      supportsRawArtifacts: false,
    })
    const snapshot = await service.scan(true)
    expect(snapshot.items).toHaveLength(0)
    expect(snapshot.skipped).toBe(1)
    expect(persistence.readRaw).not.toHaveBeenCalled()
    expect(persistence.inspect).not.toHaveBeenCalled()
    expect(persistence.readFrom).not.toHaveBeenCalled()
    expect(forbidden.readSession).not.toHaveBeenCalled()
    expect(forbidden.readTitleSnapshots).not.toHaveBeenCalled()
  })
})

describe('ReviveService.reviveAll', () => {
  it('cold-resumes each interrupted session and follows up with the prompt', async () => {
    const headers = [header('a'), header('b')]
    const { service, followed, resumed, persistence } = harness({
      headers,
      logs: new Map([['a', KILLED_EVENTS], ['b', KILLED_EVENTS]]),
    })
    const result = await service.reviveAll()
    expect(result.revived).toHaveLength(2)
    expect(result.failed).toHaveLength(0)
    expect(resumed.sort()).toEqual(['a', 'b'])
    expect(followed).toHaveLength(2)
    expect(persistence.inspect).toHaveBeenCalledTimes(2)
  })

  it('pokes a live idle agent without resuming from persistence', async () => {
    const meta = header('a')
    const { service, followed, resumed } = harness({
      headers: [meta],
      logs: new Map(),
      live: new Map([['a', { status: 'idle', events: KILLED_EVENTS }]]),
    })
    const result = await service.reviveAll()
    expect(result.revived[0]).toMatchObject({ sessionId: 'a', resumedFromCold: false })
    expect(resumed).toHaveLength(0)
    expect(followed[0]?.text).toBe('继续')
  })

  it('collects per-session failures without stopping the sweep', async () => {
    const boom = new Error('resume exploded')
    const resolveAgent = async (sessionId: SessionId) => {
      if (sessionId === 'a') throw boom
      return { id: sessionId, status: 'idle', followup: vi.fn() } as unknown as Agent
    }
    const { service } = harness({
      headers: [header('a'), header('b')],
      logs: new Map([['a', KILLED_EVENTS], ['b', KILLED_EVENTS]]),
      resolveAgent,
    })
    const result = await service.reviveAll()
    expect(result.revived).toHaveLength(1)
    expect(result.revived[0].sessionId).toBe('b')
    expect(result.failed).toEqual([{ sessionId: 'a', error: 'resume exploded' }])
  })
})
