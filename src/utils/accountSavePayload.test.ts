import { describe, expect, it } from 'vitest'
import type { Identity } from '@mailcopilot/types'
import {
  buildAccountSavePayloadPatch,
  buildAvatarSavePayloadPatch,
  toSaveIdentity,
} from './accountSavePayload'

function makeIdentity(partial: Partial<Identity> & { id: string; email: string }): Identity {
  return {
    id: partial.id,
    displayName: partial.displayName ?? partial.email,
    email: partial.email,
    signature: partial.signature,
    defaultBcc: partial.defaultBcc,
    isDefault: partial.isDefault ?? false,
  }
}

describe('buildAccountSavePayloadPatch', () => {
  describe('when identities tab is dirty (identities[] is source of truth)', () => {
    it('emits identities[] and DOES NOT emit top-level signature', () => {
      const patch = buildAccountSavePayloadPatch({
        signature: 'stale Signature-tab state',
        identities: [makeIdentity({ id: 'x', email: 'a@b.c', signature: 'new sig', isDefault: true })],
        identitiesDirty: true,
      })
      expect(patch.identities).toBeDefined()
      expect(patch.identities).toHaveLength(1)
      expect(patch.identities?.[0]).toMatchObject({
        id: 'x',
        email: 'a@b.c',
        signature: 'new sig',
        isDefault: true,
      })
      // CRITICAL: no top-level signature. saveAccount's legacy mirror must
      // derive meta.signature ONLY from identities[] when identities[] is
      // present — leaking top-level signature here resurrects a cleared value.
      expect('signature' in patch).toBe(false)
    })

    it('preserves empty-string signature on an identity as an explicit clear', () => {
      const patch = buildAccountSavePayloadPatch({
        signature: 'ignored',
        identities: [
          makeIdentity({ id: 'x', email: 'a@b.c', signature: '', isDefault: true }),
        ],
        identitiesDirty: true,
      })
      expect(patch.identities?.[0].signature).toBe('')
    })

    it('preserves undefined signature on an identity (no-signature case)', () => {
      const patch = buildAccountSavePayloadPatch({
        signature: 'ignored',
        identities: [
          makeIdentity({ id: 'x', email: 'a@b.c', signature: undefined, isDefault: true }),
        ],
        identitiesDirty: true,
      })
      expect(patch.identities?.[0].signature).toBeUndefined()
    })

    it('emits empty identities[] when dirty but list is empty (edge case)', () => {
      const patch = buildAccountSavePayloadPatch({
        signature: 'ignored',
        identities: [],
        identitiesDirty: true,
      })
      expect(patch.identities).toEqual([])
      expect('signature' in patch).toBe(false)
    })
  })

  describe('when identities tab is clean (legacy Signature tab path)', () => {
    it('emits top-level signature verbatim and DOES NOT emit identities[]', () => {
      const patch = buildAccountSavePayloadPatch({
        signature: 'my signature',
        identities: [makeIdentity({ id: 'x', email: 'a@b.c', isDefault: true })],
        identitiesDirty: false,
      })
      expect(patch.signature).toBe('my signature')
      expect('identities' in patch).toBe(false)
    })

    it('emits empty-string signature as an explicit clear (NOT collapsed to undefined)', () => {
      // The critical regression fixed by 2.3 wave 3: legacy code used
      // `signature || undefined` which silently drops the clear intent.
      const patch = buildAccountSavePayloadPatch({
        signature: '',
        identities: [makeIdentity({ id: 'x', email: 'a@b.c', isDefault: true })],
        identitiesDirty: false,
      })
      expect(patch.signature).toBe('')
      // saveAccount distinguishes '' (clear) from undefined (keep existing).
      expect(patch.signature).not.toBeUndefined()
      expect('identities' in patch).toBe(false)
    })

    it('emits whitespace-only signature verbatim (save-schema decides trim)', () => {
      const patch = buildAccountSavePayloadPatch({
        signature: '   ',
        identities: [],
        identitiesDirty: false,
      })
      expect(patch.signature).toBe('   ')
    })
  })
})

