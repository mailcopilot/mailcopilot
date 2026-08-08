import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Shield, Download, Trash2, RefreshCw, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { ERROR_PRESENTATION_I18N_KEYS, decodeErrorPresentation } from '@mailcopilot/core'
import { captureException } from '../../sentry'

/**
 * §3.3 B1 Privacy Audit Panel — renders the live `ai_action_log` table from
 * the main process for Settings → AI → Privacy & Audit. Three-section layout:
 *
 *   1. Period selector (today / week / month) + per-provider aggregate table
 *      (cost, tokens, untrusted wraps, injection blocks). Answers the
 *      question "is the AI gate doing anything for me?".
 *
 *   2. Paginated audit log (50 rows/page) with timestamp / provider / model /
 *      goal / tool / cost / wrapped/blocked counts / outcome / soft-delete.
 *      Retention note: the log has a row-count cap (default 10,000 rows,
 *      configurable via AI_ACTION_LOG_MAX_ROWS in packages/db). When the
 *      cap is exceeded the background rotation job physically DELETEs the
 *      oldest rows by id, regardless of their soft-delete state. The soft-
 *      delete button (sets `deleted_at`) is a separate, user-facing action
 *      that hides rows from the UI but does NOT physically remove them —
 *      they stay in the DB until the rotation cap prunes them.
 *
 *   3. Export JSON / Export CSV / Clear All actions. Export hits the main-
 *      side dialog.showSaveDialog — main writes the file. Clear All is
 *      gated by a main-process dialog.showMessageBox so the destructive
 *      confirmation cannot be forged from a compromised renderer
 *      (§3.3.B1.f1 — XSS via email content, prompt injection, rogue MCP
 *      tool). The renderer just invokes the IPC and respects
 *      { cancelled: true } as a no-op.
 *
 * Design notes:
 *   - cost_usd null → "n/a" (subscription provider does not report
 *     per-request cost upstream). We deliberately do NOT fabricate
 *     estimates — see §3.3 B1 acceptance criteria.
 *   - Shield icon next to wrapped/blocked counts links the visible counter
 *     to the underlying privacy invariant in Settings tooltips.
 *   - All UI strings via t('...') in 6 locales (i18n merge gate, CLAUDE.md).
 *   - This is a pure client component: no global state, no effects beyond
 *     the IPC fetches. Re-renders driven by local state.
 */

type Period = 'today' | 'week' | 'month'

type AuditRow = {
  id: number
  provider: string
  model: string | null
  goal: string | null
  toolName: string | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  untrustedWrapped: number
  injectionBlocked: number
  outcome: 'ok' | 'error' | 'aborted'
  createdAt: string
  deletedAt: string | null
}

type AuditListResult = {
  rows: AuditRow[]
  total: number
}

type AggregateRow = {
  provider: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  untrustedWrapped: number
  injectionBlocked: number
}

type ExportResult =
  | { ok: true; path: string; payload: string }
  | { ok: false; cancelled: true; payload: string }
  | { ok: false; error: string; payload: string }

const PAGE_SIZE = 50

function formatCost(cost: number | null, t: ReturnType<typeof useTranslation>['t']): string {
  if (cost === null || cost === undefined) return t('ai.privacy.audit.notAvailable')
  if (cost === 0) return '$0.00'
  if (cost < 0.01) return `<$0.01`
  return `$${cost.toFixed(4)}`
}

function formatTimestamp(iso: string): string {
  // SQLite `datetime('now')` returns 'YYYY-MM-DD HH:MM:SS' UTC. Render it
  // in the user's locale without inventing a timezone — Intl.DateTimeFormat
  // attaches the runtime tz when the input has none, which is exactly what
  // we want for a local-display audit log.
  try {
    const safe = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z'
    const d = new Date(safe)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString()
  } catch {
    return iso
  }
}

