/**
 * §2.145 — size ceilings, in one place, with no imports.
 *
 * WHY A LEAF MODULE. These numbers are consulted by layers that must not depend
 * on each other: the MIME parse (`eml.ts`, which pulls in mailparser), the IMAP
 * fetch (`message.ts`, which reaches the database through `imap.ts`), the
 * on-disk store (`mailStore.ts`, which is fs/path only) and a main-process
 * guard (`electron/cachedDetailGuard.ts`, whose unit test must not load
 * better-sqlite3). A constant that lived in any one of them would drag that
 * module's whole import graph into the others — which is how
 * `MAX_LEGITIMATE_CACHED_BODY_BYTES` came to be a hand-copied literal in the
 * first place, and how it silently went out of step with the value it mirrored.
 *
 * This file therefore imports nothing and must keep importing nothing.
 */

/**
 * Largest raw RFC822 message that will be ACQUIRED OR PARSED at all, in bytes.
 *
 * Where the number comes from: providers refuse to accept mail anywhere near
 * it. Gmail caps a message at 25 MB, Outlook/Microsoft 365 at 20 MB (150 MB
 * only if an administrator raises it), Yahoo at 25 MB, iCloud at 20 MB; the
 * largest message observed in our own field data is 35 MB. 100 MiB is therefore
 * ~3x the largest legitimate message anybody has ever handed us and ~4x what
 * the biggest providers will even relay: the cap cannot cut a message a real
 * correspondent could have sent, and everything above it is pathology or an
 * attack.
 *
 * ACQUIRED OR PARSED is the §2.145 wave-2.1 correction, and it is the whole
 * point of this constant now. Enforcing it only at parser entry left the
 * allocation primitive wide open: the bytes were already in native memory,
 * accumulated chunk by chunk off an IMAP socket or read whole off disk, before
 * anything asked how big they were. A remote sender could hand a folder in
 * offline mode a message of any size and have it buffered — and, if the
 * folder's own size limit was "unlimited", written to disk as well. The ceiling
 * now binds at every point where attacker-controlled bytes are ACQUIRED:
 *
 *   - `downloadRawMessage` / `downloadRawMessagePerAccount` (packages/net/message.ts)
 *     count while streaming and stop consuming;
 *   - `readEml` (packages/net/mailStore.ts) stats before it reads;
 *   - `parseEmlBuffer` / `extractIcsFromRawEml` / `extractEmlAttachment`
 *     (packages/net/eml.ts) still check at entry, now as defence in depth
 *     rather than as the only line.
 *
 * It is also, deliberately, ABOVE `MAX_QUEUED_BYTES` (64 MiB, the worker
 * admission bound in emlWorkerClient.ts): see that constant for why the
 * ordering is what keeps one symptom to one cause.
 */
export const MAX_EML_PARSE_BYTES = 100 * 1024 * 1024

/**
 * Bytes of a message read when building the hard-cap placeholder — the header
 * block and nothing more.
 *
 * The placeholder needs from/subject/date, and the point of the hard cap is
 * that the message is never streamed: feeding 200 MB to `MailParser` to recover
 * four header fields would cost the ~1 event-loop turn per 77 bytes the offload
 * exists to avoid (§2.124). 32 KiB is far above any real header block (a
 * heavily-forwarded message with long `Received:` chains and DKIM signatures
 * runs 4-8 KB) while costing at most ~425 turns.
 *
 * Also the read size for the on-disk over-cap path: `readEml` reads exactly
 * this much of an oversized file rather than the whole thing.
 */
export const EML_HEADER_SCAN_BYTES = 32 * 1024

/**
 * First-tier cap on the DECODED body, in bytes, per body representation (html
 * and text are capped independently — they are alternatives, not halves).
 *
 * Industry practice clips far lower: Gmail shows "Message clipped" at 102 KB,
 * Exchange ActiveSync's `MIMETruncation` tops out at 102 400 characters. We are
 * an order of magnitude more generous on purpose — a clip a user meets on
 * ordinary mail is a papercut, and our cap has to earn its existence on
 * pathological mail only. 1 MiB of decoded HTML is roughly 300 pages of prose.
 */
export const EML_BODY_SOFT_CAP_BYTES = 1 * 1024 * 1024

/**
 * Second-tier cap, used only when the user explicitly asks to see the rest.
 *
 * Raised, and still FINITE. "Show full message" must not become the bypass the
 * hard cap refuses to be: the decoded body still crosses a structured clone, an
 * IPC boundary, DOMPurify and an iframe, all linear in its size.
 */
export const EML_BODY_FULL_CAP_BYTES = 8 * 1024 * 1024

/**
 * Largest body ONE representation can hold when fetched directly from the
 * server, in bytes.
 *
 * This is the bound `fetchMessageDetails` (packages/net/message.ts) applies to
 * the html part and to the text part separately, via
 * `readStreamToString(content, ...)` — a reader that stops BEFORE appending a
 * chunk that would cross the bound, so this is a true ceiling and not an
 * approximation.
 *
 * It lives here rather than inside that function because a SECOND consumer
 * needs the same number for a different reason: `electron/cachedDetailGuard.ts`
 * decides whether a stored `messages.cached_detail` row is servable, and the
 * server-direct path is one of the two writers of that cache — the one whose
 * rows carry no `parseCap`. Judging those rows by the EML path's 1 MiB soft cap
 * refused every legitimate server-direct body above 1 MiB on every reopen
 * (§2.145 fix wave 1.2). The guard therefore has to know THIS number, and
 * knowing it by hand-copied literal is what wave 2.1 is removing: if the fetch
 * bound moves, the guard moves with it, because there is only one constant.
 */
export const SERVER_DIRECT_MAX_BODY_BYTES = 5 * 1024 * 1024
