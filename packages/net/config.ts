import Store from 'electron-store'
import keytar from 'keytar'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { deleteAccountData } from '../db'
import type { AccountConfig, AccountMeta, FolderRoles, Identity } from './types'

export type Settings = {
  theme: 'light' | 'dark'
  /**
   * @deprecated §2.15-ter — ignored at runtime. Cache retention is now split
   * into two layers: the message INDEX (messages row + FTS) is kept forever
   * with a per-folder `index_in_search` toggle in `folder_prefs`, and the
   * full message BODIES (.eml files) are pruned per `bodyRetentionDays`
   * combined with `folder_prefs.offlineMode`. Field stays optional with a
   * default to keep persisted configs from existing users parseable.
   */
  cacheDays: number
  /**
   * Global retention window for downloaded message bodies (.eml files)
   * applied when a folder is in `offlineMode='full'`. Allowed values:
   * 30, 90, 180, 365 days, or -1 = forever. Default 365 (1 year).
   * For `offlineMode='period'`, the per-folder `offlineDays` takes
   * priority.
   */
  bodyRetentionDays?: number
  language: 'en' | 'ru' | 'fr' | 'de' | 'es' | 'it'
  /**
   * Master switch for new-mail desktop notifications. §2.99 moved the decision
   * and the presentation into the main process, but the switch is unchanged —
   * there is deliberately no second "background notifications" flag.
   */
  notificationsEnabled: boolean
  imapIdleEnabled: boolean
  draftSyncEnabled: boolean
  /**
   * §2.99 — show the system tray / status-bar icon. Default ON: it is the
   * surface that makes `closeToTray` recoverable, so it must exist before the
   * user can opt into closing to it.
   */
  trayEnabled?: boolean
  /**
   * §2.99 — closing the main window hides it instead of quitting. Default OFF
   * (opt-in behaviour change) and honoured ONLY while a tray icon actually
   * exists, so the app can never end up running with no way to bring it back.
   */
  closeToTray?: boolean
  /**
   * §2.99 — register the app to start on login. Default OFF. Applying it is a
   * platform capability, not a guarantee: on failure the flag stays as the user
   * set it and the main process reports the capability so the UI can degrade
   * honestly instead of throwing.
   */
  launchAtLogin?: boolean
  /**
   * §2.99 (review H4) — what the last autostart registration attempt actually
   * achieved.
   *
   * Main-only writable (`MAIN_ONLY_SETTINGS_FIELDS`), written by
   * `setLaunchAtLoginStatus` from `applyLaunchAtLoginSetting`. It exists
   * because `launchAtLogin` is a WISH and this is the OUTCOME: an unpackaged
   * build, a platform without the capability, or an unwritable autostart
   * directory all leave the wish standing while nothing was registered, and a
   * UI that shows only the wish is lying. `requested` is the state the attempt
   * tried to reach, so a stale record cannot be misread as describing the
   * current toggle.
   */
  launchAtLoginStatus?: { supported: boolean; applied: boolean; requested: boolean; at: string }
  /** Hotkeys preset: Gmail (default) or Outlook (Ctrl-like shortcuts). */
  hotkeysPreset?: 'gmail' | 'outlook'
  /** Send delay (Undo Send), seconds. 0 = disabled. */
  sendDelaySeconds?: number
  /** Always load external images in emails (Privacy Protection). */
  alwaysLoadImages?: boolean
  /** Show sender photos (Gravatar) in the mail list. */
  gravatarInMail?: boolean
  /** Group emails into threads (Conversation View). */
  groupConversations?: boolean
  /** Mail list sort mode. */
  sortMode?: 'date' | 'from' | 'subject'
  /** Auto-advance after archive/delete/snooze: open next email automatically. */
  autoAdvance?: 'off' | 'newer' | 'older' | 'back_to_list'
  /** Conversation card order in thread view. Default 'newest-top'. */
  conversationOrder?: 'newest-top' | 'oldest-top'
  /** Last selected account in UI */
  currentAccountId?: number
  /** Folders for which unread badges should NOT be shown */
  hiddenUnreadFolders?: string[]
  /** @deprecated Use per-folder offlineMode in folder_prefs instead */
  offlineEnabled?: boolean
  /** @deprecated Use per-folder offlineDays in folder_prefs instead */
  offlineSyncDays?: number
  /** Do not download emails larger than N KB (0 = no limit) */
  offlineMaxSizeKB?: number
  /** Maximum total EML cache size in MB (0 = unlimited) */
  offlineMaxTotalMB?: number
  /** @deprecated Use per-folder offlineMode in folder_prefs instead */
  offlineFolders?: string[]
  /**
   * AI provider. Mirrors `AiProvider` in electron/services/ai.ts — kept as a
   * literal so packages/net stays free of an electron import. All members are
   * key-based (BYOK); §2.218 removed the consumer-subscription member.
   */
  aiProvider?: 'anthropic-api' | 'openai-api' | 'gemini-api'
  /** AI model (default: sonnet) */
  aiModel?: string
  /** User has consented to sending data to the AI provider */
  aiPrivacyConsent?: boolean
  /** AI panel is open */
  aiPanelOpen?: boolean
  /** AI panel width (px) */
  aiPanelWidth?: number
  /** Send on Enter (true) or Ctrl+Enter (false) */
  aiSendOnEnter?: boolean
  /** Base URL of OpenAI-compatible API (OpenRouter, LiteLLM, etc.). Default: https://api.openai.com */
  aiOpenAiBaseUrl?: string
  /** HTTP(S) proxy URL for AI requests (e.g. http://proxy.company.local:3128) */
  aiProxyUrl?: string
  /** AI response language */
  aiLocale?: 'auto' | 'ru' | 'en'
  /** Show sources block in AI response */
  aiShowSources?: boolean
  /** Daily AI budget limit (USD) */
  aiDailyBudgetUsd?: number
  /** Monthly AI budget limit (USD) */
  aiMonthlyBudgetUsd?: number
  /** Max tool_use cycles per single AI request */
  aiMaxTurns?: number
  /** Max budget per single AI request (USD), API providers only */
  aiMaxBudgetPerRequest?: number
  /**
   * §2.122 — per-provider "an API key for this provider was saved at some
   * point" marker. NEVER the key itself, never a fragment or a hash of it:
   * a boolean and nothing more.
   *
   * OBSERVABILITY, NOT ENFORCEMENT (CLAUDE.md §5 "Кто владеет правдой"). The
   * OS secret store owns the truth about whether a key exists; this flag is
   * our own recollection of having written one. It is allowed to influence
   * exactly two things: the wording of the message the user sees, and
   * telemetry. It MUST NOT gate saving, gate the assistant, trigger a delete
   * or a re-auth, or stand in for a real key read. A disagreement
   * (`flag = true`, store empty) turns "no key" into "there was one and it is
   * gone — enter it again", and forbids nothing.
   *
   * Main-only writable (`MAIN_ONLY_SETTINGS_FIELDS`): written by
   * `setAiApiKeySavedFlag` from the main-process save/delete paths in
   * electron/services/ai.ts, deliberately absent from
   * `rendererWritableSettingsSchema`.
   */
  aiApiKeySaved?: {
    'anthropic-api'?: boolean
    'openai-api'?: boolean
    'gemini-api'?: boolean
  }
  /** Global offline mode — disables all network access */
  workOffline?: boolean
  /** Extended debug logging in main/electron-log */
  debugLogging?: boolean
  /**
   * Send diagnostic and usage data to Sentry. NOT anonymous: every event
   * carries the stable per-install identifier (electron/installId.ts), which
   * is pseudonymisation, not anonymisation.
   *
   * This is the Settings → About switch — the GDPR art. 7(3) withdrawal path,
   * so it stays renderer-writable. It is NOT by itself permission to send:
   * telemetry flows only when this is not `false` AND `telemetryConsent`
   * records an active grant for the current disclosure version (see
   * `isTelemetryAllowed` in electron/telemetryConsent.ts).
   */
  sentryEnabled?: boolean
  /**
   * §2.82 — proof of the user's answer on the first-run telemetry consent
   * screen.
   *
   * Main-only writable. The renderer asks for the state and reports the click
   * through `telemetry:consentState` / `telemetry:setConsent`; `version` and
   * `at` are stamped by the main process, never taken from the renderer
   * payload, and `settings:save` rejects this field outright
   * (`MAIN_ONLY_SETTINGS_FIELDS`). A renderer that could write it would be
   * able to manufacture consent it never obtained.
   *
   * Absent means "not answered yet" → nothing is sent and the screen runs
   * once. `version` pins the answer to the DISCLOSED COMPOSITION of collected
   * data (`TELEMETRY_CONSENT_VERSION`); widening the composition bumps it and
   * re-asks exactly once, which is the only lawful reason to show the screen
   * again (ePrivacy art. 5(3), GDPR art. 4(11)).
   */
  telemetryConsent?: { granted: boolean; version: number; at: string }
  /** Background polling sync interval (minutes, 1-30). With IMAP IDLE, this is just a safety net. */
  syncIntervalMinutes?: number
  /** Periodic folder sync interval (minutes, 1-60). Syncs folders with headerSyncMode full/period. */
  periodicSyncIntervalMin?: number
  /** Enable MCP export server on localhost */
  mcpExportEnabled?: boolean
  /** MCP export server port */
  mcpExportPort?: number
  /**
   * Whitelist of tool names to export (default: `DEFAULT_EXPORT_WHITELIST`,
   * read-only tools). §2.158: values outside `EXPORTABLE_MCP_TOOLS` are
   * rejected on the renderer-writable path and dropped at server start —
   * this field can narrow the exported surface, never widen it.
   */
  mcpExportWhitelist?: string[]
  /**
   * Allow stdio MCP transport (spawning local processes).
   *
   * SECURITY (§3.10 P0): not writable from the renderer. Flipping stdio on
   * requires either the `MAILCOPILOT_ENABLE_STDIO_MCP=1` developer env flag
   * (read on every `isStdioMcpEnabled()` check — not persisted) or an
   * explicit native dialog confirmation issued from the main process (see
   * `stdioApproved` below). The renderer never writes this field; attempts
   * to include it in a `settings:save` payload are rejected by
   * `rendererWritableSettingsSchema` with `{ ok: false, reason: 'forbidden_field' }`.
   */
  mcpEnableStdio?: boolean
  /**
   * Proof that stdio MCP was approved by the user via a native dialog.
   *
   * Main-only writable. Persists the source of the approval and when it
   * happened so the gate can be invalidated across app upgrades (an approval
   * granted in v1.20 should not silently carry over into v2.0 after a
   * dramatic change in stdio behaviour; we require re-confirmation). The
   * `appVersion` field pins the grant to the running version at the time.
   *
   * The `source: 'env'` variant is synthesized at runtime when
   * `MAILCOPILOT_ENABLE_STDIO_MCP=1` is set; it is not persisted (env state
   * changes between runs and must be re-checked on every call site).
   */
  stdioApproved?: { source: 'native-confirm'; approvedAt: string; appVersion: string }
  /** External MCP server connections */
  mcpConnections?: McpConnectionConfig[]
  /**
   * AI outbound egress policy (§3.10 P1).
   *
   * Controls whether `WebSearch`, `WebFetch`, and external MCP bridge tools
   * (`list_external_tools` / `call_external_tool`) are available to the AI
   * when user email data is in the request scope (selected email, thread,
   * folder, attachments — or any prior email-data MCP tool call in the
   * current session via taint propagation).
   *
   *   - `'default-deny'` (default) — egress disabled when email data is in
   *     scope; per-request consent unlocks for one turn.
   *   - `'ask'` — same data flow as `default-deny`; renderer may render an
   *     inline ask UI (vs a pre-arming chip).
   *   - `'allow'` — egress always available (power-user mode). Logged.
   *
   * See `electron/services/aiEgressPolicy.ts` for the full policy and
   * threat model.
   */
  aiEgressPolicy?: 'default-deny' | 'ask' | 'allow'
  /** Trusted domains that won't trigger misdirection warnings (newline-separated) */
  trustedDomains?: string
  /** Registered as default mailto: handler */
  defaultMailApp?: boolean
  /**
   * §2.19 — when true, electron-updater downloads updates in the background
   * without explicit user click. Default false: opt-in. Read at startup
   * AND on every settings:save (the runtime observer in main.ts flips
   * `autoUpdater.autoDownload` without restart).
   */
  autoUpdateEnabled?: boolean
  /**
   * §3.3 B2 — Thread AI Summary opt-in, PER ACCOUNT. Keyed by account id
   * (stringified because electron-store JSON object keys are strings). A value
   * of `true` opts that account in; a missing/`false` entry means the feature
   * is OFF for the account. Default OFF everywhere (empty/undefined map). The
   * main-side `ai:threadSummary:generate` handler gates on this map before
   * generating; the Settings toggle (renderer) writes the same key. Renderer-
   * writable (see `rendererWritableSettingsSchema`) — it is a plain UX opt-in,
   * not a security-sensitive flag like stdio MCP.
   */
  aiThreadSummaryEnabled?: Record<string, boolean>
  /**
   * §3.3 B4 — per-account Instant Reply opt-in map (accountId → enabled). An
   * explicit entry of `true` opts that account in; a missing/`false` entry means
   * the feature is OFF for the account. Default OFF everywhere (empty/undefined
   * map). The main-side `ai:instantReply:generate` handler / `ai.ts` generator
   * gate on this map before generating drafts; the Settings toggle (renderer)
   * writes the same key. Renderer-writable (see `rendererWritableSettingsSchema`)
   * — a plain UX opt-in, not a security-sensitive flag like stdio MCP. (Quick
   * actions have no separate opt-in — they run under the normal AI gate.)
   */
  aiInstantReplyEnabled?: Record<string, boolean>
  /**
   * §3.3 B7 — per-account AI Proofread opt-in map (accountId → enabled). An
   * explicit entry of `true` opts that account in; a missing/`false` entry means
   * the feature is OFF for the account. Default OFF everywhere. The `ai.ts`
   * seam gates on this map before any provider call and refuses with its own
   * `not_enabled` reason (never `no_provider` — the actionable fix is a toggle,
   * not a provider key). Renderer-writable, like the other two AI opt-ins: a
   * plain UX preference, not a security-sensitive flag. The toggle cannot
   * enable anything on its own — the path it unblocks still needs a configured
   * provider and available budget.
   */
  aiProofreadEnabled?: Record<string, boolean>
  /**
   * §3.3 B6 — per-account AI Translate opt-in map (accountId → enabled). An
   * explicit entry of `true` opts that account in; a missing/`false` entry means
   * the feature is OFF for the account. Default OFF everywhere. The main-side
   * translate generator gates on this map before any provider call and refuses
   * with its own `opt_out` reason (never `no_provider` — the actionable fix is a
   * toggle, not a provider key, §3.3.B4.f3(a)). Renderer-writable, like the
   * other AI opt-ins: a plain UX preference, not a security-sensitive flag. The
   * toggle cannot enable anything on its own — the path it unblocks still needs
   * a configured provider and available budget, and translation is never
   * automatic: it happens only on an explicit user action.
   */
  aiTranslateEnabled?: Record<string, boolean>
  /**
   * §2.103 — spell checking, master switch. Default OFF, and the default is
   * the point.
   *
   * Chromium's own default is the opposite: `webPreferences.spellcheck` is
   * `true`, and an empty language list makes Electron populate it from the OS
   * locale on launch and FETCH that hunspell dictionary from Google's CDN (see
   * `DICTIONARY_DOWNLOAD_ORIGIN` in electron/services/spellcheck.ts). That is a
   * silent request to a third party on first launch, which this product's
   * stated posture (`aiEgressPolicy: 'default-deny'`) does not permit. So the
   * spellchecker is armed only by an explicit user action, and on the
   * downloading platforms only after the per-language consent below.
   *
   * Renderer-writable: it is a plain preference. The flag by itself cannot
   * BYPASS a recorded consent — `spellcheckLanguages` is what selects
   * dictionaries, and main filters that list against
   * `spellcheckDictionaryConsent` before it reaches a session. (It is not
   * "cannot cause a download": flipping this on re-activates a list the user
   * already chose and already consented to, which may well fetch. That is the
   * consent working, not a hole in it.)
   */
  spellcheckEnabled?: boolean
  /**
   * §2.103 — dictionaries the spellchecker is enabled for, as Chromium
   * language codes (`en-US`, `ru-RU`, …). Several at once: mixed-language
   * mail is the normal case.
   *
   * The value domain is owned by Chromium (`availableSpellCheckerLanguages`),
   * not by us — a hardcoded mirror of someone else's set drifts (§2.167). Main
   * intersects this list with the live availability list before it reaches the
   * session, so an entry an older build persisted is inert rather than fatal.
   *
   * Renderer-writable, but NOT sufficient on its own: a language whose
   * dictionary would have to be downloaded is dropped by `settings:save` unless
   * `spellcheckDictionaryConsent` already carries it, or the user accepts the
   * native prompt during that save.
   */
  spellcheckLanguages?: string[]
  /**
   * §2.103 — the languages whose dictionary DOWNLOAD the user has agreed to,
   * and when they last agreed.
   *
   * Main-only writable (`MAIN_ONLY_SETTINGS_FIELDS`). This is the record of a
   * human answering a native dialog drawn by main; a renderer able to write it
   * could grant itself the download it was supposed to ask about, which is the
   * whole of the protection. Same reasoning as `telemetryConsent` and
   * `stdioApproved`.
   *
   * Absent means "never asked" — not "refused". A refusal is not persisted:
   * declining leaves the language unselected, and the user has to pick it again
   * to be asked again (electron/services/spellcheck.ts).
   */
  spellcheckDictionaryConsent?: { granted: string[]; at: string }
  /**
   * §2.103 — main's report of what the platform's spellchecker actually
   * offers. Main-only writable, refreshed on every launch.
   *
   * It exists so the Settings window can render the picker from the REAL list
   * (`session.availableSpellCheckerLanguages`) without a new IPC channel and
   * without a second, drifting copy of Chromium's language set in the renderer
   * — the same "main reports, renderer displays" shape as `launchAtLoginStatus`.
   *
   * `platformOwned` is true on macOS, where the OS spellchecker owns the
   * language list and `setSpellCheckerLanguages` is a documented no-op. There
   * the picker is not shown at all: offering a control that changes nothing is
   * the failure mode CLAUDE.md §5 "Кто владеет правдой" describes.
   *
   * `max` carries {@link SPELLCHECK_MAX_LANGUAGES} for the same reason the
   * language list is carried: the renderer cannot import this module (it pulls
   * electron-store, keytar and packages/db), and a hand-copied constant on the
   * other side is a drifting mirror of a bound main enforces. Reported, not
   * duplicated.
   */
  spellcheckAvailable?: { languages: string[]; platformOwned: boolean; max: number; at: string }
}

