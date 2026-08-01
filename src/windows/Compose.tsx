import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Send, Loader2, Paperclip, X, FileText, Bell, Archive, ChevronDown, Clock, Calendar } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AccountMeta, ComposeAttachment, ComposeInit, FolderRoles, Identity } from '../../packages/net/types'
import { formatBytes } from '../utils/mail'
import { resolveFromEmailFromMeta } from '../utils/composeFromEmail'
import WindowTitlebar from '../components/WindowTitlebar'
import { useIdentitySelection } from '../hooks/useIdentitySelection'
import { useIdentityDefaultBcc } from '../hooks/useIdentityDefaultBcc'
import IdentityPicker from '../components/IdentityPicker'
import Select from '../components/Select'
import { ComposeQuickActions } from '../components/ComposeQuickActions'
import {
  defaultCustomScheduleValue,
  mondayMorning,
  nextHalfHour,
  parseDateTimeLocalValue,
  tomorrowMorning,
} from '../utils/schedule'
import { substituteVars } from '../utils/templateVars'
import { checkMisdirection, extractDomain, type Recipient } from '../utils/misdirection'
import { recordEvent, bucketBodySize, bucketFollowupDays as bucketFollowupDaysLocal } from '../utils/metrics'
import { captureException } from '../sentry'

type ComposeSourceTag = NonNullable<ComposeInit['source']>

/**
 * Derive the compose.opened source tag. Prefers the explicit `init.source`
 * set by the caller (reply / reply_all / forward / draft / mailto / template /
 * ai_chip) and falls back to structural heuristics only when no caller
 * bothered to set it — that path is limited to "fresh new compose" today.
 */
function composeSourceFromInit(init: ComposeInit | null, hasAnyContent: boolean): ComposeSourceTag {
  if (init?.source) return init.source
  if (!init) return 'new'
  if (typeof init.draftId === 'string' && init.draftId) return 'draft'
  if (init.replyRef) {
    const subj = typeof init.subject === 'string' ? init.subject.toLowerCase() : ''
    if (subj.startsWith('fwd:') || subj.startsWith('fw:')) return 'forward'
    return 'reply'
  }
  if (hasAnyContent) return 'mailto'
  return 'new'
}

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return String(Date.now()) + '-' + Math.random().toString(16).slice(2)
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function filesToAttachments(files: FileList): Promise<ComposeAttachment[]> {
  const items: ComposeAttachment[] = []
  for (const f of Array.from(files)) {
    const contentBase64 = arrayBufferToBase64(await f.arrayBuffer())
    items.push({ filename: f.name, contentType: f.type || undefined, contentBase64 })
  }
  return items
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // 25 MB
const DRAFT_PREFIX = 'mailcopilot:draft:'
// §2.16 — `DRAFT_LAST_KEY_LEGACY` is the pre-§2.16 unscoped key. We migrate
// readers/writers to per-account scoping (`draftLastKeyForAccount`) so two
// accounts can each have their own "reuse-last-draft" memory without
// stepping on each other.
//
// §2.16 iter3 (codex Medium): the legacy key is READ-ONLY going forward.
// New code never writes it; it is only read (for the `gcDrafts` skip-list)
// and cleared (on fresh compose, on send/discard via clearLastDraftPointers).
// This way pre-§2.16 state on user machines naturally decays as users
// finalize their old pending drafts, without new writes keeping it alive.
const DRAFT_LAST_KEY_LEGACY = 'mailcopilot:draft:last'
const DRAFT_LAST_KEY_PREFIX = 'mailcopilot:draft:last:'
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const MAX_DRAFTS = 10

function draftLastKeyForAccount(accountId: number): string {
  return `${DRAFT_LAST_KEY_PREFIX}${accountId}`
}

/** §2.16 — clear every "last draft" pointer for a draftId, including the
 *  legacy unscoped key and any per-account variants. Used during finalize
 *  so the next compose isn't tempted to resurrect a sent id. */
function clearLastDraftPointers(draftId: string, currentAccountId?: number | null): void {
  try {
    if (localStorage.getItem(DRAFT_LAST_KEY_LEGACY) === draftId) {
      localStorage.removeItem(DRAFT_LAST_KEY_LEGACY)
    }
    if (typeof currentAccountId === 'number') {
      const k = draftLastKeyForAccount(currentAccountId)
      if (localStorage.getItem(k) === draftId) localStorage.removeItem(k)
    }
    // Belt-and-suspenders: walk every per-account key and drop matches.
    // localStorage is small enough this is O(n) over a tiny n.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(DRAFT_LAST_KEY_PREFIX)) continue
      if (localStorage.getItem(k) === draftId) localStorage.removeItem(k)
    }
  } catch {
    // localStorage unavailable — ignore
  }
}

type DraftData = {
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  updatedAt: string
}

type ContactSuggestion = {
  id: number
  email: string
  emailNorm: string
  name?: string | null
  frequency: number
  lastUsed?: string | null
  lastSeen?: string | null
  source: string
}

type RecipientChip = {
  email: string
  name?: string
}

type RecipientField = 'to' | 'cc' | 'bcc'

function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase()
}

function formatRecipientChip(chip: RecipientChip): string {
  const name = (chip.name || '').trim()
  const email = (chip.email || '').trim()
  return name ? `${name} <${email}>` : email
}

function parseRecipientToken(raw: string): RecipientChip | null {
  const s = (raw || '').trim()
  if (!s) return null

  const m = s.match(/^(.*)<([^>]+)>$/)
  if (m) {
    const name = (m[1] || '').replace(/^"|"$/g, '').trim()
    const email = (m[2] || '').trim()
    if (!email || !email.includes('@')) return null
    return { email, name: name || undefined }
  }

  if (!s.includes('@')) return null
  return { email: s }
}

function serializeRecipients(chips: RecipientChip[], inputValue: string): string {
  const parts = chips.map(formatRecipientChip)
  const tail = (inputValue || '').trim()
  if (tail) parts.push(tail)
  return parts.join(', ')
}

type AddressChipsInputProps = {
  field: RecipientField
  testId: string
  placeholder: string
  chips: RecipientChip[]
  inputValue: string
  suggestions: ContactSuggestion[]
  suggestionsVisible: boolean
  onFocusField: (field: RecipientField) => void
  onBlurField: () => void
  onInputValueChange: (value: string) => void
  onCommitToken: (field: RecipientField, rawToken: string) => void
  onRemoveChip: (field: RecipientField, index: number) => void
  onSelectSuggestion: (field: RecipientField, suggestion: ContactSuggestion) => void
  removeChipTitle: string
}

