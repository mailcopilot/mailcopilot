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
