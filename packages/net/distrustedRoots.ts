import { createHash, X509Certificate } from 'node:crypto'

/**
 * Trust anchors removed from every CA list we hand to OpenSSL.
 *
 * Why this exists: on 2026-10-17 the private keys of eight eMudhra
 * intermediate CAs were reported compromised (Mozilla incident bug 2083449;
 * browsers block the intermediates through OneCRL / CRLSets, and Mozilla's NSS
 * removed the signing root). Node's TLS stack does no revocation checking, so
 * the only lever on our side is not to anchor a chain at the roots those
 * intermediates hang from. Node's own security releases did exactly that to
 * its bundled store.
 *
 * Two copies of that trust can reach a connection, and the filter has to cover
 * both:
 *  - the bundled Mozilla store of the Electron we ship (Electron 43.4.1 and
 *    43.8.1 still carry "emSign ECC Root CA - G3"; 43.8.7 and 45.2.2 do not);
 *  - the OS store (`getCACertificates('system')`), which a user's machine may
 *    not have updated yet. Windows and macOS stores also carry the other two
 *    roots below.
 * Filtering the combined list is therefore the smallest mechanism that holds
 * for both; a bundle bump alone would leave the OS copies in place.
 *
 * Why each entry is here:
 *  - "emSign ECC Root CA - G3": a root program anchor; the compromised
 *    intermediates are cross-signed by it. Present in the bundled store of
 *    older Electron builds.
 *  - "emSign Root TLS CA - G3": the self-signed root the intermediates are
 *    directly issued by; the Windows store trusts it as an anchor.
 *  - "AAA Certificate Services": Sectigo cross-signed the compromised
 *    intermediates under it, and Apple and Microsoft still trust it. Mozilla and
 *    Chrome already dropped it, so removing it leaves our bundled baseline
 *    unchanged; a server that chains to it fails with an ordinary certificate
 *    error and the user gets the normal confirm-this-certificate dialog.
 *
 * Matching is by SHA-256 of the SubjectPublicKeyInfo, not of the certificate:
 * the same key is published as a self-signed root and as cross-signed
 * certificates, and each variant has its own certificate fingerprint but the
 * same SPKI.
 *
 * Scope, stated plainly: the filter applies wherever WE hand OpenSSL the CA
 * list — IMAP/SMTP (via `buildTlsOptions`) and the AI provider connection (via
 * `getCombinedCaCertificates`). A TLS client that supplies no CA list uses the
 * runtime's built-in store instead (the global `fetch` calls to Microsoft Graph
 * and the OAuth token endpoints, and `safeRemoteFetch`); that copy goes away
 * only by moving to an Electron release whose bundled store no longer has the
 * root. Nothing here changes those paths. The same holds when the platform
 * cannot list its CA store at all (`tls.getCACertificates` missing or throwing,
 * not the case on Electron 43): connections then omit `ca` and use the built-in
 * store unfiltered; falling back to a filtered `tls.rootCertificates` was
 * rejected because it would drop `NODE_EXTRA_CA_CERTS`.
 *
 * This is an explicit, short denylist, not a revocation system. It does not
 * cover certificates the user pinned: pinned bodies are added to the trust set
 * AFTER this filter (see `buildTlsOptions`) because they record a decision the
 * user made in the main-initiated recovery dialog.
 */
const DISTRUSTED_ROOT_SPKI_SHA256 = new Map<string, string>([
  ['8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782', 'emSign ECC Root CA - G3'],
  ['c619e4780ed8e0abeda24ad732567de4383a7ea941338f6d1a7d1b49ac792fe9', 'emSign Root TLS CA - G3'],
  ['bd153ed7b0434f6886b17bce8bbe84ed340c7132d702a8f4fa318f756ecbd6f3', 'AAA Certificate Services'],
])

function spkiSha256(pem: string): string | null {
  try {
    const der = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(der).digest('hex')
  } catch {
    return null
  }
}

/** Parsing ~480 certificates costs ~30 ms on the main thread (measured); the CA
 *  snapshot is recomputed every ten minutes from the same strings, so the
 *  verdict is remembered per PEM. Bounded by the number of distinct roots the
 *  platform exposes, and the keys are the strings Node already holds. */
const verdictMemo = new Map<string, boolean>()

/** `true` when the PEM's public key is on the denylist. An unparsable entry is
 *  NOT reported as distrusted: dropping it would only narrow trust by accident,
 *  and OpenSSL ignores such entries on its own. */
export function isDistrustedRootPem(pem: string): boolean {
  const known = verdictMemo.get(pem)
  if (known !== undefined) return known
  const spki = spkiSha256(pem)
  const verdict = spki !== null && DISTRUSTED_ROOT_SPKI_SHA256.has(spki)
  verdictMemo.set(pem, verdict)
  return verdict
}

/** The list without the distrusted roots. Order of the rest is preserved. */
export function withoutDistrustedRoots(list: string[]): string[] {
  return list.filter((pem) => !isDistrustedRootPem(pem))
}

/** `true` when the SPKI digest (lowercase hex) is on the denylist. */
export function isDistrustedSpki(spkiSha256Hex: string): boolean {
  return DISTRUSTED_ROOT_SPKI_SHA256.has(spkiSha256Hex)
}

/** Names of the denylisted roots, for tests and diagnostics. */
export function distrustedRootNames(): string[] {
  return [...DISTRUSTED_ROOT_SPKI_SHA256.values()]
}

/** Test seam: add an SPKI to the denylist and get the restore function back.
 *  Restore puts back whatever was there before, so a real entry is never lost. */
export const __testOnly = {
  addDistrusted(spkiSha256Hex: string): () => void {
    const previous = DISTRUSTED_ROOT_SPKI_SHA256.get(spkiSha256Hex)
    DISTRUSTED_ROOT_SPKI_SHA256.set(spkiSha256Hex, 'test')
    verdictMemo.clear()
    return () => {
      if (previous === undefined) DISTRUSTED_ROOT_SPKI_SHA256.delete(spkiSha256Hex)
      else DISTRUSTED_ROOT_SPKI_SHA256.set(spkiSha256Hex, previous)
      verdictMemo.clear()
    }
  },
}
