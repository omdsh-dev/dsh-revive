/**
 * Browser wire types for the `/revive` RPC channel. Kept local to the client
 * bundle — the host half's types never cross into browser code.
 * @module
 */

/** One revivable session in a snapshot. */
export interface ReviveCandidateWire {
  readonly sessionId: string
  readonly title?: string
  readonly reason: string
  readonly live: boolean
  readonly createdAt: number
}

/** Snapshot payload of the `snapshot` endpoint. */
export interface ReviveScanWire {
  readonly items: readonly ReviveCandidateWire[]
  readonly totalPersisted: number
  readonly runningLive: number
  readonly skipped: number
  readonly generatedAt: number
}

/** Payload of the `run` endpoint. */
export interface ReviveRunWire {
  readonly revived: ReadonlyArray<{
    readonly sessionId: string
    readonly title?: string
    readonly resumedFromCold: boolean
  }>
  readonly failed: ReadonlyArray<{
    readonly sessionId: string
    readonly error: string
  }>
  readonly generatedAt: number
}
