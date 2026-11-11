import { imapRendererSchema, smtpRendererSchema } from '../packages/net/config'

/**
 * IPC-scoped connection-test schemas for `net:testImap` / `net:testSmtp`.
 *
 * `tlsPinnedCertsPem` is IPC-INADMISSIBLE. A certificate BODY in that field is
 * what tells `buildTlsOptions` (packages/net/tls.ts) that the leaf was
 * confirmed by a human in the main-initiated recovery dialog: such a leaf
 * becomes an OpenSSL trust anchor, turns on `allowPartialTrustChain` and is
 * accepted with the hostname check skipped. Anchor provenance is therefore
 * single-writer — bodies come only from `net:trustCert`, after a native
 * `dialog.showMessageBox`, and are read back out of the pin store. A renderer
 * (compromised or not) must not be able to hand one in, so these channels
 * parse a narrowed account shape rather than the full schemas.
 *
 * Two independent layers, so that re-introducing the field fails loudly instead
 * of silently re-opening the hole:
 *   1. `parseNetTestConfig` REFUSES a payload that carries the key at all
 *      (`cert_body_not_accepted`) — a present body means the sender is not the
 *      Account window, which never sends one.
 *   2. The schemas physically cannot carry it — they ARE the renderer-facing
 *      narrowing exported next to the base schemas (shared with
 *      `accountSaveSchema`, so there is one omission rather than two copies),
 *      so even if the guard above is dropped the parsed value handed to the
 *      transport has no anchor in it.
 *
 * Fingerprint-only pins (`tlsPinsSha256`) still pass through untouched: they
 * are a narrowing of trust, not a source of identity (see `tls:addPin`).
 */
export const imapTestSchema = imapRendererSchema
export const smtpTestSchema = smtpRendererSchema

/** Key whose presence on these channels is itself the refusal condition. */
export const CERT_BODY_FIELD = 'tlsPinnedCertsPem'

export function parseNetTestConfig<T>(
  schema: { parse: (value: unknown) => T },
  cfg: unknown,
): T {
  if (typeof cfg === 'object' && cfg !== null && CERT_BODY_FIELD in cfg) {
    throw new Error('cert_body_not_accepted')
  }
  return schema.parse(cfg)
}