export default function AiPrivacyPanel() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<Period>('week')
  const [aggregate, setAggregate] = useState<AggregateRow[]>([])
  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState<number>(0)
  const [page, setPage] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string>('')
  const [collapsed, setCollapsed] = useState<boolean>(true)
  // §2.127 — every catch below shows a sentence from the closed error
  // vocabulary instead of the raw rejection text. These are local audit-log
  // reads and writes: their failures have no server-side story to tell, and
  // the old text was the bare IPC wrapper ("Error invoking remote method
  // 'ai:auditLog:list': …"). Read through a ref so a language switch does not
  // change `refresh`'s identity and re-run the effect that calls it.
  const tRef = useRef(t)
  tRef.current = t

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [agg, list] = await Promise.all([
        window.api.invoke<AggregateRow[]>('ai:auditLog:aggregate', { period }),
        window.api.invoke<AuditListResult>('ai:auditLog:list', {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      ])
      setAggregate(agg)
      setRows(list.rows)
      setTotal(list.total)
    } catch (e) {
      setError(tRef.current(ERROR_PRESENTATION_I18N_KEYS[decodeErrorPresentation(e)]))
      captureException(e, { source: 'AiPrivacyPanel.refresh' })
    } finally {
      setLoading(false)
    }
  }, [period, page])

  useEffect(() => {
    if (collapsed) return
    void refresh()
  }, [refresh, collapsed])

  const handleSoftDelete = useCallback(async (id: number) => {
    try {
      await window.api.invoke('ai:auditLog:softDelete', { id })
      void refresh()
    } catch (e) {
      setError(tRef.current(ERROR_PRESENTATION_I18N_KEYS[decodeErrorPresentation(e)]))
      captureException(e, { source: 'AiPrivacyPanel.softDelete' })
    }
  }, [refresh])

  const handleClearAll = useCallback(async () => {
    // §3.3.B1.f1 — Confirmation lives in the main process now (native
    // dialog.showMessageBox in `ai:auditLog:clear` handler). A renderer-only
    // prompt would be bypassable from a compromised renderer (XSS via
    // email content, prompt injection, rogue MCP tool). Trust the main
    // gate; treat { cancelled: true } as a no-op.
    try {
      const res = await window.api.invoke<{ ok: boolean; cancelled?: boolean; deleted: number }>(
        'ai:auditLog:clear',
      )
      if (res && res.cancelled) return
      setPage(0)
      void refresh()
    } catch (e) {
      setError(tRef.current(ERROR_PRESENTATION_I18N_KEYS[decodeErrorPresentation(e)]))
      captureException(e, { source: 'AiPrivacyPanel.clear' })
    }
  }, [refresh])

  const handleExport = useCallback(async (format: 'json' | 'csv') => {
    try {
      await window.api.invoke<ExportResult>('ai:auditLog:export', { format })
    } catch (e) {
      setError(tRef.current(ERROR_PRESENTATION_I18N_KEYS[decodeErrorPresentation(e)]))
      captureException(e, { source: 'AiPrivacyPanel.export' })
    }
  }, [])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <section className="form-section ai-privacy-panel">
      <h3
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        onClick={() => setCollapsed(c => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(c => !c) } }}
      >
        <Shield size={16} style={{ verticalAlign: -2 }} />
        {t('ai.privacy.audit.title')}
        {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </h3>
      <p className="hint">{t('ai.privacy.audit.hint')}</p>

      {!collapsed && (
        <>
          <div className="setting-row" style={{ alignItems: 'center', gap: 8 }}>
            <label>{t('ai.privacy.audit.period')}:</label>
            <select
              value={period}
              onChange={e => { setPage(0); setPeriod(e.target.value as Period) }}
              data-testid="ai-privacy-period"
            >
              <option value="today">{t('ai.privacy.audit.periodToday')}</option>
              <option value="week">{t('ai.privacy.audit.periodWeek')}</option>
              <option value="month">{t('ai.privacy.audit.periodMonth')}</option>
            </select>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void refresh()}
              disabled={loading}
              title={t('ai.privacy.audit.refresh')}
            >
              <RefreshCw size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
              {t('ai.privacy.audit.refresh')}
            </button>
          </div>

          {error && (
            <p className="status-err" style={{ marginTop: 8 }}>
              <AlertCircle size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
              {error}
            </p>
          )}

          <h4 style={{ marginTop: 16 }}>{t('ai.privacy.audit.aggregateTitle')}</h4>
          {aggregate.length === 0 ? (
            <p className="hint">{t('ai.privacy.audit.aggregateEmpty')}</p>
          ) : (
            <div className="ai-privacy-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="ai-privacy-table">
                <thead>
                  <tr>
                    <th>{t('ai.privacy.audit.col.provider')}</th>
                    <th>{t('ai.privacy.audit.col.requests')}</th>
                    <th>{t('ai.privacy.audit.col.cost')}</th>
                    <th>{t('ai.privacy.audit.col.tokensIn')}</th>
                    <th>{t('ai.privacy.audit.col.tokensOut')}</th>
                    <th title={t('ai.privacy.audit.col.wrappedTooltip')}>
                      <Shield size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                      {t('ai.privacy.audit.col.wrapped')}
                    </th>
                    <th title={t('ai.privacy.audit.col.blockedTooltip')}>
                      <Shield size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                      {t('ai.privacy.audit.col.blocked')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aggregate.map(a => (
                    <tr key={a.provider}>
                      <td>{a.provider}</td>
                      <td>{a.requests}</td>
                      <td>{formatCost(a.costUsd, t)}</td>
                      <td>{a.inputTokens || t('ai.privacy.audit.notAvailable')}</td>
                      <td>{a.outputTokens || t('ai.privacy.audit.notAvailable')}</td>
                      <td>{a.untrustedWrapped}</td>
                      <td>{a.injectionBlocked}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h4 style={{ marginTop: 16 }}>{t('ai.privacy.audit.logTitle')}</h4>
          {rows.length === 0 ? (
            <p className="hint">{t('ai.privacy.audit.logEmpty')}</p>
          ) : (
            <>
              <div className="ai-privacy-table-wrap" style={{ overflowX: 'auto' }}>
                <table className="ai-privacy-table">
                  <thead>
                    <tr>
                      <th>{t('ai.privacy.audit.col.timestamp')}</th>
                      <th>{t('ai.privacy.audit.col.provider')}</th>
                      <th>{t('ai.privacy.audit.col.model')}</th>
                      <th>{t('ai.privacy.audit.col.goal')}</th>
                      <th>{t('ai.privacy.audit.col.tool')}</th>
                      <th>{t('ai.privacy.audit.col.tokensIn')}</th>
                      <th>{t('ai.privacy.audit.col.tokensOut')}</th>
                      <th>{t('ai.privacy.audit.col.cost')}</th>
                      <th title={t('ai.privacy.audit.col.wrappedTooltip')}>
                        <Shield size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                        {t('ai.privacy.audit.col.wrapped')}
                      </th>
                      <th title={t('ai.privacy.audit.col.blockedTooltip')}>
                        <Shield size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                        {t('ai.privacy.audit.col.blocked')}
                      </th>
                      <th>{t('ai.privacy.audit.col.outcome')}</th>
                      <th>{t('ai.privacy.audit.col.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id}>
                        <td>{formatTimestamp(r.createdAt)}</td>
                        <td>{r.provider}</td>
                        <td>{r.model ?? t('ai.privacy.audit.notAvailable')}</td>
                        <td>{r.goal ?? t('ai.privacy.audit.notAvailable')}</td>
                        <td>{r.toolName ?? t('ai.privacy.audit.notAvailable')}</td>
                        <td>{r.inputTokens ?? t('ai.privacy.audit.notAvailable')}</td>
                        <td>{r.outputTokens ?? t('ai.privacy.audit.notAvailable')}</td>
                        <td>{formatCost(r.costUsd, t)}</td>
                        <td>{r.untrustedWrapped}</td>
                        <td>{r.injectionBlocked}</td>
                        <td>{t(`ai.privacy.audit.outcome.${r.outcome}`)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn-link"
                            onClick={() => void handleSoftDelete(r.id)}
                            title={t('ai.privacy.audit.deleteRow')}
                            data-testid={`ai-privacy-delete-${r.id}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="setting-row" style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={page === 0 || loading}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                >
                  {t('ai.privacy.audit.prev')}
                </button>
                <span className="hint">
                  {t('ai.privacy.audit.pageOf', { page: page + 1, total: totalPages })}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={page + 1 >= totalPages || loading}
                  onClick={() => setPage(p => p + 1)}
                >
                  {t('ai.privacy.audit.next')}
                </button>
              </div>
            </>
          )}

          <div className="setting-row" style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleExport('json')}
              disabled={loading}
              data-testid="ai-privacy-export-json"
            >
              <Download size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
              {t('ai.privacy.audit.exportJson')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleExport('csv')}
              disabled={loading}
              data-testid="ai-privacy-export-csv"
            >
              <Download size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
              {t('ai.privacy.audit.exportCsv')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void handleClearAll()}
              disabled={loading || total === 0}
              data-testid="ai-privacy-clear-all"
            >
              <Trash2 size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
              {t('ai.privacy.audit.clearAll')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
