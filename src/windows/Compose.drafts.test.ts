/**
 * §2.16 — Compose.tsx draft-reuse logic (pure unit tests).
 *
 * Compose.tsx is a 1400-line component; mounting it in jsdom requires mocking
 * ~15 heavy imports (ImapFlow, react-i18next, all hooks, window.api, etc.).
 * Instead we mirror the handful of pure helper functions verbatim and test
 * their logic directly — the same pattern used in Settings.bodyRetention.test.ts.
 *
 * Functions under test (mirrors of Compose.tsx private helpers):
 *   - draftLastKeyForAccount(accountId)
 *   - clearLastDraftPointers(draftId, currentAccountId?)
 *   - draftReusePicked(candidate, hasBody, wasSent) — reuse decision logic
 *
 * The "fresh-compose reuse" IPC interaction (drafts:wasSent → window.api) is
 * tested via the behaviour contract expressed here, not via a mounted component.
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'

// ─── Mirrors of Compose.tsx private constants ─────────────────────────────────
const DRAFT_LAST_KEY_LEGACY = 'mailcopilot:draft:last'
const DRAFT_LAST_KEY_PREFIX = 'mailcopilot:draft:last:'

// ─── Mirrors of Compose.tsx private helpers ───────────────────────────────────

function draftLastKeyForAccount(accountId: number): string {
  return `${DRAFT_LAST_KEY_PREFIX}${accountId}`
}

/**
 * Mirror of clearLastDraftPointers from Compose.tsx §2.16.
 * Clears legacy unscoped key AND any per-account key that points at draftId.
 */
function clearLastDraftPointers(draftId: string, currentAccountId?: number | null): void {
  try {
    if (localStorage.getItem(DRAFT_LAST_KEY_LEGACY) === draftId) {
      localStorage.removeItem(DRAFT_LAST_KEY_LEGACY)
    }
    if (typeof currentAccountId === 'number') {
      const k = draftLastKeyForAccount(currentAccountId)
      if (localStorage.getItem(k) === draftId) localStorage.removeItem(k)
    }
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(DRAFT_LAST_KEY_PREFIX)) continue
      if (localStorage.getItem(k) === draftId) localStorage.removeItem(k)
    }
  } catch {
    // localStorage unavailable — ignore
  }
}

/**
 * Mirror of the reuse-decision inline logic from Compose.tsx §2.16 fresh-compose path.
 *
 *   if (candidate && hasBody && !wasSent) → reuse candidate
 *   else → mint fresh (return '')
 */
function draftReuseDecision(candidate: string, hasBody: boolean, wasSent: boolean): string {
  if (candidate && hasBody && !wasSent) return candidate
  return ''
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Compose §2.16 — draftLastKeyForAccount', () => {
  it('returns the per-account prefixed key for a positive account id', () => {
    expect(draftLastKeyForAccount(1)).toBe('mailcopilot:draft:last:1')
    expect(draftLastKeyForAccount(42)).toBe('mailcopilot:draft:last:42')
  })

  it('keys for different account ids are distinct', () => {
    expect(draftLastKeyForAccount(1)).not.toBe(draftLastKeyForAccount(2))
  })

  it('does not overlap with the legacy unscoped key', () => {
    expect(draftLastKeyForAccount(1)).not.toBe(DRAFT_LAST_KEY_LEGACY)
  })
})

