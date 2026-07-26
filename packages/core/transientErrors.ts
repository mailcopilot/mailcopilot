/**
 * Transient network error classification.
 *
 * Single source of truth for Sentry telemetry filtering of errors that are:
 *   - not actionable from code (user's proxy, sleep, VPN, flaky Wi-Fi),
 *   - expected to retry on their own,
 *   - noisy in Sentry.
 *
 * Consumers (telemetry filters — keep in sync):
 *   - electron/sentry.ts (main-process beforeSend filter)
 *   - src/sentry.ts (renderer beforeSend filter)
 *   - electron/main.ts (autoUpdater.on('error') gate)
 *
 * Note: packages/net/imap.ts has its own retry-classification regex
 * (`'not usable'`, `'closed'` — retry-specific phrases). Semantics differ
 * from telemetry filtering; do not unify without a dedicated refactor.
 *
 * Pure function, no side effects.
 */

// Chromium / Electron net::ERR_* codes surfaced through autoUpdater and
// webContents. Only codes that unambiguously indicate a transient network
// condition live here. Codes that may mask a real bug (broken TLS config,
// corrupt update artifact) are intentionally NOT classified as transient:
//   - ERR_SSL_PROTOCOL_ERROR — may indicate misconfigured server/CA,
//     expired cert, or pinning mismatch. Hiding it masks real TLS breakage.
//   - ERR_CONTENT_LENGTH_MISMATCH — may indicate a corrupted update
//     artifact or a broken CDN; needs visibility in telemetry.
const CHROMIUM_NET_CODES = [
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_FAILED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_TIMED_OUT',
  'ERR_HTTP2_PROTOCOL_ERROR',
  'ERR_EMPTY_RESPONSE',
  'ERR_SOCKET_NOT_CONNECTED',
  'ERR_TUNNEL_CONNECTION_FAILED',
];

// Node.js syscall error codes.
const NODE_NET_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
];

// Library-level textual signatures that always indicate transient state.
const TRANSIENT_PHRASES = [
  'Socket timeout',
  'Connection not available', // imapflow createNoConnectionError
  'Connection closed',
  'socket hang up',
  'Client network socket disconnected',
];

const TRANSIENT_NET_RE = new RegExp(
  [
    ...CHROMIUM_NET_CODES,
    ...NODE_NET_CODES,
    ...TRANSIENT_PHRASES.map(escapeRegex),
  ].join('|'),
);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Max depth for walking `err.cause` chains / AggregateError.errors trees.
// Bounded to defend against cyclic cause references.
const MAX_CAUSE_DEPTH = 5;

/**
 * Returns true if `input` looks like a transient network condition that is
 * not actionable from our code and should be filtered out of telemetry.
 *
 * Walks `err.cause` chains (wrapped errors) and AggregateError.errors trees:
 *   - wrapped Error with a transient cause → true
 *   - AggregateError where ALL inner errors are transient → true
 *   - AggregateError where ANY inner error is non-transient → false
 *     (conservative: do not silence telemetry if a real error is mixed in)
 *
 * Accepts a string, Error, or unknown payload (e.g. `unhandledRejection`
 * reason, which may be anything).
 */
export function isTransientNetworkError(input: unknown): boolean {
  return classify(input, 0, new WeakSet());
}

function classify(input: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (input == null) return false;
  if (typeof input === 'string') return TRANSIENT_NET_RE.test(input);

  if (typeof input === 'object') {
    const obj = input as object;
    if (seen.has(obj)) return false;
    seen.add(obj);

    // AggregateError: transient iff all inner errors are transient, and
    // there is at least one inner error. A single non-transient inner
    // error must keep the aggregate visible in telemetry.
    const errs = (obj as { errors?: unknown }).errors;
    if (Array.isArray(errs) && errs.length > 0 && depth < MAX_CAUSE_DEPTH) {
      let allTransient = true;
      for (const inner of errs) {
        if (!classify(inner, depth + 1, seen)) {
          allTransient = false;
          break;
        }
      }
      if (allTransient) return true;
      // fall through: aggregate's own message/code may still classify,
      // but if any inner is non-transient we stay conservative and return
      // false below unless top-level message/code matches.
    }

    // Top-level message / code.
    const msg = typeof (obj as { message?: unknown }).message === 'string'
      ? (obj as { message: string }).message
      : '';
    const code = typeof (obj as { code?: unknown }).code === 'string'
      ? (obj as { code: string }).code
      : '';
    if (msg && TRANSIENT_NET_RE.test(msg)) return true;
    if (code && TRANSIENT_NET_RE.test(code)) return true;

    // Walk `err.cause` for wrapped errors (Error cause chain).
    if (depth < MAX_CAUSE_DEPTH) {
      const cause = (obj as { cause?: unknown }).cause;
      if (cause !== undefined && cause !== obj) {
        if (classify(cause, depth + 1, seen)) return true;
      }
    }
  }

  return false;
}

/**
 * Detect Linux electron-updater install failures that throw synchronously
 * from quitAndInstall() (usually pkexec code 127 or apt-get errors).
 *
 * These are not transient — they are install-environment problems — but
 * they are also not actionable from our code and should be shown to the
 * user as a dialog instead of reported to Sentry as a crash.
 */
export function isLinuxInstallerError(input: unknown): boolean {
  const msg = extractMessage(input);
  if (!msg) return false;
  if (msg.includes('pkexec')) return true;
  if (/exited with code \d+/.test(msg) && /apt-get|dpkg|rpm|zypper/.test(msg)) {
    return true;
  }
  return false;
}

function extractMessage(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message || '';
  if (typeof input === 'object') {
    const maybe = input as { message?: unknown };
    if (typeof maybe.message === 'string') return maybe.message;
  }
  return '';
}