export type McpConnectionConfig = {
  id: string
  name: string
  transport: 'sse' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled: boolean
  autoConnect: boolean
  /**
   * Per-connection approval marker for stdio transport (§3.10 P0).
   *
   *   - `'env'` — approval inherited from `MAILCOPILOT_ENABLE_STDIO_MCP=1`
   *     (developer / CI mode). Synthesized in-memory; main does not persist
   *     this value. If the env flag is gone on the next run, the synthesized
   *     'env' approval also disappears and the connection reverts to
   *     unapproved.
   *   - `'native-confirm'` — user clicked through the native dialog shown
   *     via `mcp:approveStdioConnection`. Persists across runs, cleared on
   *     app version change and on connection edit (command/args mutation).
   *   - `null` or `undefined` — unapproved. `mcp:connect` refuses to launch.
   *
   * SSE connections ignore this field; they're always allowed on loopback.
   */
  approvedSource?: 'env' | 'native-confirm' | null
}

/**
 * Built-in command allowlist for stdio MCP (§3.10 P0).
 *
 * A compromised renderer that crafts an `mcp:saveConnection` payload with
 * an arbitrary `command` cannot put an attacker-chosen binary into the
 * connection list: the write handler rejects anything outside this list
 * (see `isAllowedMcpStdioCommand`). Each of these commands is a well-known
 * MCP-server runtime that the user would plausibly pick on purpose; even
 * saving one still requires the native-confirm `approvedSource` step
 * before the subprocess is actually spawned on `mcp:connect`.
 *
 * Keep the list narrow. Extending it needs a security review because each
 * added entry is a local-process spawn surface the renderer can now
 * trigger (gated by approval, but still a surface).
 */
export const DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST = [
  'node',
  'npx',
  'python',
  'python3',
  'uv',
  'uvx',
  'bun',
  'deno',
] as const

/**
 * Returns true when `command` is in the built-in MCP stdio allowlist.
 * Comparison is exact (no basename/path traversal) — if a caller supplies
 * `/usr/bin/node` instead of `node`, it is intentionally rejected. Stdio
 * commands are PATH-resolved by the spawned transport, so using bare names
 * only is the clean happy path.
 */
export function isAllowedMcpStdioCommand(command: string): boolean {
  return (DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST as readonly string[]).includes(command)
}

/**
 * Env-key denylist for per-connection stdio `env` overrides (§3.10 P0
 * reinforcement — wave 2 security-reviewer finding).
 *
 * Rationale. The stdio allowlist + approval dialog together guard against a
 * compromised renderer spawning arbitrary binaries. But once `command` is
 * nailed down (e.g. `node`), the attacker can still subvert what the runtime
 * does at startup by setting "loader" env vars BEFORE the user-approved
 * entry-point runs:
 *   - `NODE_OPTIONS=--require /tmp/evil.js` — Node preloads the attacker's
 *     module before it parses the approved script, giving full RCE within
 *     the subprocess user context.
 *   - `PYTHONSTARTUP=/tmp/evil.py` — analogous for CPython REPL init.
 *   - `LD_PRELOAD=/tmp/evil.so` / `DYLD_INSERT_LIBRARIES=...` —
 *     libc-level injection on Linux / macOS.
 *   - `BUN_CONFIG_PRELOAD=...`, `DENO_DIR=...` — runtime-specific variants.
 *   - `PATH=...` — lets the attacker shadow the approved command with a
 *     sibling binary the transport resolves instead of the real runtime.
 *
 * These keys never have a legitimate "user wants to share this with the MCP
 * server" reason in a configured connection context — they exist to modify
 * *how* the interpreter bootstraps, which is precisely what the approval
 * dialog showed the user we would NOT be doing. Rejecting them at the schema
 * layer means both the renderer-write path (`mcpSaveConnectionSchema`) and
 * the persisted read path (`mcpConnectionSchema`) refuse to hand back a
 * config with poisoned env, closing the "poison after approval" vector too.
 *
 * Keep the list synced with any new runtime we add to
 * `DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST` — each interpreter tends to ship its
 * own loader-hook env var.
 *
 * The check is case-insensitive: env var names are case-sensitive on Linux
 * and macOS but Windows normalizes to upper-case at process level, and we do
 * not want a platform-specific bypass (e.g. `nOdE_OpTiOnS` on Linux —
 * ineffective — routed through a Windows code path that would uppercase it
 * on spawn). Cheap and safe to reject both.
 */
export const FORBIDDEN_MCP_STDIO_ENV_KEYS = [
  // Node.js loader hooks / module resolution
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  // Python loader hooks / module resolution
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONDONTWRITEBYTECODE',
  // Deno runtime cache / module dir
  'DENO_DIR',
  // Bun loader hooks
  'BUN_CONFIG_PRELOAD',
  // Dynamic linker injection (Linux / macOS)
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  // Command resolution — shadowing allowlisted binaries with attacker paths
  'PATH',
] as const

const FORBIDDEN_MCP_STDIO_ENV_KEYS_UPPER = new Set(
  FORBIDDEN_MCP_STDIO_ENV_KEYS.map(k => k.toUpperCase()),
)

/**
 * Returns true when `key` names an env var that is never allowed in a
 * per-connection stdio `env` override. Also rejects any `BUN_CONFIG_*` key
 * as a conservative prefix — Bun adds config vars over time, and any of
 * them can change how the interpreter bootstraps.
 */
export function isForbiddenMcpStdioEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (FORBIDDEN_MCP_STDIO_ENV_KEYS_UPPER.has(upper)) return true
  // Conservative prefix guard for Bun config surface (new keys appear
  // across Bun versions). Narrowly scoped so benign vendor env prefixes
  // aren't caught.
  if (upper.startsWith('BUN_CONFIG_')) return true
  return false
}

/**
 * Zod refinement helper shared by both the renderer-write schema and the
 * persisted-read schema. Returns the set of offending keys (empty if env
 * is absent or clean). Callers convert this into `.refine()` results or
 * explicit IPC rejections as appropriate.
 */
export function findForbiddenMcpStdioEnvKeys(
  env: Record<string, string> | undefined,
): string[] {
  if (!env) return []
  const hits: string[] = []
  for (const key of Object.keys(env)) {
    if (isForbiddenMcpStdioEnvKey(key)) hits.push(key)
  }
  return hits
}

/**
 * Refinement attached to both `mcpConnectionSchema` and
 * `mcpSaveConnectionSchema` via `.superRefine`. Rejects any env key on the
 * denylist with a structured issue whose `path` points at the offending
 * key (so zod error.issues[].path[] flushes back to the renderer with
 * enough info to highlight the row in the env editor).
 */
function refineMcpStdioEnvKeys(
  value: { env?: Record<string, string> | undefined },
  ctx: { addIssue: (issue: { code: 'custom'; message: string; path: (string | number)[] }) => void },
): void {
  const hits = findForbiddenMcpStdioEnvKeys(value.env)
  for (const key of hits) {
    ctx.addIssue({
      code: 'custom',
      message: `env key "${key}" is not allowed in stdio MCP connections (loader-hook / PATH-shadowing risk)`,
      path: ['env', key],
    })
  }
}

/**
 * Result of sanitizing an `mcpConnections` array for forbidden env keys.
 *
 * - `sanitized` — the same array shape as the input, but with forbidden env
 *   keys stripped from each connection's `env` map. Non-connection entries
 *   and unrelated fields are preserved verbatim so the caller can re-run
 *   `settingsSchema.parse()` and get a clean pass on the env path without
 *   losing any legitimate settings.
 * - `stripped` — audit record: one entry per `(connection id, stripped env
 *   key)` pair. Callers aggregate this into a single audit log event rather
 *   than logging per-connection to avoid log spam during multi-connection
 *   migrations.
 *
 * Input `rawMcpConnections` is `unknown` because we call this on raw store
 * JSON which has not yet been parsed by zod (that parse is what we're
 * trying to rescue). The helper tolerates anything that doesn't shape like
 * an array of objects with an `env` key — it simply returns the input
 * unchanged and an empty `stripped` list.
 */
export type SanitizeMcpConnectionsEnvResult = {
  sanitized: unknown
  stripped: Array<{ id: string | undefined; key: string }>
}

export function sanitizeMcpConnectionsEnv(
  rawMcpConnections: unknown,
): SanitizeMcpConnectionsEnvResult {
  if (!Array.isArray(rawMcpConnections)) {
    return { sanitized: rawMcpConnections, stripped: [] }
  }
  const stripped: Array<{ id: string | undefined; key: string }> = []
  const sanitized = rawMcpConnections.map(conn => {
    if (!conn || typeof conn !== 'object') return conn
    const obj = conn as Record<string, unknown>
    const env = obj.env
    if (!env || typeof env !== 'object' || Array.isArray(env)) return conn
    const envObj = env as Record<string, unknown>
    const cleanEnv: Record<string, unknown> = {}
    let stripCount = 0
    for (const [key, value] of Object.entries(envObj)) {
      if (isForbiddenMcpStdioEnvKey(key)) {
        stripped.push({
          id: typeof obj.id === 'string' ? obj.id : undefined,
          key,
        })
        stripCount++
        continue
      }
      cleanEnv[key] = value
    }
    if (stripCount === 0) return conn
    return { ...obj, env: cleanEnv }
  })
  return { sanitized, stripped }
}

/**
 * Wave-3 migration audit hook. `getSettings()` calls this exactly once per
 * launch when the sanitization path fires (i.e. the raw persisted
 * mcpConnections contain forbidden env keys from before the wave-2 gate).
 * main.ts wires a listener that logs + appends an audit row; packages/net
 * itself stays layer-pure (no electron-log / no DB imports).
 *
 * The handler is called with the aggregated `stripped` list for the whole
 * settings record, not per-connection, so the audit pipeline sees one
 * event per launch rather than N events.
 */
export type McpEnvSanitizationListener = (event: {
  stripped: Array<{ id: string | undefined; key: string }>
}) => void

let mcpEnvSanitizationListener: McpEnvSanitizationListener | null = null

export function setMcpEnvSanitizationListener(
  listener: McpEnvSanitizationListener | null,
): void {
  mcpEnvSanitizationListener = listener
}

function notifyMcpEnvSanitization(
  stripped: Array<{ id: string | undefined; key: string }>,
): void {
  if (!mcpEnvSanitizationListener) return
  try {
    mcpEnvSanitizationListener({ stripped })
  } catch {
    // Migration audit must never throw out of the settings-load path —
    // a broken listener cannot be allowed to crash the boot.
  }
}

const service = 'mailcopilot'
// Explicitly set projectName so electron-store works correctly both in bundle (vite/electron) and in e2e.
// For e2e/data isolation we use MAILCOPILOT_DATA_DIR if set.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeOptions: any = {
  name: 'settings',
  // electron-store hides `projectName` in types, but this option is needed in build/tests,
  // otherwise the store may crash with "Please specify projectName" error.
  projectName: 'mailcopilot',
}
if (process.env.MAILCOPILOT_DATA_DIR) {
  const dir = process.env.MAILCOPILOT_DATA_DIR
  fs.mkdirSync(dir, { recursive: true })
  storeOptions.cwd = path.resolve(dir)
}
const store = new Store<{ accounts?: AccountMeta[]; account?: AccountConfig; settings?: unknown }>(storeOptions)

const hostSchema = z.string().min(1)
const portSchema = z.number().int().positive()
const boolSchema = z.boolean()
const userSchema = z.string().min(1)
const passSchema = z.string().min(1)
const tlsPinsSchema = z.array(z.string().min(1)).optional()
/**
 * PEM bodies of the pinned certificates, kept alongside their SHA-256
 * fingerprints. Load-bearing for self-signed / private-CA servers:
 * `buildTlsOptions` (./tls) feeds them to Node as explicit trust anchors,
 * which is what lets such a server verify WITHOUT weakening
 * `rejectUnauthorized`. Without this field in the schema a `.parse()` would
 * silently strip it and pinned self-signed accounts would stay fail-closed.
 *
 * Form-only validation, deliberately symmetric to `tlsPinsSchema`: content
 * validation lives in packages/db (the writer). A malformed anchor must
 * degrade to a failed TLS handshake — which the cert-error UX surfaces — and
 * NOT to a rejected account config, where one bad string would make the whole
 * account disappear from the app.
 */
const tlsPinnedCertsPemSchema = z.array(z.string().min(1)).optional()
/**
 * Inner object shape — exported so main.ts (and other consumers that need
 * `.extend()` / `.strict()`) can layer additional IPC-scoped refinements on
 * top and still apply the shared env-key denylist as a terminal
 * `.superRefine()`. Direct parse callers should use `mcpConnectionSchema`
 * below, which has the denylist pre-attached.
 */
export const mcpConnectionObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(['sse', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(),
  autoConnect: z.boolean(),
  // Persisted approval marker for stdio transport. Incoming renderer writes
  // MUST NOT set anything but `null` or omit it — the 'env' / 'native-confirm'
  // values are granted only by main (`mcp:approveStdioConnection` /
  // env-gate synthesis). A stricter schema for renderer writes lives in
  // `mcpSaveConnectionSchema` below.
  approvedSource: z.enum(['env', 'native-confirm']).nullable().optional(),
})

export const mcpConnectionSchema = mcpConnectionObjectSchema.superRefine(refineMcpStdioEnvKeys)

