/**
 * AiConsentMatrix — §1.26.1(3), the single place the AI tab answers "which of my
 * mailboxes may use which AI feature".
 *
 * A row per mailbox, a column per feature, a checkbox at the crossing, and a
 * three-state checkbox in each column header that grants or withdraws that ONE
 * feature across every mailbox — its accessible name is built from what the
 * click would write, so a mixed column says "turn off" rather than "allow".
 *
 * All derivation lives in `useAiConsentMatrix`; this file is markup plus copy,
 * so `src/windows/Settings.tsx` (a CLAUDE.md §5 hotspot) is left with a single
 * call site instead of four near-identical sections that each re-rendered the
 * same account picker.
 *
 * The per-feature descriptions that used to be a `section-hint` under each of
 * those four sections are kept, as a legend below the table: they are the only
 * place that says what each feature costs and that nothing runs on its own, and
 * a column header of two or three words cannot carry that.
 */

import { useTranslation } from 'react-i18next'
import {
  AI_CONSENT_FEATURES,
  useAiConsentMatrix,
  type AiConsentFeature,
  type AiConsentMapUpdate,
  type AiConsentValue,
} from '../../hooks/useAiConsentMatrix'

/** One mailbox as the grid renders it; the label is built by the caller. */
export type AiConsentMatrixAccount = {
  id: number
  label: string
}

export type AiConsentMatrixProps = {
  accounts: AiConsentMatrixAccount[]
  value: AiConsentValue
  onChangeFeature: (feature: AiConsentFeature, update: AiConsentMapUpdate) => void
}

/**
 * Column heading copy. Deliberately the SAME keys the four retired sections used
 * for their titles and hints: the wording was reviewed for six locales and says
 * the honest thing about each feature, and re-inventing it here would have
 * created a second, drifting description of the same switch.
 */
function featureTitleKey(feature: AiConsentFeature): string {
  return `ai.settings.${feature}.title`
}

function featureHelpKey(feature: AiConsentFeature): string {
  return `ai.settings.${feature}.help`
}

export default function AiConsentMatrix({
  accounts,
  value,
  onChangeFeature,
}: AiConsentMatrixProps) {
  const { t } = useTranslation()
  const { columns, rows, accountCount } = useAiConsentMatrix({
    accountIds: accounts.map(a => a.id),
    value,
    onChangeFeature,
  })
  const labelById = new Map(accounts.map(a => [a.id, a.label]))

  return (
    <section className="form-section" data-testid="settings-ai-consent-matrix">
      <h3>{t('ai.settings.consentMatrix.title')}</h3>
      <p className="section-hint">{t('ai.settings.consentMatrix.help')}</p>

      {accountCount === 0 ? (
        <p className="section-hint" data-testid="settings-ai-consent-empty">
          {t('ai.settings.consentMatrix.noAccounts')}
        </p>
      ) : (
        <table className="ai-consent-matrix">
          <thead>
            <tr>
              <th scope="col" className="ai-consent-account-head">
                {t('ai.settings.consentMatrix.accountColumn')}
              </th>
              {columns.map(col => {
                // The bulk control names the feature AND the number of mailboxes
                // it would touch, because the click is invisible in the header
                // itself — the evidence is the column of cells underneath.
                //
                // The name is derived from `col.grants` — what the click will
                // actually write — and not from `col.state`, so all THREE header
                // states announce themselves honestly: a mixed column withdraws
                // and says so, which the old `state === 'all'` test got wrong.
                const bulkLabel = t(
                  col.grants
                    ? 'ai.settings.consentMatrix.allowAll'
                    : 'ai.settings.consentMatrix.clearAll',
                  { feature: t(featureTitleKey(col.feature)), count: accountCount },
                )
                return (
                  <th scope="col" key={col.feature} className="ai-consent-feature-head">
                    <input
                      type="checkbox"
                      data-testid={`settings-ai-consent-all-${col.feature}`}
                      checked={col.state === 'all'}
                      // Native tri-state: `indeterminate` is an IDL property, not
                      // an attribute, so it has to be written on the node. It maps
                      // to `aria-checked="mixed"` for assistive technology by
                      // itself — the Win32 UX guide's "set for part of the
                      // selection", which is what a column with some mailboxes on
                      // and some off actually means.
                      ref={el => {
                        if (el) el.indeterminate = col.state === 'some'
                      }}
                      aria-label={bulkLabel}
                      title={bulkLabel}
                      onChange={col.toggleAll}
                    />{' '}
                    <span className="ai-consent-feature-name">
                      {t(featureTitleKey(col.feature))}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.accountId} data-testid={`settings-ai-consent-row-${row.accountId}`}>
                <th scope="row" className="ai-consent-account-cell">
                  {labelById.get(row.accountId) ?? `#${row.accountId}`}
                </th>
                {row.cells.map(cell => {
                  const cellLabel = t('ai.settings.consentMatrix.cellLabel', {
                    feature: t(featureTitleKey(cell.feature)),
                    account: labelById.get(row.accountId) ?? `#${row.accountId}`,
                  })
                  return (
                    <td key={cell.feature} className="ai-consent-cell">
                      <input
                        type="checkbox"
                        data-testid={`settings-ai-consent-${cell.feature}-${row.accountId}`}
                        checked={cell.granted}
                        aria-label={cellLabel}
                        title={cellLabel}
                        onChange={e => cell.toggle(e.target.checked)}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <dl className="ai-consent-legend">
        {AI_CONSENT_FEATURES.map(feature => (
          <div key={feature} className="ai-consent-legend-item">
            <dt>{t(featureTitleKey(feature))}</dt>
            <dd className="section-hint">{t(featureHelpKey(feature))}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
