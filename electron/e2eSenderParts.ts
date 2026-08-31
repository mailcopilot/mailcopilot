import { senderFromEnvelope } from '../packages/net/imap'

export type SenderParts = { from: string; fromAddr: string; fromName: string | undefined }

/**
 * §2.172 — the sender split used by every e2e fixture seeding site in main.ts.
 *
 * Fixtures carry a raw `From:` header string (`buildE2EFixtureEml` writes that
 * very string into real bytes), while the production verdict — which of the two
 * parsed halves is allowed to become the stored ADDRESS — lives in
 * `senderFromEnvelope` (packages/net/imap.ts). This module owns only the first
 * step (header string → `{ name, address }`, the job an RFC 5322 parser does on
 * the production path) and DELEGATES the verdict. It deliberately does not
 * reimplement it: a second copy of that rule inside the e2e path is how the
 * seeding sites drifted apart in the first place — they seeded rows the
 * production parser cannot produce (`from_addr` holding a display string), so
 * the specs that assert on `from_address` rules were testing impossible data.
 *
 * The one rule that matters, inherited from `senderFromEnvelope`: `fromAddr` is
 * the parsed address or nothing, never back-filled from the display name. The
 * removed fallback (`fromAddr || raw.trim()`) is exactly the §2.90 defect.
 */
export function senderPartsFromHeader(raw: string | undefined): SenderParts {
  return senderFromEnvelope(parseSenderHeader(raw))
}

/**
 * Splits a raw `From:` header value the way a real header parser does.
 *
 * Three shapes, in order:
 *  1. `Display Name <addr@host>` — the angle brackets are the addr-spec, and
 *     everything before them is a label, however address-like it looks. This is
 *     the spoof case: `"victim@example.com" <attacker@evil.test>`.
 *  2. A whole-string quoted phrase (`"victim@example.com"`) or any multi-token
 *     text — a display name with no addr-spec at all, so there is no address.
 *     The old `s.includes('@')` heuristic promoted both to addresses, which is
 *     precisely "the address came from the display name".
 *  3. A single bare token containing `@` — a valid RFC 5322 addr-spec with no
 *     display name (`alice@example.test`). This one IS an address: ImapFlow
 *     parses the same header the same way, and treating it as a name would make
 *     the fixtures diverge from production in the opposite direction.
 */
export function parseSenderHeader(raw: string | undefined): { name?: string; address?: string } {
  const s = (raw || '').trim()
  if (!s) return {}
  const angled = s.match(/^(.*)<([^>]*)>$/)
  if (angled) {
    const name = unquote(angled[1] ?? '')
    const address = (angled[2] || '').trim()
    return { name: name || undefined, address: address || undefined }
  }
  if (isBareAddrSpec(s)) return { address: s }
  return { name: unquote(s) || undefined }
}

function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).trim()
  return t
}

/** A single unquoted token with an `@` inside — no spaces, no quotes, no commas. */
function isBareAddrSpec(s: string): boolean {
  return /^[^\s",]+@[^\s",]+$/.test(s)
}