/**
 * Renderer-write schema for `mcp:saveConnection` (§3.10 P0).
 *
 * Renderer payloads must not seed an approval. Any incoming `approvedSource`
 * value is ignored; main re-computes the correct marker based on transport
 * type and environment:
 *   - SSE: no approval needed (loopback-only).
 *   - stdio + env flag: main stamps `approvedSource: 'env'` at connect time
 *     (not persisted, re-derived on each `isStdioMcpEnabled()` check).
 *   - stdio + no env flag: main persists `approvedSource: null` and waits
 *     for `mcp:approveStdioConnection` to upgrade to `'native-confirm'`.
 *
 * Additionally the stdio command must be in
 * `DEFAULT_MCP_STDIO_COMMAND_ALLOWLIST`. That check is not part of this
 * schema (it's a non-zod runtime assertion in the main handler) because the
 * allowlist may grow over time and we want a precise error code
 * (`unapproved_command`) rather than a generic zod parse failure.
 */
/**
 * Inner strict object — exported so main.ts can `.extend()` with IPC-scoped
 * `.url()` validation and still compose the env denylist refinement at the
 * end. See `mcpConnectionObjectSchema` for the rationale on splitting raw
 * shape from refined schema.
 */
export const mcpSaveConnectionObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(['sse', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(),
  autoConnect: z.boolean(),
  // Explicitly strip any renderer-supplied approval seed. Treating this as a
  // forbidden field (zod `.strict()` with no approvedSource key) would make
  // legitimate post-approval re-saves churn between "allowed with marker"
  // and "allowed without marker" depending on whether the caller remembers
  // to remove it. Easier: accept-and-ignore.
  approvedSource: z.enum(['env', 'native-confirm']).nullable().optional(),
}).strict()

export const mcpSaveConnectionSchema =
  mcpSaveConnectionObjectSchema.superRefine(refineMcpStdioEnvKeys)

/**
 * RFC 4122 UUID regex. Accepts canonical v1-v8 UUIDs plus the nil/max
 * sentinels. `crypto.randomUUID()` returns v4, which matches. Used to guard
 * incoming identity ids against arbitrary renderer-supplied strings (M1).
 */
const UUID_REGEX = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value)
}

/**
 * Per-account sending identity (2.3-A). See `Identity` type JSDoc for the full
 * product contract. The zod schema here is the runtime source of truth; the
 * TS type in `packages/types/account.ts` is the structural mirror used by
 * consumers that cannot pull in zod (e.g. renderer components).
 *
 * WRITE-SIDE (strict — `identitySchema`). Used by `identitiesArraySchema` and
 * by the HIGH-3 re-validation pass on `existing.identities`:
 *   - `id` is required non-empty. NOT UUID-strict at this layer because
 *     legacy records migrated from pre-2.3-A storage may carry non-UUID ids
 *     (e.g. the first read-side synthesis before this module enforced UUID).
 *     Forcing UUID here would churn ids on the first re-save after migration
 *     and break the "ids stable across saves" invariant. UUID enforcement
 *     for renderer-supplied payloads lives in `accountSaveSchema` below.
 *   - `displayName` and `email` are non-empty; `email` must be RFC-valid.
 *   - `signature` / `defaultBcc` are optional; empty string is tolerated on
 *     BOTH so the save path can distinguish "cleared by user" (empty) from
 *     "not submitted" (undefined — no change to existing value). The
 *     Identities tab emits `defaultBcc: ''` verbatim when the user empties
 *     the field; `.min(1)` here would reject the clear signal and the entire
 *     `accounts:save` IPC would fail, locking users out of clearing the
 *     default Bcc once it has been set.
 *
 * READ-SIDE (permissive — `identityReadSchema`). Used by `accountMetaSchema`:
 *   - Same structure, but `email` allows any non-empty string. Legacy records
 *     predate the strict validator and may synthesize an identity whose email
 *     falls back to a bare IMAP username (no `@`). Rejecting those on read
 *     would lock users out of their accounts; the write path applies strict
 *     validation on the first re-save (see HIGH-3 reconciliation).
 *
 * RENDERER-FACING (strictest — `accountSaveSchema.identities[].id`). Only the
 *   incoming IPC payload enforces UUID format on `id`. A compromised renderer
 *   cannot forge `id: "attacker-controlled"` because the write-side schema
 *   rejects it at parse time. Legitimate callers pass either `crypto.randomUUID()`
 *   or `undefined` (server fills in a UUID via `normalizeIdentities`).
 */
export const identitySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(1),
  email: z.string().trim().email(),
  // Accept empty string so "user cleared the signature" survives round-trip
  // as a distinct state from "not submitted / preserve existing value".
  signature: z.string().optional(),
  // Same clear-vs-unset contract as signature: the Identities tab forwards
  // an empty `defaultBcc` verbatim to signal "the user emptied the field".
  // `.trim()` normalizes whitespace-only input to '' (consistent with the
  // other trimmed fields); empty string is then the canonical "cleared"
  // sentinel, distinct from `undefined` which means "not submitted".
  defaultBcc: z.string().trim().optional(),
  isDefault: z.boolean(),
})

const identityReadSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(1),
  email: z.string().trim().min(1),
  // Tolerate empty-string signatures on read so records written after the
  // BLOCKER fix (empty signature = explicit clear) round-trip through
  // listAccounts without being rejected.
  signature: z.string().optional(),
  // Symmetric with identitySchema: empty string is a legitimate persisted
  // state meaning "user cleared the default Bcc" and must round-trip through
  // listAccounts. `.trim()` normalizes whitespace-only values.
  defaultBcc: z.string().trim().optional(),
  isDefault: z.boolean(),
})

/** Strict write-side array schema — exported for tests. */
export const identitiesArraySchema = z.array(identitySchema)
  .min(1, 'at least one identity required')
  .refine(
    (items) => items.filter(i => i.isDefault).length === 1,
    { message: 'exactly one identity must have isDefault: true' },
  )
  .refine(
    (items) => new Set(items.map(i => i.id)).size === items.length,
    { message: 'identity ids must be unique' },
  )

const identitiesReadArraySchema = z.array(identityReadSchema)
  .min(1, 'at least one identity required')
  .refine(
    (items) => items.filter(i => i.isDefault).length === 1,
    { message: 'exactly one identity must have isDefault: true' },
  )
  .refine(
    (items) => new Set(items.map(i => i.id)).size === items.length,
    { message: 'identity ids must be unique' },
  )

/**
 * Synthesize a single default identity from legacy top-level account fields.
 * Used by both the read-side migration (when persisted record has no
 * `identities[]`) and the write-side normalization (when incoming save payload
 * has no `identities[]` but carries legacy `signature` / `name` / `email`).
 *
 * Pure, no I/O. The synthesized identity must pass `identitySchema`, which
 * means `displayName` and `email` are required non-empty strings. We fall
 * back to the email local-part for display name when the account has no
 * `name` — this matches the UI convention already used in `MailItem` /
 * `Sidebar` (where `meta.name || meta.imap.user` is shown). Caller must
 * supply a usable `email` (any read-side call site has `imap.user` as a
 * last-resort fallback).
 */
function synthesizeDefaultIdentity(input: {
  displayName?: string | null
  email?: string | null
  signature?: string | null
  defaultBcc?: string | null
}): Identity {
  const rawEmail = (input.email ?? '').trim()
  const rawDisplayName = (input.displayName ?? '').trim()
  // Fallback: email local-part ("alice" for "alice@example.com"), or the full
  // email when there's no '@' (shouldn't happen on real data, but keeps the
  // synthesis total).
  const emailLocalPart = rawEmail.includes('@') ? rawEmail.split('@')[0] : rawEmail
  const displayName = rawDisplayName || emailLocalPart || rawEmail
  const signature = input.signature?.trim() || undefined
  const defaultBcc = input.defaultBcc?.trim() || undefined
  return {
    id: randomUUID(),
    displayName,
    email: rawEmail,
    signature,
    defaultBcc,
    isDefault: true,
  }
}

export const imapSchema = z.object({
  host: hostSchema,
  port: portSchema,
  secure: boolSchema,
  user: userSchema,
  pass: passSchema.optional(),
  tlsPinsSha256: tlsPinsSchema,
  tlsPinnedCertsPem: tlsPinnedCertsPemSchema,
})
export const smtpSchema = z.object({
  host: hostSchema,
  port: portSchema,
  secure: boolSchema,
  user: userSchema,
  pass: passSchema.optional(),
  tlsPinsSha256: tlsPinsSchema,
  tlsPinnedCertsPem: tlsPinnedCertsPemSchema,
})
export const accountSchema = z.object({ imap: imapSchema, smtp: smtpSchema })
/**
 * Read-side account-meta schema. Accepts three on-disk shapes and normalizes
 * them to the canonical {authType, providerId, transportType} new-shape:
 *   (a) legacy password-shape: no providerId/transportType, authType missing or 'password'
 *   (b) legacy google_oauth2-shape: authType === 'google_oauth2', no providerId/transportType
 *   (c) new-shape: providerId + transportType already present
 *
 * Normalization rules (pure, no I/O):
 *   - Missing providerId is filled based on authType:
 *       'google_oauth2' / 'oauth2' -> 'gmail'
 *       'password' / missing       -> 'generic-imap'
 *   - Missing transportType defaults to 'imap-smtp' (the only transport we support today).
 *   - authType === 'google_oauth2' is normalized to 'oauth2'.
 *
 * This is the single remaining surface that accepts 'google_oauth2' — it is a
 * backward-compatibility safety net for electron-store records written by older
 * builds. The write-side schema (accountSaveSchema) rejects 'google_oauth2' and
 * all in-memory call sites use the canonical two-member authType union.
 */
const rawAccountMetaObject = z.object({
  id: z.number().int().positive(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  colorIndex: z.number().int().min(0).max(7).optional(),
  avatarInitials: z.string().min(1).max(2).optional(),
  avatarIcon: z.string().min(1).optional(),
  avatarMode: z.enum(['initials', 'icon', 'gravatar']).optional(),
  authType: z.enum(['password', 'oauth2']).optional(),
  providerId: z.enum(['gmail', 'outlook', 'generic-imap']),
  transportType: z.enum(['imap-smtp']),
  imap: imapSchema,
  smtp: smtpSchema,
  folderRoles: z.object({
    archive: z.string().optional(),
    trash: z.string().optional(),
    sent: z.string().optional(),
    drafts: z.string().optional(),
    junk: z.string().optional(),
  }).optional(),
  /**
   * 2.3-A: per-account sending identities. After preprocess this is always a
   * non-empty array with exactly one `isDefault: true`. The preprocess below
   * synthesizes it from legacy top-level fields when the persisted record
   * predates 2.3-A. Read-side schema is permissive on `email` (see
   * `identityReadSchema` JSDoc) so legacy records with bare IMAP usernames
   * in the email slot don't fail validation and lock out users.
   */
  identities: identitiesReadArraySchema,
  /**
   * @deprecated 2.3-A — read-only legacy fallback. See AccountMeta JSDoc.
   * Kept for one release cycle so consumers that still read `signature`
   * directly (Compose, Settings → Signature tab, Send helpers) keep working
   * while wave 2 wires up the identity selector. Write path no longer
   * populates this from the save payload — new saves emit identities[] only.
   */
  signature: z.string().optional(),
})

const accountMetaSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw
  const src = raw as Record<string, unknown>
  const next: Record<string, unknown> = { ...src }

  const rawAuthType = typeof src.authType === 'string' ? src.authType : undefined

  // providerId inference (only when missing — do not override explicit values).
  // The only OAuth2 provider in the current codebase is Google, so both
  // 'google_oauth2' (legacy literal found only in old electron-store records)
  // and 'oauth2' (canonical) with no explicit providerId resolve to 'gmail'.
  // Microsoft OAuth2 (task 2.2) will extend this mapping when it lands. Keep
  // this symmetric with normalizeAccountSavePayload on the write side — a
  // record saved as oauth2 must read back as gmail, regardless of which side
  // saw it first.
  if (next.providerId === undefined) {
    if (rawAuthType === 'google_oauth2' || rawAuthType === 'oauth2') {
      next.providerId = 'gmail'
    } else {
      // password or missing authType — legacy IMAP
      next.providerId = 'generic-imap'
    }
  }

  // transportType default — only imap-smtp is supported today
  if (next.transportType === undefined) {
    next.transportType = 'imap-smtp'
  }

  // authType normalization: legacy 'google_oauth2' -> canonical 'oauth2'. This
  // is the ONLY site in the codebase that accepts the legacy literal; every
  // other surface (write-side schema, in-memory types) uses the two-member
  // union.
  if (rawAuthType === 'google_oauth2') {
    next.authType = 'oauth2'
  }

  // 2.3-A: synthesize default identity for legacy records that predate
  // multi-identity support. Migration-on-read: we do NOT rewrite the
  // persisted record eagerly — the next `saveAccount` call will emit the
  // new shape, and until then the synthesized identity is re-materialized
  // on every read. A fresh UUID on each read is acceptable because the
  // only consumers that care about id stability (Compose selector, reply
  // identity matching) operate on a single in-memory listAccounts()
  // snapshot per user interaction.
  //
  // If `identities` is already present and is an array, we leave it alone
  // (including malformed arrays — the schema refine below will reject
  // them, which is the correct behaviour for corrupted on-disk data).
  if (!Array.isArray(next.identities)) {
    const legacySignature = typeof src.signature === 'string' ? src.signature : undefined
    const legacyDisplayName = typeof src.name === 'string' ? src.name : undefined
    const legacyEmail = typeof src.email === 'string'
      ? src.email
      : (typeof (src.smtp as { user?: unknown } | undefined)?.user === 'string'
        ? (src.smtp as { user: string }).user
        : (typeof (src.imap as { user?: unknown } | undefined)?.user === 'string'
          ? (src.imap as { user: string }).user
          : ''))
    next.identities = [synthesizeDefaultIdentity({
      displayName: legacyDisplayName,
      email: legacyEmail,
      signature: legacySignature,
    })]
  }

  return next
}, rawAccountMetaObject)
export const folderRolesSchema = z.object({
  archive: z.string().optional(),
  trash: z.string().optional(),
  sent: z.string().optional(),
  drafts: z.string().optional(),
  junk: z.string().optional(),
}).optional()

/**
 * §2.15-ter: allowed values for `bodyRetentionDays`. -1 encodes "forever"
 * (no body pruning) so the field can remain a number rather than a tagged
 * union — keeps persisted config and IPC payload shapes simple.
 */
export const BODY_RETENTION_DAYS_VALUES = [30, 90, 180, 365, -1] as const
export const DEFAULT_BODY_RETENTION_DAYS = 365

/**
 * §2.158 — the CEILING of what the MCP export server may ever expose to an
 * external client, and the value domain of `Settings.mcpExportWhitelist`.
 *
 * Canonical source of truth. `electron/services/mcpExport.ts` re-exports it as
 * `ALL_EXPORTABLE_TOOLS` (the name CLAUDE.md §4 refers to) and intersects every
 * incoming whitelist with it before registering tools. It lives HERE rather
 * than in the service because the settings schema below needs it to bound the
 * field, and `packages/net` must not import from `electron/` — a second copy
 * would drift, which is exactly the failure this task fixes.
 *
 * §3.10 P0 shape: every DESTRUCTIVE MAIL operation appears only as a
 * `preview_*` / `apply_*` pair. The direct variants (`snooze_email`,
 * `flag_email`, `add_followup`, `dismiss_followup`, `mark_read_later`,
 * `create_mail_rule`, `update_mail_rule`, `delete_mail_rule`, `mail_action`,
 * `unsubscribe`, `send_email`, `move_email`) are deliberately absent: an
 * external MCP client has no renderer-issued confirmation token, so exposing
 * them would be a confused-deputy escalation path.
 *
 * The pair rule covers destructive mail operations, NOT "every tool that
 * mutates something". One mutating tool below is unpaired on purpose — read
 * this as an accepted exception, not as a gap in the rule:
 *   - `create_draft` only writes a draft and opens Compose. It cannot put mail
 *     on the wire (no-send-ever is a separate invariant), and the user reads
 *     the draft before anything can be sent.
 *
 * DELIBERATELY ABSENT — do not re-add without the preview/apply pair:
 *   - `update_memory`. It overwrites persisted AI memory in place, with no
 *     preview and no confirmation token. The rationale that keeps it unpaired
 *     on the CHAT path ("the model writes memory from text the user typed")
 *     is a prompt-level policy, not an enforced property — nothing in the tool
 *     checks where the text came from — and on THIS path it is void outright:
 *     an external MCP client authors the call itself, so there is no user
 *     turn behind it at all. `wrapUntrusted()` bounds the damage when memory
 *     is substituted back into prompts, but it neither authorises the write
 *     nor undoes long-lived memory poisoning, which then leaks into every
 *     later answer, summary and suggestion. Removed from the ceiling as the
 *     cheap half of the fix; the expensive half — a real preview/apply pair
 *     for memory writes — is tracked in BACKLOG. Until that pair exists, this
 *     tool stays chat-only. Do not put it back "for symmetry" with
 *     `create_draft`: a draft is inert until a human sends it, memory is not.
 *   - `list_external_tools` / `call_external_tool`. The external-MCP bridge is
 *     an egress surface; it belongs to the chat path where a human is present
 *     to answer the §3.10 P2 consent prompt.
 */
