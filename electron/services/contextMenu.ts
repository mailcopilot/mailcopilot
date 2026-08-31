/**
 * Native context menu — BACKLOG §2.93(a).
 *
 * Electron, unlike a browser, draws no context menu of its own, and
 * `Menu.setApplicationMenu(null)` in main.ts removes the application menu too.
 * Before this service the app had no context menu at all: a right click on a
 * link in a message could not copy its address, and no editable field offered
 * Cut / Copy / Paste.
 *
 * Why the menu lives in the MAIN process. A message body renders inside a
 * sandboxed `srcdoc` iframe without `allow-scripts`, so the parent document
 * never sees its `contextmenu` events and no interceptor can be injected into
 * it — that is precisely the protection against active content in mail. The
 * only surface that observes those clicks is `webContents.on('context-menu')`,
 * which fires for every frame and carries `linkURL`, `selectionText`,
 * `isEditable` and `editFlags`.
 *
 * Security invariants (these are the reason the file is shaped this way):
 *
 *  1. NO SECOND ROUTE TO THE BROWSER. "Open link in browser" does not call
 *     `shell.openExternal`, and does not reach the `openExternalGated` funnel
 *     directly either. It hands the link to the SAME per-window `mail:link`
 *     funnel a click on that link would have used
 *     (`configureExternalLinks` → `MailLinkRouter` → renderer phishing
 *     evaluation in `useMailLinkClick` → `ui:openExternal`). A parallel
 *     implementation of a security-critical route drifts from the original,
 *     and an attacker only needs whichever copy was patched last. Reuse also
 *     means the menu automatically inherits the §2.25 dedup + circuit breaker,
 *     the IDN / http / display-mismatch warnings and the token-bucket gate.
 *
 *  2. THE DECISION FUNCTION IS THE CLICK PATH'S OWN.
 *     {@link resolveLinkTarget} calls `decideMailLinkAction` from
 *     ../mailLinkRouter — the exact function `will-frame-navigate` uses — so
 *     the menu cannot accept a URL shape the click path rejects, and cannot
 *     drop the `unsafeBypass` flag that forces the phishing prompt for a raw
 *     link that escaped `rewriteMailHtmlLinks`.
 *
 *  3. NO NEW IPC. The handler runs in main off a `webContents` event; nothing
 *     here lets a renderer ask main to open an arbitrary URL. The only
 *     renderer→main traffic involved is the pre-existing `ui:openExternal`,
 *     reached through the renderer's own warning UI, exactly as for a click.
 *
 *  4. WHAT WE COPY IS THE DESTINATION, NOT THE MARKUP.
 *     See {@link resolveLinkTarget} for the full reasoning.
 *
 *  5. NOTHING THIRD-PARTY-AUTHORED IS TRANSMITTED. Everything this handler
 *     touches is untrusted by construction — `params` carries mail-supplied
 *     link URLs and the user's selection, and the failures it catches carry the
 *     text of whichever component threw. So the telemetry boundary here is the
 *     one from ../services/netErrorTelemetry.ts: Sentry gets a SYNTHETIC error
 *     built from literals in this file, the raw error stays in the local log.
 *     See {@link reportContextMenuFailure}. The boundary has TWO entry points,
 *     because the handler has two: menu construction, and the later dispatch of
 *     a clicked item ({@link ContextMenuPhase} `action`). An item callback that
 *     throws past this file lands in the global `uncaughtException` handler and
 *     is transmitted raw, so it must not be left unwrapped.
 *
 * The menu construction is a pure function ({@link buildContextMenuPlan}) that
 * turns the Electron params shape into a description of the menu, so every
 * "this item must NOT appear" assertion is unit-testable without launching
 * Electron.
 */
