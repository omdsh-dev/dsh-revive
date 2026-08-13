/**
 * ReviveService: enumerate interrupted sessions and send each one a「继续」
 * prompt through the same cold-resume path the web GUI uses.
 *
 * Scan policy:
 * - only project-backed sessions (`cwd` set) that are not subagent-owned
 *   (`origin: 'subagent'`) are candidates — subagent children are revived
 *   through their parent;
 * - live agents that are still running are left alone;
 * - a live but idle agent is poked directly; a cold session is resumed from
 *   persistence with its recorded preset composition and last model.
 *
 * All revival is initiated from the host plane; the resumed agents are owned
 * by the plugin's fiber (host lifetime).
 * @module
 */

import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { ApiRemoteSessionNotFound, inspectApiRemoteSession } from '@deepseek-ai/dsh-api-remotes'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { detectHealth, lastRequestConfig, type InterruptReason } from './detect.ts'
// Type-only: pull the Context interface merges the service types ride on
// (`sessionQuery`, `agents`, `sessions`, `agentPresets`, `agentDefaultModel`).
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'

/** One revivable session as reported to the command / tool / browser widget. */
export interface ReviveCandidate {
  readonly sessionId: SessionId
  readonly title?: string
  readonly reason: InterruptReason
  readonly live: boolean
  readonly createdAt: number
}

/** Snapshot produced by {@link ReviveService.scan}. */
export interface ReviveScanResult {
  readonly items: ReviveCandidate[]
  /** Total persisted records the scan visited (live + cold). */
  readonly totalPersisted: number
  /** Live agents that are currently running (not touched). */
  readonly runningLive: number
  /** Records skipped as subagent-owned or project-less. */
  readonly skipped: number
  readonly generatedAt: number
}

/** One successful revival. */
export interface ReviveOutcome {
  readonly sessionId: SessionId
  readonly title?: string
  readonly resumedFromCold: boolean
}

/** One failed revival. */
export interface ReviveFailure {
  readonly sessionId: SessionId
  readonly error: string
}

/** Full report produced by {@link ReviveService.reviveAll}. */
export interface ReviveRunResult {
  readonly revived: readonly ReviveOutcome[]
  readonly failed: readonly ReviveFailure[]
  readonly generatedAt: number
}

/** Detached persisted metadata + events, as inspectApiRemoteSession returns. */
export interface InspectedSession {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
}

/** Service dependencies that vary with the caller. */
export interface ReviveServiceOptions {
  /** The prompt text sent to every revived session (default 继续). */
  readonly prompt: () => string
  /** Snapshot cache TTL in milliseconds. */
  readonly scanTtlMs?: number
  /** Scan batch size for cold-log reads. */
  readonly scanConcurrency?: number
  /**
   * Resolve one session to a live Agent: live reuse, cold resume.
   * Injectable for tests; defaults to the production implementation.
   */
  resolveAgent?: (sessionId: SessionId, inspected: InspectedSession) => Promise<Agent>
}

interface WorkItem {
  readonly record: SessionRecord
  /** Start loading this session's events only when a scan worker is ready. */
  readonly readEvents: () => Promise<readonly SessionEvent[]> | readonly SessionEvent[]
}

const DEFAULT_SCAN_TTL_MS = 120_000
/** Serialize cold-log reads by default: one giant log can approach the V8 heap limit alone. */
export const DEFAULT_SCAN_CONCURRENCY = 1

export class ReviveService {
  private cache: { readonly at: number; readonly result: ReviveScanResult } | undefined
  private scanInFlight: Promise<ReviveScanResult> | undefined
  private readonly inFlight = new Map<string, Promise<Agent>>()
  private readonly resolveAgent: (sessionId: SessionId, inspected: InspectedSession) => Promise<Agent>

  constructor(
    private readonly ctx: Context,
    private readonly options: ReviveServiceOptions,
  ) {
    this.resolveAgent = options.resolveAgent ?? ((sessionId, inspected) => this.resumeCold(sessionId, inspected))
  }

  /** Scan the corpus and report every revivable session. */
  scan(force = false): Promise<ReviveScanResult> {
    // Prefer the current refresh over a completed cache entry. In particular,
    // a forced caller must join an already-running scan rather than launch a
    // second corpus walk beside it.
    if (this.scanInFlight !== undefined) return this.scanInFlight

    const now = Date.now()
    if (!force && this.cache !== undefined && now - this.cache.at < (this.options.scanTtlMs ?? DEFAULT_SCAN_TTL_MS)) {
      return Promise.resolve(this.cache.result)
    }

    const pending = this.scanCorpus()
    this.scanInFlight = pending
    // Settle single-flight state on both outcomes without creating a floating
    // rejected promise. A failed refresh leaves the last completed cache intact.
    void pending.then(
      (result) => {
        if (this.scanInFlight === pending) this.scanInFlight = undefined
        this.cache = { at: Date.now(), result }
      },
      () => {
        if (this.scanInFlight === pending) this.scanInFlight = undefined
      },
    )
    return pending
  }