export const EXPORTABLE_MCP_TOOLS = [
  // Read-only
  'get_email', 'list_emails', 'search_emails',
  'list_folders', 'get_thread', 'get_contacts',
  'get_account_info', 'count_unread', 'query_db',
  'list_attachments', 'read_attachment', 'get_attachment_hash',
  'get_current_context',
  'list_mail_rules', 'get_rule_log',
  // Destructive — preview/apply pairs (disabled by default).
  // External clients calling apply_* without a renderer-issued
  // confirmation_token will be rejected at the validation gate.
  'preview_mail_action', 'apply_mail_action',
  'preview_unsubscribe', 'apply_unsubscribe',
  'send_email_preview', 'send_email_apply',
  'move_email_preview', 'move_email_apply',
  'preview_snooze_email', 'apply_snooze_email',
  'preview_unsnooze_email', 'apply_unsnooze_email',
  'preview_flag_email', 'apply_flag_email',
  'preview_mark_read_later', 'apply_mark_read_later',
  'preview_add_followup', 'apply_add_followup',
  'preview_dismiss_followup', 'apply_dismiss_followup',
  'preview_create_mail_rule', 'apply_create_mail_rule',
  'preview_update_mail_rule', 'apply_update_mail_rule',
  'preview_delete_mail_rule', 'apply_delete_mail_rule',
  // Compose (no-send). `update_memory` is NOT here — see the header above.
  'create_draft',
] as const

export type ExportableMcpTool = typeof EXPORTABLE_MCP_TOOLS[number]

/** Membership test for `EXPORTABLE_MCP_TOOLS`, narrowing to the union type. */
export function isExportableMcpTool(name: string): name is ExportableMcpTool {
  return (EXPORTABLE_MCP_TOOLS as readonly string[]).includes(name)
}

/**
 * §2.103 — upper bound on how many dictionaries may be enabled at once.
 *
 * Not a UX preference: every enabled language is a hunspell dictionary
 * Chromium loads into memory and, on first use, a separate file downloaded
 * from a third-party CDN. The bound keeps a compromised or stale renderer from
 * turning one `settings:save` into an arbitrary number of outbound requests.
 * Generous against the real case — Thunderbird users routinely run two or
 * three, and eight covers every realistic multilingual mailbox.
 */
export const SPELLCHECK_MAX_LANGUAGES = 8

/**
 * §2.103 — shape of a Chromium spellchecker language code (`en`, `en-US`,
 * `sr-Cyrl`).
 *
 * This is a SHAPE check, not a membership check, and the distinction matters:
 * the authoritative set is `session.availableSpellCheckerLanguages`, which
 * belongs to Chromium and changes between versions. Mirroring it here would be
 * the drifting copy §2.167 forbids. What this bound does is keep the payload
 * to something that can only ever be a language tag — the value is later
 * intersected with the live set in main, and an entry outside it never reaches
 * the session.
 */
export const spellcheckLanguageCodeSchema = z.string()
  .trim()
  .min(2)
  .max(20)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)

export const settingsSchema = z.object({
  theme: z.enum(['light', 'dark']),
  /**
   * @deprecated §2.15-ter — ignored at runtime, kept on the schema with
   * default 30 so persisted configs from earlier versions still parse. The
   * value is never read by sync, prune or query paths anymore.
   */
  cacheDays: z.number().int().positive().default(30),
  /**
   * §2.15-ter — global body retention window (days, or -1 for forever).
   * Refined to a fixed allowlist instead of an arbitrary positive number to
   * keep telemetry buckets and UI dropdown values aligned with what the
   * settings dropdown can actually emit.
   */
  bodyRetentionDays: z.number().int().refine(
    v => (BODY_RETENTION_DAYS_VALUES as readonly number[]).includes(v),
    { message: `bodyRetentionDays must be one of ${BODY_RETENTION_DAYS_VALUES.join(', ')}` },
  ).default(DEFAULT_BODY_RETENTION_DAYS),
  language: z.enum(['en', 'ru', 'fr', 'de', 'es', 'it']).default('en'),
  notificationsEnabled: z.boolean().default(true),
  imapIdleEnabled: z.boolean().default(true),
  draftSyncEnabled: z.boolean().default(true),
  // §2.99 — tray on by default; the two behaviour changes it enables are opt-in.
  trayEnabled: z.boolean().default(true),
  closeToTray: z.boolean().default(false),
  launchAtLogin: z.boolean().default(false),
  // Main-only report of the last registration attempt (review H4). Absent means
  // "never attempted", which is not the same as "failed".
  launchAtLoginStatus: z.object({
    supported: z.boolean(),
    applied: z.boolean(),
    requested: z.boolean(),
    at: z.string(),
  }).optional(),
  hotkeysPreset: z.enum(['gmail', 'outlook']).default('gmail'),
  sendDelaySeconds: z.number().int().min(0).max(60).default(0),
  alwaysLoadImages: z.boolean().default(false),
  gravatarInMail: z.boolean().default(true),
  groupConversations: z.boolean().default(true),
  sortMode: z.enum(['date', 'from', 'subject']).default('date'),
  autoAdvance: z.enum(['off', 'newer', 'older', 'back_to_list']).default('older'),
  conversationOrder: z.enum(['newest-top', 'oldest-top']).default('newest-top'),
  currentAccountId: z.number().int().positive().optional(),
  hiddenUnreadFolders: z.array(z.string()).optional(),
  offlineEnabled: z.boolean().default(false),
  offlineSyncDays: z.number().int().min(0).default(30),
  offlineMaxSizeKB: z.number().int().min(0).default(0),
  offlineMaxTotalMB: z.number().int().min(0).default(0),
  offlineFolders: z.array(z.string()).default(['INBOX']),
  /**
   * §2.218 — `.catch(undefined)` is the SILENT-RESET MIGRATION for the removed
   * `subscription` provider, and it is load-bearing rather than defensive
   * tidiness.
   *
   * This is the PERSISTED schema, and `getSettings()` is not lenient about it:
   * a `safeParse` failure that is not the mcpConnections-env case falls through
   * to a terminal `settingsSchema.parse(raw)` that THROWS, whereupon callers
   * fall back to fresh defaults — i.e. one stale enum member on disk would have
   * discarded the user's ENTIRE settings record on every read. Dropping just
   * the offending field instead leaves the rest of the record intact and leaves
   * `aiProvider` unset, which every consumer already handles as "not
   * configured" (the AI panel shows its existing onboarding state). No
   * notification, no migration UI.
   *
   * The scope is deliberately this one field: `.catch` here cannot mask a
   * malformed value on the SAVE path, because `settings:save` validates the
   * incoming payload against the strict `settingsSaveSchema` below first.
   */
  aiProvider: z.enum(['anthropic-api', 'openai-api', 'gemini-api']).optional().catch(undefined),
  aiModel: z.string().optional(),
  aiPrivacyConsent: z.boolean().default(false),
  aiPanelOpen: z.boolean().default(false),
  aiPanelWidth: z.number().int().min(280).max(600).default(350),
  aiSendOnEnter: z.boolean().default(true),
  /**
   * §2.119 — the address AI requests are delivered to, and the proxy in front
   * of it. Both are renderer-writable ON PURPOSE (a self-hosted endpoint and a
   * corporate proxy are wanted capabilities), and both are the destination of
   * a request carrying the user's API key — so a CHANGE to either is gated on
   * a native confirmation in main: electron/services/aiDestinationGuard.ts.
   *
   * The schema cannot express that gate, which is why it is written here: a
   * new write path to these two fields is a new exfiltration route unless it
   * goes through the guard too. Today there are exactly two, `settings:save`
   * and the `ai:checkAuth` overrides.
   */
  aiOpenAiBaseUrl: z.string().trim().optional(),
  aiProxyUrl: z.string().trim().optional(),
  aiLocale: z.enum(['auto', 'ru', 'en']).default('auto'),
  aiShowSources: z.boolean().default(true),
  aiDailyBudgetUsd: z.number().min(0).max(10000).default(5),
  aiMonthlyBudgetUsd: z.number().min(0).max(100000).default(100),
  aiMaxTurns: z.number().int().min(1).max(200).default(30),
  aiMaxBudgetPerRequest: z.number().min(0).max(100).default(2),
  /**
   * §2.122 — per-provider "a key was saved at some point" marker. See the
   * `Settings.aiApiKeySaved` JSDoc for the full contract (observability, never
   * enforcement; never the key material). Main-only writable — deliberately
   * NOT in `rendererWritableSettingsSchema`.
   *
   * Optional rather than `.default({})`: an absent record must stay
   * distinguishable from "we looked and this provider was never saved", the
   * same distinction `getRawPersistedSettings` protects for `sentryEnabled`.
   */
  aiApiKeySaved: z.object({
    'anthropic-api': z.boolean().optional(),
    'openai-api': z.boolean().optional(),
    'gemini-api': z.boolean().optional(),
  }).optional(),
  workOffline: z.boolean().default(false),
  debugLogging: z.boolean().default(false),
  sentryEnabled: z.boolean().default(true),
  /**
   * §2.82 — persisted first-run telemetry consent. Main-only writable; see the
   * `Settings.telemetryConsent` JSDoc for the contract. `.optional()` with no
   * default on purpose: "no record" is a meaningful state (not answered yet →
   * send nothing, ask once) and a default would erase it.
   */
  telemetryConsent: z.object({
    granted: z.boolean(),
    version: z.number().int(),
    at: z.string().min(1),
  }).optional(),
  syncIntervalMinutes: z.number().int().min(1).max(30).default(1),
  periodicSyncIntervalMin: z.number().int().min(1).max(60).default(5),
  darkModeEmails: z.boolean().default(true),
  mcpExportEnabled: z.boolean().default(false),
  mcpExportPort: z.number().int().min(1024).max(65535).default(23847),
  /**
   * §2.158 — deliberately NOT narrowed to `z.enum(EXPORTABLE_MCP_TOOLS)`,
   * unlike its `rendererWritableSettingsSchema` twin. This is the PERSISTED
   * schema: a config written by an older build (or hand-edited) may hold a
   * tool name that has since left the ceiling, and rejecting it here would
   * fail the whole settings load, not just this field. Out-of-ceiling entries
   * are inert anyway — `McpExportServer.start()` intersects with
   * `EXPORTABLE_MCP_TOOLS` before any tool is registered.
   */
  mcpExportWhitelist: z.array(z.string()).optional(),
  mcpEnableStdio: z.boolean().default(false),
  /**
   * Persisted native-confirm approval for stdio MCP (§3.10 P0). Main-only
   * writable. See the `Settings.stdioApproved` JSDoc for the contract.
   */
  stdioApproved: z.object({
    source: z.literal('native-confirm'),
    approvedAt: z.string().min(1),
    appVersion: z.string().min(1),
  }).optional(),
  mcpConnections: z.array(mcpConnectionSchema).optional(),
  aiEgressPolicy: z.enum(['default-deny', 'ask', 'allow']).default('default-deny'),
  trustedDomains: z.string().default('').optional(),
  defaultMailApp: z.boolean().default(false),
  /**
   * §2.19 — when true, electron-updater downloads updates in the background
   * without explicit user click. Default false: opt-in, surface every
   * download in the UI. Read at startup AND on every settings:save (the
   * `onSettingsChangedMain` observer flips `autoUpdater.autoDownload`
   * without restart). Independent of `canSelfUpdate` — the renderer is
   * responsible for greying out the toggle on read-only installs.
   */
  autoUpdateEnabled: z.boolean().default(false),
  /**
   * §3.3 B2 — per-account Thread AI Summary opt-in map (accountId → enabled).
   * Default empty (feature OFF for every account). z.record keys are strings
   * (electron-store JSON object keys), values are booleans.
   */
  aiThreadSummaryEnabled: z.record(z.string(), z.boolean()).default({}),
  /**
   * §3.3 B4 — per-account Instant Reply opt-in map (accountId → enabled).
   * Default empty (feature OFF for every account). z.record keys are strings
   * (electron-store JSON object keys), values are booleans.
   */
  aiInstantReplyEnabled: z.record(z.string(), z.boolean()).default({}),
  /**
   * §3.3 B7 — per-account AI Proofread opt-in map (accountId → enabled).
   * Default empty (feature OFF for every account).
   */
  aiProofreadEnabled: z.record(z.string(), z.boolean()).default({}),
  /**
   * §3.3 B6 — per-account AI Translate opt-in map (accountId → enabled).
   * Default empty (feature OFF for every account).
   */
  aiTranslateEnabled: z.record(z.string(), z.boolean()).default({}),
  // §2.103 — see the `Settings.spellcheck*` JSDoc for the contract. Default
  // OFF: Chromium's default would otherwise fetch the OS-locale dictionary
  // from a third-party CDN with nothing asked.
  spellcheckEnabled: z.boolean().default(false),
  /**
   * §2.103 — deliberately NOT narrowed to the code shape enforced on the
   * renderer-writable twin, for the reason spelled out on `mcpExportWhitelist`
   * above: this is the PERSISTED schema, and rejecting a value written by an
   * older build (or by Chromium's own language set changing under us) would
   * fail the ENTIRE settings load rather than this one field. Out-of-domain
   * entries are inert — `resolveSpellcheckSession` in
   * electron/services/spellcheck.ts intersects with the live availability list
   * before anything reaches the session.
   */
  spellcheckLanguages: z.array(z.string()).optional(),
  /**
   * §2.103 — main-only consent record for dictionary downloads. `.optional()`
   * with no default, like `telemetryConsent`: "no record" is a meaningful state
   * (never asked) and a default would erase the distinction.
   */
  spellcheckDictionaryConsent: z.object({
    granted: z.array(z.string()),
    at: z.string().min(1),
  }).optional(),
  /** §2.103 — main's report of the platform spellchecker's language set. */
  spellcheckAvailable: z.object({
    languages: z.array(z.string()),
    platformOwned: z.boolean(),
    // `.default` rather than required: a record written before this field
    // existed must still parse — the persisted schema failing would discard
    // the whole settings object, not just this report.
    max: z.number().int().positive().default(SPELLCHECK_MAX_LANGUAGES),
    at: z.string().min(1),
  }).optional(),
})

/**
 * Renderer-writable settings subset (§3.10 P0).
 *
 * This is the schema that `settings:save` in the main process validates
 * incoming renderer payloads against. Fields that live on the full
 * `settingsSchema` but ARE NOT in this schema are considered main-only —
 * a compromised renderer cannot flip them by crafting a payload.
 *
 * Why `.strict()`: zod's default `passthrough` would let an attacker smuggle
 * `mcpEnableStdio: true` through as "unknown extra key" and main would ignore
 * it (no mutation), but the attack surface would look silent. `.strict()`
 * makes the rejection explicit so the IPC handler can return
 * `{ ok: false, reason: 'forbidden_field' }` and we can log an audit row.
 *
 * THE LIST of main-only fields is `MAIN_ONLY_SETTINGS_FIELDS` below — that
 * array is the source of truth, and a prose enumeration here would drift out of
 * date the first time a field is added (it already had: the §2.103 spellcheck
 * records were missing from it). What follows is not the list but the REASONING
 * for the non-obvious entries — read it for "why", read the array for "what":
 *   - `mcpEnableStdio` — renderer-to-local-RCE gate, main writes only via
 *     native-confirm path.
 *   - `stdioApproved` — proof record of the native-confirm, written only by
 *     the `mcp:requestStdioEnable` handler.
 *   - `mcpConnections` — renderer mutates this via `mcp:saveConnection` /
 *     `mcp:removeConnection` IPC, never via a raw `settings:save`. Leaving
 *     it off this schema prevents a compromised renderer from bypassing the
 *     command-allowlist gate by writing connections directly to settings.
 *   - `telemetryConsent` (§2.82) — the record of the user's answer on the
 *     consent screen. Written only by the `telemetry:setConsent` handler,
 *     which stamps `version` and `at` itself. A renderer able to write it
 *     could fabricate consent that was never given.
 *   - `aiApiKeySaved` (§2.122) — main's own record of having written an AI
 *     key to the OS secret store. It exists to make a lost key legible
 *     ("there was one and it is gone"), so a renderer that could set or
 *     clear it would be editing the evidence about its own storage.
 */
