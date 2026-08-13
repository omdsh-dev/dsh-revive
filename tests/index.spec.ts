import { beforeEach, describe, expect, it, vi } from 'vitest'

const indexMocks = vi.hoisted(() => ({
  serviceOptions: [] as Array<Record<string, unknown>>,
}))

vi.mock('../src/service.ts', () => ({
  ReviveService: class {
    constructor(_ctx: unknown, options: Record<string, unknown>) {
      indexMocks.serviceOptions.push(options)
    }
  },
}))

import { Config, apply } from '../src/index.ts'

describe('dsh-revive config', () => {
  beforeEach(() => { indexMocks.serviceOptions.length = 0 })

  it('publishes the memory-safe scan defaults in its loader schema', () => {
    expect(Config({})).toMatchObject({
      resumePrompt: '继续',
      autoReviveOnStartup: false,
      startupDelayMs: 5_000,
      scanTtlMs: 120_000,
      scanConcurrency: 1,
    })
    expect(() => Config({ scanConcurrency: 0 })).toThrow()
  })

  it('passes configured scanConcurrency through to ReviveService', () => {
    const ctx = { effect: vi.fn() }
    apply(ctx as never, Config({ resumePrompt: 'go', scanConcurrency: 3 }))

    expect(indexMocks.serviceOptions).toHaveLength(1)
    expect(indexMocks.serviceOptions[0]).toMatchObject({
      scanTtlMs: 120_000,
      scanConcurrency: 3,
    })
    expect((indexMocks.serviceOptions[0].prompt as () => string)()).toBe('go')
  })
})