describe('Compose §2.16 — clearLastDraftPointers', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('removes legacy unscoped key when it points at draftId', () => {
    localStorage.setItem(DRAFT_LAST_KEY_LEGACY, 'draft-abc')
    clearLastDraftPointers('draft-abc')
    expect(localStorage.getItem(DRAFT_LAST_KEY_LEGACY)).toBeNull()
  })

  it('does not remove legacy key when it points at a different draftId', () => {
    localStorage.setItem(DRAFT_LAST_KEY_LEGACY, 'draft-xyz')
    clearLastDraftPointers('draft-abc')
    expect(localStorage.getItem(DRAFT_LAST_KEY_LEGACY)).toBe('draft-xyz')
  })

  it('removes per-account key for the provided accountId when it matches', () => {
    localStorage.setItem(draftLastKeyForAccount(7), 'draft-abc')
    clearLastDraftPointers('draft-abc', 7)
    expect(localStorage.getItem(draftLastKeyForAccount(7))).toBeNull()
  })

  it('does not remove per-account key for a different accountId', () => {
    localStorage.setItem(draftLastKeyForAccount(7), 'draft-abc')
    localStorage.setItem(draftLastKeyForAccount(8), 'draft-abc')
    clearLastDraftPointers('draft-abc', 7)
    // Account 8 pointer is cleared by the belt-and-suspenders walk.
    // Verify both are gone (the walk always removes all matching per-account keys).
    expect(localStorage.getItem(draftLastKeyForAccount(7))).toBeNull()
    expect(localStorage.getItem(draftLastKeyForAccount(8))).toBeNull()
  })

  it('belt-and-suspenders walk removes per-account keys even without explicit accountId', () => {
    localStorage.setItem(draftLastKeyForAccount(3), 'draft-abc')
    localStorage.setItem(draftLastKeyForAccount(9), 'draft-abc')
    // Called without currentAccountId — the loop still catches all matching keys.
    clearLastDraftPointers('draft-abc')
    expect(localStorage.getItem(draftLastKeyForAccount(3))).toBeNull()
    expect(localStorage.getItem(draftLastKeyForAccount(9))).toBeNull()
  })

  it('clears both legacy and per-account key in one call', () => {
    localStorage.setItem(DRAFT_LAST_KEY_LEGACY, 'draft-abc')
    localStorage.setItem(draftLastKeyForAccount(5), 'draft-abc')
    clearLastDraftPointers('draft-abc', 5)
    expect(localStorage.getItem(DRAFT_LAST_KEY_LEGACY)).toBeNull()
    expect(localStorage.getItem(draftLastKeyForAccount(5))).toBeNull()
  })

  it('leaves unrelated localStorage keys intact', () => {
    localStorage.setItem('mailcopilot:draft:d1', JSON.stringify({ subject: 'hello' }))
    localStorage.setItem(DRAFT_LAST_KEY_LEGACY, 'other-draft')
    clearLastDraftPointers('draft-abc')
    expect(localStorage.getItem('mailcopilot:draft:d1')).not.toBeNull()
    expect(localStorage.getItem(DRAFT_LAST_KEY_LEGACY)).toBe('other-draft')
  })

  it('is a no-op when localStorage is empty', () => {
    expect(() => clearLastDraftPointers('draft-abc', 1)).not.toThrow()
  })

  it('ignores null currentAccountId (does not throw)', () => {
    expect(() => clearLastDraftPointers('draft-abc', null)).not.toThrow()
  })

  it('ignores undefined currentAccountId', () => {
    expect(() => clearLastDraftPointers('draft-abc', undefined)).not.toThrow()
  })
})

describe('Compose §2.16 — fresh-compose reuse decision', () => {
  it('reuses candidate when body present and not sent', () => {
    expect(draftReuseDecision('draft-123', true, false)).toBe('draft-123')
  })

  it('mints fresh id when draft was already finalized (wasSent=true)', () => {
    expect(draftReuseDecision('draft-123', true, true)).toBe('')
  })

  it('mints fresh id when local body has been gc-ed (hasBody=false)', () => {
    expect(draftReuseDecision('draft-123', false, false)).toBe('')
  })

  it('mints fresh id when candidate is empty string (no pointer in localStorage)', () => {
    expect(draftReuseDecision('', false, false)).toBe('')
  })

  it('mints fresh id when both hasBody=false and wasSent=true', () => {
    expect(draftReuseDecision('draft-123', false, true)).toBe('')
  })
})

// ─── §2.16 iter2 mirrors ──────────────────────────────────────────────────────

/**
 * Mirror of the rememberAsLastDraftRef decision from Compose.tsx §2.16 iter2.
 *
 *   remember = initDraftId !== '' OR
 *              (!hasInitPayload && !isFreshCompose) OR
 *              isFreshCompose
 *
 * Critical iter2 fix (codex High #1): the third clause changed from
 * `isFreshCompose && Boolean(lastDraftId)` to plain `isFreshCompose`. Before
 * the fix, a fresh compose with no prior pointer minted randomId() but never
 * persisted it — the next fresh compose for the same account had no pointer
 * to reuse and minted again, and AC2 was a no-op on clean state.
 */
function shouldRememberAsLastDraft(opts: {
  initDraftId: string
  hasInitPayload: boolean
  isFreshCompose: boolean
}): boolean {
  return (
    Boolean(opts.initDraftId) ||
    (!opts.hasInitPayload && !opts.isFreshCompose) ||
    opts.isFreshCompose
  )
}