export const rendererWritableSettingsSchema = z.object({
  theme: z.enum(['light', 'dark']).optional(),
  /**
   * @deprecated §2.15-ter — ignored at runtime; accepted on the renderer
   * payload only so older Settings windows mid-upgrade keep saving without
   * a `forbidden_field` rejection.
   */
  cacheDays: z.number().int().positive().optional(),
  bodyRetentionDays: z.number().int().refine(
    v => (BODY_RETENTION_DAYS_VALUES as readonly number[]).includes(v),
    { message: `bodyRetentionDays must be one of ${BODY_RETENTION_DAYS_VALUES.join(', ')}` },
  ).optional(),
  language: z.enum(['en', 'ru', 'fr', 'de', 'es', 'it']).optional(),
  notificationsEnabled: z.boolean().optional(),
  imapIdleEnabled: z.boolean().optional(),
  draftSyncEnabled: z.boolean().optional(),
  // §2.99 — user-facing switches, so renderer-writable (NOT main-only): the
  // Settings window is the only place that flips them.
  trayEnabled: z.boolean().optional(),
  closeToTray: z.boolean().optional(),
  launchAtLogin: z.boolean().optional(),
  hotkeysPreset: z.enum(['gmail', 'outlook']).optional(),
  sendDelaySeconds: z.number().int().min(0).max(60).optional(),
  alwaysLoadImages: z.boolean().optional(),
  gravatarInMail: z.boolean().optional(),
  groupConversations: z.boolean().optional(),
  sortMode: z.enum(['date', 'from', 'subject']).optional(),
  autoAdvance: z.enum(['off', 'newer', 'older', 'back_to_list']).optional(),
  conversationOrder: z.enum(['newest-top', 'oldest-top']).optional(),
  currentAccountId: z.number().int().positive().optional(),
  hiddenUnreadFolders: z.array(z.string()).optional(),
  offlineEnabled: z.boolean().optional(),
  offlineSyncDays: z.number().int().min(0).optional(),
  offlineMaxSizeKB: z.number().int().min(0).optional(),
  offlineMaxTotalMB: z.number().int().min(0).optional(),
  offlineFolders: z.array(z.string()).optional(),
  /**
   * STRICT on purpose — no `.catch` twin of the persisted schema above. A
   * renderer that submits an unknown provider (a stale Settings window, or a
   * compromised one trying to name a provider the registry does not carry) must
   * be REFUSED, not silently normalised to "unset". Leniency belongs to reading
   * our own disk, never to accepting a payload.
   */
  aiProvider: z.enum(['anthropic-api', 'openai-api', 'gemini-api']).optional(),
  aiModel: z.string().optional(),
  aiPrivacyConsent: z.boolean().optional(),
  aiPanelOpen: z.boolean().optional(),
  aiPanelWidth: z.number().int().min(280).max(600).optional(),
  aiSendOnEnter: z.boolean().optional(),
  /**
   * §2.119 — writable, but a CHANGE needs a human: see the JSDoc on the same
   * two fields in `settingsSchema` above, and
   * electron/services/aiDestinationGuard.ts. Membership here is what makes the
   * guard necessary, not a statement that the fields are harmless.
   */
  aiOpenAiBaseUrl: z.string().trim().optional(),
  aiProxyUrl: z.string().trim().optional(),
  aiLocale: z.enum(['auto', 'ru', 'en']).optional(),
  aiShowSources: z.boolean().optional(),
  aiDailyBudgetUsd: z.number().min(0).max(10000).optional(),
  aiMonthlyBudgetUsd: z.number().min(0).max(100000).optional(),
  aiMaxTurns: z.number().int().min(1).max(200).optional(),
  aiMaxBudgetPerRequest: z.number().min(0).max(100).optional(),
  workOffline: z.boolean().optional(),
  debugLogging: z.boolean().optional(),
  sentryEnabled: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(1).max(30).optional(),
  periodicSyncIntervalMin: z.number().int().min(1).max(60).optional(),
  darkModeEmails: z.boolean().optional(),
  mcpExportEnabled: z.boolean().optional(),
  mcpExportPort: z.number().int().min(1024).max(65535).optional(),
  /**
   * §2.158 — bounded by the export ceiling, same pattern as `aiEgressPolicy`
   * below: a compromised renderer cannot widen the exported tool surface by
   * writing an arbitrary tool name into settings.
   *
   * §2.167 — what an out-of-domain value costs is decided by the HANDLER, not
   * by this schema: `settings:save` refuses THIS FIELD (the persisted value
   * stays, the submitted one is not written) and applies the rest of the save,
   * reporting `{ field, code: 'unknown_export_tool' }` back. Before that the
   * failure had no verdict of its own — the handler only acted on the
   * main-only-field case, so the value fell through to the lax PERSISTED
   * schema above and was stored verbatim, unreported. See
   * electron/settingsSaveRefusal.ts.
   *
   * This is the SECOND layer, not the only one: `McpExportServer.start()`
   * intersects whatever it is handed with `EXPORTABLE_MCP_TOOLS`, which also
   * covers the main-side `mcpExport:start` IPC path and legacy persisted
   * values that never pass through this schema.
   */
  mcpExportWhitelist: z.array(z.enum(EXPORTABLE_MCP_TOOLS)).optional(),
  // §3.10 P1: renderer-writable so users can flip the policy from Settings.
  // The field is bounded by the enum — a compromised renderer cannot expand
  // the surface beyond the three known values.
  aiEgressPolicy: z.enum(['default-deny', 'ask', 'allow']).optional(),
  trustedDomains: z.string().optional(),
  defaultMailApp: z.boolean().optional(),
  // §2.19: renderer can flip auto-download from Settings → About. Bounded
  // boolean — strict() guards against smuggled extra fields.
  autoUpdateEnabled: z.boolean().optional(),
  // §3.3 B2: renderer Settings toggle writes the per-account Thread AI Summary
  // opt-in map here (accountId → enabled). A plain UX opt-in, not a security
  // gate, so it is renderer-writable (unlike stdio MCP). strict() still bounds
  // the value shape to a string→boolean record.
  aiThreadSummaryEnabled: z.record(z.string(), z.boolean()).optional(),
  // §3.3 B4: renderer Settings toggle writes the per-account Instant Reply
  // opt-in map here (accountId → enabled). A plain UX opt-in, not a security
  // gate, so it is renderer-writable (unlike stdio MCP). strict() still bounds
  // the value shape to a string→boolean record.
  aiInstantReplyEnabled: z.record(z.string(), z.boolean()).optional(),
  // §3.3 B7: renderer Settings toggle writes the per-account AI Proofread
  // opt-in map here (accountId → enabled). A plain UX opt-in, not a security
  // gate, so it is renderer-writable. strict() still bounds the value shape to
  // a string→boolean record.
  aiProofreadEnabled: z.record(z.string(), z.boolean()).optional(),
  // §3.3 B6: renderer Settings toggle writes the per-account AI Translate
  // opt-in map here (accountId → enabled). A plain UX opt-in, not a security
  // gate, so it is renderer-writable. strict() still bounds the value shape to
  // a string→boolean record.
  aiTranslateEnabled: z.record(z.string(), z.boolean()).optional(),
  // §2.103 — a plain preference, so renderer-writable. The flag by itself
  // cannot bypass the consent record: the language list below is what selects
  // dictionaries, and main filters that against the record before applying it.
  spellcheckEnabled: z.boolean().optional(),
  /**
   * §2.103 — STRICT on the payload path (unlike its persisted twin above):
   * bounded in count and in shape, so a compromised renderer cannot turn one
   * save into an unbounded set of dictionary fetches or push a non-language
   * string into a Chromium session API that THROWS on an unknown code.
   *
   * This is the first of three layers, and the only one this schema can
   * express. The second is `settings:save`, which drops any language whose
   * dictionary would have to be downloaded without a recorded human consent
   * (electron/services/spellcheck.ts). The third is the intersection with the
   * live availability list before the session is touched.
   */
  spellcheckLanguages: z.array(spellcheckLanguageCodeSchema).max(SPELLCHECK_MAX_LANGUAGES).optional(),
}).strict()

export type RendererWritableSettings = z.infer<typeof rendererWritableSettingsSchema>

/**
 * Names of settings fields that are NOT renderer-writable (§3.10 P0). Kept
 * in a single array so scanners / tests can assert the invariant without
 * re-deriving it from schema introspection.
 */
export const MAIN_ONLY_SETTINGS_FIELDS = [
  'mcpEnableStdio',
  'stdioApproved',
  'mcpConnections',
  // §2.82 — consent record. Renderer signals its click through
  // `telemetry:setConsent`; main stamps the version and timestamp.
  'telemetryConsent',
  // §2.122 — main's record of having saved an AI key. Written only by
  // `setAiApiKeySavedFlag` from the main-side save/delete paths.
  'aiApiKeySaved',
  // §2.99 (review H4) — main's report of the last autostart registration
  // attempt. A renderer that could write it would be able to claim a
  // registration the OS never accepted.
  'launchAtLoginStatus',
  // §2.103 — the record of a human accepting a dictionary DOWNLOAD in a native
  // dialog main drew. A renderer able to write it would grant itself the
  // outbound request the dialog exists to authorise (same shape as
  // `telemetryConsent` and `stdioApproved`).
  'spellcheckDictionaryConsent',
  // §2.103 — main's report of what the platform spellchecker offers. A renderer
  // able to write it could claim availability the platform never reported and
  // steer the language list past the intersection that bounds it.
  'spellcheckAvailable',
] as const

export type MainOnlySettingsField = typeof MAIN_ONLY_SETTINGS_FIELDS[number]

// §2.33 PR2a — injectable secret backend for IMAP/SMTP passwords and OAuth
// refresh tokens.
//
// Surface tag forwarded to the injected backend for telemetry context. Mirrors
// the subset of electron/sentry.ts `SecretStoreSurface` that config.ts can
// emit ('imap_smtp' | 'oauth_refresh'). The default keytar backend ignores it;
// the injected secretStore uses it to tag once-per-session
// keychain-unavailability telemetry. Exported so the main-process DI wiring
// (electron/main.ts → setSecretBackend) can reference the same union.
export type SecretSurface = 'imap_smtp' | 'oauth_refresh'

/**
 * Injectable secret backend. ALL IMAP/SMTP password and OAuth refresh-token
 * get/set/delete in this module route through this seam — there are no direct
 * `keytar.*` secret calls left at the call sites.
 *
 * DEFAULT = direct keytar (see `defaultSecretBackend`). This preserves
 * portability (packages/net stays layer-pure, no electron import) and the
 * existing test/runtime behaviour: keytar errors propagate out of get/set and
 * are swallowed per-key by the OAuth lookup helpers exactly as before §2.33.
 *
 * INJECTED at startup by electron/main.ts via `setSecretBackend()` with the
 * secretStore-backed implementation (electron/services/secretStore.ts). That
 * backend adds the machine-bound AES-256-GCM disk fallback AND the
 * once-per-session keychain-unavailability telemetry
 * (electron/sentry.ts `reportKeychainUnavailable`). Because reporting lives in
 * that backend, config.ts itself MUST NOT also report — the §2.34 net-telemetry
 * latch that used to live here is gone (no double-report; §2.33 brief item 5).
 *
 * MIGRATION BOUNDARY (re-entry — PR3, NOT this task): after a session that fell
 * back to the encrypted disk store (OS keyring was down), the keyring can
 * reappear on a later launch. A secret written to disk-only during the fallback
 * session is NOT present in the now-healthy keyring, so the injected backend's
 * get() returns null cleanly. The caller (getAccountConfig) then surfaces a
 * config with `pass: undefined`, which the connection layer treats as
 * "credentials missing → needs re-entry". The re-entry prompt UI is PR3; this
 * task only guarantees the clean null (never a throw, never a stale/plaintext
 * value) so the boundary is well-defined.
 */
export interface SecretBackend {
  get(key: string, surface?: SecretSurface): Promise<string | null>
  set(key: string, value: string, surface?: SecretSurface): Promise<void>
  delete(key: string, surface?: SecretSurface): Promise<void>
}

/**
 * Default backend: direct keytar, with the shared `service` namespace baked in.
 * No telemetry, no disk fallback — a keytar rejection propagates to the caller
 * (matching pre-§2.33 semantics). `keytar.deletePassword` resolves to a
 * boolean; we normalize it to void so the SecretBackend contract is uniform.
 */
/**
 * §2.132 — under `MAILCOPILOT_E2E=1` this path must never run.
 *
 * In the real app `electron/main.ts` injects the secretStore-backed
 * implementation, which serves e2e runs from the per-data-dir encrypted disk
 * fallback and never contacts the keychain. This default is what remains if
 * that wiring is ever missed — and `service`/`imap:<id>`/`smtp:<id>` address a
 * PER-USER keychain, not the throwaway `MAILCOPILOT_DATA_DIR`, so silently
 * falling through here means a test overwrites or deletes the developer's own
 * credentials (that is exactly how §2.132 was found: an e2e run replaced a live
 * AI key with a test string).
 *
 * What the throw guarantees is that no keychain call happens — NOT that a test
 * turns red. Several call sites here swallow secret-backend failures on purpose
 * (a keychain fault must not break a save flow), so under a missing wiring the
 * refusal can surface as a clean null or a dropped write instead of an
 * exception. That is the intended trade: the user's credentials stay untouched,
 * and the e2e run simply has no secret to read.
 *
 * Unit tests are unaffected: they mock the `keytar` module and do not set
 * `MAILCOPILOT_E2E`.
 */
function assertKeychainAllowed(): void {
  if (process.env.MAILCOPILOT_E2E === '1') {
    throw new Error(
      'secret backend: OS keychain access is disabled under MAILCOPILOT_E2E (setSecretBackend was not wired)',
    )
  }
}

const defaultSecretBackend: SecretBackend = {
  get: async (key) => { assertKeychainAllowed(); return keytar.getPassword(service, key) },
  set: async (key, value) => { assertKeychainAllowed(); return keytar.setPassword(service, key, value) },
  delete: async (key) => { assertKeychainAllowed(); await keytar.deletePassword(service, key) },
}

let secretBackend: SecretBackend = defaultSecretBackend

/**
 * Inject the process-wide secret backend. electron/main.ts calls this once at
 * startup with the secretStore-backed implementation; `secretStore` is directly
 * assignable to `SecretBackend` (its surface param is the wider
 * `SecretStoreSurface`, which is contravariantly compatible). Passing `null`
 * resets to the direct-keytar default — used by tests to restore isolation
 * between cases.
 */
export function setSecretBackend(backend: SecretBackend | null): void {
  secretBackend = backend ?? defaultSecretBackend
}

function imapSecretKey(id: number) {
  return `imap:${id}`
}

function smtpSecretKey(id: number) {
  return `smtp:${id}`
}

/**
 * New provider-agnostic keytar key for OAuth2 refresh tokens.
 * Format mirrors legacy keys (`google:refresh:${id}`) but includes providerId
 * so the same scheme works for Outlook, Yahoo, etc. in 2.2 and beyond.
 */
export function oauthRefreshSecretKey(providerId: string, id: number): string {
  return `oauth-refresh:${providerId}:${id}`
}

