/**
 * ReviveDock: the one-click revive widget mounted on
 * 'conversation.composer.dock' (the band under the composer card, next to
 * the stats line). Polls the host `/revive` snapshot every 15s, shows a
 * count badge of interrupted sessions, and revives them all on click.
 * @module
 */

import { useEffect, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { callRpc } from './rpc.ts'
import type { ReviveRunWire, ReviveScanWire } from './wire.ts'

const POLL_MS = 60_000
const NOTICE_MS = 8_000

interface ReviveDockProps {
  connection: ConnectionHandle
}

const styles = {
  wrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    lineHeight: '18px',
  } as const,
  button: (alert: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    border: '1px solid transparent',
    borderRadius: 8,
    padding: '1px 8px',
    background: alert ? 'rgba(255, 176, 32, 0.14)' : 'transparent',
    color: alert ? '#ffb020' : 'var(--dsh-text-muted, #8b93a1)',
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: '18px',
    transition: 'background 0.15s, color 0.15s',
  }),
  notice: {
    color: 'var(--dsh-text-muted, #8b93a1)',
    whiteSpace: 'nowrap',
  } as const,
  error: {
    color: '#ff6b6b',
    whiteSpace: 'nowrap',
  } as const,
}

/** One-click revive widget: snapshot polling + revive-all action. */
export function ReviveDock(props: ReviveDockProps) {
  const { connection } = props
  const [snapshot, setSnapshot] = useState<ReviveScanWire | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let disposed = false
    const refresh = async (force = false): Promise<void> => {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)
        const next = await callRpc<ReviveScanWire>(connection, 'snapshot', force ? { refresh: true } : undefined, controller.signal)
        clearTimeout(timeout)
        if (!disposed) setSnapshot(next)
      } catch {
        // A failed poll keeps the last snapshot; the next tick retries.
      }
    }
    // A remount should reuse the host snapshot cache; only an explicit revive
    // action below forces a corpus rescan.
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
      if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    }
  }, [connection])

  const count = snapshot?.items.length ?? 0
  const alert = count > 0

  const revive = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await callRpc<ReviveRunWire>(connection, 'run')
      const text = result.failed.length > 0
        ? `已复活 ${result.revived.length} 个，失败 ${result.failed.length} 个`
        : `已复活 ${result.revived.length} 个会话`
      setNotice({ text, error: result.failed.length > 0 })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      try {
        setSnapshot(await callRpc<ReviveScanWire>(connection, 'snapshot', { refresh: true }, controller.signal))
      } catch {
        // Keep the stale snapshot; the poll loop refreshes it soon.
      }
      clearTimeout(timeout)
    } catch (error) {
      setNotice({ text: `复活失败：${error instanceof Error ? error.message : String(error)}`, error: true })
    } finally {
      setBusy(false)
      if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
      noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
    }
  }

  return (
    <span style={styles.wrap}>
      <button
        type="button"
        style={styles.button(alert)}
        title={count > 0
          ? `复活 ${count} 个被打断的会话`
          : '一键复活：给被打断的会话发送继续指令'}
        onClick={() => { void revive() }}
        disabled={busy}
      >
        <span aria-hidden>⚡</span>
        {busy ? '复活中…' : count > 0 ? `复活 ${count}` : '复活'}
      </button>
      {notice !== null && (
        <span style={notice.error ? styles.error : styles.notice}>{notice.text}</span>
      )}
    </span>
  )
}
