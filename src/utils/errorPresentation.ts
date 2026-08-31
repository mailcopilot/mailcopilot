// Renderer-side wrapper over @mailcopilot/core/errorPresentation — the single
// place that turns a rejected `window.api.invoke(...)` into copy a human reads.
// Source of truth for the classification itself is packages/core.
import type { useTranslation } from 'react-i18next'
import {
  ERROR_PRESENTATION_I18N_KEYS,
  decodeErrorPresentation,
  stripErrorPresentation,
  type ErrorPresentationKey,
} from '@mailcopilot/core'

export type Translate = ReturnType<typeof useTranslation>['t']

/**
 * An error the renderer raised itself, whose message is ALREADY a translated
 * user-facing sentence.
 *
 * Some flows want one catch block to own their cleanup (metrics, wizard-step
 * rollback, cooldown bookkeeping) rather than duplicating it per failure mode,
 * so a `res.ok === false` branch throws instead of returning. Without a marker,
 * {@link presentedError} could not tell that deliberate copy apart from a
 * third party's prose, and would collapse it into the generic "unknown"
 * sentence.
 *
 * The marker is a CLASS, not a string convention: `instanceof` cannot be forged
 * by a server that happens to echo our wording back at us, and it does not
 * survive the IPC boundary — anything arriving from main is a plain `Error` by
 * construction (see packages/core/errorPresentation.ts), so a hostile main-side
 * value can never claim to be already-translated.
 */
export class TranslatedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranslatedError'
  }
}

/**
 * §2.127 — the sentence shown for a failed operation, never the error text.
 *
 * Every rejection that crosses `electron/ipc.ts` arrives tagged with a
 * closed-vocabulary key (`[mcerr:offline]` and friends);
 * `decodeErrorPresentation` reads that tag, and falls back to the same
 * classifier for failures raised before the funnel (the preload whitelist) or
 * purely in the renderer. The result indexes ERROR_PRESENTATION_I18N_KEYS, so
 * what reaches the screen is one of four translated sentences — plus the
 * {@link TranslatedError} passthrough for copy we wrote ourselves.
 *
 * This replaces `String(e)`, which produced "Sync error: Error: Error invoking
 * remote method 'net:inboxSummaries': AggregateError" on a dropped connection —
 * an AggregateError's `message` is empty by construction, so the user was shown
 * a type name. It also keeps untrusted text off the screen: IMAP/SMTP servers
 * and OAuth endpoints are third parties, and their prose has no business being
 * rendered as our own copy.
 *
 * The console line carries the VERDICT, never the value. Logging the raw error
 * here used to look free — it is renderer-local diagnostics, after all — but
 * the renderer keeps Sentry's default integrations (see `src/sentry.ts`), and
 * `console.*` output is one of them: every argument becomes a breadcrumb and
 * ships with the next event that passes `beforeSend`. Since the text after
 * `[mcerr:*]` is deliberately left raw (two consumers match substrings in it),
 * printing the object handed a hostile IMAP/SMTP server a writable field in our
 * telemetry — the free third-party text CLAUDE.md §8 forbids, defeating the
 * §2.127 boundary from the other side.
 *
 * The raw value is not lost: the main-process funnel logs the flattened error
 * tree via `describeErrorForLog`, which is a local log file and never Sentry.
 * Errors raised purely in the renderer never had a raw carrier to lose — their
 * text is ours, and the {@link TranslatedError} branch is where it is shown.
 */
export function presentedError(translate: Translate, e: unknown): string {
  if (e instanceof TranslatedError && e.message) {
    console.error('[ipc-error]', 'translated')
    return e.message
  }
  // Closed vocabulary in, closed vocabulary out: one of ERROR_PRESENTATION_KEYS.
  const key = decodeErrorPresentation(e)
  console.error('[ipc-error]', key)
  return translate(ERROR_PRESENTATION_I18N_KEYS[key])
}

// ---------------------------------------------------------------------------
// Telemetry side of the same boundary
// ---------------------------------------------------------------------------
//
// §2.127 closed one of two doors: the SCREEN no longer shows third-party prose,
// and the console (a Sentry breadcrumb source) no longer prints it. The other
// door is the exception itself — `captureException(err, …)` on a RAW IPC
// rejection sends the text of that rejection as the exception value, and the
// renderer's `beforeSend` only knows two rules (transient-noise, PII shapes),
// neither of which stops prose. An IMAP/SMTP server picks that text, so it is
// third-party free text on a transmission path — exactly what CLAUDE.md §8
// forbids, and it needs an ALLOW list, not a deny list.
//
// The `[mcerr:*]` tag is the allow-list signal: main already classified the
// error BY OBJECT (codes, `authenticationFailed`, the AggregateError/cause
// tree) before Electron flattened it into a string, and it stamped the verdict
// at a position only the funnel can write. So the renderer never has to parse
// server prose — it reads the verdict and throws the rest away.

/** A rejection that carries the main-process funnel's verdict. */
export type IpcFailureTag = {
  /** Closed-vocabulary verdict decoded from the tag. */
  key: ErrorPresentationKey
  /** IPC channel taken from Electron's envelope, or null when absent/odd. */
  channel: string | null
}