/**
 * Legacy keytar key for Google refresh tokens. Mirrors the legacyImapSecretKey /
 * legacySmtpSecretKey pattern: retained for read-side fallback as a
 * backward-compat safety net for stored records written before the
 * provider-agnostic key scheme landed.
 */
export function legacyGoogleRefreshSecretKey(id: number): string {
  return `google:refresh:${id}`
}

/** Dependency-injected keytar getter shape used by lookupOauthRefreshToken. */
export type KeytarGetter = (service: string, account: string) => Promise<string | null>

/**
 * Pure lookup helper that tries the new provider-agnostic keytar key first and
 * falls back to the legacy `google:refresh:${id}` key when the new key is absent.
 *
 * The keytar getter is passed as a dependency so callers and tests can supply
 * their own implementation without module mocking. Errors from the getter are
 * swallowed per-key (keytar is best-effort — missing backend on Linux etc.)
 * so a failure on the new-key read does not prevent the legacy fallback.
 */
export async function lookupOauthRefreshToken(
  providerId: string,
  id: number,
  getter: KeytarGetter,
): Promise<string | undefined> {
  const detailed = await lookupOauthRefreshTokenWithSource(providerId, id, getter)
  return detailed?.token
}

/**
 * Which keytar key a looked-up token was read from. Exposed so callers
 * (electron/main.ts Google OAuth path) can trigger "migrate on first use"
 * cleanup of the legacy key after a successful read + new-key write.
 */
export type OauthRefreshTokenSource = 'new' | 'legacy'

/**
 * Same as lookupOauthRefreshToken but reports which key the value came from.
 */
export async function lookupOauthRefreshTokenWithSource(
  providerId: string,
  id: number,
  getter: KeytarGetter,
): Promise<{ token: string; source: OauthRefreshTokenSource } | undefined> {
  try {
    const fresh = await getter(service, oauthRefreshSecretKey(providerId, id))
    if (fresh) return { token: fresh, source: 'new' }
  } catch { /* fall through to legacy */ }
  try {
    const legacy = await getter(service, legacyGoogleRefreshSecretKey(id))
    if (legacy) return { token: legacy, source: 'legacy' }
  } catch { /* ignore */ }
  return undefined
}

/**
 * Provider-agnostic writer for OAuth2 refresh tokens. Writes the new
 * `oauth-refresh:${providerId}:${id}` keytar key. A null/empty token deletes
 * the key. Keytar errors are swallowed with console.warn — a keytar backend
 * failure must not break account save flows.
 */
async function setOauthRefreshTokenWith(
  backend: SecretBackend,
  providerId: string,
  id: number,
  token: string | null,
): Promise<void> {
  const key = oauthRefreshSecretKey(providerId, id)
  try {
    if (!token) {
      await backend.delete(key, 'oauth_refresh')
      return
    }
    await backend.set(key, token, 'oauth_refresh')
  } catch (err) {
    // FINDING 2: PII-safe. No account id, providerId, key name, or raw backend
    // message (the message can embed the key, e.g. `oauth-refresh:gmail:9`).
    // A stable label + sanitized error class only; non-throwing swallow so a
    // keytar backend failure never breaks account-save flows.
    console.warn('[net/config] setOauthRefreshToken failed:', err instanceof Error ? err.name : 'unknown')
  }
}

export async function setOauthRefreshToken(
  providerId: string,
  id: number,
  token: string | null,
): Promise<void> {
  // FINDING 3: snapshot the backend once for this operation.
  const backend = secretBackend
  await setOauthRefreshTokenWith(backend, providerId, id, token)
}

/**
 * Provider-agnostic reader for OAuth2 refresh tokens. Tries the new key first,
 * falls back to the legacy `google:refresh:${id}` key. Returns null when both
 * are absent or keytar is unavailable.
 */
export async function getOauthRefreshToken(
  providerId: string,
  id: number,
): Promise<string | null> {
  // Route through the injected secret backend. Any rejection is caught per-key
  // inside lookupOauthRefreshToken so the new→legacy fallback is unchanged; the
  // injected backend (secretStore) owns unavailability telemetry + disk
  // fallback, so config.ts no longer reports here.
  // FINDING 3: snapshot the backend once so both the new-key and legacy-key
  // reads of this multi-step fallback observe the same backend.
  const backend = secretBackend
  const getter: KeytarGetter = (_svc, account) => backend.get(account, 'oauth_refresh')
  const found = await lookupOauthRefreshToken(providerId, id, getter)
  return found ?? null
}

/**
 * Provider-agnostic reader with source channel — exposes whether the token
 * came from the new or legacy key.
 */
export async function getOauthRefreshTokenWithSource(
  providerId: string,
  id: number,
): Promise<{ token: string; source: OauthRefreshTokenSource } | null> {
  // See getOauthRefreshToken: route through the injected backend; per-key
  // try/catch inside lookupOauthRefreshTokenWithSource preserves the new→legacy
  // fallback.
  // FINDING 3: snapshot the backend once for the multi-step new→legacy read.
  const backend = secretBackend
  const getter: KeytarGetter = (_svc, account) => backend.get(account, 'oauth_refresh')
  const found = await lookupOauthRefreshTokenWithSource(providerId, id, getter)
  return found ?? null
}

/**
 * Explicit one-shot cleanup of the legacy `google:refresh:${id}` key. Called
 * from electron/main.ts after a successful read-from-legacy + write-to-new
 * cycle ("migrate on first use"). Keytar errors are swallowed.
 */
async function deleteLegacyGoogleRefreshTokenWith(
  backend: SecretBackend,
  id: number,
): Promise<void> {
  try {
    await backend.delete(legacyGoogleRefreshSecretKey(id), 'oauth_refresh')
  } catch (err) {
    // FINDING 2: PII-safe. No account id and no raw backend message (the
    // message can embed the key name). Stable label + sanitized error class
    // only; non-throwing swallow so a backend failure never breaks save flows.
    console.warn('[net/config] deleteLegacyGoogleRefreshToken failed:', err instanceof Error ? err.name : 'unknown')
  }
}

export async function deleteLegacyGoogleRefreshToken(id: number): Promise<void> {
  // FINDING 3: snapshot the backend once for this operation.
  const backend = secretBackend
  await deleteLegacyGoogleRefreshTokenWith(backend, id)
}

function legacyImapSecretKey(meta: AccountMeta) {
  return `imap:${meta.imap.user}@${meta.imap.host}`
}

function legacySmtpSecretKey(meta: AccountMeta) {
  return `smtp:${meta.smtp.user}@${meta.smtp.host}`
}

function ensureMigratedSingleAccountToAccounts(): void {
  const hasAccounts = Array.isArray(store.get('accounts'))
  if (hasAccounts) return

  const legacy = store.get('account')
  if (!legacy) return

  // Migration: old single-account format -> accounts[ {id:1,...} ] list.
  const settingsRaw = store.get('settings')
  const parsedSettings = (() => {
    try {
      return settingsSchema.parse(settingsRaw)
    } catch {
      return undefined
    }
  })()

  // In the old format, folderRoles were stored in settings. Move them to the account.
  const legacyFolderRoles = (settingsRaw && typeof settingsRaw === 'object')
    ? (settingsRaw as { folderRoles?: unknown }).folderRoles
    : undefined
  const folderRoles = (() => {
    try {
      return folderRolesSchema.parse(legacyFolderRoles)
    } catch {
      return undefined
    }
  })()

  const imapMeta = imapSchema.parse(stripSecrets(legacy.imap))
  const smtpMeta = smtpSchema.parse(stripSecrets(legacy.smtp))
  const meta: AccountMeta = {
    id: 1,
    name: undefined,
    colorIndex: 0,
    authType: 'password',
    providerId: 'generic-imap',
    transportType: 'imap-smtp',
    // Secrets are not stored in AccountMeta, so we strip `pass`.
    imap: imapMeta,
    smtp: smtpMeta,
    folderRoles: folderRoles || {},
    // 2.3-A: synthesize a default identity for the migrated single-account
    // record. We do this eagerly here (unlike the read-side preprocess, which
    // keeps the on-disk record unchanged) because this migration path
    // *already* rewrites the store (account -> accounts[0]), so adding the
    // identities[] field to the fresh record is a single atomic write.
    identities: [synthesizeDefaultIdentity({
      displayName: undefined,
      email: smtpMeta.user || imapMeta.user,
      signature: undefined,
    })],
  }

  store.set('accounts', [meta])
  store.delete('account')

  // If currentAccountId is not set, default to 1.
  const nextSettings: Settings = parsedSettings
    ? { ...parsedSettings, currentAccountId: parsedSettings.currentAccountId ?? 1 }
    : {
        theme: 'light',
        cacheDays: 30,
        language: 'en',
        notificationsEnabled: true,
        imapIdleEnabled: true,
        draftSyncEnabled: true,
        currentAccountId: 1,
      }
  store.set('settings', nextSettings)
}

export function listAccounts(): AccountMeta[] {
  ensureMigratedSingleAccountToAccounts()
  const items = store.get('accounts')
  if (!Array.isArray(items)) return []

  const sanitized = items
    .map(item => accountMetaSchema.safeParse(item))
    .filter((result): result is z.ZodSafeParseSuccess<AccountMeta> => result.success)
    .map(result => {
      const d = result.data
      // Strip passwords — they belong in keytar, not in the store or IPC responses.
      // The Zod schema accepts `pass` from the store, but AccountMeta omits it.
      delete (d.imap as Record<string, unknown>).pass
      delete (d.smtp as Record<string, unknown>).pass
      return d
    })

  if (sanitized.length !== items.length || JSON.stringify(sanitized) !== JSON.stringify(items)) {
    store.set('accounts', sanitized)
  }
  return sanitized
}

export function getAccountMeta(id: number): AccountMeta | undefined {
  return listAccounts().find(a => a.id === id)
}

export async function getAccountConfig(id: number): Promise<AccountConfig | undefined> {
  const meta = getAccountMeta(id)
  if (!meta) return undefined

  // For OAuth2 accounts, password secrets are not needed: the access token is obtained via refresh token at runtime.
  // Here we return only the base config without secrets.
  if ((meta.authType ?? 'password') !== 'password') {
    return { imap: { ...meta.imap }, smtp: { ...meta.smtp } }
  }

  // §2.33 PR2a (FINDING 3): snapshot the backend once for the whole
  // read → migrate → reread operation. setSecretBackend() swaps a module-global;
  // taking a local snapshot guarantees every step of this multi-step op observes
  // the same backend even if a swap lands mid-flight.
  const backend = secretBackend

  const tryMigrateLegacySecrets = async (migrateImap: boolean, migrateSmtp: boolean) => {
    // Migration of old-format secrets (host-scoped keys) to the id-scoped keys,
    // routed through the snapshot backend so a session on the encrypted disk
    // fallback migrates in-place too.
    //
    // FINDING 1: migrate each credential ONLY when its id-scoped key is absent
    // (the migrate* flags carry the already-computed missing state). An
    // unconditional migration would overwrite a present, working id-scoped
    // password with stale legacy host-scoped data whenever the *other*
    // credential happened to be missing → auth failures.
    if (migrateImap) {
      try {
        const oldImap = await backend.get(legacyImapSecretKey(meta), 'imap_smtp')
        if (oldImap) {
          await backend.set(imapSecretKey(id), oldImap, 'imap_smtp')
          await backend.delete(legacyImapSecretKey(meta), 'imap_smtp')
        }
      } catch { /* ignore */ }
    }
    if (migrateSmtp) {
      try {
        const oldSmtp = await backend.get(legacySmtpSecretKey(meta), 'imap_smtp')
        if (oldSmtp) {
          await backend.set(smtpSecretKey(id), oldSmtp, 'imap_smtp')
          await backend.delete(legacySmtpSecretKey(meta), 'imap_smtp')
        }
      } catch { /* ignore */ }
    }
  }

  // If secrets are missing under new keys, try migrating legacy ones.
  //
  // With the DEFAULT (keytar) backend a backend failure rejects here, so the op
  // fails hard exactly as before — the connection must not start without a
  // password. With the INJECTED secretStore backend a keychain-unavailable
  // error is absorbed into the disk fallback, and a disk-only secret that the
  // reappeared keyring cannot see resolves to null (→ pass: undefined →
  // "needs re-entry", see SecretBackend migration-boundary note).
  let imapPass = (await backend.get(imapSecretKey(id), 'imap_smtp')) ?? undefined
  let smtpPass = (await backend.get(smtpSecretKey(id), 'imap_smtp')) ?? undefined
  if (!imapPass || !smtpPass) {
    await tryMigrateLegacySecrets(!imapPass, !smtpPass)
    imapPass = (await backend.get(imapSecretKey(id), 'imap_smtp')) ?? imapPass
    smtpPass = (await backend.get(smtpSecretKey(id), 'imap_smtp')) ?? smtpPass
  }

  return {
    imap: { ...meta.imap, pass: imapPass },
    smtp: { ...meta.smtp, pass: smtpPass },
  }
}

function normalizePass(pass?: string): string | undefined {
  // Do not trim spaces — passwords may contain leading/trailing spaces.
  return pass || undefined
}

function stripSecrets<T extends { pass?: unknown; accessToken?: unknown }>(cfg: T): Omit<T, 'pass' | 'accessToken'> {
  const { pass, accessToken, ...rest } = cfg
  // Secrets are stored only in keytar, so we intentionally ignore the values.
  void pass
  void accessToken
  return rest
}

/**
 * Write-side account schema. Accepts the canonical new-shape payload only —
 * the legacy 'google_oauth2' literal is rejected at parse time. Incoming
 * payloads with missing providerId/transportType are allowed and filled in
 * by normalizeAccountSavePayload below.
 *
 * The read-side accountMetaSchema is the single surface that still accepts
 * the legacy literal, as a backward-compat safety net for stored records.
 */
// 2.1-D / 2.2: Gmail and Outlook OAuth are supported at runtime.
// Keep this as a plain array so extending the allowlist is a one-line change
// and the refine message stays human-readable.
const OAUTH_ALLOWED_PROVIDER_IDS = ['gmail', 'outlook'] as const

export const accountSaveSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  colorIndex: z.number().int().min(0).max(7).optional(),
  avatarInitials: z.string().trim().min(1).max(2).optional(),
  avatarIcon: z.string().trim().min(1).optional(),
  avatarMode: z.enum(['initials', 'icon', 'gravatar']).optional(),
  authType: z.enum(['password', 'oauth2']).optional(),
  providerId: z.enum(['gmail', 'outlook', 'generic-imap']).optional(),
  transportType: z.enum(['imap-smtp']).optional(),
  imap: imapSchema,
  smtp: smtpSchema,
  folderRoles: folderRolesSchema,
  /**
   * 2.3-A legacy fallback — still accepted so wave 2 (renderer-ui) can land
   * independently. When `identities` is supplied, it wins; when only
   * `signature` is supplied, the save path propagates the signature onto
   * the existing default identity (BLOCKER fix) or synthesizes a new default
   * identity from the legacy top-level fields (new account path).
   *
   * Empty string is accepted as an explicit "clear" sentinel: the user
   * opened the legacy Signature tab, emptied the field, hit save. Previous
   * behaviour (`min(1)`) silently dropped this and reused the prior value,
   * so the user's clear was lost.
   */
  signature: z.string().optional(),
  /**
   * 2.3-A: explicit per-account identities. When present, must satisfy the
   * invariants (exactly one `isDefault: true`, unique ids, at least one).
   * Identity ids on incoming payloads are optional (the UI may emit a fresh
   * identity without a pre-assigned id — `normalizeIdentities()` fills in
   * `randomUUID()`); when provided they MUST be valid UUIDs. This blocks a
   * compromised renderer from forging an attacker-controlled id to collide
   * with an existing identity or to embed non-opaque data in the stable key.
   */
  identities: z.array(z.object({
    id: z.string().uuid().optional(),
    displayName: z.string().trim().min(1),
    email: z.string().trim().email(),
    signature: z.string().optional(),
    // Empty string is the explicit "clear" sentinel emitted by the Identities
    // tab when the user empties the field — must not be rejected. See
    // identitySchema.defaultBcc for the full contract.
    defaultBcc: z.string().trim().optional(),
    isDefault: z.boolean(),
  })).min(1).optional(),
}).strict().refine(
  (data) => {
    // Non-OAuth payloads are unrestricted here (password flows handle their
    // own providerId inference via normalizeAccountSavePayload).
    if (data.authType !== 'oauth2') return true
    // When authType === 'oauth2', providerId is either omitted (normalize
    // will fill in 'gmail') or must explicitly be in the allowlist. A
    // compromised renderer that persists an unsupported provider would
    // reach a token-refresh path that does not exist; reject at parse time.
    if (data.providerId === undefined) return true
    return (OAUTH_ALLOWED_PROVIDER_IDS as readonly string[]).includes(data.providerId)
  },
  {
    message: `OAuth accounts currently support only providerId in {${OAUTH_ALLOWED_PROVIDER_IDS.join(', ')}}`,
    path: ['providerId'],
  },
).refine(
  // 2.3-A: explicit identities[] in incoming payload must satisfy per-account
  // invariants — exactly one default, unique ids (among those present).
  // Note: ids are optional on the incoming shape (the UI may send a fresh
  // identity without an id), so unique-id check runs over identities that
  // DO have an id. `normalizeIdentities()` fills in UUIDs for the rest, and
  // those are unique-by-construction (randomUUID).
  (data) => {
    if (!data.identities) return true
    const defaults = data.identities.filter(i => i.isDefault).length
    if (defaults !== 1) return false
    const ids = data.identities.map(i => i.id).filter((id): id is string => typeof id === 'string')
    if (new Set(ids).size !== ids.length) return false
    return true
  },
  {
    message: 'identities must be non-empty with exactly one isDefault and unique ids',
    path: ['identities'],
  },
)

