import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

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

import { Config, apply, inject } from '../src/index.ts'

describe('dsh-revive config', () => {
  beforeEach(() => { indexMocks.serviceOptions.length = 0 })

  it('publishes the memory-safe scan defaults in its loader schema', () => {
    expect(Config({})).toMatchObject({
      resumePrompt: '继续',
      autoReviveOnStartup: false,
      startupDelayMs: 5_000,
      scanTtlMs: 120_000,
    })
  })

  it('requires direct persistence instead of session-query projections', () => {
    expect(inject).toContain('sessionPersistence')
    expect(inject).not.toContain('sessionQuery')
  })

  it('waits for the client module that declares the composer slot', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh: { client: { inject: string[] } }
    }
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-conversation')
    expect(manifest.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-ui-slots')
  })

  it('passes resolved scan settings through to ReviveService', () => {
    const ctx = { effect: vi.fn() }
    apply(ctx as never, Config({ resumePrompt: 'go', scanTtlMs: 30_000 }))

    expect(indexMocks.serviceOptions).toHaveLength(1)
    expect(indexMocks.serviceOptions[0]).toMatchObject({
      scanTtlMs: 30_000,
    })
    expect((indexMocks.serviceOptions[0].prompt as () => string)()).toBe('go')
  })
})