describe('buildAvatarSavePayloadPatch (2.3 wave 4)', () => {
  const baseIdentity = makeIdentity({
    id: 'uuid-1',
    email: 'default@acc.com',
    signature: 'editor-signature',
    isDefault: true,
  })

  describe('when saving the account that is currently being edited', () => {
    it('emits identities[] when identitiesDirty=true (preserves unsaved edits through avatar save)', () => {
      const patch = buildAvatarSavePayloadPatch({
        targetAccountId: 1,
        editorAccountId: 1,
        savedAccountSignature: 'stale-server-signature',
        editorSignature: 'editor-signature',
        editorIdentities: [baseIdentity],
        editorIdentitiesDirty: true,
      })
      expect(patch.identities).toBeDefined()
      expect(patch.identities).toHaveLength(1)
      expect(patch.identities?.[0]).toMatchObject({
        id: 'uuid-1',
        signature: 'editor-signature',
        isDefault: true,
      })
      // Legacy signature must be omitted — identities[] is the sole source
      // of truth when dirty, and emitting both lets the save-path's legacy
      // mirror resurrect whichever value is stale. Same contract as the
      // main Save button path.
      expect('signature' in patch).toBe(false)
    })

    it('preserves cleared identity signature as empty string (HIGH wave-3 contract)', () => {
      const patch = buildAvatarSavePayloadPatch({
        targetAccountId: 1,
        editorAccountId: 1,
        savedAccountSignature: 'stale-server-signature',
        editorSignature: '',
        editorIdentities: [
          makeIdentity({ id: 'uuid-1', email: 'a@b.c', signature: '', isDefault: true }),
        ],
        editorIdentitiesDirty: true,
      })
      expect(patch.identities?.[0].signature).toBe('')
      expect('signature' in patch).toBe(false)
    })

    it('falls back to legacy signature when identitiesDirty=false (payload shape matches pre-wave-4)', () => {
      // When the user hasn't touched the Identities tab, the avatar save
      // must keep behaving like the legacy code: pass the Signature tab
      // value (editorSignature) through as top-level `signature`, no
      // identities[]. This protects users who only use the classic
      // Signature tab — they get the same shape they had before.
      const patch = buildAvatarSavePayloadPatch({
        targetAccountId: 1,
        editorAccountId: 1,
        savedAccountSignature: 'stale-server-signature',
        editorSignature: 'my-signature',
        editorIdentities: [baseIdentity],
        editorIdentitiesDirty: false,
      })
      expect(patch.signature).toBe('my-signature')
      expect('identities' in patch).toBe(false)
    })

    it('passes empty-string editor signature through as explicit clear', () => {
      const patch = buildAvatarSavePayloadPatch({
        targetAccountId: 1,
        editorAccountId: 1,
        savedAccountSignature: 'stale-server-signature',
        editorSignature: '',
        editorIdentities: [baseIdentity],
        editorIdentitiesDirty: false,
      })
      expect(patch.signature).toBe('')
      expect('identities' in patch).toBe(false)
    })
  })

  describe('when saving a different account than the one being edited', () => {
    it('emits only the saved account signature — does NOT leak editor state into other accounts', () => {
      const patch = buildAvatarSavePayloadPatch({
        targetAccountId: 2, // sidebar avatar for account 2
        editorAccountId: 1, // editor tracks account 1
        savedAccountSignature: 'account-2-signature',
        editorSignature: 'account-1-editor-signature',
        editorIdentities: [
          makeIdentity({ id: 'uuid-acc1', email: 'a1@x.c', signature: 'acc1-dirty', isDefault: true }),
        ],
        editorIdentitiesDirty: true, // dirty — but for OTHER account
      })
      expect(patch.signature).toBe('account-2-signature')
      expect('identities' in patch).toBe(false)
    })

    it('falls back to empty string when saved account has no signature (no regression from pre-wave-4)', () => {
      const patch = buildAvatarSavePayloadPatch({
        targetAccountId: 2,
        editorAccountId: 1,
        savedAccountSignature: undefined,
        editorSignature: 'irrelevant',
        editorIdentities: [baseIdentity],
        editorIdentitiesDirty: false,
      })
      expect(patch.signature).toBe('')
      expect('identities' in patch).toBe(false)
    })

    it('preserves this contract even when no editor is bound (editorAccountId=null)', () => {
      // e.g. Settings window just opened and Identities tab not visited yet.
      const patch = buildAvatarSavePayloadPatch({
        targetAccountId: 2,
        editorAccountId: null,
        savedAccountSignature: 'account-2-signature',
        editorSignature: '',
        editorIdentities: [],
        editorIdentitiesDirty: false,
      })
      expect(patch.signature).toBe('account-2-signature')
      expect('identities' in patch).toBe(false)
    })
  })
})

describe('toSaveIdentity', () => {
  it('drops empty-string id (freshly added, server assigns UUID on persist)', () => {
    const out = toSaveIdentity({
      id: '',
      displayName: 'Alice',
      email: 'a@b.c',
      signature: 'sig',
      defaultBcc: undefined,
      isDefault: true,
    })
    expect(out.id).toBeUndefined()
    expect(out.displayName).toBe('Alice')
    expect(out.email).toBe('a@b.c')
    expect(out.signature).toBe('sig')
    expect(out.isDefault).toBe(true)
  })

  it('keeps non-empty id (edit of existing identity)', () => {
    const out = toSaveIdentity({
      id: 'uuid-123',
      displayName: 'Bob',
      email: 'b@x.c',
      signature: undefined,
      defaultBcc: 'ccc@x.c',
      isDefault: false,
    })
    expect(out.id).toBe('uuid-123')
    expect(out.defaultBcc).toBe('ccc@x.c')
    expect(out.signature).toBeUndefined()
  })

  it('preserves empty-string signature and defaultBcc as explicit clears', () => {
    // Matches IdentitiesTab wave-3 fix: empty textarea => '' (clear), not undefined.
    const out = toSaveIdentity({
      id: 'uuid-99',
      displayName: 'Carol',
      email: 'c@x.c',
      signature: '',
      defaultBcc: '',
      isDefault: true,
    })
    expect(out.signature).toBe('')
    expect(out.defaultBcc).toBe('')
  })
})