/**
 * Fill in missing `id` fields on incoming identities with fresh UUIDs and
 * validate the strict identity schema. Used by saveAccount on incoming
 * renderer payloads (which have already passed `accountSaveSchema`'s
 * UUID-strict check). Returns the canonical identities list ready to persist.
 *
 * Any supplied id MUST be a valid UUID — mirrors the write-side IPC schema
 * so direct callers (tests, future internal surfaces) can't bypass M1.
 * Missing ids are synthesized via `randomUUID()`.
 */
export function normalizeIdentities(incoming: Array<{
  id?: string
  displayName: string
  email: string
  signature?: string
  defaultBcc?: string
  isDefault: boolean
}>): Identity[] {
  const withIds: Identity[] = incoming.map(i => {
    if (i.id !== undefined && i.id.length > 0) {
      if (!isUuid(i.id)) {
        throw new Error(`identity.id must be a valid UUID (got '${i.id}')`)
      }
      return {
        id: i.id,
        displayName: i.displayName,
        email: i.email,
        signature: i.signature,
        defaultBcc: i.defaultBcc,
        isDefault: i.isDefault,
      }
    }
    return {
      id: randomUUID(),
      displayName: i.displayName,
      email: i.email,
      signature: i.signature,
      defaultBcc: i.defaultBcc,
      isDefault: i.isDefault,
    }
  })
  // Final invariants check — defence-in-depth: the write-side schema already
  // enforced these on the payload, but re-validate after id synthesis to catch
  // any subsequent caller-introduced breakage before we persist.
  return identitiesArraySchema.parse(withIds)
}

/**
 * HIGH-3: strictly re-validate an identity loaded from storage before a
 * re-save. Returns the identity verbatim when it satisfies the strict
 * write-side schema. When any field fails (typically `email` on legacy
 * records that fell back to a bare IMAP username), re-synthesize the email
 * from the provided fallback chain while preserving the surviving fields
 * (id, displayName, signature, defaultBcc, isDefault).
 *
 * Rationale: `existing.identities` is read via `identityReadSchema`
 * (permissive on email) to avoid locking users out on startup, but the
 * write path must not cement that legacy state forever — the next save
 * should auto-normalize. The id is preserved as-is even when non-UUID:
 * rewriting it would churn references and break "ids stable across saves".
 * Subsequent saves that DO supply a renderer payload go through the strict
 * `accountSaveSchema.identities[].id` UUID check and supersede the legacy id.
 */
function reconcileExistingIdentity(identity: Identity, fallbackEmail: string): Identity {
  const parsed = identitySchema.safeParse(identity)
  if (parsed.success) return parsed.data as Identity
  const rawDisplayName = (identity.displayName ?? '').trim()
  const rawEmail = fallbackEmail.trim()
  const emailLocalPart = rawEmail.includes('@') ? rawEmail.split('@')[0] : rawEmail
  const displayName = rawDisplayName || emailLocalPart || rawEmail
  return {
    // Keep legacy id for stability; downstream renderer writes will refresh
    // to UUID via accountSaveSchema on the next identity-editor save.
    id: identity.id && identity.id.length > 0 ? identity.id : randomUUID(),
    displayName,
    email: rawEmail,
    signature: identity.signature,
    defaultBcc: identity.defaultBcc,
    isDefault: identity.isDefault,
  }
}

/**
 * Normalize a parsed accountSaveSchema payload to the canonical new-shape.
 * Pure, no I/O. Does not overwrite explicit providerId/transportType already
 * present in the payload.
 */
function normalizeAccountSavePayload<T extends {
  authType?: 'password' | 'oauth2'
  providerId?: 'gmail' | 'outlook' | 'generic-imap'
  transportType?: 'imap-smtp'
}>(parsed: T): T & {
  authType: 'password' | 'oauth2'
  providerId: 'gmail' | 'outlook' | 'generic-imap'
  transportType: 'imap-smtp'
} {
  const nextAuthType: 'password' | 'oauth2' = parsed.authType ?? 'password'

  let nextProviderId = parsed.providerId
  if (nextProviderId === undefined) {
    // Symmetric with accountMetaSchema preprocess on the read side: the only
    // OAuth2 provider shipped today is Google. Microsoft OAuth2 (task 2.2)
    // will extend this when it lands.
    nextProviderId = nextAuthType === 'oauth2' ? 'gmail' : 'generic-imap'
  }

  const nextTransportType: 'imap-smtp' = parsed.transportType ?? 'imap-smtp'

  return {
    ...parsed,
    authType: nextAuthType,
    providerId: nextProviderId,
    transportType: nextTransportType,
  }
}

function pickColorIndex(existing: AccountMeta[], fallbackSeed: number): number {
  const used = new Set<number>()
  for (const a of existing) {
    if (typeof a.colorIndex === 'number' && Number.isFinite(a.colorIndex)) used.add(a.colorIndex)
  }
  for (let i = 0; i < 8; i++) {
    if (!used.has(i)) return i
  }
  return Math.abs(fallbackSeed) % 8
}

export async function saveAccount(input: unknown): Promise<{ id: number }> {
  ensureMigratedSingleAccountToAccounts()
  // FINDING 3: snapshot the backend once for all direct secret get/set/delete in
  // this operation. The OAuth cleanup below routes through the internal
  // `*With(backend, ...)` helpers so the nested secret work shares this single
  // operation snapshot — an in-flight setSecretBackend() swap can no longer
  // split one save's secret cleanup across two backends.
  const backend = secretBackend
  const parsedRaw = accountSaveSchema.parse(input) as {
    id?: number
    name?: string
    email?: string
    colorIndex?: number
    avatarInitials?: string
    avatarIcon?: string
    avatarMode?: 'initials' | 'icon' | 'gravatar'
    authType?: 'password' | 'oauth2'
    providerId?: 'gmail' | 'outlook' | 'generic-imap'
    transportType?: 'imap-smtp'
    imap: AccountConfig['imap']
    smtp: AccountConfig['smtp']
    folderRoles?: FolderRoles
    signature?: string
    identities?: Array<{
      id?: string
      displayName: string
      email: string
      signature?: string
      defaultBcc?: string
      isDefault: boolean
    }>
  }
  const parsed = normalizeAccountSavePayload(parsedRaw)

  const imapPass = normalizePass(parsed.imap.pass)
  const smtpPass = normalizePass(parsed.smtp.pass)

  const accounts = listAccounts()
  const id = parsed.id ?? (accounts.reduce((m, a) => Math.max(m, a.id), 0) + 1)
  const existing = accounts.find(a => a.id === id)
  const existingAuthType = existing?.authType

  // IPC trust gap guard: refuse to transition an existing account from a
  // non-OAuth state into OAuth unless a refresh token already exists in
  // keytar for this account id. A compromised renderer can craft a payload
  // with authType:'oauth2' + providerId, but it cannot mint an OAuth
  // refresh token — those are planted in keytar only by the provider-
  // specific OAuth flow (oauth:google:connect or oauth:microsoft:connect)
  // after a completed OAuth handshake. So "keytar has a token" is a proxy
  // for "the legitimate OAuth flow ran recently".
  //
  // New accounts (no existing record) are allowed without this check: they
  // flow through the provider OAuth handler, which writes the keytar token
  // in the same handler after saveAccount returns with the assigned id.
  // Accounts already in OAuth state are also allowed (re-save is idempotent).
  //
  // Note: existingAuthType here is already normalized to the canonical
  // two-member union by accountMetaSchema's read-side preprocess, so we
  // don't need to match the legacy literal on the existing side.
  const incomingIsOAuth = parsedRaw.authType === 'oauth2'
  const existingIsOAuth = existingAuthType === 'oauth2'
  if (existing && incomingIsOAuth && !existingIsOAuth) {
    const providerForLookup: 'gmail' | 'outlook' | 'generic-imap' =
      parsedRaw.providerId ?? 'gmail'
    const getter: KeytarGetter = (_svc, account) => backend.get(account, 'oauth_refresh')
    const found = await lookupOauthRefreshTokenWithSource(providerForLookup, id, getter)
    if (!found) {
      throw new Error(
        'OAuth account save requires a completed OAuth flow (oauth:<provider>:connect must precede accounts:save)',
      )
    }
  }
  // If the incoming payload didn't specify authType, fall back to the existing
  // account's value (already normalized to the canonical union on read).
  const authType: 'password' | 'oauth2' =
    parsedRaw.authType !== undefined
      ? parsed.authType
      : existingAuthType === 'oauth2'
        ? 'oauth2'
        : 'password'
  // providerId/transportType: prefer explicit incoming, then existing, then
  // the inferred value from normalization. This way a re-save without these
  // fields doesn't re-tag an account that already has them set.
  const providerId =
    parsedRaw.providerId
    ?? existing?.providerId
    ?? parsed.providerId
  const transportType =
    parsedRaw.transportType
    ?? existing?.transportType
    ?? parsed.transportType
  const colorIndex =
    parsed.colorIndex
    ?? existing?.colorIndex
    ?? pickColorIndex(accounts, id)

  // 2.3-A identities merge order:
  //   1. Explicit incoming `identities[]` wins unconditionally (the UI
  //      settled on a new list, respect it).
  //   2. Otherwise, if the incoming payload carries a legacy top-level
  //      `signature` (Signature tab save) AND an existing default identity
  //      exists, propagate the signature onto the default identity.
  //      BLOCKER fix: previously the save path reused `existing.identities`
  //      verbatim and later derived `meta.signature` from the default
  //      identity, which overwrote the user's edit with the stale value.
  //      Empty string is honoured as "user cleared signature" (distinct from
  //      undefined = "not submitted, preserve existing"). The rest of the
  //      existing identity list is preserved and still goes through the
  //      HIGH-3 re-validation pass below.
  //   3. Otherwise reuse the existing account's identities (re-save of
  //      unrelated fields, e.g. avatar, must not churn identity ids).
  //   4. Otherwise (brand-new account OR pre-2.3-A legacy record that has no
  //      identities yet) synthesize a default identity from the incoming /
  //      existing top-level legacy fields (`name`, `email`, `signature`).
  //
  // HIGH-3: whenever the path lands in branch 2 or 3 (reusing existing
  // identities without a fresh renderer payload), each identity is passed
  // through `reconcileExistingIdentity` — legacy records with a bare IMAP
  // username in the email slot (tolerated by the permissive read schema)
  // are auto-normalized on the first save instead of being cemented in
  // perpetuity. `id` is preserved across this normalization so the
  // "ids stable across saves" invariant holds; the first save that supplies
  // a renderer payload will upgrade non-UUID legacy ids via the strict
  // accountSaveSchema check.
  const mergedName = parsed.name ?? existing?.name
  const mergedEmail = parsed.email ?? existing?.email
  const mergedSignature = parsed.signature ?? existing?.signature
  const fallbackIdentityEmail =
    mergedEmail ?? parsed.smtp.user ?? parsed.imap.user

  let identities: Identity[]
  if (parsedRaw.identities) {
    identities = normalizeIdentities(parsedRaw.identities)
  } else if (existing?.identities && existing.identities.length > 0) {
    // Branch 2+3 merged: reuse existing, optionally patch default.signature.
    const existingList = existing.identities
    const shouldPatchSignature = parsedRaw.signature !== undefined
    // Preserve user's empty-string clear as-is (distinct from undefined).
    const nextSignature: string | undefined = shouldPatchSignature
      ? parsedRaw.signature
      : undefined

    identities = existingList.map(identity => {
      const patched: Identity = shouldPatchSignature && identity.isDefault
        ? { ...identity, signature: nextSignature }
        : identity
      return reconcileExistingIdentity(patched, fallbackIdentityEmail)
    })
    // NOTE: no final `identitiesArraySchema.parse(...)` pass here. The strict
    // array schema includes zod's email validator, which rejects hand-rolled
    // bare-domain forms like `user@host` (no TLD) that imap/smtp schemas
    // happily accept for `user`. If the stored record's smtp.user IS a
    // bare-form value, the reconciled identity email inherits it and a final
    // strict re-validation would reject the save. Per-identity reconcile
    // already preserves per-identity invariants by construction; list-level
    // invariants (exactly-one default, unique ids) are preserved from the
    // source list which passed `identityReadSchema` on load.
  } else {
    identities = [{
      ...synthesizeDefaultIdentity({
        displayName: mergedName,
        email: fallbackIdentityEmail,
        signature: mergedSignature,
      }),
    }]
  }

  const meta: AccountMeta = {
    id,
    name: mergedName,
    email: mergedEmail,
    colorIndex,
    avatarInitials: parsed.avatarInitials ?? existing?.avatarInitials,
    avatarIcon: parsed.avatarIcon ?? existing?.avatarIcon,
    avatarMode: parsed.avatarMode ?? existing?.avatarMode,
    authType,
    providerId,
    transportType,
    // Secrets are not stored in AccountMeta, so we strip `pass`.
    imap: stripSecrets(parsed.imap),
    smtp: stripSecrets(parsed.smtp),
    folderRoles: parsed.folderRoles ?? existing?.folderRoles ?? {},
    identities,
    // 2.3-A: keep the legacy `signature` field populated for one release cycle.
    // Source-of-truth is now the default identity's signature; legacy readers
    // (Compose, Settings → Signature tab, AI send helpers) fall back to this
    // field until wave 2 rewires them to the identity selector.
    //
    // HIGH-2 (2.3 wave 3): when the renderer submits `identities[]` explicitly,
    // that array is the sole source of truth — the legacy `meta.signature`
    // MUST be derived ONLY from the default identity's signature, with NO
    // fallback to `parsed.signature` (the Settings window currently also
    // emits a top-level `signature` from independent state) or to
    // `existing?.signature` (the stored legacy mirror). Otherwise, when the
    // user clears the default identity's signature via the Identities tab
    // (identity.signature becomes '' or undefined), the `??` chain resurrects
    // the stale legacy value, Compose reads that fallback, and the cleared
    // signature reappears. Empty string and undefined both mean "cleared"
    // here and are normalized to '' so the mirror reflects the clear
    // unambiguously (renderer-ui sends '' explicitly, but older callers may
    // still emit undefined — both paths must behave identically).
    //
    // When `identities[]` is NOT submitted (legacy-only save from the
    // Signature tab), the fallback chain is preserved: the wave-2 BLOCKER
    // fix has already propagated `parsed.signature` into the default
    // identity (branch 2 of the merge above), so the first `??` term still
    // wins in practice; the remaining fallbacks guard brand-new-account
    // and unchanged-signature re-save flows.
    signature: parsedRaw.identities !== undefined
      ? (identities.find(i => i.isDefault)?.signature ?? '')
      : (identities.find(i => i.isDefault)?.signature
          ?? parsed.signature
          ?? existing?.signature),
  }

  // Enforce `oauth2 => providerId in OAUTH_ALLOWED_PROVIDER_IDS` on the
  // *merged* record, not just on the incoming payload. The accountSaveSchema
  // refine above only sees the raw payload: an update that omits `authType`
  // but injects an unsupported providerId slips past because the refine
  // short-circuits on `data.authType !== 'oauth2'` (authType undefined).
  // Then the merge-with-existing block restores `authType = 'oauth2'` from
  // the stored record while the explicit providerId from the payload wins.
  // The resulting record lands at runtime inside a token-refresh path that
  // may not exist for the injected provider.
  //
  // The refine is kept on purpose — it gives the best zod error path for
  // straight-forward attacks and rejects early before merge — and this check
  // is the defense-in-depth second layer on the effective post-merge pair.
  if (
    meta.authType === 'oauth2' &&
    meta.providerId !== undefined &&
    !(OAUTH_ALLOWED_PROVIDER_IDS as readonly string[]).includes(meta.providerId)
  ) {
    throw new Error(
      `OAuth accounts currently support only providerId in {${OAUTH_ALLOWED_PROVIDER_IDS.join(', ')}} (got '${meta.providerId}')`,
    )
  }

  const next = existing
    ? accounts.map(a => (a.id === id ? meta : a))
    : [...accounts, meta]
  store.set('accounts', next)

  if (authType === 'password') {
    if (imapPass) await backend.set(imapSecretKey(id), imapPass, 'imap_smtp')
    if (smtpPass) await backend.set(smtpSecretKey(id), smtpPass, 'imap_smtp')
    // If the account was switched from OAuth2 to password, the refresh token
    // is no longer needed. Also clean up the legacy `google:refresh:${id}`
    // key in case it was hanging around from pre-migration installs.
    if (existingAuthType === 'oauth2') {
      await setOauthRefreshTokenWith(backend, providerId, id, null)
      await deleteLegacyGoogleRefreshTokenWith(backend, id)
    }
  } else {
    // For OAuth2 we don't store password secrets.
    try { await backend.delete(imapSecretKey(id), 'imap_smtp') } catch { /* ignore */ }
    try { await backend.delete(smtpSecretKey(id), 'imap_smtp') } catch { /* ignore */ }
  }

  // If this is the first account, set it as the current one.
  const s = getSettings()
  if (!s.currentAccountId) {
    saveSettings({ ...s, currentAccountId: id })
  }

  return { id }
}

