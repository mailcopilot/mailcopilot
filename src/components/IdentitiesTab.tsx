import { useCallback, useMemo, useState } from 'react'
import { Pencil, Trash2, Plus, CheckCircle2, Star } from 'lucide-react'
import type { Identity } from '@mailcopilot/types'

/**
 * Plain draft shape used while a row is being edited/added. We deliberately
 * keep `id` optional because freshly-added entries get their UUID on persist
 * (server-side `normalizeIdentities` fills missing ids). The `isDefault` flag
 * is mutable from this UI too — the "Set as default" action rewrites it
 * across all rows.
 */
export type IdentityDraft = {
  id?: string
  displayName: string
  email: string
  signature?: string
  defaultBcc?: string
  isDefault: boolean
}

export type IdentitiesTabLabels = {
  tabLabel: string
  empty: string
  add: string
  edit: string
  delete: string
  setDefault: string
  defaultBadge: string
  displayNameLabel: string
  emailLabel: string
  signatureLabel: string
  defaultBccLabel: string
  cancel: string
  save: string
}

export type IdentitiesTabProps = {
  identities: readonly Identity[]
  /**
   * Called when the user has produced a new identities list through any
   * action (add / edit / delete / set-default). Parent is responsible for
   * persisting via `accounts:save` and surfacing errors.
   */
  onChange: (next: IdentityDraft[]) => void
  labels: IdentitiesTabLabels
  disabled?: boolean
}

type EditorState =
  | { kind: 'closed' }
  | { kind: 'add'; draft: IdentityDraft }
  | { kind: 'edit'; index: number; draft: IdentityDraft }

function makeBlankDraft(defaultBeingFirst: boolean): IdentityDraft {
  return {
    displayName: '',
    email: '',
    signature: undefined,
    defaultBcc: undefined,
    isDefault: defaultBeingFirst,
  }
}

function toDraft(ident: Identity): IdentityDraft {
  return {
    id: ident.id,
    displayName: ident.displayName,
    email: ident.email,
    signature: ident.signature,
    defaultBcc: ident.defaultBcc,
    isDefault: ident.isDefault,
  }
}

/**
 * Identities management UI for Settings. Supports:
 *   - Listing identities with a "default" badge.
 *   - Adding a new identity via inline editor.
 *   - Editing an existing identity.
 *   - Deleting a non-default identity.
 *   - Promoting an identity to default (demotes the previous default).
 *
 * Kept intentionally self-contained (no `window.api` calls) so the parent
 * Settings screen controls persistence and can show a save error banner
 * without forking the component state.
 */
