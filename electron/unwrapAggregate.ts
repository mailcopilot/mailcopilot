import { isImapOutcomeUndetermined } from '@mailcopilot/core/transportFailure'

/**
 * Unwraps an AggregateError (thrown by Node net on multi-AF connect failures)
 * into its first inner error, so the user sees "connect ETIMEDOUT 1.2.3.4:993"
 * instead of the uninformative "AggregateError". Preserves other errors as-is.
 *
 * Extracted from electron/main.ts for unit-testability (the helper lives next
 * to the §2.14 net:* offline-fallback handlers but is a pure function that
 * does not depend on the electron main-process module graph).
 *
 * Uses a duck-type check (`err.errors` is an Array) rather than
 * `instanceof AggregateError` because the TS lib target does not always
 * expose the AggregateError global, and because IMAP libraries sometimes
 * synthesize AggregateError-shaped objects without inheriting from the real
 * constructor.
 */
export function unwrapAggregate(err: unknown): unknown {
  if (err && typeof err === 'object' && 'errors' in err) {
    const errs = (err as { errors?: unknown }).errors
    if (Array.isArray(errs) && errs.length > 0) {
      const first = errs.find((e: unknown) => e instanceof Error && e.message) ?? errs[0]
      return first
    }
  }
  return err
}

const UNDETERMINED_NOTE =
  'outcome unknown: the server may or may not have applied the change, or applied only part of it; check the folder before repeating the action'

// The reason is built from a CLOSED vocabulary, never from `message`: the text of
// an error from a mail server, a socket or a library is third-party free text
// (a server address, a folder name, whatever a hostile server chose to say) and
// must not reach the model or the log (CLAUDE.md §5, "free text of a third party
// is not transmitted").
//
// Our own failures carry a code with a fixed sentence here.
const REASON_BY_CODE: Readonly<Record<string, string>> = {
  ERR_IMAP_COMMAND_REJECTED: 'the mail server rejected the command',
  ERR_IMAP_OUTCOME_UNKNOWN: 'the change was only partly applied or its result is unknown',
  ERR_IMAP_OPERATION_DEADLINE: 'the mail server did not finish within the time limit',
  ERR_IMAP_AUTH_BACKOFF: 'sign-in to the mail server is paused after a failed attempt',
  NoConnection: 'the connection to the mail server was lost',
  EConnectionClosed: 'the connection to the mail server was closed',
  CONNECT_TIMEOUT: 'the connection to the mail server timed out',
  GREETING_TIMEOUT: 'the mail server did not greet in time',
  UPGRADE_TIMEOUT: 'the secure connection to the mail server timed out',
  ETIMEOUT: 'the mail server stopped responding',
}

// Anything else is reduced to shapes that cannot carry free text: an errno-style
// code, a system call name, an identifier-shaped class name.
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,39}$/
const SYSCALL_SHAPE = /^[a-z][a-z0-9_]{1,19}$/
const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9]{0,39}$/

function strField(node: unknown, name: string): string {
  if (node === null || typeof node !== 'object') return ''
  try {
    const v = (node as Record<string, unknown>)[name]
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** Reason for one error node: its code's sentence, or `CODE (syscall)`, or the class name. */
function describeNode(node: unknown): string {
  const code = strField(node, 'code')
  const known = REASON_BY_CODE[code]
  if (known) return known
  const syscall = strField(node, 'syscall')
  if (CODE_SHAPE.test(code)) return SYSCALL_SHAPE.test(syscall) ? `${code} (${syscall})` : code
  const name = strField(node, 'name')
  return NAME_SHAPE.test(name) ? name : 'Error'
}

/**
 * A short, readable reason for a failure, for places that print it to a log or
 * hand it to the model as a tool result.
 *
 * Why it exists (§2.307): a multi-address connect failure is an
 * `AggregateError` whose own `message` is empty, so `err.message` alone
 * produced `apply_mail_action failed: ` with nothing after the colon — in the
 * log, in the tool result, and from there in the model's answer to the user.
 * The diagnosis lives on the members, so the reason is read from the first
 * member that has one.
 *
 * Whatever the shape of the error (a single connect failure, an aggregate, a
 * library error with a server sentence in its message), the text comes from a
 * closed vocabulary: our own code sentences, an errno-style code with its
 * failing syscall, or the class name. `message` is never read. A failure that
 * struck after a mutating IMAP command was sent carries the "outcome unknown"
 * note so the model does not promise that nothing changed.
 */
export function describeErrorReason(err: unknown): string {
  let reason = 'Error'
  try {
    const inner = typeof err === 'string' ? undefined : unwrapAggregate(err)
    if (inner !== undefined) reason = describeNode(inner)
  } catch {
    // An error object with a throwing accessor must not turn the report of a
    // failure into a second failure.
  }
  let undetermined = false
  try {
    undetermined = isImapOutcomeUndetermined(err)
  } catch { /* same */ }
  return undetermined ? `${reason} - ${UNDETERMINED_NOTE}` : reason
}