/**
 * Settings fields that are maps keyed by stringified account id AND hold a
 * consent — a recorded answer to "may this mailbox use this feature".
 *
 * Kept as an array rather than spelled out at the call site so that adding a
 * fifth per-account opt-in has ONE place to be registered, and so a test can
 * assert the list matches the schema instead of trusting prose.
 */
export const ACCOUNT_KEYED_CONSENT_FIELDS = [
  'aiThreadSummaryEnabled',
  'aiInstantReplyEnabled',
  'aiProofreadEnabled',
  'aiTranslateEnabled',
] as const

export type AccountKeyedConsentField = typeof ACCOUNT_KEYED_CONSENT_FIELDS[number]

/**
 * Drop every recorded consent belonging to one account id.
 *
 * Why this exists: account ids are handed out as `max(existing) + 1`, so a
 * freed number can come back — deleting the highest-numbered mailbox hands its
 * id to the next one created. Delete a mailbox that had been allowed to use,
 * say, AI Translate, add another, and the main-side gate reads a map that still
 * says `{"2": true}` and honours it. The new mailbox comes up with a consent
 * its owner never gave, and from main's point of view that `true` is a
 * perfectly honest record. The §1.26 consent grid widened the exposure: one
 * click on a column header now writes `true` for every mailbox at once,
 * including the id that is about to be freed.
 *
 * The entry is DELETED, not set to `false`: `false` means "asked and refused",
 * and there is no longer anyone to have refused. See `forgetAccountAiConsents`
 * usage in `deleteAccount` for why it runs before the record is removed.
 *
 * The durable, id-keyed state that lives elsewhere is already handled: DB rows
 * by `deleteAccountData` (packages/db), secrets by `deleteAccount` itself, and
 * main's in-memory registries by `completeAccountRemoval` — including the
 * account GENERATION, which is the same defence applied to sign-in verdicts in
 * §2.165.
 */
export function forgetAccountAiConsents(id: number): void {
  const key = String(id)
  const settings = getSettings()
  const patch: { [K in AccountKeyedConsentField]?: Record<string, boolean> } = {}
  let changed = false
  for (const field of ACCOUNT_KEYED_CONSENT_FIELDS) {
    const map = settings[field]
    if (!map || !Object.prototype.hasOwnProperty.call(map, key)) continue
    const nextMap = { ...map }
    delete nextMap[key]
    patch[field] = nextMap
    changed = true
  }
  if (!changed) return
  saveSettings({ ...settings, ...patch })
}

export async function deleteAccount(id: number): Promise<void> {
  ensureMigratedSingleAccountToAccounts()
  // The consents go FIRST — before the record, the secrets and the rows.
  //
  // Everything below this line can fail (the OAuth cleanup awaits are not
  // wrapped), and an id can come back: `saveAccount` assigns `max(existing) + 1`,
  // so deleting the highest-numbered mailbox frees its number for the next one.
  //
  // What the ordering buys is one guarantee and nothing wider: no path through
  // this function ends with the account record gone and its consents still
  // recorded. That is the direction §2.82 calls safe — a withdrawal may happen
  // too eagerly, a grant may not outlive the owner it belonged to. Running the
  // purge last would invert exactly that: a rejection in the secret cleanup
  // would leave the record removed and the `true` behind, and
  // `completeAccountRemoval` in main (the teardown owner for that case) has no
  // access to the settings store.
  //
  // Other residue a partial failure can leave is NOT ruled out, in either
  // direction: a throw before `store.set('accounts', …)` leaves the mailbox
  // listed with its consents already withdrawn, and a throw after it leaves the
  // record gone with secrets, EMLs or rows partly behind.
  //
  // The purge is also not the last word on the maps — the settings window is a
  // second writer and can merge a stale entry back. That is refused in main
  // (`settings:save`, electron/accountKeyedConsents.ts).
  forgetAccountAiConsents(id)
  // FINDING 3: snapshot the backend once for this operation's direct secret
  // deletes. The OAuth cleanup below routes through the internal
  // `*With(backend, ...)` helpers so the nested secret work shares this single
  // operation snapshot — an in-flight setSecretBackend() swap can no longer
  // split one delete's secret cleanup across two backends.
  const backend = secretBackend
  const accounts = listAccounts()
  const next = accounts.filter(a => a.id !== id)
  store.set('accounts', next)
  try { await backend.delete(imapSecretKey(id), 'imap_smtp') } catch { /* ignore */ }
  try { await backend.delete(smtpSecretKey(id), 'imap_smtp') } catch { /* ignore */ }
  // Clean up OAuth2 refresh tokens for known providers plus the legacy key.
  // We don't know the providerId at delete time (account already filtered out
  // above), so wipe all provider slots defensively.
  await setOauthRefreshTokenWith(backend, 'gmail', id, null)
  await setOauthRefreshTokenWith(backend, 'outlook', id, null)
  await deleteLegacyGoogleRefreshTokenWith(backend, id)
  try { deleteAccountData(id) } catch { /* ignore */ }

  const s = getSettings()
  if (s.currentAccountId === id) {
    const fallback = next[0]?.id
    saveSettings({ ...s, currentAccountId: fallback })
  }
}

export function listMcpConnections(): McpConnectionConfig[] {
  return getSettings().mcpConnections ?? []
}

export function getMcpConnection(id: string): McpConnectionConfig | undefined {
  return listMcpConnections().find(conn => conn.id === id)
}

export function saveMcpConnection(input: unknown): McpConnectionConfig {
  const parsed = mcpConnectionSchema.parse(input)
  const settings = getSettings()
  const current = settings.mcpConnections ?? []
  const existingIndex = current.findIndex(conn => conn.id === parsed.id)
  const next = existingIndex >= 0
    ? current.map((conn, index) => (index === existingIndex ? parsed : conn))
    : [...current, parsed]
  saveSettings({
    ...settings,
    mcpConnections: next,
  })
  return parsed
}

export function deleteMcpConnection(id: string): void {
  const settings = getSettings()
  const current = settings.mcpConnections ?? []
  const next = current.filter(conn => conn.id !== id)
  saveSettings({
    ...settings,
    mcpConnections: next.length > 0 ? next : undefined,
  })
}

/**
 * Module-level marker so the wave-3 mcpConnections env-denylist migration
 * audit event fires at most once per launch. Without this guard, every
 * subsequent `getSettings()` call that hits the sanitization path (until
 * the user re-saves) would re-emit the audit event and spam the log.
 *
 * The persisted "already migrated" marker lives on the settings record
 * itself (see `mcpConnectionsEnvMigratedWave3` below): once we successfully
 * re-persist the sanitized record, later launches bypass the sanitization
 * path entirely. The in-memory flag is a secondary guard for the window
 * between sanitize-in-memory and persist-on-disk (e.g. if the persist
 * throws because the disk is full).
 */
let mcpEnvSanitizationAuditedThisLaunch = false

/**
 * The persisted settings record EXACTLY as stored — no schema parse, no
 * defaults, no migrations.
 *
 * `getSettings()` cannot answer "was this key ever written?", because zod
 * substitutes a default for every absent field. §2.82's one-time consent
 * migration needs precisely that distinction: `sentryEnabled: false` on disk
 * is a user who found the About switch and turned it off (an expressed
 * refusal, seed it as one), while an ABSENT key is a user who was simply never
 * asked (leave the record empty so the consent screen runs). Reading the
 * parsed value would conflate the two the moment anyone changes
 * `sentryEnabled`'s default — see electron/services/telemetryConsentService.ts.
 *
 * Returns `undefined` when nothing has been persisted yet (fresh install) or
 * the stored value is not an object.
 */
export function getRawPersistedSettings(): Record<string, unknown> | undefined {
  const raw = store.get('settings')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

export function getSettings(): Settings {
  ensureMigratedSingleAccountToAccounts()
  const raw = store.get('settings')
  if (!raw) {
    return {
      theme: 'light',
      cacheDays: 30,
      language: 'en',
      notificationsEnabled: true,
      imapIdleEnabled: true,
      draftSyncEnabled: true,
      groupConversations: true,
      currentAccountId: listAccounts()[0]?.id,
    }
  }

  // Support for old settings: add new fields via schema defaults.
  //
  // Wave-3 migration tolerance: before wave-2, `mcpConnections[].env` had
  // no denylist, so pre-wave-2 users may have persisted entries with
  // PATH / NODE_OPTIONS / LD_PRELOAD / etc. The wave-2 `.superRefine()`
  // on `mcpConnectionSchema` now rejects those at parse time, which would
  // crash `getSettings()` for pre-wave-2 users and brick the app at boot.
  //
  // Policy: if the strict parse fails AND the only reason is forbidden
  // env keys in persisted mcpConnections, strip those keys, audit-log the
  // strip once per launch, and re-parse. Preserve all other connection
  // fields and all other settings. This matches the pattern used by
  // `ensureMigratedSingleAccountToAccounts` for legacy `account` records:
  // silently upgrade on read, then persist once so subsequent reads see
  // a clean record.
  const initialParse = settingsSchema.safeParse(raw)
  if (initialParse.success) {
    const parsed = initialParse.data
    return {
      ...parsed,
      currentAccountId: parsed.currentAccountId ?? listAccounts()[0]?.id,
    }
  }

  // Narrow: attempt env-denylist sanitization only when the stored record
  // looks like an object with mcpConnections that could contain forbidden
  // env keys. Anything else re-throws via the terminal parse below so
  // un-parseable garbage still falls through to the existing catch path
  // in callers (legacy "fresh defaults on corrupted settings" behaviour).
  if (raw && typeof raw === 'object') {
    const rawObj = raw as Record<string, unknown>
    const { sanitized: sanitizedConns, stripped } = sanitizeMcpConnectionsEnv(
      rawObj.mcpConnections,
    )
    if (stripped.length > 0) {
      const patched = { ...rawObj, mcpConnections: sanitizedConns }
      const retry = settingsSchema.safeParse(patched)
      if (retry.success) {
        const parsed = retry.data
        // Audit-log exactly once per launch, then set a persisted marker so
        // subsequent launches skip the whole sanitization branch.
        if (!mcpEnvSanitizationAuditedThisLaunch) {
          mcpEnvSanitizationAuditedThisLaunch = true
          notifyMcpEnvSanitization(stripped)
        }
        // Persist the sanitized record once so the next launch sees a
        // clean record and does not re-sanitize on every read. Writing
        // on a read path is unusual — we do it here because the legacy
        // record is no longer parse-safe, and leaving the bad env keys
        // in the store would mean `getSettings()` continues to pay the
        // sanitize + re-parse cost until the user happens to edit
        // something. Wrapped in try/catch so a disk-full / permission
        // failure does not brick the boot — we still return the in-memory
        // sanitized record.
        try {
          store.set('settings', parsed)
        } catch {
          // Persistence failure is non-fatal: the in-memory record is
          // already clean for this session. The next launch will re-run
          // sanitization, which is idempotent.
        }
        return {
          ...parsed,
          currentAccountId: parsed.currentAccountId ?? listAccounts()[0]?.id,
        }
      }
      // Sanitization removed env keys but parse still failed for unrelated
      // reasons — fall through to the strict parse below, which will throw
      // and surface the other error (not swallowed).
    }
  }

  // Terminal strict parse — same behaviour as before wave-3 for records
  // that aren't rescuable via env sanitization. Throws so upstream catch
  // blocks (e.g. `ensureMigratedSingleAccountToAccounts`) can fall back
  // to fresh defaults.
  const parsed = settingsSchema.parse(raw)
  return {
    ...parsed,
    currentAccountId: parsed.currentAccountId ?? listAccounts()[0]?.id,
  }
}

/**
 * Test-only helper: reset the in-memory "audited this launch" flag so
 * successive test cases can re-trigger the sanitization audit pathway
 * without process restart. Not exported for app code.
 */
export function __resetMcpEnvSanitizationAuditFlagForTest(): void {
  mcpEnvSanitizationAuditedThisLaunch = false
}

export function saveSettings(s: Settings) {
  const parsed = settingsSchema.parse(s)
  store.set('settings', parsed)
}

/** Providers whose AI key can be stored. Mirrors `ApiKeyProvider` in
 * electron/services/ai.ts; kept as a literal here so packages/net stays free of
 * an electron import. Every provider is key-based since §2.218. */
export type AiKeyProviderId = 'anthropic-api' | 'openai-api' | 'gemini-api'

/**
 * §2.122 — record (or clear) the non-secret "a key for this provider was
 * saved" marker. MAIN-PROCESS ONLY: the sole call sites are `saveApiKey` /
 * `deleteApiKey` in electron/services/ai.ts, and the field is absent from
 * `rendererWritableSettingsSchema` so `settings:save` rejects it outright.
 *
 * The value is a boolean and only a boolean — no key material, no fragment,
 * no hash. See the `Settings.aiApiKeySaved` JSDoc for why this may never
 * become an enforcement input.
 */
export function setAiApiKeySavedFlag(provider: AiKeyProviderId, saved: boolean): void {
  const current = getSettings()
  const next = { ...(current.aiApiKeySaved ?? {}), [provider]: saved }
  saveSettings({ ...current, aiApiKeySaved: next })
}

/**
 * §2.99 (review H4) — record the outcome of an autostart registration attempt.
 *
 * Main-only, same shape of writer as `setAiApiKeySavedFlag`: the renderer reads
 * it through the settings it already fetches and never writes it. The user's
 * own `launchAtLogin` preference is deliberately NOT touched here — a failed
 * registration must not silently un-choose what the user chose.
 */
export function setLaunchAtLoginStatus(status: {
  supported: boolean
  applied: boolean
  requested: boolean
  at: string
}): void {
  const current = getSettings()
  saveSettings({ ...current, launchAtLoginStatus: status })
}
