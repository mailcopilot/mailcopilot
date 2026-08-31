import { describe, expect, it, vi } from 'vitest'
import { autoconfigWithDeps, __private__ } from './autoconfig'

describe('packages/net/autoconfig', () => {
  it('parseThunderbirdXml extracts IMAP/SMTP servers', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <displayName>Example Mail</displayName>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`

    const parsed = __private__.parseThunderbirdXml(xml, 'user@example.com')
    expect(parsed).not.toBeNull()
    expect(parsed?.displayName).toBe('Example Mail')
    expect(parsed?.imap).toEqual({ host: 'imap.example.com', port: 993, secure: true })
    expect(parsed?.smtp).toEqual({ host: 'smtp.example.com', port: 587, secure: false })
  })

  it('autoconfigWithDeps returns preset for gmail.com', async () => {
    const fetchMock = vi.fn()
    const mxMock = vi.fn()
    const probeMock = vi.fn()

    const cfg = await autoconfigWithDeps('user@gmail.com', {
      fetch: fetchMock as unknown as typeof fetch,
      resolveMx: mxMock,
      probePort: probeMock,
    })

    expect(cfg).toEqual({
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
      displayName: 'Gmail',
      source: 'preset',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mxMock).not.toHaveBeenCalled()
    expect(probeMock).not.toHaveBeenCalled()
  })

  it('autoconfigWithDeps uses domain-autoconfig after failed ISPDB', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.test">
    <incomingServer type="imap">
      <hostname>imap.example.test</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.test</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(xml, { status: 200 }))

    const cfg = await autoconfigWithDeps('u@example.test', {
      fetch: fetchMock as unknown as typeof fetch,
      resolveMx: vi.fn().mockResolvedValue([]),
      probePort: vi.fn().mockResolvedValue(false),
    })

    expect(cfg).toEqual({
      imap: { host: 'imap.example.test', port: 993, secure: true },
      smtp: { host: 'smtp.example.test', port: 465, secure: true },
      displayName: undefined,
      source: 'domain-autoconfig',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // §2.57 — fast-xml-parser 5.9.x -> 5.10.1 bump (GHSA-8r6m-32jq-jx6q).
  // Pre-5.10.1, a second `<!DOCTYPE>` block re-entered the entity-registration
  // path and reset the shared expansion limiters, so a malicious autoconfig XML
  // response with repeated DOCTYPE declarations could define far more internal
  // entities than the per-document caps were meant to allow. 5.10.1 closes this
  // by rejecting a second DOCTYPE outright ("Multiple DOCTYPE declarations
  // found.") rather than by tightening the counters. We don't need
  // to reproduce the full entity-expansion blowup to lock in the fix: the
  // security-relevant, deterministic behavior is that this payload is now
  // rejected (parseThunderbirdXml swallows the parser error and returns
  // null) instead of being silently parsed with an inflated entity budget.
  it('parseThunderbirdXml rejects XML with multiple DOCTYPE declarations (entity-limit reset bypass)', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE clientConfig [
<!ENTITY a "budget-1">
]>
<!DOCTYPE clientConfig [
<!ENTITY b "budget-2">
]>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`

    const parsed = __private__.parseThunderbirdXml(xml, 'user@example.com')
    expect(parsed).toBeNull()
  })

  // §2.110 — fast-xml-parser 5.5.8 -> 5.11.0. Pre-bump, an unmatched/mismatched
  // closing tag threw a parse error, which parseThunderbirdXml's try/catch
  // turned into a clean `null`. 5.11 no longer throws on this shape at all —
  // it recovers silently and returns a PARTIAL object where the mismatched
  // tag popped the element stack past its real parent, orphaning whatever
  // followed. Below, `</bogus>` (which matches no open tag) pops past
  // `emailProvider`, so `outgoingServer` ends up as a sibling of
  // `emailProvider` under `clientConfig` instead of a child of it.
  //
  // This is the exact shape that would be dangerous to accept: an incoming
  // server without its matching outgoing server. What's pinned here is not
  // the parser's recovery (that's fast-xml-parser's business) but that
  // parseThunderbirdXml's own pairing check — incoming AND outgoing must be
  // found on the SAME provider element — still rejects it, because it never
  // throws to hit the catch block anymore; it falls through the provider
  // loop to the final `return null` instead.
  it('rejects a malformed closing tag that silently detaches outgoingServer from its provider', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
    </incomingServer>
    </bogus>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`

    const parsed = __private__.parseThunderbirdXml(xml, 'user@example.com')
    expect(parsed).toBeNull()
  })
})
