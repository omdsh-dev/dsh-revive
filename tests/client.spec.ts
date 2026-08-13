import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

const clientMocks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  callRpc: vi.fn(),
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => { clientMocks.effects.push(effect) },
    useRef: (initial: unknown) => ({ current: initial }),
    useState: (initial: unknown) => [initial, vi.fn()],
  }
})

vi.mock('../src/client/rpc.ts', () => ({ callRpc: clientMocks.callRpc }))

import { ReviveDock } from '../src/client/ReviveDock.tsx'

describe('ReviveDock', () => {
  beforeEach(() => {
    clientMocks.effects.length = 0
    clientMocks.callRpc.mockReset()
  })

  it('uses the host scan cache for its initial snapshot on mount', async () => {
    clientMocks.callRpc.mockResolvedValue({
      items: [],
      totalPersisted: 0,
      runningLive: 0,
      skipped: 0,
      generatedAt: 1,
    })
    const connection = {} as ConnectionHandle

    ReviveDock({ connection })
    expect(clientMocks.effects).toHaveLength(1)
    const cleanup = clientMocks.effects[0]()
    try {
      await vi.waitFor(() => expect(clientMocks.callRpc).toHaveBeenCalledTimes(1))
      expect(clientMocks.callRpc).toHaveBeenCalledWith(
        connection,
        'snapshot',
        undefined,
        expect.any(AbortSignal),
      )
    } finally {
      if (typeof cleanup === 'function') cleanup()
    }
  })
})