/**
 * Verdicts that describe the state of the NETWORK rather than a defect in the
 * app: the user's Wi-Fi, VPN, laptop lid or a server that stopped answering.
 * They belong with `isTransientNetworkError` in the noise filter.
 *
 * This is also what finally closes the long-standing `AggregateError` hole.
 * `beforeSend` receives a STRING (`event.exception.values[i].value`), while the
 * unwrapping that recognises transient noise inside an `AggregateError` needs
 * the OBJECT — `.errors[]` never survives the IPC boundary, and an
 * `AggregateError`'s own `message` is empty by construction. So
 * "Error invoking remote method 'net:inboxSummaries': AggregateError" — the
 * single noisiest renderer event, a dropped connection during sync — was never
 * matched by the classifier the filter exists for. The tag carries the verdict
 * main reached while the object was still intact.
 */
const IPC_FAILURE_NOISE_KEYS: ReadonlySet<ErrorPresentationKey> = new Set<ErrorPresentationKey>([
  'offline',
  'timeout',
])

/** True when the tagged failure is network state, not an app defect. */
export function isIpcFailureNoise(failure: IpcFailureTag): boolean {
  return IPC_FAILURE_NOISE_KEYS.has(failure.key)
}

/**
 * `exception.type` of the synthetic event the renderer sends instead of a
 * tagged rejection. Mirrors `NetError` in electron/services/netErrorTelemetry.ts.
 */
export const IPC_FAILURE_EXCEPTION_NAME = 'IpcFailure'

/** Placeholder used when the channel could not be read from the envelope. */
const UNKNOWN_CHANNEL = 'unknown'

/**
 * The whole payload of a tagged failure, assembled from a closed set: the
 * verdict enum plus a shape-validated channel name. Doubles as the Sentry
 * grouping key, same shape as `net_<source>_<class>` in the main process.
 */
export function ipcFailureLabel(failure: IpcFailureTag): string {
  return `ipc_${failure.channel ?? UNKNOWN_CHANNEL}_${failure.key}`
}

// Electron's own envelope — `Error invoking remote method '<channel>': …` —
// anchored at the start of the message, where only Electron writes. This is NOT
// a second copy of the tag format (that has exactly one owner, see
// `readIpcFailureTag`); it is a reader for a different producer's wrapper, and
// core exports none.
//
// The channel class is deliberately narrow (our own channel names: `net:`,
// `ai:`, `cert:` … ) and bounded. A server cannot reach position 0 — the funnel
// prepends its tag and Electron prepends this envelope — but if any string that
// does not look like one of our channels shows up there, it is dropped rather
// than transmitted, so prose can never ride along as a "channel".
const IPC_ENVELOPE_CHANNEL_RE =
  /^(?:[\w$]{0,60}(?:Error|Exception): )?Error invoking remote method '([A-Za-z0-9][A-Za-z0-9:._-]{0,63})'/

/** Best-effort text of an unknown rejection value. Never throws. */
function readErrorText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    if (value !== null && typeof value === 'object') {
      const message = (value as { message?: unknown }).message
      if (typeof message === 'string' && message) return message
    }
    return value == null ? '' : String(value)
  } catch {
    // Exotic values (throwing getters, Symbol.toPrimitive traps).
    return ''
  }
}

/**
 * Read the main-process verdict off a rejection, or null when the value never
 * passed through the IPC funnel.
 *
 * Tag DETECTION is delegated, not reimplemented. The format has exactly one
 * owner — packages/core/errorPresentation.ts — and a second implementation of
 * the same security decision is precisely the vulnerability this project keeps
 * paying for. Core exports no `hasTag()` predicate, but `stripErrorPresentation`
 * IS the positional matcher: it removes a funnel-position tag and, beyond that,
 * only normalises whitespace. Applying the same normalisation here and comparing
 * leaves exactly the tag as the difference.
 *
 * Drift direction is deliberate. If core ever adds another cosmetic rewrite to
 * `strip`, an untagged error would look tagged and be reported as a synthetic
 * event — a loss of detail, never a leak. The dangerous direction (a tagged
 * rejection read as untagged, so its raw text is transmitted) requires `strip`
 * to stop removing the tag, which its own tests forbid.
 *
 * Recognising the tag rather than the text also means an echo attack fails
 * closed: a server that embeds `[mcerr:auth]` in its own prose only adds a
 * SECOND occurrence, while the funnel's tag still sits in first position — the
 * value is still treated as tagged and the prose is still discarded.
 */
export function readIpcFailureTag(value: unknown): IpcFailureTag | null {
  const text = readErrorText(value)
  if (!text) return null
  let stripped: string
  try {
    stripped = stripErrorPresentation(text)
  } catch {
    return null
  }
  // The cosmetic half of `stripErrorPresentation`, applied to the input so the
  // only surviving difference can be the tag it removed.
  const normalized = text.replace(/\s{2,}/g, ' ').trim()
  if (stripped === normalized) return null
  let key: ErrorPresentationKey
  try {
    key = decodeErrorPresentation(text)
  } catch {
    key = 'unknown'
  }
  const channel = IPC_ENVELOPE_CHANNEL_RE.exec(text)?.[1] ?? null
  return { key, channel }
}