export default function IdentitiesTab(props: IdentitiesTabProps) {
  const { identities, onChange, labels, disabled } = props
  const [editor, setEditor] = useState<EditorState>({ kind: 'closed' })

  const hasAny = identities.length > 0

  const openAdd = useCallback(() => {
    // New identity becomes default automatically when the list is empty —
    // identities[] is never empty after server-side normalization, so the
    // checkbox flips on only when the user is seeding an account.
    setEditor({ kind: 'add', draft: makeBlankDraft(!hasAny) })
  }, [hasAny])

  const openEdit = useCallback((index: number) => {
    const ident = identities[index]
    if (!ident) return
    setEditor({ kind: 'edit', index, draft: toDraft(ident) })
  }, [identities])

  const closeEditor = useCallback(() => setEditor({ kind: 'closed' }), [])

  const commit = useCallback((nextList: IdentityDraft[]) => {
    onChange(nextList)
    setEditor({ kind: 'closed' })
  }, [onChange])

  const saveDraft = useCallback(() => {
    if (editor.kind === 'closed') return
    const draft = editor.draft
    const displayName = draft.displayName.trim()
    const email = draft.email.trim()
    if (!displayName || !email) return

    // Signature: preserve the exact value the user left in the textarea so
    // the save-path can distinguish "user cleared the field" (explicit empty
    // string — travels through to saveAccount as a clear signal) from "never
    // had a signature" (undefined, set by `makeBlankDraft`). Normalizing '' to
    // undefined here silently drops user clear intent; see
    // `packages/net/config.ts` saveAccount + `buildAccountSavePayloadPatch`.
    //
    // Default Bcc mirrors the same contract for symmetry — an empty string is
    // a deliberate clear, not a normalization artifact.
    const cleaned: IdentityDraft = {
      id: draft.id,
      displayName,
      email,
      signature: draft.signature,
      defaultBcc: draft.defaultBcc,
      isDefault: draft.isDefault,
    }

    const list: IdentityDraft[] = identities.map(toDraft)
    if (editor.kind === 'add') {
      if (cleaned.isDefault) {
        list.forEach(i => { i.isDefault = false })
      }
      list.push(cleaned)
      // Seed: if no explicit default exists after append, promote first.
      if (!list.some(i => i.isDefault) && list.length > 0) list[0].isDefault = true
    } else {
      const next = [...list]
      if (cleaned.isDefault) {
        next.forEach(i => { i.isDefault = false })
      }
      next[editor.index] = cleaned
      if (!next.some(i => i.isDefault) && next.length > 0) next[0].isDefault = true
      commit(next)
      return
    }
    commit(list)
  }, [editor, identities, commit])

  const deleteRow = useCallback((index: number) => {
    const target = identities[index]
    if (!target) return
    if (target.isDefault) return // Guarded by disabled UI, but defensive.
    const next = identities.filter((_, i) => i !== index).map(toDraft)
    onChange(next)
  }, [identities, onChange])

  const promoteDefault = useCallback((index: number) => {
    const target = identities[index]
    if (!target || target.isDefault) return
    const next = identities.map((ident, i) => ({
      ...toDraft(ident),
      isDefault: i === index,
    }))
    onChange(next)
  }, [identities, onChange])

  const activeDraft = editor.kind === 'closed' ? null : editor.draft
  const setDraft = useCallback((patch: Partial<IdentityDraft>) => {
    setEditor(prev => {
      if (prev.kind === 'closed') return prev
      return { ...prev, draft: { ...prev.draft, ...patch } }
    })
  }, [])

  // When an account has a single identity, offering delete is a trap —
  // the invariant says at least one must exist. We disable both actions
  // in that case; the button's `title` can still explain why via caller labels.
  const canDelete = useMemo(() => identities.length > 1, [identities.length])

  return (
    <div className="identities-tab" data-testid="identities-tab">
      {!hasAny && <div className="form-status-inline">{labels.empty}</div>}
      {hasAny && (
        <ul className="identities-list" data-testid="identities-list">
          {identities.map((ident, index) => (
            <li key={ident.id} className="identities-row" data-testid={`identities-row-${index}`}>
              <div className="identities-row-info">
                <div className="identities-row-title">
                  <span className="identities-row-name">{ident.displayName}</span>
                  {ident.isDefault && (
                    <span className="identities-row-default" data-testid={`identities-default-badge-${index}`}>
                      <Star size={12} /> {labels.defaultBadge}
                    </span>
                  )}
                </div>
                <div className="identities-row-email">{ident.email}</div>
              </div>
              <div className="identities-row-actions">
                {!ident.isDefault && (
                  <button
                    type="button"
                    onClick={() => promoteDefault(index)}
                    title={labels.setDefault}
                    disabled={disabled}
                    data-testid={`identities-set-default-${index}`}
                  >
                    <CheckCircle2 size={14} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openEdit(index)}
                  title={labels.edit}
                  disabled={disabled}
                  data-testid={`identities-edit-${index}`}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => deleteRow(index)}
                  title={labels.delete}
                  disabled={disabled || ident.isDefault || !canDelete}
                  data-testid={`identities-delete-${index}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editor.kind === 'closed' && (
        <button
          type="button"
          className="btn-secondary"
          onClick={openAdd}
          disabled={disabled}
          data-testid="identities-add"
        >
          <Plus size={14} /> {labels.add}
        </button>
      )}

      {activeDraft && (
        <div className="identities-editor" data-testid="identities-editor">
          <label>
            <span>{labels.displayNameLabel}</span>
            <input
              type="text"
              value={activeDraft.displayName}
              onChange={e => setDraft({ displayName: e.target.value })}
              data-testid="identities-editor-displayName"
            />
          </label>
          <label>
            <span>{labels.emailLabel}</span>
            <input
              type="email"
              value={activeDraft.email}
              onChange={e => setDraft({ email: e.target.value })}
              data-testid="identities-editor-email"
            />
          </label>
          <label>
            <span>{labels.signatureLabel}</span>
            <textarea
              value={activeDraft.signature ?? ''}
              onChange={e => setDraft({ signature: e.target.value })}
              data-testid="identities-editor-signature"
              rows={3}
            />
          </label>
          <label>
            <span>{labels.defaultBccLabel}</span>
            <input
              type="text"
              value={activeDraft.defaultBcc ?? ''}
              onChange={e => setDraft({ defaultBcc: e.target.value })}
              data-testid="identities-editor-defaultBcc"
            />
          </label>
          <label className="identities-editor-default-toggle">
            <input
              type="checkbox"
              checked={activeDraft.isDefault}
              onChange={e => setDraft({ isDefault: e.target.checked })}
              // Disallow un-checking default when this row IS currently the only default;
              // server invariant requires exactly one default.
              disabled={
                activeDraft.isDefault &&
                identities.filter(i => i.isDefault && i.id !== activeDraft.id).length === 0 &&
                identities.length > 0
              }
              data-testid="identities-editor-isDefault"
            />
            <span>{labels.setDefault}</span>
          </label>
          <div className="identities-editor-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={saveDraft}
              disabled={disabled || !activeDraft.displayName.trim() || !activeDraft.email.trim()}
              data-testid="identities-editor-save"
            >
              {labels.save}
            </button>
            <button
              type="button"
              onClick={closeEditor}
              disabled={disabled}
              data-testid="identities-editor-cancel"
            >
              {labels.cancel}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
