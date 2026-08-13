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
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { detectHealth, lastRequestConfig, type InterruptReason, type SessionHealth } from './detect.ts'
import { detectRawHealth } from './raw-health.ts'
// Type-only: pull the Context interface merges the service types ride on
// (`sessionPersistence`, `agents`, `sessions`, `agentPresets`, `agentDefaultModel`).
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
  /** Records skipped as ineligible, transient, unreadable, or unsafe to project. */
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
  /**
   * Resolve one session to a live Agent: live reuse, cold resume.
   * Injectable for tests; defaults to the production implementation.
   */
  resolveAgent?: (sessionId: SessionId, inspected: InspectedSession) => Promise<Agent>
}

interface ColdProjection {
  readonly health: SessionHealth
}

const DEFAULT_SCAN_TTL_MS = 120_000

export class ReviveService {
  private cache: { readonly at: number; readonly result: ReviveScanResult } | undefined
  private scanInFlight: Promise<ReviveScanResult> | undefined
  private readonly coldCache = new Map<SessionId, {
    readonly revision: SessionPersistenceRevision
    readonly projection: ColdProjection
  }>()
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
    const persistence = this.ctx.sessionPersistence
    const before = await persistence.listSnapshots()
    const candidates: ReviveCandidate[] = []
    const cold: SessionPersistenceSnapshot[] = []
    let runningLive = 0
    let skipped = 0

    for (const snapshot of before) {
      const { header } = snapshot
      if (!isEligible(header)) {
        skipped += 1
        continue
      }
      const agent = this.ctx.agents.get(header.id)
      const session = this.ctx.sessions.get(header.id)
      if (agent !== undefined || session !== undefined) {
        // A half-attached live identity is transient. Treat it as unavailable;
        // a raw cold result could race the store entry it is becoming.
        if (agent === undefined || session === undefined) {
          skipped += 1
          continue
        }
        if (agent.status === 'running') {
          runningLive += 1
          continue
        }
        const health = detectHealth(session.events)
        if (health.state === 'interrupted') {
          candidates.push(candidateOf(header, health.reason, true))
        }
        continue
      }
      cold.push(snapshot)
    }

    const skippedCold = new Set<SessionId>()
    let latest: SessionPersistenceSnapshot[]
    if (!persistence.supportsRawArtifacts) {
      for (const snapshot of cold) skippedCold.add(snapshot.header.id)
      latest = await persistence.listSnapshots()
    } else {
      const first = await this.projectColdSerial(persistence, cold)
      const after = await persistence.listSnapshots()
      const afterById = snapshotsById(after)
      const retry: SessionPersistenceSnapshot[] = []

      for (const snapshot of cold) {
        const observed = afterById.get(snapshot.header.id)
        const projection = first.get(snapshot.header.id)
        if (observed !== undefined && observed.revision === snapshot.revision) {
          if (projection === undefined) skippedCold.add(snapshot.header.id)
          else if (!this.acceptCold(observed, projection, candidates)) skippedCold.add(snapshot.header.id)
          continue
        }
        if (observed === undefined || !isEligible(observed.header)) skippedCold.add(snapshot.header.id)
        else retry.push(observed)
      }

      if (retry.length === 0) {
        latest = after
      } else {
        const second = await this.projectColdSerial(persistence, retry)
        latest = await persistence.listSnapshots()
        const finalById = snapshotsById(latest)
        for (const snapshot of retry) {
          const observed = finalById.get(snapshot.header.id)
          const projection = second.get(snapshot.header.id)
          if (observed !== undefined && observed.revision === snapshot.revision && projection !== undefined) {
            if (!this.acceptCold(observed, projection, candidates)) skippedCold.add(snapshot.header.id)
          } else {
            skippedCold.add(snapshot.header.id)
          }
        }
      }
    }

    this.pruneColdCache(latest)
    skipped += skippedCold.size
    candidates.sort((left, right) => right.createdAt - left.createdAt
      || String(left.sessionId).localeCompare(String(right.sessionId)))
    const result: ReviveScanResult = {
      items: candidates,
      totalPersisted: before.length,
      runningLive,
      skipped,
      generatedAt,
    }
    return result
  }

  /** Project raw artifacts one at a time; this concurrency is intentionally not configurable. */
  private async projectColdSerial(
    persistence: SessionPersistence,
    snapshots: readonly SessionPersistenceSnapshot[],
  ): Promise<Map<SessionId, ColdProjection>> {
    const projected = new Map<SessionId, ColdProjection>()
    for (const snapshot of snapshots) {
      const { id } = snapshot.header
      const cached = this.coldCache.get(id)
      if (cached?.revision === snapshot.revision) {
        projected.set(id, cached.projection)
        continue
      }
      try {
        const raw = await persistence.readRaw(id)
        if (raw === undefined || raw.meta.id !== id) continue
        projected.set(id, { health: detectRawHealth(raw.content) })
      } catch {
        // One absent, corrupt, or unreadable artifact must not discard peers.
      }
    }
    return projected
  }

  /** Commit one revision-stable projection to the tiny process cache and result set. */
  private acceptCold(
    snapshot: SessionPersistenceSnapshot,
    projection: ColdProjection,
    candidates: ReviveCandidate[],
  ): boolean {
    const { id } = snapshot.header
    // If this identity attached while its artifact was read, never publish the
    // cold observation; the next scan will inspect the authoritative live log.
    if (this.ctx.agents.get(id) !== undefined || this.ctx.sessions.get(id) !== undefined) return false
    this.coldCache.set(id, { revision: snapshot.revision, projection })
    if (projection.health.state === 'interrupted') {
      candidates.push(candidateOf(snapshot.header, projection.health.reason, false))
    }
    return true
  }

  /** Drop projections whose durable identity disappeared or advanced. */
  private pruneColdCache(snapshots: readonly SessionPersistenceSnapshot[]): void {
    const latest = snapshotsById(snapshots)
    for (const [id, cached] of this.coldCache) {
      if (latest.get(id)?.revision !== cached.revision) this.coldCache.delete(id)
    }
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

}

function isEligible(header: SessionHeader): boolean {
  return header.cwd !== undefined && header.origin !== 'subagent'
}

function candidateOf(
  header: SessionHeader,
  reason: InterruptReason,
  live: boolean,
): ReviveCandidate {
  return { sessionId: header.id, reason, live, createdAt: header.createdAt }
}

function snapshotsById(
  snapshots: readonly SessionPersistenceSnapshot[],
): Map<SessionId, SessionPersistenceSnapshot> {
  return new Map(snapshots.map(snapshot => [snapshot.header.id, snapshot]))
}