  /** Perform one uncached corpus walk. Call through {@link scan}. */
  private async scanCorpus(): Promise<ReviveScanResult> {
    const generatedAt = Date.now()
    const records = await this.ctx.sessionQuery.listSessions()
    const work: WorkItem[] = []
    let runningLive = 0
    let skipped = 0
    for (const record of records) {
      const header = record.header
      if (header.cwd === undefined || header.origin === 'subagent') {
        skipped += 1
        continue
      }
      if (record.live) {
        const agent = this.ctx.agents.get(header.id)
        const session = this.ctx.sessions.get(header.id)
        if (agent === undefined || session === undefined) {
          // Attached without a live agent: transient in-process state; never
          // resume into it (a cold resume would collide with the store entry).
          skipped += 1
          continue
        }
        if (agent.status === 'running') {
          runningLive += 1
          continue
        }
        work.push({ record, readEvents: () => session.events })
        continue
      }
      work.push({
        record,
        readEvents: async () => (await this.ctx.sessionQuery.readSession(header.id)).events,
      })
    }

    const requestedConcurrency = this.options.scanConcurrency ?? DEFAULT_SCAN_CONCURRENCY
    const concurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? Math.max(1, Math.floor(requestedConcurrency))
      : DEFAULT_SCAN_CONCURRENCY
    const candidates: Array<ReviveCandidate | undefined> = new Array(work.length)
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (nextIndex < work.length) {
        const index = nextIndex
        nextIndex += 1
        const item = work[index]
        try {
          const events = await item.readEvents()
          const health = detectHealth(events)
          if (health.state === 'interrupted') {
            candidates[index] = {
              sessionId: item.record.header.id,
              reason: health.reason,
              live: item.record.live,
              createdAt: item.record.header.createdAt,
            }
          }
        } catch {
          // Preserve the previous allSettled behavior: one unreadable session
          // does not prevent the rest of the persisted corpus from being scanned.
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(concurrency, work.length) },
      () => worker(),
    ))
    const items = candidates.filter((candidate): candidate is ReviveCandidate => candidate !== undefined)

    const titles = await this.titlesFor(items.map(item => item.sessionId))
    const titled = items.map((item, index) => ({ ...item, title: titles[index] }))
    const result: ReviveScanResult = {
      items: titled,
      totalPersisted: records.length,
      runningLive,
      skipped,
      generatedAt,
    }
    return result
  }

  /** Revive every session the current scan reports as interrupted. */
  async reviveAll(): Promise<ReviveRunResult> {
    const snapshot = await this.scan(true)
    const revived: ReviveOutcome[] = []
    const failed: ReviveFailure[] = []
    for (const item of snapshot.items) {
      try {
        const outcome = await this.reviveOne(item.sessionId, item)
        if (outcome.status === 'revived') revived.push(outcome.outcome)
        else if (outcome.status === 'failed') failed.push({ sessionId: item.sessionId, error: outcome.error })
      } catch (error) {
        failed.push({ sessionId: item.sessionId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    // Invalidate the snapshot cache so the next scan reflects post-revive state.
    this.cache = undefined
    return { revived, failed, generatedAt: Date.now() }
  }

  /**
   * Revive one session: poke a live idle agent, or cold-resume a persisted
   * one, then admit a「继续」prompt as the next turn.
   */
  async reviveOne(
    sessionId: SessionId,
    hint?: { title?: string },
  ): Promise<
    | { status: 'revived'; outcome: ReviveOutcome }
    | { status: 'failed'; error: string }
    | { status: 'skipped'; reason: string }
  > {
    let agent = this.ctx.agents.get(sessionId)
    let resumedFromCold = false
    if (agent === undefined) {
      let inspected: InspectedSession
      try {
        inspected = await inspectApiRemoteSession(this.ctx, sessionId)
      } catch (error) {
        if (error instanceof ApiRemoteSessionNotFound) return { status: 'skipped', reason: 'not found' }
        return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
      let pending = this.inFlight.get(sessionId)
      if (pending === undefined) {
        pending = this.resolveAgent(sessionId, inspected)
        this.inFlight.set(sessionId, pending)
        // Settle the dedupe map on both outcomes; `.then` with two handlers
        // never leaves a floating rejection (`.finally` would re-propagate).
        void pending.then(
          () => { this.inFlight.delete(sessionId) },
          () => { this.inFlight.delete(sessionId) },
        )
      }
      agent = await pending
      resumedFromCold = true
    }
    if (agent.status === 'running') {
      return { status: 'skipped', reason: 'already running' }
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: this.options.prompt() }],
      source: { kind: 'plugin', plugin: 'dsh-revive' },
    })
    agent.followup(message)
    return {
      status: 'revived',
      outcome: { sessionId, title: hint?.title, resumedFromCold },
    }
  }

  /** Production cold-resume: preset composition + last recorded model. */
  private async resumeCold(sessionId: SessionId, inspected: InspectedSession): Promise<Agent> {
    const presets = this.ctx.get('agentPresets')
    const setup: AgentSetup | undefined = presets === undefined
      ? undefined
      : async (agentCtx) => {
          const presetId = resolveSessionPreset({ header: inspected.meta, events: [...inspected.events] })
          await presets.mount(agentCtx, presetId)
        }
    const recorded = lastRequestConfig(inspected.events)
    const defaults = this.ctx.get('agentDefaultModel')?.currentSelection()
    const agentOptions = recorded === undefined
      ? (defaults === undefined ? undefined : { provider: defaults.provider, model: defaults.model })
      : { provider: recorded.provider, model: recorded.model }
    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      ...agentOptions === undefined ? {} : { agentOptions },
      ...setup === undefined ? {} : { setup },
    })
    return handle.agent
  }

  /** Batch-read titles for the given ids; failures degrade to undefined. */
  private async titlesFor(ids: readonly SessionId[]): Promise<Array<string | undefined>> {
    if (ids.length === 0) return []
    const results = await this.ctx.sessionQuery.readTitleSnapshots(ids)
    return results.map(result => (result.status === 'fulfilled' ? result.value.title?.title : undefined))
  }
}