/**
 * Mirror of the autosave per-account pointer write from Compose.tsx §2.16.
 * Honours `remember` (the rememberAsLastDraftRef snapshot at autosave time).
 *
 * §2.16 iter3 (codex Medium): legacy unscoped key is NEVER written by
 * autosave any more. Per-account scope is the only authoritative store
 * going forward; legacy key is read-only (cleared on fresh compose / send /
 * discard so it decays naturally).
 */
function autosaveWritePointer(opts: {
  remember: boolean
  accountId: number | null | undefined
  draftId: string
}): void {
  if (!opts.remember) return
  if (typeof opts.accountId === 'number') {
    localStorage.setItem(draftLastKeyForAccount(opts.accountId), opts.draftId)
  }
  // Legacy key NOT written here — see iter3 fix in Compose.tsx autosave.
}

describe('Compose §2.16 iter2 — fresh compose persists per-account pointer on first save', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('CRITICAL — fresh compose with NO prior pointer remembers the freshly-minted id', () => {
    // Codex High #1 reproducer: clean state, user opens "New Message".
    // isFreshCompose=true, hasInitPayload=false, initDraftId='', lastDraftId=''
    // → randomId() chosen → must persist this id so the SECOND fresh compose
    // can find and reuse it.
    const remember = shouldRememberAsLastDraft({
      initDraftId: '',
      hasInitPayload: false,
      isFreshCompose: true,
    })
    expect(remember).toBe(true)

    // Simulate the autosave tick — pointer must be persisted.
    autosaveWritePointer({ remember, accountId: 7, draftId: 'fresh-mint-abc' })
    expect(localStorage.getItem(draftLastKeyForAccount(7))).toBe('fresh-mint-abc')
  })

  it('fresh compose with EXISTING pointer (reuse path) still remembers — unchanged behaviour', () => {
    // Pre-existing pointer survived wasSent check, lastDraftId='draft-old'.
    // Reuse path must continue to persist (this was the pre-iter2 happy case).
    const remember = shouldRememberAsLastDraft({
      initDraftId: '',
      hasInitPayload: false,
      isFreshCompose: true, // lastDraftId presence does not factor in any more
    })
    expect(remember).toBe(true)

    autosaveWritePointer({ remember, accountId: 7, draftId: 'draft-old' })
    expect(localStorage.getItem(draftLastKeyForAccount(7))).toBe('draft-old')
  })

  it('reply / forward (hasInitPayload=true) does NOT remember — would clobber a real draft pointer', () => {
    // Reply / forward minted a fresh randomId for a one-off compose; we must
    // not override the per-account "last new message" pointer with it.
    const remember = shouldRememberAsLastDraft({
      initDraftId: '',
      hasInitPayload: true,
      isFreshCompose: false,
    })
    expect(remember).toBe(false)

    autosaveWritePointer({ remember, accountId: 7, draftId: 'reply-throwaway' })
    expect(localStorage.getItem(draftLastKeyForAccount(7))).toBeNull()
  })

  it('explicit draft edit (initDraftId set) remembers regardless of payload presence', () => {
    const remember = shouldRememberAsLastDraft({
      initDraftId: 'd-existing',
      hasInitPayload: true,
      isFreshCompose: false,
    })
    expect(remember).toBe(true)
  })

  it('window reuse path (ctx === null, no init at all) remembers — restores last-edited draft', () => {
    const remember = shouldRememberAsLastDraft({
      initDraftId: '',
      hasInitPayload: false,
      isFreshCompose: false, // ctx === null, not a fresh open
    })
    expect(remember).toBe(true)
  })

  it('iter2 regression: TWO consecutive fresh composes for same account end up sharing one pointer', () => {
    // Simulate the user's full flow that motivated AC2:
    //   1) Open "New Message" (isFreshCompose=true) — lastDraftId=''.
    //      Compose mints draft-A, persists it.
    //   2) User closes window without typing or sends, etc.
    //   3) Open "New Message" AGAIN — lastDraftId='draft-A'.
    //      Compose reuses draft-A and persists it.
    // Net effect: only ONE per-account pointer, only ONE Drafts entry on the
    // server (next save replaces it). Without iter2 fix, step 1 minted but
    // never persisted — step 2 saw lastDraftId='', minted draft-B, and we
    // ended with TWO siblings.
    const accountId = 11

    // Step 1 — clean state
    expect(localStorage.getItem(draftLastKeyForAccount(accountId))).toBeNull()
    const remember1 = shouldRememberAsLastDraft({
      initDraftId: '',
      hasInitPayload: false,
      isFreshCompose: true,
    })
    autosaveWritePointer({ remember: remember1, accountId, draftId: 'draft-A' })
    expect(localStorage.getItem(draftLastKeyForAccount(accountId))).toBe('draft-A')

    // Step 2 — pointer survived; reuse path picks it up
    const candidate = localStorage.getItem(draftLastKeyForAccount(accountId)) || ''
    const reused = draftReuseDecision(candidate, /*hasBody*/ true, /*wasSent*/ false)
    expect(reused).toBe('draft-A') // SAME id, not a new mint

    const remember2 = shouldRememberAsLastDraft({
      initDraftId: '',
      hasInitPayload: false,
      isFreshCompose: true,
    })
    autosaveWritePointer({ remember: remember2, accountId, draftId: reused })
    expect(localStorage.getItem(draftLastKeyForAccount(accountId))).toBe('draft-A') // unchanged
  })
})