import { Menu, clipboard, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { createLogger } from '../logger'
import { captureException } from '../sentry'
import { recordEvent } from '../metrics'
import { decideMailLinkAction } from '../mailLinkRouter'
import { normalizeExternalUrl } from '@mailcopilot/core/mailLinks'
// The renderer's own translation resources — the single source of truth for
// these labels. See {@link CONTEXT_MENU_LABELS} for why main reads them
// directly instead of keeping a second, hand-written copy.
import enLocale from '../../src/i18n/locales/en.json'
import ruLocale from '../../src/i18n/locales/ru.json'
import frLocale from '../../src/i18n/locales/fr.json'
import deLocale from '../../src/i18n/locales/de.json'
import esLocale from '../../src/i18n/locales/es.json'
import itLocale from '../../src/i18n/locales/it.json'

const log = createLogger('ContextMenu')

/**
 * Upper bound on the length of a link address the menu is willing to act on.
 *
 * Truncating is not an option: a shortened address is a DIFFERENT address, and
 * handing the user a string that does not resolve where the link goes is the
 * dishonesty this feature exists to prevent. So beyond this bound the link
 * items are omitted entirely rather than shown with a lie behind them. The
 * bound is generous — well past the longest real tracking/redirect URLs (a few
 * thousand characters) — and only screens out pathological, mail-supplied
 * blobs that would be pushed into the OS clipboard, a process-global surface,
 * on a single accidental click. A left click on such a link still works: the
 * click path is untouched.
 */
export const MAX_LINK_ADDRESS_LENGTH = 8192

/**
 * §2.103 — upper bound on how many spelling replacements are offered.
 *
 * Chromium already returns a short list (typically ≤ 5), so this is not a
 * trimming rule for the normal case — it is a bound on a MAIL-DERIVED array.
 * `dictionarySuggestions` is computed from the word under the cursor, and in a
 * reply that word came out of a message someone else wrote. A menu whose length
 * is decided by that input is a menu an email can make unusable.
 */
export const MAX_SPELL_SUGGESTIONS = 6

/**
 * §2.103 — upper bound on the length of a word the spelling section will act
 * on. Same reasoning as {@link MAX_LINK_ADDRESS_LENGTH}: no truncation (a
 * shortened word is a DIFFERENT word, and `replaceMisspelling` would then
 * replace the selection with something the user did not choose), so beyond the
 * bound the section is omitted entirely. Far past any real word in any
 * language; it only screens out a pathological blob typed or pasted into a
 * field.
 */
export const MAX_MISSPELLED_WORD_LENGTH = 128

/** The keys of the `contextMenu.*` block in src/i18n/locales/*.json. */
export type ContextMenuLabelKey =
  | 'openLink'
  | 'copyLinkAddress'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'addToDictionary'

/** Edit actions delegated to Electron's built-in menu roles. */
export type ContextMenuRole = 'cut' | 'copy' | 'paste' | 'selectAll'

/** Payload shape of the per-window `mail:link` funnel in main.ts. */
export interface MailLinkPayload {
  href: string
  text: string
  unsafeBypass?: true
}

export type ContextMenuPlanItem =
  | { kind: 'separator' }
  /** Routes `link` through the window's `mail:link` funnel — never openExternal. */
  | { kind: 'openLink'; labelKey: 'openLink'; link: MailLinkPayload }
  /** Writes `address` — the resolved destination — to the clipboard. */
  | { kind: 'copyLinkAddress'; labelKey: 'copyLinkAddress'; address: string }
  | { kind: 'role'; labelKey: ContextMenuRole; role: ContextMenuRole; enabled: boolean }
  /**
   * §2.103 — one spelling replacement. `suggestion` is BOTH the label and the
   * argument: Chromium produced it from the dictionary, and it is applied
   * through `webContents.replaceMisspelling`, never by our own text surgery.
   */
  | { kind: 'spellSuggestion'; suggestion: string }
  /** §2.103 — adds `word` to the user's personal dictionary. */
  | { kind: 'addToDictionary'; labelKey: 'addToDictionary'; word: string }

/** The subset of `Electron.ContextMenuParams` this service reads. */
export interface ContextMenuInput {
  linkURL: string
  selectionText: string
  isEditable: boolean
  editFlags: {
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
  /**
   * §2.103 — the word under the cursor when Chromium considers it misspelled,
   * and its suggested replacements. Both are absent on a build/params shape
   * without them, hence optional: this service must not require Electron to
   * populate a field to keep working.
   *
   * UNTRUSTED, and the most easily forgotten instance of it in this file: in a
   * reply the text under the cursor is quoted mail, so `misspelledWord` can be
   * anything a sender chose to write. It is displayed and handed back to
   * Chromium; it is never logged, never a metric tag, never part of an error.
   */
  misspelledWord?: string
  dictionarySuggestions?: string[]
}

export interface BuildContextMenuOptions {
  /**
   * True only for surfaces that actually listen for `mail:link` (the main
   * window and the standalone message window). Elsewhere the "open link" item
   * would be a silent no-op, so it is not offered — see the surface table in
   * {@link attachContextMenu}.
   */
  canRouteLinks: boolean
}

/**
 * Resolve what a right-clicked link actually points at, or `null` when the
 * menu must offer nothing for it.
 *
 * `linkURL` here is attacker-controlled: it comes off a page rendering
 * untrusted email HTML. Two shapes reach us.
 *
 *  - A `mailcopilot-link://` URL. `rewriteMailHtmlLinks` rewrites every mail
 *    `href` into this form, carrying the original address in `u`. NOTE that an
 *    email can also *plant* one directly: the rewriter leaves an href it
 *    cannot normalise untouched, so `mailcopilot-link://open?u=javascript:…`
 *    survives into the DOM. Hence the `u` value is re-validated below exactly
 *    as the renderer re-validates it before opening.
 *  - A raw URL that escaped the rewriter. `decideMailLinkAction` marks it
 *    `unsafeBypass`, which forces the phishing prompt downstream.
 *
 * WHAT WE COPY. The address we put on the clipboard is the *destination*, run
 * through the same `normalizeExternalUrl` the click path applies before
 * opening — never the `mailcopilot-link://` wrapper the DOM holds (an internal
 * scheme is useless to the user) and never the link's visible text (that is
 * sender-controlled, and copying it would reproduce the very display/target
 * mismatch `useMailLinkClick` warns about). Two consequences are deliberate:
 *   - a host written in Unicode is copied in its punycode/ASCII serialisation,
 *     because that is where the browser will actually go — the Unicode form
 *     would put a homograph back into the user's hands;
 *   - embedded credentials (`https://user:pass@host/`) are preserved, not
 *     stripped, for the same reason: silently copying a different URL than the
 *     one that would open is worse than copying an ugly one. The click path
 *     applies no credential check either, and a menu item must not diverge
 *     from it in either direction.
 */
export function resolveLinkTarget(
  linkURL: string,
): { link: MailLinkPayload; address: string } | null {
  // The click path's own decision function — routed vs raw vs ignore. Passing
  // isMainFrame: false because a context menu applies to the link the user
  // pointed at regardless of which frame holds it; the main-frame carve-out
  // there exists for navigations, which is not what this is.
  const action = decideMailLinkAction({ url: linkURL, isMainFrame: false })
  if (action.kind === 'ignore') return null

  // Same validation the renderer runs in handleLinkClick before opening:
  // protocol allowlist (http/https/mailto) plus canonical serialisation. A
  // routed link whose `u` carries javascript:/data:/cid: dies here, which is
  // also why no item is offered for it — an item that silently does nothing is
  // worse than an absent one.
  const address = normalizeExternalUrl(action.payload.href)
  if (!address) return null
  if (address.length > MAX_LINK_ADDRESS_LENGTH) return null

  return { link: action.payload, address }
}

/**
 * Pure menu construction: Electron params in, a description of the menu out.
 *
 * Sections, in order:
 *   1. link items (only for a link whose destination survives
 *      {@link resolveLinkTarget});
 *   2. §2.103 spelling items — replacements plus "Add to dictionary", only for
 *      a misspelled word in an EDITABLE field;
 *   3. edit items — the full Cut/Copy/Paste/Select All set in an editable
 *      field, and Copy alone over a selection in non-editable content.
 *
 * The spelling section is inserted BETWEEN the two pre-existing ones rather
 * than appended: replacements are what a person right-clicking a red-underlined
 * word came for, and burying them under Cut/Copy/Paste would make the section
 * pointless. The relative order and the contents of the existing sections are
 * unchanged — §2.93(b) (Select All outside input fields) stays deferred.
 *
 * An empty result means no menu is shown at all. That is the common case for a
 * plain right click on the message list or a folder, where the renderer's own
 * React menus (`ContextMenu.tsx`, `FolderContextMenu.tsx`) are the UI — so the
 * two mechanisms do not stack by construction.
 */
/**
 * §2.103 — the spelling items, or none.
 *
 * Every condition here is a "this must NOT appear" assertion in the test file:
 *
 *  - NOT EDITABLE ⇒ nothing. Chromium reports a misspelled word for read-only
 *    text too (a message body is spellchecked as soon as the checker is armed),
 *    and both actions are meaningless there: `replaceMisspelling` cannot write
 *    into content that is not editable, and "add to dictionary" would let a
 *    right click on MAIL-AUTHORED text teach the user's personal dictionary a
 *    word they never typed.
 *  - NO WORD ⇒ nothing. `misspelledWord` is `''` for a normal right click, and
 *    an empty word would produce an "Add "" to dictionary" item.
 *  - AN OVERLONG WORD ⇒ nothing, rather than a truncated one (see
 *    {@link MAX_MISSPELLED_WORD_LENGTH}).
 *  - SUGGESTIONS ARE FILTERED AND CAPPED: non-strings and empty strings are
 *    dropped (a menu item with no label is unclickable but occupies the list),
 *    duplicates collapse, and at most {@link MAX_SPELL_SUGGESTIONS} survive.
 *
 * "Add to dictionary" is offered even when there are no suggestions — that is
 * the common case for a name or a term the dictionary simply lacks, and it is
 * the only way out of a permanent red underline.
 */
function buildSpellingSection(params: ContextMenuInput): ContextMenuPlanItem[] {
  const word = typeof params.misspelledWord === 'string' ? params.misspelledWord : ''
  if (!params.isEditable) return []
  if (word === '' || word.length > MAX_MISSPELLED_WORD_LENGTH) return []

  const items: ContextMenuPlanItem[] = []
  const seen = new Set<string>()
  for (const raw of params.dictionarySuggestions ?? []) {
    if (typeof raw !== 'string') continue
    const suggestion = raw.trim()
    if (suggestion === '' || suggestion.length > MAX_MISSPELLED_WORD_LENGTH) continue
    if (seen.has(suggestion)) continue
    seen.add(suggestion)
    items.push({ kind: 'spellSuggestion', suggestion })
    if (items.length >= MAX_SPELL_SUGGESTIONS) break
  }
  items.push({ kind: 'addToDictionary', labelKey: 'addToDictionary', word })
  return items
}

export function buildContextMenuPlan(
  params: ContextMenuInput,
  options: BuildContextMenuOptions,
): ContextMenuPlanItem[] {
  const items: ContextMenuPlanItem[] = []

  const target = params.linkURL ? resolveLinkTarget(params.linkURL) : null
  if (target) {
    if (options.canRouteLinks) {
      items.push({ kind: 'openLink', labelKey: 'openLink', link: target.link })
    }
    items.push({ kind: 'copyLinkAddress', labelKey: 'copyLinkAddress', address: target.address })
  }

  const spelling = buildSpellingSection(params)
  if (items.length > 0 && spelling.length > 0) items.push({ kind: 'separator' })
  items.push(...spelling)

  const edit: ContextMenuPlanItem[] = []
  const flags = params.editFlags
  if (params.isEditable) {
    edit.push(
      { kind: 'role', labelKey: 'cut', role: 'cut', enabled: flags.canCut },
      { kind: 'role', labelKey: 'copy', role: 'copy', enabled: flags.canCopy },
      { kind: 'role', labelKey: 'paste', role: 'paste', enabled: flags.canPaste },
      { kind: 'role', labelKey: 'selectAll', role: 'selectAll', enabled: flags.canSelectAll },
    )
  } else if (params.selectionText.trim() !== '' && flags.canCopy) {
    // Non-editable content: Copy only. Cut/Paste are meaningless, and Select
    // All over a whole message body is BACKLOG §2.93(b), not this change.
    edit.push({ kind: 'role', labelKey: 'copy', role: 'copy', enabled: true })
  }

  if (items.length > 0 && edit.length > 0) items.push({ kind: 'separator' })
  items.push(...edit)

  return items
}

/**
 * Which section the menu offered — an aggregate, fixed-enum usage signal
 * (CLAUDE.md §8). Never carries a URL, a selection or any content.
 */
export function contextMenuContext(items: ContextMenuPlanItem[]): 'link' | 'editable' | 'selection' {
  if (items.some(i => i.kind === 'openLink' || i.kind === 'copyLinkAddress')) return 'link'
  if (items.filter(i => i.kind === 'role').length > 1) return 'editable'
  return 'selection'
}

/**
 * §2.103 — which spelling item was activated. Aggregate and closed-set: the
 * word and the replacement are never emitted, in either direction. A
 * misspelled word in a reply is quoted mail, and the user's own typing is no
 * more sendable than that.
 */
export type ContextMenuSpellAction = 'replace' | 'add_to_dictionary'

/**
 * Native menu labels for the main process — read from the SAME locale
 * resources the renderer uses, not copied out of them.
 *
 * i18next itself does not run here (it is a renderer concern: React bindings,
 * a live language switch), but its DATA is plain JSON, and these imports are
 * inlined into the main bundle by vite at build time — no runtime file lookup,
 * so packaging and `app.asar` layout are irrelevant to it. The bundle carries
 * only what is used: vite emits the JSON as named exports and rollup drops the
 * rest of each locale, measured at +1.8 kB of main.js for all six languages
 * (the other ~420 kB of translations stay out). Bundle weight is therefore not
 * an argument for going back to a copy.
 *
 * WHY NOT A HAND-WRITTEN TABLE, as `WINDOW_TITLES` in main.ts still does. A
 * copy of the strings inside main is invisible to the only automated thing
 * that keeps languages in step: the i18n merge gate (CLAUDE.md §5) compares
 * key sets ACROSS src/i18n/locales/*.json and can only see what lives in those
 * files. Strings kept outside them fall behind silently — a translator editing
 * the JSON changes nothing, a maintainer editing the table leaves the JSON
 * stale, and neither is told. Reading the resources instead gives one source
 * of truth, and the `Record<ContextMenuLabelKey, string>` annotation below
 * turns a locale that drops one of these keys into a compile error.
 *
 * ADDING A LANGUAGE: add its locale file (the merge gate then requires the
 * `contextMenu.*` block in it, translated) and one line here. The line is not
 * left to memory either — contextMenu.test.ts walks src/i18n/locales/ on disk
 * and fails if a locale file exists that this dictionary does not cover, so a
 * forgotten line is a red test rather than a silently English menu.
 */
const CONTEXT_MENU_LABELS: Record<string, Record<ContextMenuLabelKey, string>> = {
  en: enLocale.contextMenu,
  ru: ruLocale.contextMenu,
  fr: frLocale.contextMenu,
  de: deLocale.contextMenu,
  es: esLocale.contextMenu,
  it: itLocale.contextMenu,
}

/** Labels for `lang`, falling back to English for an unknown language. */
export function contextMenuLabels(lang: string): Record<ContextMenuLabelKey, string> {
  return CONTEXT_MENU_LABELS[lang] ?? CONTEXT_MENU_LABELS.en
}

export interface ContextMenuDeps {
  /** Current UI language code, e.g. from `getSettings().language`. */
  getLanguage: () => string
  /**
   * The window's existing `mail:link` funnel. Omitted for surfaces with no
   * `mail:link` consumer — then no "open link" item is offered at all, instead
   * of offering one that silently does nothing.
   */
  emitMailLink?: (payload: MailLinkPayload) => void
  /**
   * §2.103 — apply a spelling replacement. Bound in {@link attachContextMenu}
   * to `webContents.replaceMisspelling`, which targets the focused frame's own
   * misspelling range. NOT our own text substitution: reconstructing "delete
   * from index i to j, insert s" in the renderer would have to re-find a word
   * that may have moved, and getting it wrong means silently corrupting the
   * user's message.
   */
  replaceMisspelling?: (text: string) => void
  /** §2.103 — add a word to the user's personal dictionary (session-scoped
   *  Chromium store, local file, never transmitted). */
  addToDictionary?: (word: string) => void
}

/**
 * Translate one plan item into an Electron menu template entry.
 *
 * Edit actions use Electron's built-in ROLES rather than hand-rolled
 * `webContents.cut()/copy()/paste()` calls: roles target the focused frame
 * (which is what makes Copy work for a selection inside the sandboxed message
 * iframe), carry the platform's own accelerator labels, and behave correctly
 * on macOS where edit commands are native. Roles ignore `click`, so no
 * per-action telemetry is attached to them — the aggregate
 * `ui.context_menu_shown` event below is the usage signal.
 */
function toTemplateItem(
  item: ContextMenuPlanItem,
  labels: Record<ContextMenuLabelKey, string>,
  deps: ContextMenuDeps,
): MenuItemConstructorOptions {
  switch (item.kind) {
    case 'separator':
      return { type: 'separator' }
    case 'openLink':
      return {
        label: labels.openLink,
        click: () => {
          try { recordEvent('ui.context_menu_link_action', { action: 'open' }) } catch { /* telemetry must not block */ }
          // The one and only route: the window's mail:link funnel. The
          // renderer evaluates the phishing warnings and, if the user
          // confirms, calls ui:openExternal — the same sequence as a click.
          deps.emitMailLink?.(item.link)
        },
      }
    case 'copyLinkAddress':
      return {
        label: labels.copyLinkAddress,
        click: () => {
          try { recordEvent('ui.context_menu_link_action', { action: 'copy_address' }) } catch { /* telemetry must not block */ }
          clipboard.writeText(item.address)
        },
      }
    case 'role':
      return { label: labels[item.labelKey], role: item.role, enabled: item.enabled }
    case 'spellSuggestion':
      return {
        // The suggestion is its own label — that is what a spelling menu is.
        // It comes from Chromium's dictionary, not from the message, but it is
        // still only ever DISPLAYED and handed back: see the click below.
        label: item.suggestion,
        click: () => {
          try { recordEvent('ui.context_menu_spell_action', { action: 'replace' }) } catch { /* telemetry must not block */ }
          // Through the PII boundary, not out into Electron's dispatch — see
          // the note on `addToDictionary` below for why an escaping throw here
          // is a disclosure and not merely an unhandled error.
          try { deps.replaceMisspelling?.(item.suggestion) }
          catch (err) { reportContextMenuFailure('action', err) }
        },
      }
    case 'addToDictionary':
      return {
        label: labels.addToDictionary,
        click: () => {
          try { recordEvent('ui.context_menu_spell_action', { action: 'add_to_dictionary' }) } catch { /* telemetry must not block */ }
          // `item.word` is `params.misspelledWord` — text from the MESSAGE, and
          // on a reply it is the sender's prose. A native call that throws may
          // quote its argument, and this callback is dispatched by Electron
          // outside the `context-menu` try/catch, so an escaping throw is
          // collected by the global `uncaughtException` handler in main.ts and
          // sent to Sentry RAW. That is mail content in telemetry (CLAUDE.md
          // §8), so the throw goes through this file's boundary instead
          // ({@link reportContextMenuFailure}), which reports literals only.
          try { deps.addToDictionary?.(item.word) }
          catch (err) { reportContextMenuFailure('action', err) }
        },
      }
  }
}

/**
 * Which step failed. Code-authored: the value is set by this file as the
 * handler advances, never derived from the error, so it can localise a fault
 * without describing what the step was working on.
 *
 * `plan` / `labels` / `build` / `popup` are stages of CONSTRUCTION, and they
 * share one try/catch because they run inside the `context-menu` event. `action`
 * is different in kind and that is why it is a separate value: the menu was
 * built and shown, and it is the invocation of a chosen item that threw — a
 * callback Electron dispatches LATER, on its own, with no enclosing try of ours
 * (see {@link toTemplateItem}).
 */
export type ContextMenuPhase = 'plan' | 'labels' | 'build' | 'popup' | 'action'

/**
 * Closed set of failure classes. Every value is a LITERAL in this file, so
 * nothing here can carry text regardless of what threw.
 */
export type ContextMenuErrorClass =
  | 'permission'
  | 'not_found'
  | 'io'
  | 'invalid_argument'
  | 'unknown'

/** Instanceof-derived error kind. Never `err.name` — that is assignable. */
export type ContextMenuErrorKind =
  | 'TypeError'
  | 'RangeError'
  | 'SyntaxError'
  | 'ReferenceError'
  | 'Error'
  | 'UnknownError'

/**
 * Allowlist of `err.code` values, mapped to the closed class set.
 *
 * The realistic sources are the settings store behind `deps.getLanguage`
 * (an `EACCES` on it was observed in the field) and Node/Electron argument
 * validation on the menu template. Lookup is on the UPPERCASED code against
 * this fixed map, so a code absent from it — including one some third-party
 * component made up — lands on `unknown` instead of travelling as a string.
 * The direction of failure is deliberately "less information", never "leak".
 *
 * No `cause` walk: the canonical seam (netErrorTelemetry.ts) classifies the
 * error it was handed and degrades, and a second traversal here would only
 * widen the input surface for signal we do not act on differently.
 */
const CONTEXT_MENU_CODE_CLASS: Readonly<Record<string, ContextMenuErrorClass>> = {
  EACCES: 'permission',
  EPERM: 'permission',
  EROFS: 'permission',
  ENOENT: 'not_found',
  ENOTDIR: 'not_found',
  EIO: 'io',
  EBUSY: 'io',
  EISDIR: 'io',
  ENOSPC: 'io',
  EMFILE: 'io',
  ENFILE: 'io',
  EAGAIN: 'io',
  ERR_INVALID_ARG_TYPE: 'invalid_argument',
  ERR_INVALID_ARG_VALUE: 'invalid_argument',
  ERR_OUT_OF_RANGE: 'invalid_argument',
}

/**
 * Map a thrown value onto the closed class set.
 *
 * Deliberately NOT a message regex: `err.message` is third-party text, and the
 * only reason a message-based classifier would be safe is that it returns
 * literals — a property of the return value, not of the input. Reading a
 * structured, code-set field keeps the input side narrow too, and the value is
 * used as a LOOKUP KEY only, never forwarded.
 */
export function classifyContextMenuError(err: unknown): ContextMenuErrorClass {
  const raw = (err as Record<string, unknown> | null | undefined)?.code
  const code = typeof raw === 'string' ? raw.toUpperCase() : ''
  if (code && Object.prototype.hasOwnProperty.call(CONTEXT_MENU_CODE_CLASS, code)) {
    return CONTEXT_MENU_CODE_CLASS[code]
  }
  return 'unknown'
}

/** Prototype-chain classification. `err.name` is a writable public property
 *  and an arbitrary throw can set it to anything, including PII. */
export function classifyContextMenuErrorKind(err: unknown): ContextMenuErrorKind {
  if (err instanceof TypeError) return 'TypeError'
  if (err instanceof RangeError) return 'RangeError'
  if (err instanceof SyntaxError) return 'SyntaxError'
  if (err instanceof ReferenceError) return 'ReferenceError'
  if (err instanceof Error) return 'Error'
  return 'UnknownError'
}

/**
 * The PII boundary for this file — the same construction, for the same reason,
 * as the canonical seam in ../services/netErrorTelemetry.ts.
 *
 * Sentry never receives the thrown value. Handing it the raw error would
 * transmit its message, its `cause` chain and its stack, and the text in there
 * is written by whatever component threw: an `EACCES` from the settings store
 * normally names a filesystem path, and a template rejection can quote what it
 * was given — which on this handler is mail-supplied. `scrubEventPii` in
 * `beforeSend` is the LAST line of defence, not the only one (CLAUDE.md §2.82):
 * it removes shapes it can recognise, and arbitrary exception text has no shape
 * a regex can recognise. So what leaves this function is a SYNTHETIC error
 * whose message, name and every attribute are literals or closed-set members
 * produced here.
 *
 * The raw error still goes to the LOCAL log, and stripping it there would be a
 * loss for nothing: that sink never leaves the machine, and it is the only
 * place a real diagnosis of a broken menu can start. It goes to `debug`, which
 * is console-only in dev and below the persisted file transport's `info`
 * threshold (see electron/logger.ts), so no third-party string reaches a file a
 * user might later attach to a report; the persisted `warn` line stays
 * aggregate-only.
 *
 * Never throws: it runs inside the catch of an Electron event handler
 * (CLAUDE.md §8 — telemetry must not break the feature it observes).
 */
export function reportContextMenuFailure(phase: ContextMenuPhase, err: unknown): void {
  try {
    const errorClass = classifyContextMenuError(err)
    try {
      log.warn('context menu failed', { phase, errorClass })
      log.debug(`context menu failed raw (${phase}, ${errorClass}):`, err)
    } catch { /* logging must never break telemetry */ }

    const sanitized = new Error(`context_menu_${phase}_${errorClass}`)
    sanitized.name = 'ContextMenuFailure'
    captureException(sanitized, {
      // `source` stays a top-level extra: electron/sentry.ts `beforeSend` reads
      // `extra.source` as a provenance marker.
      source: 'contextMenu',
      phase,
      error_class: errorClass,
      error_kind: classifyContextMenuErrorKind(err),
    })
  } catch { /* telemetry must never throw into Electron's event dispatch */ }
}

/**
 * Attach the native context menu to a window.
 *
 * Called once per window from `configureExternalLinks` in main.ts, which is
 * where the per-window `mail:link` funnel is built — so every surface gets the
 * menu through one uniform wiring point rather than incidentally.
 *
 * Failures are contained: a menu that cannot be built never throws into
 * Electron's event dispatch, and what it reports is aggregate — the step that
 * failed and a closed error class, never the URL, the selection or a
 * third-party message. See {@link reportContextMenuFailure} for the split
 * between what Sentry receives and what stays in the local log.
 */
export function attachContextMenu(win: BrowserWindow, deps: ContextMenuDeps): void {
  // §2.103 — the two spelling actions are bound to THIS window's own
  // webContents/session here rather than being threaded through main.ts. The
  // wiring point does not get to choose a different target: `replaceMisspelling`
  // must land in the frame the menu was raised over, and the personal
  // dictionary belongs to the session that flagged the word. Injectable for
  // tests, defaulted here so the call site stays as it was.
  const effective: ContextMenuDeps = {
    ...deps,
    replaceMisspelling: deps.replaceMisspelling ?? ((text: string) => {
      if (!win.isDestroyed()) win.webContents.replaceMisspelling(text)
    }),
    addToDictionary: deps.addToDictionary ?? ((word: string) => {
      if (!win.isDestroyed()) win.webContents.session.addWordToSpellCheckerDictionary(word)
    }),
  }
  win.webContents.on('context-menu', (_event, params) => {
    // Advanced as construction progresses, so a failure report can say WHICH
    // step broke without carrying anything that step was working on.
    let phase: ContextMenuPhase = 'plan'
    try {
      const plan = buildContextMenuPlan(params, { canRouteLinks: Boolean(deps.emitMailLink) })
      if (plan.length === 0) return

      phase = 'labels'
      const labels = contextMenuLabels(deps.getLanguage())

      phase = 'build'
      const menu = Menu.buildFromTemplate(plan.map(item => toTemplateItem(item, labels, effective)))
      if (win.isDestroyed()) return

      try {
        recordEvent('ui.context_menu_shown', { context: contextMenuContext(plan) })
      } catch { /* telemetry must not block */ }

      // Position: for a mouse-invoked menu Electron's default (the cursor) is
      // exactly right. A keyboard-invoked one (Menu key / Shift+F10) has no
      // meaningful cursor, so the params' window-relative coordinates are used
      // instead — otherwise the menu would appear wherever the pointer was
      // last left, possibly on another display.
      phase = 'popup'
      if (params.menuSourceType === 'keyboard') {
        menu.popup({ window: win, x: params.x, y: params.y })
      } else {
        menu.popup({ window: win })
      }
    } catch (err) {
      reportContextMenuFailure(phase, err)
    }
  })
}
