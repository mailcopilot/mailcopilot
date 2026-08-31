import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import Select from './Select'
import { isMoveMissingFolder, type MailRuleActionDraft } from './mailRuleDrafts'

export interface RuleActionRowProps {
  action: MailRuleActionDraft
  onChange: (next: MailRuleActionDraft) => void
  onRemove: () => void
}

/** Action types the editor offers, in dropdown order. */
const ACTION_TYPES = [
  'move',
  'archive',
  'trash',
  'mark_read',
  'mark_starred',
  'mark_spam',
] as const

/**
 * One action row of the mail-rules editor: type / target folder / remove.
 *
 * The folder is required for `move` and the row says so at the field. A `move`
 * without one used to save quietly and then do nothing while the audit log
 * recorded it as applied; it is now refused on save as `malformed_rule`, and
 * that message — "the rule is not written in a form MailCopilot can apply" — is
 * true but useless to somebody looking straight at the empty box. Warning here
 * turns a post-hoc refusal into a visible prerequisite.
 *
 * Extracted out of Settings.tsx (CLAUDE.md §5 hotspot policy) for the same
 * reason RuleConditionRow was: the row now carries a rule of its own.
 */
export default function RuleActionRow({ action, onChange, onRemove }: RuleActionRowProps) {
  const { t } = useTranslation()
  const missingFolder = isMoveMissingFolder(action)

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <Select
          value={action.type}
          // A type change drops the folder with the old type: it belongs to
          // `move` alone, and carrying it over would hide a stale target behind
          // an action that never reads it.
          onChange={v => onChange({ type: v })}
          ariaLabel={t('settings.rules.actionType')}
          options={ACTION_TYPES.map(type => ({
            value: type,
            label: t(`settings.rules.action.${type}`),
          }))}
        />
        {action.type === 'move' && (
          <input
            type="text"
            placeholder={t('settings.rules.folderPlaceholder')}
            value={action.folder ?? ''}
            // Stored verbatim: a space is a legal character in an IMAP mailbox
            // name, so only the "is it empty" decision trims.
            onChange={e => onChange({ ...action, folder: e.target.value })}
            aria-invalid={missingFolder || undefined}
            style={{ flex: 1 }}
          />
        )}
        <button className="btn-icon" onClick={onRemove}>
          <X size={14} />
        </button>
      </div>
      {missingFolder && (
        <p
          className="hint"
          role="alert"
          data-testid="rule-move-folder-required"
          style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--danger, #ef4444)' }}
        >
          {t('settings.rules.moveFolderRequired')}
        </p>
      )}
    </div>
  )
}