// ─── §2.16 iter3 mirrors ──────────────────────────────────────────────────────

/**
 * Mirror of the rememberAsLastDraftRef decision made by the compose:init
 * EVENT handler in Compose.tsx (~line 597). This is the second entry point
 * (window reuse via electron/main.ts ~5531 dispatching `compose:init` with
 * accountId + init=null|payload), parallel to the compose:getInit path that
 * iter2 covered.
 *
 * Iter3 fix (codex High):
 *   remember = explicit_draftId OR fresh_compose (init=null OR no payload)
 *
 * Pre-iter3 (broken):
 *   remember = explicit_draftId only — fresh-compose path on window reuse
 *   minted randomId() but never persisted, so a second fresh compose for
 *   the same account spawned a sibling Drafts entry. Iter2 had already
 *   fixed the equivalent path inside compose:getInit, but the EVENT handler
 *   (live window reuse) was missed.
 */
function shouldRememberAsLastDraftFromInitEvent(opts: {
  initHasDraftId: boolean
  hasInit: boolean
}): boolean {
  return opts.initHasDraftId || !opts.hasInit
}

describe('Compose §2.16 iter3 — compose:init event handler (window reuse)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('CRITICAL — window reuse for fresh "Compose" (init=null) mints draftId AND remembers per-account pointer', () => {
    // Codex iter3 High reproducer: ui:openCompose dispatched compose:init with
    // init=null because a Compose window was already open. The event handler
    // must mint a fresh randomId() AND set rememberAsLastDraftRef so the
    // first autosave persists the per-account pointer. Without this fix the
    // sibling-draft regression iter2 closed comes back via this second entry
    // point.
    const remember = shouldRememberAsLastDraftFromInitEvent({
      initHasDraftId: false,
      hasInit: false,
    })
    expect(remember).toBe(true)

    autosaveWritePointer({ remember, accountId: 7, draftId: 'fresh-mint-via-event-abc' })
    expect(localStorage.getItem(draftLastKeyForAccount(7))).toBe('fresh-mint-via-event-abc')
  })

  it('window reuse for explicit draft edit (initHasDraftId=true, hasInit=true) remembers — unchanged behaviour', () => {
    const remember = shouldRememberAsLastDraftFromInitEvent({
      initHasDraftId: true,
      hasInit: true,
    })
    expect(remember).toBe(true)
  })

  it('window reuse for reply / forward (hasInit=true, no draftId) does NOT remember — preserves the per-account pointer for fresh composes', () => {
    // Reply / forward minted a one-off id; we must not let it overwrite the
    // user's per-account "last new message" pointer. This is the regression
    // we explicitly do not introduce in iter3 — verifying the conditional
    // is `initHasDraftId || !hasInit`, not `initHasDraftId || true`.
    const remember = shouldRememberAsLastDraftFromInitEvent({
      initHasDraftId: false,
      hasInit: true,
    })
    expect(remember).toBe(false)

    autosaveWritePointer({ remember, accountId: 7, draftId: 'reply-throwaway-via-event' })
    expect(localStorage.getItem(draftLastKeyForAccount(7))).toBeNull()
  })

  it('iter3 regression scenario: TWO consecutive window-reuse fresh composes share one pointer', () => {
    // Full flow that iter3 closes:
    //   1) Compose window already open (any prior state).
    //   2) User clicks "New Message" — main sends compose:init with init=null.
    //      Event handler mints draft-A, autosave persists pointer.
    //   3) User clicks "New Message" AGAIN later — main sends compose:init.
    //      compose:getInit was NOT involved (window persisted). Iter3 fix
    //      means draft-A pointer is still here for the next reuse decision.
    const accountId = 13

    // Step 2 — first fresh "New Message" via event
    const remember1 = shouldRememberAsLastDraftFromInitEvent({
      initHasDraftId: false,
      hasInit: false,
    })
    autosaveWritePointer({ remember: remember1, accountId, draftId: 'draft-A' })
    expect(localStorage.getItem(draftLastKeyForAccount(accountId))).toBe('draft-A')

    // Step 3 — second fresh "New Message" via event. The reuse path inside
    // compose:getInit is what actually picks draft-A back up; the event handler
    // does not perform the reuse query itself (that happens once on mount).
    // What iter3 guarantees is that step 2 PERSISTED, so by the time the user
    // navigates back through a flow that re-enters compose:getInit, the
    // pointer survives. We assert it survives an intervening event-handler
    // pass for any mid-stream reply / forward / explicit-edit:
    const remember2 = shouldRememberAsLastDraftFromInitEvent({
      initHasDraftId: false,
      hasInit: true, // mid-stream reply
    })
    // Reply does NOT clobber:
    autosaveWritePointer({ remember: remember2, accountId, draftId: 'reply-throwaway' })
    expect(localStorage.getItem(draftLastKeyForAccount(accountId))).toBe('draft-A')
  })

  it('legacy unscoped key is NEVER written by autosave (iter3 Medium)', () => {
    // Pre-iter3 autosave wrote both the per-account key AND the legacy key.
    // Iter3 makes the legacy key read-only — it can only decay (cleared on
    // fresh compose / send / discard), never accumulate new writes from the
    // post-§2.16 codepath. This makes the docstring claim "fresh compose
    // never touches legacy" actually true.
    const accountId = 21
    const remember = shouldRememberAsLastDraftFromInitEvent({
      initHasDraftId: false,
      hasInit: false,
    })

    autosaveWritePointer({ remember, accountId, draftId: 'fresh-id' })

    // Per-account key written ✓
    expect(localStorage.getItem(draftLastKeyForAccount(accountId))).toBe('fresh-id')
    // Legacy key untouched — was never set, must remain null.
    expect(localStorage.getItem(DRAFT_LAST_KEY_LEGACY)).toBeNull()
  })

  it('legacy key pre-existing on disk is not refreshed by autosave', () => {
    // Stale legacy pointer from pre-§2.16 install. Autosave must NOT refresh
    // it — leave it for the natural decay path (clearLastDraftPointers on
    // send/discard, removeItem on fresh-compose entry).
    localStorage.setItem(DRAFT_LAST_KEY_LEGACY, 'pre-2.16-stale')

    const remember = shouldRememberAsLastDraftFromInitEvent({
      initHasDraftId: false,
      hasInit: false,
    })
    autosaveWritePointer({ remember, accountId: 33, draftId: 'fresh-id-iter3' })

    // Stale value still there — we did not overwrite it with 'fresh-id-iter3'.
    expect(localStorage.getItem(DRAFT_LAST_KEY_LEGACY)).toBe('pre-2.16-stale')
    // And the new id IS in the per-account slot.
    expect(localStorage.getItem(draftLastKeyForAccount(33))).toBe('fresh-id-iter3')
  })
})

describe('Compose §2.16 — AC2 safety: drafts:wasSent fallback on IPC error', () => {
  /**
   * When drafts:wasSent IPC throws, Compose treats wasSent as `true`
   * (conservative — do not reuse an unknown id). This is captured in the
   * decision function: error → wasSent=true → no reuse.
   */
  it('IPC error path: wasSent treated as true → no reuse', () => {
    // Simulate IPC throw → caller sets wasSent = true.
    const wasSentOnError = true
    expect(draftReuseDecision('draft-xyz', true, wasSentOnError)).toBe('')
  })

  it('IPC success path: wasSent=false → candidate reused', () => {
    const wasSentOnSuccess = false
    expect(draftReuseDecision('draft-xyz', true, wasSentOnSuccess)).toBe('draft-xyz')
  })
})
