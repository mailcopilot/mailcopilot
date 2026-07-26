import type { Identity } from '@mailcopilot/types'
import type { IdentityDraft } from '../components/IdentitiesTab'

/**
 * Inputs consumed by {@link buildAccountSavePayloadPatch} — only the fields
 * relevant to the signature / identities clear-flow. The caller supplies the
 * rest of the payload (ids, imap, smtp, folderRoles) as-is; this helper only
 * decides which of the *signature-adjacent* fields to emit.
 *
 * Naming note: we intentionally mirror the UI's state names (`signature`,
 * `identities`, `identitiesDirty`) rather than the save schema's field names
 * so the call site in Settings.save() stays a literal `{ signature, identities,
 * identitiesDirty }` pass-through.
 */
export type AccountSavePayloadInput = {
  /** Current value of the legacy Signature tab textarea (renderer state). */
  signature: string
  /** Identity list from the Identities tab (after {@link IdentitiesTab} edits). */
  identities: readonly Identity[]
  /**
   * True when the user has touched the Identities tab during this Settings
   * session. Determines whether identities[] is the source of truth for the
   * default identity's signature, or whether the legacy top-level `signature`
   * field is the only thing the save-path should consult.
   */
  identitiesDirty: boolean
}

/**
 * Signature-adjacent fragment of the `accounts:save` payload. Callers spread
 * this onto the rest of the payload (id, imap, smtp, folderRoles, etc.).
 */
export type AccountSavePayloadPatch = {
  /**
   * Legacy top-level signature. Emitted ONLY when identities[] is not being
   * submitted in the same save — otherwise the save-path (see
   * `packages/net/config.ts` saveAccount wave-2 fix) has two conflicting
   * sources for the default identity's signature:
   *   1. identity[].signature from identities[]
   *   2. this legacy top-level field
   * Emitting both lets stale legacy state resurrect a signature the user
   * just cleared via the Identities tab.
   *
   * When emitted, empty string is honoured as "user cleared the Signature
   * tab" — NOT normalized to undefined. saveAccount distinguishes "cleared"
   * (`''`) from "keep existing" (`undefined`); collapsing the former to the
   * latter silently drops clear actions.
   */
  signature?: string
  /**
   * Identities array, emitted ONLY when the user has touched the Identities
   * tab this session. Sending a stale list on every save would either rewrite
   * server-assigned ids or drop aliases added elsewhere.
   *
   * Every row is emitted verbatim: empty-string `signature` / `defaultBcc`
   * values travel through as explicit clears; `undefined` means "this
   * identity had no signature to begin with".
   */
  identities?: AccountSaveIdentity[]
}

/** Shape of an identity row in the save payload (id optional for new rows). */
export type AccountSaveIdentity = {
  id?: string
  displayName: string
  email: string
  signature?: string
  defaultBcc?: string
  isDefault: boolean
}

/**
 * Decides which of {@link AccountSavePayloadInput.signature} /
 * {@link AccountSavePayloadInput.identities} to include in the `accounts:save`
 * payload.
 *
 * Contract (see Settings.tsx save() call site and
 * `packages/net/config.ts` saveAccount):
 *   - When `identitiesDirty` is true, identities[] is the sole source of
 *     truth for the default identity's signature. The legacy top-level
 *     `signature` MUST be omitted — otherwise saveAccount's backward-compat
 *     mirror falls back to it and resurrects the value the user just cleared
 *     via the Identities tab.
 *   - When `identitiesDirty` is false, only the legacy Signature tab was
 *     touched (or nothing at all). Emit the Signature tab value verbatim,
 *     including empty string on clear. Do NOT collapse `''` to `undefined` —
 *     saveAccount uses that exact distinction to tell "clear" from "no-op".
 *
 * Both branches produce a patch object spreadable onto the rest of the
 * `accounts:save` payload; the caller supplies id/name/imap/smtp/folderRoles.
 */
export function buildAccountSavePayloadPatch(
  input: AccountSavePayloadInput,
): AccountSavePayloadPatch {
  const { signature, identities, identitiesDirty } = input
  if (identitiesDirty) {
    return {
      identities: identities.map(toSaveIdentity),
      // Intentionally no `signature:` key — identities[] is the only input
      // saveAccount should consult in this branch.
    }
  }
  // Legacy-only branch: pass Signature tab value through verbatim. Empty
  // string is a deliberate clear signal, not a normalization artifact.
  return { signature }
}

/**
 * Avatar-save-specific payload helper. Avatar controls can target any account
 * in the sidebar, but the Identities / Signature editor state only tracks the
 * currently selected account (`editorAccountId`). This wrapper decides whether
 * the editor state applies to the account being saved.
 *
 * Contract:
 *   - When `targetAccountId === editorAccountId` (we're saving the account
 *     whose identities/signature the user is actively editing), delegate to
 *     {@link buildAccountSavePayloadPatch} with the live editor state. Dirty
 *     identities piggy-back on the avatar save so they aren't wiped by the
 *     subsequent `accounts:changed` broadcast.
 *   - When the user is editing a different account (or no account), pass the
 *     saved account's legacy signature through verbatim. Touching
 *     identities[] for an account whose editor state we don't have would
 *     either drop aliases or corrupt them.
 *
 * Returned shape matches {@link buildAccountSavePayloadPatch} exactly — the
 * caller spreads it onto the save payload.
 */
export function buildAvatarSavePayloadPatch(input: {
  targetAccountId: number
  editorAccountId: number | null
  savedAccountSignature: string | undefined
  editorSignature: string
  editorIdentities: readonly Identity[]
  editorIdentitiesDirty: boolean
}): AccountSavePayloadPatch {
  const {
    targetAccountId,
    editorAccountId,
    savedAccountSignature,
    editorSignature,
    editorIdentities,
    editorIdentitiesDirty,
  } = input
  if (editorAccountId !== targetAccountId) {
    // Different account — emit only the legacy signature from the saved
    // account meta. Fall back to '' rather than undefined so saveAccount
    // treats "meta has no signature" as an explicit clear (consistent with
    // pre-wave-4 behaviour which always emitted `acc.signature`).
    return { signature: savedAccountSignature ?? '' }
  }
  // Same account — reuse the main-save helper. This ensures avatar saves and
  // the main Save button emit identical shapes for the signature/identities
  // fragment, so there's only one contract to reason about.
  return buildAccountSavePayloadPatch({
    signature: editorSignature,
    identities: editorIdentities,
    identitiesDirty: editorIdentitiesDirty,
  })
}

/**
 * Converts an {@link Identity} (server-shaped, id is required) or
 * {@link IdentityDraft} (UI-shaped, id optional for freshly-added rows) into
 * the save-payload shape. Empty-string signature / defaultBcc survive the
 * round-trip so the save-path can distinguish "clear" from "absent".
 */
export function toSaveIdentity(
  identity: Identity | IdentityDraft,
): AccountSaveIdentity {
  const id = identity.id && identity.id.length > 0 ? identity.id : undefined
  return {
    id,
    displayName: identity.displayName,
    email: identity.email,
    signature: identity.signature,
    defaultBcc: identity.defaultBcc,
    isDefault: identity.isDefault,
  }
}