function AddressChipsInput(props: AddressChipsInputProps) {
  const {
    field,
    testId,
    placeholder,
    chips,
    inputValue,
    suggestions,
    suggestionsVisible,
    onFocusField,
    onBlurField,
    onInputValueChange,
    onCommitToken,
    onRemoveChip,
    onSelectSuggestion,
    removeChipTitle,
  } = props

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
      if ((inputValue || '').trim()) {
        e.preventDefault()
        onCommitToken(field, inputValue)
      }
      return
    }

    if (e.key === 'Backspace' && !inputValue && chips.length > 0) {
      e.preventDefault()
      onRemoveChip(field, chips.length - 1)
    }
  }

  const onInput = (value: string) => {
    // Support entering multiple addresses at once: "a@x, b@y, c@z".
    if (value.includes(',')) {
      const parts = value.split(',')
      const keep = parts.pop() || ''
      for (const part of parts) {
        const token = part.trim()
        if (token) onCommitToken(field, token)
      }
      onInputValueChange(keep)
      return
    }
    onInputValueChange(value)
  }

  return (
    <div className="compose-address-field">
      <div className="compose-address-chips">
        {chips.map((chip, idx) => (
          <span key={`${chip.email}:${idx}`} className="compose-address-chip">
            <span className="compose-address-chip-label">{formatRecipientChip(chip)}</span>
            <button
              type="button"
              className="compose-address-chip-remove"
              onClick={() => onRemoveChip(field, idx)}
              title={removeChipTitle}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          data-testid={testId}
          placeholder={placeholder}
          value={inputValue}
          onFocus={() => onFocusField(field)}
          onBlur={() => onBlurField()}
          onKeyDown={onKeyDown}
          onChange={e => onInput(e.target.value)}
        />
      </div>
      {suggestionsVisible && suggestions.length > 0 && (
        <div className="compose-contact-suggest" data-testid={`compose-${field}-suggest`}>
          {suggestions.map(s => (
            <button
              key={`${s.emailNorm}:${s.id}`}
              type="button"
              className="compose-contact-suggest-item"
              onMouseDown={e => {
                e.preventDefault()
                onSelectSuggestion(field, s)
              }}
            >
              <span className="compose-contact-suggest-name">{(s.name || '').trim() || s.email}</span>
              {(s.name || '').trim() && <span className="compose-contact-suggest-email">{s.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function draftKey(draftId: string) {
  return `${DRAFT_PREFIX}${draftId}`
}

/** Removes old and excess drafts from localStorage */
function gcDrafts() {
  try {
    const entries: { key: string; updatedAt: number }[] = []
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(DRAFT_PREFIX)) continue
      // §2.16 — never gc the "last draft" pointer keys. They share the same
      // DRAFT_PREFIX namespace but carry no body content; gc'ing them would
      // silently disable per-account draft reuse.
      if (key === DRAFT_LAST_KEY_LEGACY) continue
      if (key.startsWith(DRAFT_LAST_KEY_PREFIX)) continue
      try {
        const d = JSON.parse(localStorage.getItem(key) || '{}') as { updatedAt?: string }
        const ts = d.updatedAt ? new Date(d.updatedAt).getTime() : 0
        entries.push({ key, updatedAt: ts })
      } catch {
        localStorage.removeItem(key)
      }
    }
    const now = Date.now()
    entries.sort((a, b) => b.updatedAt - a.updatedAt) // newest first
    for (let i = 0; i < entries.length; i++) {
      if (i >= MAX_DRAFTS || now - entries[i].updatedAt > MAX_DRAFT_AGE_MS) {
        localStorage.removeItem(entries[i].key)
      }
    }
  } catch {
    // localStorage unavailable
  }
}

export default function Compose() {
  const { t } = useTranslation()
  // Do not restart init logic on language change (t identity changes), otherwise compose:getInit may
  // be "consumed" and the Reply/Forward prefill will be overwritten by the restored last draft.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const [accounts, setAccounts] = useState<AccountMeta[]>([])
  const [accountId, setAccountId] = useState<number | null>(null)
  const [fromEmail, setFromEmail] = useState('')
  // Per-account identities surfaced to the identity picker; kept as a derived
  // slice of state so the Compose reducer can swap it atomically when the
  // user switches accounts.
  const [identities, setIdentities] = useState<readonly Identity[]>([])
  // Reply/forward context used by `useIdentitySelection` for auto-matching.
  // We fold all original recipients (from+to+cc) into a single string; the
  // hook performs the actual case-insensitive per-identity match.
  const [originalRecipientsForIdentity, setOriginalRecipientsForIdentity] = useState<string | null>(null)
  // Explicit identity hint carried through the queue → cancel → edit round
  // trip. Supplied via `ComposeInit.identityId` by `mail:cancelSend` so the
  // user's original From alias stays selected instead of silently falling
  // back to the default identity. Cleared after the first render pass because
  // `useIdentitySelection` only consults it on initial pick.
  const [initialIdentityId, setInitialIdentityId] = useState<string | null>(null)
  const [draftSyncEnabled, setDraftSyncEnabled] = useState(true)
  const [sendDelaySeconds, setSendDelaySeconds] = useState(0)
  const [trustedDomains, setTrustedDomains] = useState<string[]>([])
  const [draftsMailbox, setDraftsMailbox] = useState<string | null>(null)
  const [draftId, setDraftId] = useState<string>('')
  const [toChips, setToChips] = useState<RecipientChip[]>([])
  const [ccChips, setCcChips] = useState<RecipientChip[]>([])
  const [bccChips, setBccChips] = useState<RecipientChip[]>([])
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([])
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templates, setTemplates] = useState<Array<{ id: number; name: string; subject: string; body: string; shortcut: string | null }>>([])
  const [scheduleMenuOpen, setScheduleMenuOpen] = useState(false)
  const [scheduleCustomOpen, setScheduleCustomOpen] = useState(false)
  const sendMenuRef = useRef<HTMLDivElement>(null)
  const templateMenuRef = useRef<HTMLDivElement>(null)
  const [scheduleCustomValue, setScheduleCustomValue] = useState(() => defaultCustomScheduleValue())
  const [followUpEnabled, setFollowUpEnabled] = useState(false)
  const [followUpDays, setFollowUpDays] = useState(3)
  const [replyRef, setReplyRef] = useState<{ accountId: number; folder: string; uid: number } | null>(null)
  const [originalRecipients, setOriginalRecipients] = useState<string[]>([])
  const [archiveFolder, setArchiveFolder] = useState<string | null>(null)
  const [focusedField, setFocusedField] = useState<RecipientField | null>(null)
  const [contactSuggestions, setContactSuggestions] = useState<ContactSuggestion[]>([])
  const fileRef = useRef<HTMLInputElement | null>(null)
  // B4 Quick Actions: ref to the body textarea so the diff-preview "Insert"
  // action can read the live caret position and restore the selection after
  // splicing rewritten text at the cursor.
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const rememberAsLastDraftRef = useRef(false)
  const lastRemoteDraftKeyRef = useRef<string>('')
  const initEpochRef = useRef(0)
  const closeSuggestTimerRef = useRef<number | null>(null)
  const contactSearchTimerRef = useRef<number | null>(null)

  const identitySelection = useIdentitySelection({
    identities,
    originalTo: originalRecipientsForIdentity,
    initialIdentityId,
  })

  // Keep Bcc aligned with the active identity's defaultBcc, using the same
  // "don't clobber user edits" heuristic as the signature swap below.
  useIdentityDefaultBcc(identitySelection.selectedIdentity, bcc, setBcc)

  // Sync fromEmail with whatever identity is active (picker change or
  // auto-match). The plain SMTP user stays as a fallback when the current
  // account has no identities loaded yet or the selection is null.
  useEffect(() => {
    const ident = identitySelection.selectedIdentity
    if (!ident) return
    const email = (ident.email || '').trim()
    if (email && email !== fromEmail) setFromEmail(email)
    // intentionally omit fromEmail — only react to identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identitySelection.selectedIdentity?.id])

  // Swap signature block when the user picks a different identity. We match
  // the convention used throughout compose: signature lives after a final
  // `\n\n--\n` separator. Rules:
  //   - Empty body → insert new identity's signature (if any).
  //   - Body with only a signature block → replace with new identity's signature.
  //   - Body with user-typed content above the signature → leave alone. We
  //     never clobber what the user actually typed.
  // This runs only on deliberate user changes (autoMatched === false OR
  // explicit setSelectedId) to avoid a cascade on the initial auto-match.
  const previousIdentityIdRef = useRef<string | null>(null)
  useEffect(() => {
    const ident = identitySelection.selectedIdentity
    const prev = previousIdentityIdRef.current
    previousIdentityIdRef.current = ident?.id ?? null
    if (!ident || !prev || prev === ident.id) return
    const newSig = (ident.signature || '').trim()
    setText(currentText => {
      const sigSep = '\n\n--\n'
      const sigIdx = currentText.lastIndexOf(sigSep)
      const before = sigIdx >= 0 ? currentText.slice(0, sigIdx) : currentText
      const isSignatureOnlyBody = sigIdx >= 0 && before.trim() === ''
      const isEmpty = currentText.trim() === ''
      if (isEmpty || isSignatureOnlyBody) {
        return newSig ? `\n\n--\n${newSig}` : ''
      }
      return currentText
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identitySelection.selectedIdentity?.id])

  const toValue = useMemo(() => serializeRecipients(toChips, to), [to, toChips])
  const ccValue = useMemo(() => serializeRecipients(ccChips, cc), [cc, ccChips])
  const bccValue = useMemo(() => serializeRecipients(bccChips, bcc), [bcc, bccChips])

  const canSend = useMemo(() => Boolean(accountId && fromEmail && toValue.trim() && !sending), [accountId, fromEmail, toValue, sending])
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-hide status messages (except "Sent!" — the window will close automatically).
  useEffect(() => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    if (status && !sending) {
      statusTimerRef.current = setTimeout(() => setStatus(''), 3000)
    }
    return () => { if (statusTimerRef.current) clearTimeout(statusTimerRef.current) }
  }, [status, sending])

  const commitToken = useCallback((field: RecipientField, rawToken: string) => {
    const token = parseRecipientToken(rawToken)
    if (!token) return
    const tokenNorm = normalizeEmail(token.email)
    if (!tokenNorm) return

    const apply = (
      chips: RecipientChip[],
      setChips: (updater: (prev: RecipientChip[]) => RecipientChip[]) => void,
      clearInput: () => void,
    ) => {
      const exists = chips.some(c => normalizeEmail(c.email) === tokenNorm)
      if (!exists) {
        setChips(prev => [...prev, { email: token.email.trim(), name: (token.name || '').trim() || undefined }])
      }
      clearInput()
      void window.api.invoke('contacts:upsert', token.email.trim(), (token.name || '').trim() || undefined).catch((e: unknown) => {
        console.warn('[Compose] Failed to save contact:', e)
      })
    }

    if (field === 'to') apply(toChips, setToChips, () => setTo(''))
    if (field === 'cc') apply(ccChips, setCcChips, () => setCc(''))
    if (field === 'bcc') apply(bccChips, setBccChips, () => setBcc(''))
  }, [bccChips, ccChips, toChips])

  const removeChip = useCallback((field: RecipientField, index: number) => {
    if (field === 'to') setToChips(prev => prev.filter((_, i) => i !== index))
    if (field === 'cc') setCcChips(prev => prev.filter((_, i) => i !== index))
    if (field === 'bcc') setBccChips(prev => prev.filter((_, i) => i !== index))
  }, [])

  const blurField = useCallback(() => {
    if (closeSuggestTimerRef.current) window.clearTimeout(closeSuggestTimerRef.current)
    closeSuggestTimerRef.current = window.setTimeout(() => {
      setFocusedField(null)
      setContactSuggestions([])
    }, 120)
  }, [])

  const selectSuggestion = useCallback((field: RecipientField, suggestion: ContactSuggestion) => {
    commitToken(field, formatRecipientChip({ email: suggestion.email, name: (suggestion.name || '').trim() || undefined }))
    if (field === 'to') setTo('')
    if (field === 'cc') setCc('')
    if (field === 'bcc') setBcc('')
    setFocusedField(field)
    setContactSuggestions([])
  }, [commitToken])

  // Automatically expand Cc/Bcc if they are populated (reply all, draft)
  useEffect(() => {
    if (ccValue.trim() || bccValue.trim()) setShowCcBcc(true)
  }, [bccValue, ccValue])

  useEffect(() => {
    const query = (() => {
      if (focusedField === 'to') return to.trim()
      if (focusedField === 'cc') return cc.trim()
      if (focusedField === 'bcc') return bcc.trim()
      return ''
    })()

    if (contactSearchTimerRef.current) {
      window.clearTimeout(contactSearchTimerRef.current)
      contactSearchTimerRef.current = null
    }

    if (!focusedField || !query) {
      setContactSuggestions([])
      return
    }

    contactSearchTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const list = await window.api.invoke('contacts:search', query, 8) as ContactSuggestion[]
          setContactSuggestions(Array.isArray(list) ? list : [])
        } catch (e) {
          console.warn('[Compose] Contact search error:', e)
          setContactSuggestions([])
        }
      })()
    }, 120)
  }, [bcc, cc, focusedField, to])

  useEffect(() => {
    return () => {
      if (closeSuggestTimerRef.current) window.clearTimeout(closeSuggestTimerRef.current)
      if (contactSearchTimerRef.current) window.clearTimeout(contactSearchTimerRef.current)
    }
  }, [])

  const composeOpenedEmittedRef = useRef(false)
  useEffect(() => {
    const onInit = (payload: unknown) => {
      const data = payload as { accountId?: unknown; init?: unknown }
      const init = (data && typeof data === 'object') ? (data as { init?: ComposeInit }).init : null
      // Window reused for a new compose — emit opened again.
      composeOpenedEmittedRef.current = false
      const nextAccountId = (data && typeof data === 'object' && typeof data.accountId === 'number') ? data.accountId : null
      initEpochRef.current += 1
      setStatus('')
      setError('')
      setAttachments([])
      setFocusedField(null)
      setScheduleMenuOpen(false)
      setScheduleCustomOpen(false)
      setScheduleCustomValue(defaultCustomScheduleValue())
      setContactSuggestions([])
      setToChips([])
      setCcChips([])
      setBccChips([])
      lastRemoteDraftKeyRef.current = ''
      if (typeof nextAccountId === 'number') {
        setAccountId(nextAccountId)
        setFromEmail('')
        setDraftsMailbox(null)
        setIdentities([])
      }
      // Reset reply-context before reading fresh init, otherwise a previous
      // reply's recipients would leak into a fresh "new compose".
      setOriginalRecipientsForIdentity(
        Array.isArray(init?.originalRecipients) && init.originalRecipients.length > 0
          ? init.originalRecipients.join(',')
          : null,
      )
      // 2.3-B: honour the identity id carried through the queue→cancel→edit
      // round trip. Falls back to null so the normal reply-match / default
      // pick kicks in for every other entry point.
      setInitialIdentityId(typeof init?.identityId === 'string' && init.identityId ? init.identityId : null)
      const hasInit = init && (
        typeof init.to === 'string' || typeof init.cc === 'string' ||
        typeof init.bcc === 'string' || typeof init.subject === 'string' ||
        typeof init.text === 'string'
      )
      if (!composeOpenedEmittedRef.current) {
        composeOpenedEmittedRef.current = true
        recordEvent('compose.opened', {
          source: composeSourceFromInit(init ?? null, Boolean(hasInit)),
          has_draft: Boolean(typeof init?.draftId === 'string' && init.draftId),
        })
      }
      // §2.16 iter3 (codex High): on window reuse for a fresh "Compose"
      // (init === null OR an init with no payload fields), the freshly minted
      // randomId() must also be persisted as the per-account "last draft"
      // pointer — otherwise the next fresh compose for this account will not
      // find a pointer to reuse and will spawn a sibling Drafts entry. This
      // mirrors the iter2 fix that was applied to the compose:getInit path
      // (~line 900) but covers the second entry point: the IPC compose:init
      // event handler used by `ui:openCompose` when a Compose window already
      // exists (electron/main.ts ~5531).
      //
      // Remember rules (compose:init event):
      //   - explicit draftId (editing a draft) → remember.
      //   - reply / forward (hasInit=true) → DO NOT remember; would clobber
      //     the per-account pointer with a one-off id.
      //   - fresh compose (init=null or hasInit=false, no draftId) → remember
      //     so the minted id is persisted on first autosave.
      const initHasDraftId = Boolean(typeof init?.draftId === 'string' && init.draftId)
      rememberAsLastDraftRef.current = initHasDraftId || !hasInit
      const nextDraftId = (typeof init?.draftId === 'string' && init.draftId) ? init.draftId : randomId()
      setDraftId(nextDraftId)
      if (typeof init?.to === 'string') setTo(init.to); else setTo('')
      if (typeof init?.cc === 'string') setCc(init.cc); else setCc('')
      if (typeof init?.bcc === 'string') setBcc(init.bcc); else setBcc('')
      if (typeof init?.subject === 'string') setSubject(init.subject); else setSubject('')
      if (typeof init?.text === 'string') setText(init.text); else setText('')
      if (Array.isArray(init?.attachments)) setAttachments(init.attachments); else setAttachments([])
      // "Compose" (no init data): clear the legacy "last draft" pointer so
      // drafts are not restored. The per-account variant is consulted via
      // window.api 'drafts:wasSent' inside the compose:getInit branch below
      // and is purposefully NOT blanket-cleared here — that's where AC2's
      // "reuse last draft on fresh compose" decision is taken.
      if (!hasInit) {
        try { localStorage.removeItem(DRAFT_LAST_KEY_LEGACY) } catch { /* ignore */ }
      }
      // Load account meta (identities + fromEmail) on every compose:init,
      // not only for fresh "new compose". Reply/forward/draft-edit flows
      // hit this handler with `hasInit=true`, and without re-hydrating
      // identities the identity picker stays empty → fromEmail stays ''
      // → Send button is disabled until the user manually re-selects the
      // account, which looks like a bug (user report 2026-04-21).
      if (typeof nextAccountId === 'number') {
        // Epoch guard (Codex post-§2.15 Medium): a rapid compose window
        // reuse (forward → new → reply) can interleave two accounts:get
        // requests. Without this check, an older request's meta could
        // overwrite the newer init's fromEmail/identities and desync the
        // From picker from the actually-selected account.
        const epochSnapshot = initEpochRef.current
        const accountIdSnapshot = nextAccountId
        void (async () => {
          try {
            const meta = await window.api.invoke('accounts:get', accountIdSnapshot) as AccountMeta | undefined
            if (!meta) return
            // Guard: drop this result if a newer compose:init has landed,
            // OR if the user/app swapped to a different account in the
            // meantime (accountId state may have advanced past what we
            // requested — trust the snapshot, not the current state).
            if (initEpochRef.current !== epochSnapshot) return
            // Always seed fromEmail from account meta so Send becomes
            // active immediately. The identity picker's own useEffect
            // at line ~358 will overwrite this once identities load,
            // if a reply-match identity exists with a different address.
            setFromEmail(resolveFromEmailFromMeta(meta))
            if (Array.isArray(meta.identities) && meta.identities.length > 0) {
              setIdentities(meta.identities)
            }
            // Signature only auto-inserts for a fresh new compose —
            // reply/forward/draft bodies must not be clobbered.
            if (!hasInit && !init?.draftId) {
              const defaultSignature = Array.isArray(meta.identities)
                ? meta.identities.find(i => i.isDefault)?.signature
                : undefined
              const sig = defaultSignature || meta.signature
              if (sig) {
                setText(prev => (prev.trim() ? prev : `\n\n--\n${sig}`))
              }
            }
          } catch { /* ignore */ }
        })()
      }
    }
    window.api?.on('compose:init', onInit)
    return () => window.api?.off('compose:init', onInit)
  }, [])

  useEffect(() => {
    void (async () => {
      const startEpoch = initEpochRef.current
      try {
        const s = await window.api.invoke('settings:get') as { draftSyncEnabled?: boolean; sendDelaySeconds?: number; trustedDomains?: string } | undefined
        setDraftSyncEnabled(s?.draftSyncEnabled ?? true)
        setSendDelaySeconds(typeof s?.sendDelaySeconds === 'number' ? Math.max(0, s.sendDelaySeconds) : 0)
        if (typeof s?.trustedDomains === 'string') {
          setTrustedDomains(s.trustedDomains.split('\n').map(d => d.trim()).filter(Boolean))
        }

        const ctx = await window.api.invoke('compose:getInit') as { accountId: number; init: ComposeInit | null } | null
        const ctxAccountId = (ctx && typeof ctx.accountId === 'number') ? ctx.accountId : null
        const ctxInit = (ctx && typeof ctx.init === 'object') ? (ctx.init as ComposeInit | null) : null

        // Emit compose.opened once per window lifecycle, based on the first
        // resolved context (ctxInit may be null for a fresh "compose new").
        if (!composeOpenedEmittedRef.current && initEpochRef.current === startEpoch) {
          composeOpenedEmittedRef.current = true
          const hasAny = Boolean(ctxInit && (
            typeof ctxInit.to === 'string' || typeof ctxInit.subject === 'string' ||
            typeof ctxInit.text === 'string' || Array.isArray(ctxInit.attachments)
          ))
          recordEvent('compose.opened', {
            source: composeSourceFromInit(ctxInit, hasAny),
            has_draft: Boolean(typeof ctxInit?.draftId === 'string' && ctxInit.draftId),
          })
        }
        // Early form field initialization — before heavy requests (accounts, meta, drafts).
        // The user immediately sees To/Subject/Text for reply/forward without waiting for metadata.
        if (ctxInit && initEpochRef.current === startEpoch) {
          if (typeof ctxInit.to === 'string') setTo(ctxInit.to)
          if (typeof ctxInit.cc === 'string') setCc(ctxInit.cc)
          if (typeof ctxInit.bcc === 'string') setBcc(ctxInit.bcc)
          if (typeof ctxInit.subject === 'string') setSubject(ctxInit.subject)
          if (typeof ctxInit.text === 'string') setText(ctxInit.text)
          if (Array.isArray(ctxInit.attachments)) setAttachments(ctxInit.attachments)
          if (ctxInit.replyRef) setReplyRef(ctxInit.replyRef)
          if (Array.isArray(ctxInit.originalRecipients)) {
            setOriginalRecipients(ctxInit.originalRecipients)
            setOriginalRecipientsForIdentity(ctxInit.originalRecipients.join(','))
          } else {
            setOriginalRecipientsForIdentity(null)
          }
          setInitialIdentityId(
            typeof ctxInit.identityId === 'string' && ctxInit.identityId ? ctxInit.identityId : null,
          )
          setToChips([])
          setCcChips([])
          setBccChips([])
        }

        // Load the account list for sender selection.
        let accountsList: AccountMeta[] = []
        try {
          accountsList = await window.api.invoke('accounts:list') as AccountMeta[]
          setAccounts(accountsList)
        } catch (err) {
          captureException(err, { source: 'Compose.loadAccounts' })
        }

        const fallbackAccountId = await (async () => {
          try {
            const cur = await window.api.invoke('accounts:getCurrent') as number | undefined
            if (typeof cur === 'number' && Number.isFinite(cur) && cur > 0) return cur
          } catch {
            // ignore
          }
          return accountsList[0]?.id ?? null
        })()

        const pickedAccountId = ctxAccountId ?? fallbackAccountId
        if (typeof pickedAccountId === 'number') setAccountId(pickedAccountId)

        let accountSignature = ''
        if (typeof pickedAccountId === 'number') {
          try {
            const meta = await window.api.invoke('accounts:get', pickedAccountId) as AccountMeta | undefined
            if (meta) {
              setFromEmail(resolveFromEmailFromMeta(meta))
              // 2.3-B: surface identities to the picker. The server-side
              // read schema always returns a non-empty identities[] (legacy
              // accounts are synthesized at read time), so Array.isArray is
              // a belt-and-suspenders guard against malformed records.
              if (Array.isArray(meta.identities) && meta.identities.length > 0) {
                setIdentities(meta.identities)
              } else {
                setIdentities([])
              }
              // Prefer the default identity's signature for a fresh compose.
              const defaultSignature = Array.isArray(meta.identities)
                ? meta.identities.find(i => i.isDefault)?.signature
                : undefined
              if (defaultSignature) accountSignature = defaultSignature
              else if (meta.signature) accountSignature = meta.signature
            }
          } catch {
            // ignore
          }

          try {
            const res = await window.api.invoke('net:mailboxesAndRoles', pickedAccountId) as { roles: FolderRoles }
            if (s?.draftSyncEnabled ?? true) setDraftsMailbox(res?.roles?.drafts || null)
            setArchiveFolder(res?.roles?.archive || null)
          } catch {
            // Fallback to cached roles when IMAP is unavailable
            try {
              const allCached = await window.api.invoke('cache:folderRoles') as Record<number, Record<string, string | undefined>> | null
              const cached = allCached?.[pickedAccountId]
              if (cached) {
                if (s?.draftSyncEnabled ?? true) setDraftsMailbox(cached.drafts || null)
                setArchiveFolder(cached.archive || null)
              }
            } catch {
              // ignore
            }
          }
        } else {
          setError(tRef.current('compose.errors.noAccount'))
        }

        // compose:init takes priority over compose:getInit to avoid races when reusing the window.
        if (initEpochRef.current !== startEpoch) return

        const initDraftId = (typeof ctxInit?.draftId === 'string' && ctxInit.draftId) ? ctxInit.draftId : ''
        const hasInitPayload = Boolean(ctxInit && (
          typeof ctxInit.from === 'string' ||
          typeof ctxInit.to === 'string' ||
          typeof ctxInit.cc === 'string' ||
          typeof ctxInit.bcc === 'string' ||
          typeof ctxInit.subject === 'string' ||
          typeof ctxInit.text === 'string' ||
          typeof ctxInit.html === 'string' ||
          Array.isArray(ctxInit.attachments)
        ))
        // ctx !== null means compose:getInit returned a context (the user explicitly opened the window).
        // If init is empty — this is a new message, NOT a crash recovery.
        const isFreshCompose = ctx !== null && !hasInitPayload && !initDraftId
        gcDrafts()

        // §2.16 — per-account "last draft" pointer. Opening "New Message"
        // twice in a row for the SAME account should reuse the same draftId
        // so the second auto-save updates the first IMAP draft instead of
        // appending a sibling. We only reuse when:
        //   1. We have an account picked.
        //   2. The per-account pointer is non-empty.
        //   3. Main confirms the draft has NOT been finalized (sent/discarded)
        //      this session — `drafts:wasSent` IPC.
        //   4. There is still local body data under that id (no point
        //      restoring an empty pointer).
        // Otherwise we mint a fresh randomId(). The legacy unscoped key is
        // still consulted as a fallback for users with pre-§2.16 state on
        // disk so we don't regress the original "reuse last draft" UX.
        let lastDraftId = ''
        if (isFreshCompose) {
          // Fresh compose: do NOT clear the per-account pointer pre-emptively.
          // Reuse decision is made via the `drafts:wasSent` check below.
          // Legacy unscoped key is cleared to retire pre-§2.16 state.
          try { localStorage.removeItem(DRAFT_LAST_KEY_LEGACY) } catch { /* ignore */ }
          if (typeof pickedAccountId === 'number') {
            const candidate = (() => {
              try { return localStorage.getItem(draftLastKeyForAccount(pickedAccountId)) || '' }
              catch { return '' }
            })()
            if (candidate) {
              // Body still present locally? Avoid resurrecting a pointer that
              // points at a draft whose body was already gc'd / discarded.
              const hasBody = (() => {
                try { return Boolean(localStorage.getItem(draftKey(candidate))) }
                catch { return false }
              })()
              if (hasBody) {
                let wasSent = false
                try {
                  const r = await window.api.invoke('drafts:wasSent', pickedAccountId, candidate) as { wasSent?: boolean }
                  wasSent = Boolean(r?.wasSent)
                } catch {
                  // If main can't tell us, fall back to "do not reuse" — safer
                  // than reusing a potentially-finalized id.
                  wasSent = true
                }
                if (!wasSent) lastDraftId = candidate
                else {
                  // Pointer is stale — clean up.
                  try { localStorage.removeItem(draftLastKeyForAccount(pickedAccountId)) } catch { /* ignore */ }
                }
              } else {
                try { localStorage.removeItem(draftLastKeyForAccount(pickedAccountId)) } catch { /* ignore */ }
              }
            }
          }
        } else {
          // Non-fresh path (ctx === null, window reuse). Honour the
          // per-account pointer ONLY.
          //
          // §2.16 iter2 fix (codex Medium #1): the legacy unscoped key has
          // no account binding — it was written by some prior compose
          // session for some account, and there is no way to verify it
          // belongs to `pickedAccountId`. Falling back to it on window
          // reuse risks restoring another account's draft id and offering
          // it as "your last draft", a cross-account data leak. The legacy
          // key is still actively cleared (clearLastDraftPointers, gcDrafts,
          // fresh-compose path) so old state drains over time; we just
          // never trust it as a source-of-truth here.
          if (typeof pickedAccountId === 'number') {
            try { lastDraftId = localStorage.getItem(draftLastKeyForAccount(pickedAccountId)) || '' }
            catch { lastDraftId = '' }
          }
        }
        // draftId:
        // - if init has draftId but NO data: explicit request to restore a local draft;
        // - if init has data (reply/forward/server draft): create a new draft or use draftId,
        //   and do NOT overwrite this data with localStorage contents;
        // - if isFreshCompose: reuse `lastDraftId` if AC2 conditions hold, else randomId();
        // - otherwise (ctx === null, window reuse): try to restore the last local draft.
        const pickedDraftId = initDraftId || (
          isFreshCompose
            ? (lastDraftId || randomId())
            : (hasInitPayload ? randomId() : (lastDraftId || randomId()))
        )
        setDraftId(pickedDraftId)
        // Remember this draftId as "last" for: explicit draft edit, window
        // reuse with ctx===null, AND the §2.16 fresh-compose flow — both when
        // we reuse an existing pointer AND when we mint a fresh id (so a
        // subsequent Compose can find this id and reuse it).
        //
        // §2.16 iter2 fix (codex High #1): on a clean-state fresh compose
        // (no prior pointer for this account), `lastDraftId` is empty, so
        // `pickedDraftId` came from `randomId()`. The previous condition
        // gated remembering on `Boolean(lastDraftId)`, which meant the first
        // fresh compose minted an id, saved remotely, but never persisted
        // the per-account pointer — so the NEXT fresh compose for the same
        // account also minted a new id and another sibling appeared in
        // Drafts. AC2 was supposed to prevent exactly this. We now persist
        // the pointer for ANY fresh-compose draftId, reused or freshly
        // minted, so the second fresh compose finds it.
        rememberAsLastDraftRef.current =
          Boolean(initDraftId) ||
          (!hasInitPayload && !isFreshCompose) ||
          isFreshCompose

        // Local draft restoration:
        //  - Explicit `initDraftId` from the parent window (legacy path).
        //  - Reply/forward (hasInitPayload) — never restored, that data was
        //    already applied above (early init).
        //  - §2.16 fresh-compose-with-reuse: when `isFreshCompose` AND we
        //    picked `lastDraftId` (per-account pointer survived `wasSent`
        //    check), restore the local body so the user sees their typing.
        let draftRestored = false
        const shouldRestoreLocal =
          (!hasInitPayload && !isFreshCompose && Boolean(initDraftId)) ||
          (isFreshCompose && Boolean(lastDraftId) && pickedDraftId === lastDraftId)
        if (shouldRestoreLocal) {
          const raw = localStorage.getItem(draftKey(pickedDraftId))
          if (raw) {
            try {
              const d = JSON.parse(raw) as Partial<DraftData>
              if (typeof d.to === 'string') setTo(d.to)
              if (typeof d.cc === 'string') setCc(d.cc)
              if (typeof d.bcc === 'string') setBcc(d.bcc)
              setToChips([])
              setCcChips([])
              setBccChips([])
              if (typeof d.subject === 'string') setSubject(d.subject)
              if (typeof d.text === 'string') setText(d.text)
              setStatus(tRef.current('compose.status.draftRestored'))
              draftRestored = true
            } catch {
              // corrupted draft — ignore
            }
          }
        }

        // 3) Insert signature for a new message (not a draft and not a reply/forward).
        if (accountSignature && !draftRestored && !hasInitPayload) {
          setText(prev => (prev.trim() ? prev : `\n\n--\n${accountSignature}`))
        }
      } catch (e) {
        setError(String(e))
      }
    })()
  }, [])

  // Load account context (from + Drafts mailbox) when accountId changes.
  useEffect(() => {
    if (typeof accountId !== 'number') return
    let cancelled = false
    void (async () => {
      try {
        const meta = await window.api.invoke('accounts:get', accountId) as AccountMeta | undefined
        if (!cancelled) {
          setFromEmail(meta ? resolveFromEmailFromMeta(meta) : '')
          setIdentities(meta && Array.isArray(meta.identities) && meta.identities.length > 0 ? meta.identities : [])
        }
      } catch {
        if (!cancelled) {
          setFromEmail('')
          setIdentities([])
        }
      }

      try {
        const res = await window.api.invoke('net:mailboxesAndRoles', accountId) as { roles: FolderRoles }
        if (!cancelled) {
          if (draftSyncEnabled) setDraftsMailbox(res?.roles?.drafts || null)
          else setDraftsMailbox(null)
          setArchiveFolder(res?.roles?.archive || null)
        }
      } catch {
        if (!cancelled) {
          setDraftsMailbox(null)
          setArchiveFolder(null)
        }
      }
    })()
    return () => { cancelled = true }
  }, [accountId, draftSyncEnabled])

  // Auto-save draft (locally).
  useEffect(() => {
    if (!draftId) return
    const id = window.setTimeout(() => {
      const data: DraftData = {
        to: toValue,
        cc: ccValue,
        bcc: bccValue,
        subject,
        text,
        updatedAt: new Date().toISOString(),
      }
      try {
        const hasAny = Boolean(toValue.trim() || ccValue.trim() || bccValue.trim() || subject.trim() || text.trim())
        if (!hasAny) {
          // Do not keep "empty" drafts: they cause false restorations and badges.
          localStorage.removeItem(draftKey(draftId))
          clearLastDraftPointers(draftId, accountId)
          return
        }
        localStorage.setItem(draftKey(draftId), JSON.stringify(data))
        if (rememberAsLastDraftRef.current) {
          // §2.16 — persist the per-account "last draft" pointer so a
          // subsequent fresh compose can reuse this same draftId.
          //
          // §2.16 iter3 (codex Medium): the legacy unscoped key is NEVER
          // written by new code. Per-account scope is the only authoritative
          // store going forward. The legacy key is read-only for backwards
          // compat with pre-§2.16 state on disk (it decays naturally as
          // existing pointers age out), and it is actively cleared by fresh
          // compose (line 612, line 822) so it never accumulates new state.
          if (typeof accountId === 'number') {
            localStorage.setItem(draftLastKeyForAccount(accountId), draftId)
          }
        }
      } catch {
        // localStorage: quota exceeded or disabled
      }
    }, 600)
    return () => window.clearTimeout(id)
  }, [accountId, bccValue, ccValue, draftId, subject, text, toValue])

  // Auto-save draft to IMAP (Drafts) — with debounce.
  useEffect(() => {
    if (!draftSyncEnabled) return
    if (typeof accountId !== 'number' || !draftsMailbox || !draftId) return
    if (sending) return

    const payload = { to: toValue, cc: ccValue, bcc: bccValue, subject, text }
    const hasAny = Boolean(toValue.trim() || ccValue.trim() || bccValue.trim() || subject.trim() || text.trim())
    if (!hasAny) return
    const key = JSON.stringify(payload)
    if (key === lastRemoteDraftKeyRef.current) return

    const id = window.setTimeout(() => {
      void (async () => {
        try {
          await window.api.invoke('net:saveDraft', accountId, draftsMailbox, draftId, payload)
          lastRemoteDraftKeyRef.current = key
          setStatus(prev => prev || t('compose.status.draftSynced'))
        } catch (e) {
          // Do not break compose with frequent sync errors (server/folder may not be supported).
          console.warn('draft sync failed:', e)
        }
      })()
    }, 1500)

    return () => window.clearTimeout(id)
  }, [accountId, bccValue, ccValue, draftSyncEnabled, draftsMailbox, draftId, sending, subject, t, text, toValue])

  const buildSendPayload = useCallback(() => {
    const resolvedTo = toValue.trim()
    const resolvedCc = ccValue.trim()
    const resolvedBcc = bccValue.trim()
    return {
      from: fromEmail,
      to: resolvedTo,
      cc: resolvedCc || undefined,
      bcc: resolvedBcc || undefined,
      subject,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      // 2.3-B: hand the identity id to the main process so it can build the
      // canonical From header (displayName + email) from AccountMeta.identities
      // regardless of what the transport wrapper sees as `from` here.
      identityId: identitySelection.selectedId || undefined,
    }
  }, [attachments, bccValue, ccValue, fromEmail, identitySelection.selectedId, subject, text, toValue])

  const finalizeAfterDispatch = useCallback(async (statusText: string) => {
    if (typeof accountId === 'number' && draftSyncEnabled && draftsMailbox && draftId) {
      try {
        await window.api.invoke('net:deleteDraft', accountId, draftsMailbox, draftId)
      } catch {
        // ignore
      }
    }

    setStatus(statusText)
    setTo('')
    setCc('')
    setBcc('')
    setToChips([])
    setCcChips([])
    setBccChips([])
    setSubject('')
    setText('')
    setAttachments([])
    if (draftId) {
      try {
        localStorage.removeItem(draftKey(draftId))
        // §2.16 — clear per-account + legacy pointers so a subsequent fresh
        // compose mints a brand-new draftId instead of resurrecting the one
        // we just sent (which would also race against `drafts:wasSent`).
        clearLastDraftPointers(draftId, accountId)
      } catch {
        // ignore
      }
    }
    window.setTimeout(() => window.close(), 900)
  }, [accountId, draftId, draftSyncEnabled, draftsMailbox])

  /** Create a follow-up reminder. sendAtMs — actual send time (for scheduled). */
  const maybeCreateFollowUp = useCallback(async (sendAtMs?: number) => {
    if (!followUpEnabled || typeof accountId !== 'number') return
    const to = toValue.trim()
    if (!to) return
    const baseTime = sendAtMs ?? Date.now()
    const remindAt = new Date(baseTime + followUpDays * 86_400_000).toISOString()
    const msgId = crypto.randomUUID?.() ?? String(Date.now())
    try {
      await window.api.invoke('followup:add', {
        accountId, sentMessageId: msgId, folder: 'Sent', uid: null,
        toAddr: to, subject: subject || undefined, remindAt,
      })
      recordEvent('followup.created', { duration_days_bucket: bucketFollowupDaysLocal(followUpDays) })
    } catch {
      // Do not block sending on follow-up creation error
    }
  }, [accountId, followUpDays, followUpEnabled, subject, toValue])

  /** Returns true if it is safe to proceed with sending, false if user cancelled. */
  const passMisdirectionCheck = useCallback((): boolean => {
    if (!fromEmail) return true
    const allAddrs = [toValue, ccValue, bccValue].join(',')
    const recipients: Recipient[] = allAddrs
      .split(',')
      .map(s => s.trim())
      .filter(s => s.includes('@'))
      .map(email => ({ email }))
    if (recipients.length === 0) return true
    const accountDomain = extractDomain(fromEmail)
    const origRecips = originalRecipients.length > 0
      ? originalRecipients.map(email => ({ email }))
      : undefined
    const warning = checkMisdirection(recipients, accountDomain, trustedDomains, origRecips)
    if (!warning) return true
    const kind = warning.type === 'external_domain' ? 'external_domain' : 'new_recipients_in_reply'
    recordEvent('misdirection.prompted', { kind })
    const msg = warning.type === 'external_domain'
      ? t('compose.misdirection.externalDomain', { domains: warning.externalDomains?.join(', ') ?? '' })
      : t('compose.misdirection.newRecipients', { recipients: warning.newRecipients?.map(r => r.email).join(', ') ?? '' })
    const accepted = window.confirm(msg)
    recordEvent('misdirection.outcome', { kind, outcome: accepted ? 'accepted' : 'cancelled' })
    return accepted
  }, [bccValue, ccValue, fromEmail, originalRecipients, t, toValue, trustedDomains])

  const sendNow = useCallback(async () => {
    if (typeof accountId !== 'number' || !fromEmail) return
    if (!passMisdirectionCheck()) return
    try {
      setError('')
      setStatus('')
      setScheduleMenuOpen(false)
      setScheduleCustomOpen(false)
      setSending(true)
      const payload = buildSendPayload()
      // Send via queue with delay=0 — the window closes instantly,
      // sending happens in the background via processSendQueue().
      await window.api.invoke('mail:scheduleSend', accountId, payload, 0)
      // Only count as enqueued after the IPC actually succeeded — a
      // validation / storage failure would otherwise show as a ghost enqueue.
      recordEvent('send_queue.enqueued', {
        scheduled: false,
        send_and_archive: false,
        has_attachments: (payload.attachments?.length ?? 0) > 0,
        body_size_bucket: bucketBodySize((payload.text || '').length),
      })
      await maybeCreateFollowUp()
      await finalizeAfterDispatch(t('compose.status.sent'))
    } catch (e) {
      setError(t('compose.errors.sendFailed', { error: String(e) }))
    } finally {
      setSending(false)
    }
  }, [accountId, buildSendPayload, finalizeAfterDispatch, fromEmail, maybeCreateFollowUp, passMisdirectionCheck, t])

  const sendAndArchive = useCallback(async () => {
    if (typeof accountId !== 'number' || !fromEmail || !replyRef || !archiveFolder) return
    if (!passMisdirectionCheck()) return
    try {
      setError('')
      setStatus('')
      setScheduleMenuOpen(false)
      setScheduleCustomOpen(false)
      setSending(true)
      const payload = buildSendPayload()
      // Pass archiveRef — background processSendQueue will archive after successful send
      await window.api.invoke('mail:scheduleSend', accountId, payload, 0, {
        accountId: replyRef.accountId,
        folder: replyRef.folder,
        archiveFolder,
        uid: replyRef.uid,
      })
      recordEvent('send_queue.enqueued', {
        scheduled: false,
        send_and_archive: true,
        has_attachments: (payload.attachments?.length ?? 0) > 0,
        body_size_bucket: bucketBodySize((payload.text || '').length),
      })
      await maybeCreateFollowUp()
      await finalizeAfterDispatch(t('compose.status.sentAndArchived'))
    } catch (e) {
      setError(t('compose.errors.sendFailed', { error: String(e) }))
    } finally {
      setSending(false)
    }
  }, [accountId, archiveFolder, buildSendPayload, finalizeAfterDispatch, fromEmail, maybeCreateFollowUp, passMisdirectionCheck, replyRef, t])

  const queueWithDelay = useCallback(async (delayMs: number) => {
    if (typeof accountId !== 'number' || !fromEmail) return
    try {
      setError('')
      setStatus('')
      setScheduleMenuOpen(false)
      setScheduleCustomOpen(false)
      setSending(true)
      const payload = buildSendPayload()
      await window.api.invoke('mail:scheduleSend', accountId, payload, delayMs)
      recordEvent('send_queue.enqueued', {
        scheduled: delayMs > 0,
        send_and_archive: false,
        has_attachments: (payload.attachments?.length ?? 0) > 0,
        body_size_bucket: bucketBodySize((payload.text || '').length),
      })
      await maybeCreateFollowUp(Date.now() + delayMs)
      await finalizeAfterDispatch(t('compose.status.scheduled', { seconds: Math.max(1, Math.round(delayMs / 1000)) }))
    } catch (e) {
      setError(t('compose.errors.sendFailed', { error: String(e) }))
    } finally {
      setSending(false)
    }
  }, [accountId, buildSendPayload, finalizeAfterDispatch, fromEmail, maybeCreateFollowUp, t])

  const scheduleAt = useCallback(async (sendAt: Date) => {
    if (typeof accountId !== 'number' || !fromEmail) return
    if (!(sendAt instanceof Date) || Number.isNaN(sendAt.getTime())) {
      setError(t('compose.errors.invalidDate'))
      return
    }
    try {
      setError('')
      setStatus('')
      setScheduleMenuOpen(false)
      setScheduleCustomOpen(false)
      setSending(true)
      const payload = buildSendPayload()
      const res = await window.api.invoke('mail:scheduleSendAt', accountId, payload, sendAt.toISOString()) as { sendAt?: string }
      recordEvent('send_queue.enqueued', {
        scheduled: true,
        send_and_archive: false,
        has_attachments: (payload.attachments?.length ?? 0) > 0,
        body_size_bucket: bucketBodySize((payload.text || '').length),
      })
      const at = new Date(typeof res?.sendAt === 'string' ? res.sendAt : sendAt.toISOString())
      await maybeCreateFollowUp(sendAt.getTime())
      await finalizeAfterDispatch(t('compose.status.scheduledAt', { at: at.toLocaleString() }))
    } catch (e) {
      setError(t('compose.errors.sendFailed', { error: String(e) }))
    } finally {
      setSending(false)
    }
  }, [accountId, buildSendPayload, finalizeAfterDispatch, fromEmail, maybeCreateFollowUp, t])

  const send = useCallback(async () => {
    if (sendDelaySeconds > 0) {
      await queueWithDelay(sendDelaySeconds * 1000)
      return
    }
    await sendNow()
  }, [queueWithDelay, sendDelaySeconds, sendNow])

  const scheduleLaterToday = useCallback(() => {
    void scheduleAt(nextHalfHour())
  }, [scheduleAt])

  const scheduleTomorrowMorning = useCallback(() => {
    void scheduleAt(tomorrowMorning())
  }, [scheduleAt])

  const scheduleMondayMorning = useCallback(() => {
    void scheduleAt(mondayMorning())
  }, [scheduleAt])

  const openCustomSchedule = useCallback(() => {
    setError('')
    setScheduleCustomValue(defaultCustomScheduleValue())
    setScheduleCustomOpen(true)
  }, [])

  const cancelCustomSchedule = useCallback(() => {
    setScheduleCustomOpen(false)
    setScheduleCustomValue(defaultCustomScheduleValue())
  }, [])

  const applyCustomSchedule = useCallback(() => {
    const at = parseDateTimeLocalValue(scheduleCustomValue)
    if (!at) {
      setError(t('compose.errors.invalidDate'))
      return
    }
    void scheduleAt(at)
  }, [scheduleAt, scheduleCustomValue, t])

  const loadTemplates = useCallback(async () => {
    try {
      const list = await window.api.invoke('templates:list') as Array<{ id: number; name: string; subject: string; body: string; shortcut: string | null }>
      setTemplates(Array.isArray(list) ? list : [])
    } catch {
      setTemplates([])
    }
  }, [])

  const applyTemplate = useCallback((tpl: { subject: string; body: string }) => {
    const vars: Record<string, string> = {
      name: accounts.find(a => a.id === accountId)?.name || '',
      email: fromEmail,
      date: new Date().toLocaleDateString(),
    }
    // Count {var} occurrences (structure only, never the var values).
    const varCount = ((tpl.subject || '').match(/\{[a-zA-Z_]+\}/g)?.length ?? 0) +
                     ((tpl.body || '').match(/\{[a-zA-Z_]+\}/g)?.length ?? 0)
    recordEvent('template.applied', { var_count: varCount })
    if (tpl.subject) setSubject(substituteVars(tpl.subject, vars))
    if (tpl.body) setText(prev => {
      // If there is a signature (-- ), insert before it
      const sigIdx = prev.indexOf('\n\n--\n')
      if (sigIdx >= 0) return substituteVars(tpl.body, vars) + prev.slice(sigIdx)
      return substituteVars(tpl.body, vars)
    })
    setTemplatesOpen(false)
  }, [accountId, accounts, fromEmail])

  const toggleTemplatesMenu = useCallback(() => {
    setTemplatesOpen(prev => {
      if (!prev) void loadTemplates()
      return !prev
    })
  }, [loadTemplates])

  const toggleScheduleMenu = useCallback(() => {
    setScheduleMenuOpen(prev => {
      const next = !prev
      if (!next) setScheduleCustomOpen(false)
      return next
    })
  }, [])

  // Close dropdown menus on click-outside or Escape
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (scheduleMenuOpen && sendMenuRef.current && !sendMenuRef.current.contains(e.target as Node)) {
        setScheduleMenuOpen(false)
        setScheduleCustomOpen(false)
      }
      if (templatesOpen && templateMenuRef.current && !templateMenuRef.current.contains(e.target as Node)) {
        setTemplatesOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (scheduleMenuOpen) { setScheduleMenuOpen(false); setScheduleCustomOpen(false) }
        if (templatesOpen) setTemplatesOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [scheduleMenuOpen, templatesOpen])

  const attachFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    try {
      setError('')
      for (const f of Array.from(files)) {
        if (f.size > MAX_ATTACHMENT_BYTES) {
          setError(t('compose.errors.fileTooLarge', {
            name: f.name,
            size: formatBytes(f.size),
            max: formatBytes(MAX_ATTACHMENT_BYTES),
          }))
          return
        }
      }
      const atts = await filesToAttachments(files)
      setAttachments(prev => [...prev, ...atts])
    } catch (e) {
      setError(String(e))
    } finally {
      // Reset value so re-selecting the same files also triggers the handler
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [t])

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer) return
    e.preventDefault()
    void attachFiles(e.dataTransfer.files)
  }, [attachFiles])

  const focusField = useCallback((field: RecipientField) => {
    if (closeSuggestTimerRef.current) {
      window.clearTimeout(closeSuggestTimerRef.current)
      closeSuggestTimerRef.current = null
    }
    setFocusedField(field)
  }, [])

  return (
    <div className="compose-window" onDragOver={onDragOver} onDrop={onDrop}>
      {/* Custom titlebar for frameless window */}
      <WindowTitlebar title={t('compose.title')} />
      <div className="compose-form">
        {accounts.length > 1 && (
          <Select
            testId="compose-from"
            value={accountId != null ? String(accountId) : ''}
            onChange={v => {
              const id = Number(v)
              if (Number.isFinite(id) && id > 0) setAccountId(id)
            }}
            ariaLabel={t('compose.from')}
            options={accounts.map(a => {
              const email = a.email || a.smtp.user || a.imap.user || ''
              const label = a.name ? `${a.name} <${email}>` : email
              return { value: String(a.id), label }
            })}
          />
        )}
        {identities.length > 1 && (
          <div className="compose-identity-row">
            <IdentityPicker
              identities={identities}
              selectedId={identitySelection.selectedId}
              onChange={identitySelection.setSelectedId}
              label={t('compose.identity.selectorLabel')}
              disabled={sending}
              testId="compose-identity"
            />
            {identitySelection.autoMatched && (
              <span className="hint" data-testid="compose-identity-auto-hint">
                {t('compose.identity.autoMatched')}
              </span>
            )}
          </div>
        )}
        <div className="compose-to-row">
          <AddressChipsInput
            field="to"
            testId="compose-to"
            placeholder={t('compose.to')}
            chips={toChips}
            inputValue={to}
            suggestions={contactSuggestions}
            suggestionsVisible={focusedField === 'to' && to.trim().length > 0}
            onFocusField={focusField}
            onBlurField={blurField}
            onInputValueChange={setTo}
            onCommitToken={commitToken}
            onRemoveChip={removeChip}
            onSelectSuggestion={selectSuggestion}
            removeChipTitle={t('compose.contacts.removeRecipient')}
          />
          {!showCcBcc && (
            <button
              type="button"
              className="compose-cc-toggle"
              data-testid="compose-cc-toggle"
              aria-expanded={false}
              aria-controls="compose-ccbcc-fields"
              onClick={() => {
                setShowCcBcc(true)
                setTimeout(() => {
                  const ccInput = document.querySelector<HTMLInputElement>('[data-testid="compose-cc"]')
                  ccInput?.focus()
                }, 0)
              }}
            >
              {t('compose.showCcBcc')}
            </button>
          )}
        </div>
        {showCcBcc && (
          <div id="compose-ccbcc-fields">
            <AddressChipsInput
              field="cc"
              testId="compose-cc"
              placeholder={t('compose.cc')}
              chips={ccChips}
              inputValue={cc}
              suggestions={contactSuggestions}
              suggestionsVisible={focusedField === 'cc' && cc.trim().length > 0}
              onFocusField={focusField}
              onBlurField={blurField}
              onInputValueChange={setCc}
              onCommitToken={commitToken}
              onRemoveChip={removeChip}
              onSelectSuggestion={selectSuggestion}
              removeChipTitle={t('compose.contacts.removeRecipient')}
            />
            <AddressChipsInput
              field="bcc"
              testId="compose-bcc"
              placeholder={t('compose.bcc')}
              chips={bccChips}
              inputValue={bcc}
              suggestions={contactSuggestions}
              suggestionsVisible={focusedField === 'bcc' && bcc.trim().length > 0}
              onFocusField={focusField}
              onBlurField={blurField}
              onInputValueChange={setBcc}
              onCommitToken={commitToken}
              onRemoveChip={removeChip}
              onSelectSuggestion={selectSuggestion}
              removeChipTitle={t('compose.contacts.removeRecipient')}
            />
          </div>
        )}
        <input
          data-testid="compose-subject"
          placeholder={t('compose.subject')}
          value={subject}
          onChange={e => setSubject(e.target.value)}
        />
        {/* B4: AI quick-action toolbar (Improve / Shorter / Formal / Grammar).
            All rewrite logic lives in useQuickActions; the diff preview only
            mutates the body via the explicit Replace/Insert callbacks below —
            never auto-substitutes (no-auto-send / no-auto-edit invariant). */}
        <ComposeQuickActions
          accountId={accountId}
          text={text}
          disabled={sending}
          getCaret={() => bodyRef.current?.selectionStart ?? text.length}
          onReplace={next => setText(next)}
          onInsert={(next, caret) => {
            setText(next)
            // Restore the caret AFTER React commits the new value so the user
            // continues typing right after the inserted text.
            requestAnimationFrame(() => {
              const el = bodyRef.current
              if (!el) return
              el.focus()
              el.setSelectionRange(caret, caret)
            })
          }}
        />
        <textarea
          ref={bodyRef}
          data-testid="compose-text"
          placeholder={t('compose.text')}
          value={text}
          onChange={e => setText(e.target.value)}
        />

        {attachments.length > 0 && (
          <div className="compose-attachments" data-testid="compose-attachments">
            {attachments.map((a, idx) => (
              <div key={`${a.filename}:${idx}`} className="compose-attachment">
                <Paperclip size={14} />
                <span className="compose-attachment-name">{a.filename}</span>
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                  title={t('compose.actions.removeAttachment')}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="compose-footer">
        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={e => void attachFiles(e.target.files)}
        />
        <div className="compose-template-wrap" ref={templateMenuRef}>
          <button
            type="button"
            onClick={toggleTemplatesMenu}
            disabled={sending}
            data-testid="compose-templates-toggle"
            title={t('compose.templates.title')}
          >
            <FileText size={14} /> {t('compose.templates.title')}
          </button>
          {templatesOpen && (
            <div className="compose-template-menu" data-testid="compose-template-menu">
              {templates.length === 0 && (
                <span className="compose-template-empty">{t('compose.templates.empty')}</span>
              )}
              {templates.map(tpl => (
                <button key={tpl.id} type="button" onClick={() => applyTemplate(tpl)}>
                  <span>{tpl.name}</span>
                  {tpl.shortcut && <span className="template-shortcut">{tpl.shortcut}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={sending}
          data-testid="compose-attach"
          title={t('compose.actions.attach')}
        >
          <Paperclip size={14} /> {t('compose.actions.attach')}
        </button>
        <div className="compose-followup">
          {/* uiaudit.17a — use setting-check class so the checkbox label
              matches the styled controls in Settings and other Compose rows. */}
          <label className="setting-check">
            <input type="checkbox" checked={followUpEnabled} onChange={e => setFollowUpEnabled(e.target.checked)} />
            <Bell size={14} />
            {t('followUp.remind')}
          </label>
          {followUpEnabled && (
            <Select<number>
              value={followUpDays}
              onChange={v => setFollowUpDays(v)}
              ariaLabel={t('followUp.reminderDays')}
              options={[
                { value: 2, label: t('followUp.days2') },
                { value: 3, label: t('followUp.days3') },
                { value: 7, label: t('followUp.days7') },
              ]}
            />
          )}
        </div>
        <div className="compose-send-split" ref={sendMenuRef}>
          <button
            data-testid="compose-send"
            className="btn-primary compose-send-main"
            onClick={() => void send()}
            disabled={!canSend}
          >
            {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            {sending ? t('compose.actions.sending') : t('compose.actions.send')}
          </button>
          <button
            type="button"
            data-testid="compose-send-dropdown-toggle"
            className="btn-primary compose-send-chevron"
            onClick={toggleScheduleMenu}
            disabled={!canSend}
            aria-label={t('compose.actions.moreOptions')}
          >
            <ChevronDown size={14} />
          </button>
          {scheduleMenuOpen && (
            <div className="compose-send-menu" data-testid="compose-send-menu">
              {replyRef && archiveFolder && (
                <>
                  <button
                    type="button"
                    data-testid="compose-send-archive"
                    onClick={() => void sendAndArchive()}
                  >
                    <Archive size={14} />
                    {t('compose.actions.sendAndArchive')}
                  </button>
                  <hr className="compose-send-menu-divider" />
                </>
              )}
              <button type="button" onClick={scheduleLaterToday}>
                <Clock size={14} />
                {t('compose.schedule.laterToday')}
              </button>
              <button type="button" onClick={scheduleTomorrowMorning}>
                <Clock size={14} />
                {t('compose.schedule.tomorrowMorning')}
              </button>
              <button type="button" onClick={scheduleMondayMorning}>
                <Clock size={14} />
                {t('compose.schedule.mondayMorning')}
              </button>
              <button type="button" data-testid="compose-schedule-custom-toggle" onClick={openCustomSchedule}>
                <Calendar size={14} />
                {t('compose.schedule.custom')}
              </button>
              {scheduleCustomOpen && (
                <div className="compose-schedule-custom" data-testid="compose-schedule-custom">
                  <label htmlFor="compose-schedule-datetime">{t('compose.schedule.dateTime')}</label>
                  <input
                    id="compose-schedule-datetime"
                    data-testid="compose-schedule-datetime"
                    type="datetime-local"
                    value={scheduleCustomValue}
                    onChange={e => setScheduleCustomValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        applyCustomSchedule()
                      }
                    }}
                  />
                  <div className="compose-schedule-custom-actions">
                    <button type="button" data-testid="compose-schedule-apply" onClick={applyCustomSchedule}>
                      {t('compose.schedule.apply')}
                    </button>
                    <button type="button" onClick={cancelCustomSchedule}>
                      {t('compose.schedule.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="compose-status-bar">
        {status && <span className="status-text status-ok" data-testid="compose-status">{status}</span>}
        {error && <span className="status-text status-err" data-testid="compose-error">{error}</span>}
        {!status && !error && <span className="status-text">&nbsp;</span>}
      </div>
    </div>
  )
}
