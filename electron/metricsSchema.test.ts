import { describe, expect, it } from 'vitest'

import {
  NET_SPANS,
  ELECTRON_SPANS,
  DB_SPANS,
  METRIC_SPAN_OP,
  DOMAINS,
  METRIC_EVENTS,
} from './metricsSchema'

/**
 * Invariant completeness tests for METRIC_SPAN_OP.
 *
 * startMetricSpan looks `op` up from METRIC_SPAN_OP; if a new span is added
 * to NET_SPANS / ELECTRON_SPANS / DB_SPANS but the map is not updated,
 * bridged calls still get a fallback op (= name), but direct typed callsites
 * compile OK and the intent map silently drifts. These tests catch that at
 * vitest time.
 */
describe('METRIC_SPAN_OP — completeness invariant', () => {
  const allSpanNames = new Set<string>([
    ...Object.keys(NET_SPANS),
    ...Object.keys(ELECTRON_SPANS),
    ...Object.keys(DB_SPANS),
  ])

  it('covers every span name registered in NET_SPANS / ELECTRON_SPANS / DB_SPANS', () => {
    const missing: string[] = []
    for (const name of allSpanNames) {
      if (!(name in METRIC_SPAN_OP)) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  it('has no stray entries that are not registered in any span registry', () => {
    const stray: string[] = []
    for (const name of Object.keys(METRIC_SPAN_OP)) {
      if (!allSpanNames.has(name)) stray.push(name)
    }
    expect(stray).toEqual([])
  })

  it('emits a non-empty op value for every registered span', () => {
    // Defence in depth: the map is typed Record<MetricSpanName, string>, but
    // nothing stops `''`.
    const empty: string[] = []
    for (const [name, op] of Object.entries(METRIC_SPAN_OP)) {
      if (!op || typeof op !== 'string') empty.push(name)
    }
    expect(empty).toEqual([])
  })
})

// --- §2.17 Phase 0 additions ------------------------------------------------

describe('§2.17 Phase 0 — DOMAINS enum additions', () => {
  it('cache_hit_level contains all five cache tier identifiers', () => {
    const levels = DOMAINS.cache_hit_level as readonly string[]
    expect(levels).toContain('memory')
    expect(levels).toContain('db')
    expect(levels).toContain('eml')
    expect(levels).toContain('imap')
    expect(levels).toContain('imap_timeout')
    expect(levels).toHaveLength(5)
  })

  it('imap_pool_requester contains all five requester tags', () => {
    const requesters = DOMAINS.imap_pool_requester as readonly string[]
    expect(requesters).toContain('interactive')
    expect(requesters).toContain('background')
    expect(requesters).toContain('indexer')
    expect(requesters).toContain('sync')
    expect(requesters).toContain('other')
    expect(requesters).toHaveLength(5)
  })
})

describe('§2.17 Phase 0 — METRIC_EVENTS new entries', () => {
  it('mail.open is registered as a histogram', () => {
    expect(METRIC_EVENTS['mail.open']).toBeDefined()
    expect(METRIC_EVENTS['mail.open'].kind).toBe('histogram')
  })

  it('mail.open tags include cache_hit_level, body_size_bucket, attachments_count', () => {
    const tags = METRIC_EVENTS['mail.open'].tags
    expect(tags.cache_hit_level).toBe('cache_hit_level')
    expect(tags.body_size_bucket).toBe('string')
    expect(tags.attachments_count).toBe('number')
  })

  it('net.message_details.wall_ms is registered as a histogram', () => {
    expect(METRIC_EVENTS['net.message_details.wall_ms']).toBeDefined()
    expect(METRIC_EVENTS['net.message_details.wall_ms'].kind).toBe('histogram')
  })

  it('net.message_details.wall_ms tags include cache_hit_level', () => {
    const tags = METRIC_EVENTS['net.message_details.wall_ms'].tags
    expect(tags.cache_hit_level).toBe('cache_hit_level')
  })

  it('imap.pool_queue_wait_ms is registered as an event', () => {
    expect(METRIC_EVENTS['imap.pool_queue_wait_ms']).toBeDefined()
    expect(METRIC_EVENTS['imap.pool_queue_wait_ms'].kind).toBe('event')
  })

  it('imap.pool_queue_wait_ms tags include requester and wait_ms_bucket', () => {
    const tags = METRIC_EVENTS['imap.pool_queue_wait_ms'].tags
    expect(tags.requester).toBe('imap_pool_requester')
    expect(tags.wait_ms_bucket).toBe('string')
  })
})

describe('§2.25 (re-diagnosis) — links.external_open_suppressed event', () => {
  // This event is emitted by the openExternalGated funnel in electron/main.ts
  // whenever the process-wide token-bucket gate denies a shell.openExternal
  // request. The shape must satisfy three invariants:
  //
  //   1. `aggregate: true` — a runaway OS re-launch loop generates thousands of
  //      denials per second; without aggregation the metric sink would be flooded.
  //      The 10s window collapses an entire storm to a handful of count records.
  //
  //   2. `mainOnly: true` — only the main process can emit this event (the gate
  //      lives in main.ts). A compromised renderer must not be able to fabricate
  //      suppression signals via metrics:record.
  //
  //   3. `source: 'external_open_source'` — a fixed low-cardinality enum
  //      call-site tag ('window_open' | 'ui_ipc' | 'update_dialog' |
  //      'unsubscribe' | 'oauth'), so the IPC bridge rejects any out-of-domain
  //      value. Critically: NEVER a URL — see CLAUDE.md §8 PII rule.

  it('is registered in METRIC_EVENTS', () => {
    expect(METRIC_EVENTS['links.external_open_suppressed']).toBeDefined()
  })

  it('kind is event', () => {
    expect(METRIC_EVENTS['links.external_open_suppressed'].kind).toBe('event')
  })

  it('aggregate is true — storm denials collapse to a windowed count record', () => {
    expect(METRIC_EVENTS['links.external_open_suppressed'].aggregate).toBe(true)
  })

  it('mainOnly is true — renderer cannot emit it', () => {
    expect(METRIC_EVENTS['links.external_open_suppressed'].mainOnly).toBe(true)
  })

  it('source tag is typed against the external_open_source enum — call-site identifier, never a URL', () => {
    const tags = METRIC_EVENTS['links.external_open_suppressed'].tags
    expect(tags.source).toBe('external_open_source')
  })

  it('external_open_source enum lists exactly the five call-site tags', () => {
    expect(DOMAINS.external_open_source).toEqual([
      'window_open',
      'ui_ipc',
      'update_dialog',
      'unsubscribe',
      'oauth',
    ])
  })

  it('purpose string is non-empty', () => {
    expect(METRIC_EVENTS['links.external_open_suppressed'].purpose.length).toBeGreaterThan(0)
  })
})

describe('§2.17 Phase 0 — ELECTRON_SPANS new entry: net.message_details', () => {
  it('net.message_details span is registered in ELECTRON_SPANS', () => {
    expect(ELECTRON_SPANS['net.message_details']).toBeDefined()
  })

  it('net.message_details span purpose string is non-empty', () => {
    expect(ELECTRON_SPANS['net.message_details'].purpose.length).toBeGreaterThan(0)
  })

  it('net.message_details span attributes include cache_hit_level, body_size_bucket, attachments_count', () => {
    const attrs = ELECTRON_SPANS['net.message_details'].attributes
    expect(attrs.cache_hit_level).toBe('cache_hit_level')
    expect(attrs.body_size_bucket).toBe('string')
    expect(attrs.attachments_count).toBe('number')
  })

  it('METRIC_SPAN_OP maps net.message_details to "net.message_details"', () => {
    expect(METRIC_SPAN_OP['net.message_details']).toBe('net.message_details')
  })
})

// --- §2.23 PR1 — send_queue.append_failed schema hardening ------------------
//
// This event is emitted exclusively from the sendMailWithAccountConfig catch
// block in electron/main.ts (via reportSentCopyAppendFailure). Three invariants
// must hold:
//
//   1. kind=event — counted once per APPEND failure, not a histogram.
//   2. mainOnly=true — renderer must never be able to fabricate this signal via
//      the metrics:record IPC bridge. The IPC bridge in electron/ipc.ts rejects
//      any payload referencing a mainOnly=true event (tested in ipc.test.ts).
//   3. Both tag domains are closed enum domains (not free-form strings), so the
//      PII fence that lives inside classifySentCopyAppendFailure /
//      normalizeSentCopyProviderId is also enforced at the schema level.

describe('§2.23 PR1 — send_queue.append_failed schema hardening', () => {
  it('is registered in METRIC_EVENTS', () => {
    expect(METRIC_EVENTS['send_queue.append_failed']).toBeDefined()
  })

  it('kind is event', () => {
    expect(METRIC_EVENTS['send_queue.append_failed'].kind).toBe('event')
  })

  it('mainOnly is true — renderer bridge must reject this event', () => {
    expect(METRIC_EVENTS['send_queue.append_failed'].mainOnly).toBe(true)
  })

  it('reason tag references the sent_copy_append_reason enum (closed domain)', () => {
    expect(METRIC_EVENTS['send_queue.append_failed'].tags.reason).toBe('sent_copy_append_reason')
  })

  it('provider_id tag references the sent_copy_provider enum (closed domain)', () => {
    expect(METRIC_EVENTS['send_queue.append_failed'].tags.provider_id).toBe('sent_copy_provider')
  })

  it('sent_copy_append_reason domain contains exactly the six reason buckets in order', () => {
    const reasons = DOMAINS.sent_copy_append_reason as readonly string[]
    expect(reasons).toEqual(['auth', 'network', 'quota', 'too_big', 'server_refused', 'unknown'])
  })

  it('sent_copy_provider domain contains exactly the four provider values in order', () => {
    const providers = DOMAINS.sent_copy_provider as readonly string[]
    expect(providers).toEqual(['gmail', 'outlook', 'generic-imap', 'unknown'])
  })
})

// --- §2.34 ship-first observability — secret_store.fallback_active ----------
//
// Emitted from the main process only (electron/sentry.ts reportKeychainUnavailable
// + the packages/net telemetry seam) when an OS secret-store read fails. Three
// invariants must hold:
//
//   1. kind=event — a counter of installs/sessions running without a keychain.
//   2. mainOnly=true — the renderer must never be able to fabricate this signal
//      via metrics:record (the IPC bridge rejects mainOnly events).
//   3. Both tag domains are closed enums (not free-form strings), so the PII
//      fence is enforced at the schema level too: no account email, no key
//      name, no raw backend error text can ever ride in as a tag value.

describe('§2.34 — secret_store.fallback_active schema hardening', () => {
  it('is registered in METRIC_EVENTS', () => {
    expect(METRIC_EVENTS['secret_store.fallback_active']).toBeDefined()
  })

  it('kind is event', () => {
    expect(METRIC_EVENTS['secret_store.fallback_active'].kind).toBe('event')
  })

  it('mainOnly is true — renderer bridge must reject this event', () => {
    expect(METRIC_EVENTS['secret_store.fallback_active'].mainOnly).toBe(true)
  })

  it('surface tag references the secret_store_surface enum (closed domain)', () => {
    expect(METRIC_EVENTS['secret_store.fallback_active'].tags.surface).toBe('secret_store_surface')
  })

  it('platform tag references the platform enum (closed domain)', () => {
    expect(METRIC_EVENTS['secret_store.fallback_active'].tags.platform).toBe('platform')
  })

  it('secret_store_surface domain contains exactly the four surface values in order', () => {
    const surfaces = DOMAINS.secret_store_surface as readonly string[]
    expect(surfaces).toEqual(['imap_smtp', 'oauth_refresh', 'ai_keys', 'unknown'])
  })

  it('purpose string is non-empty', () => {
    expect(METRIC_EVENTS['secret_store.fallback_active'].purpose.length).toBeGreaterThan(0)
  })
})

describe('TLS trust rework (Phase A2) — cert recovery funnel events', () => {
  // Five events, one funnel: imap.cert_error → cert.recovery_dialog_shown →
  // cert.trust_clicked / cert.trust_rejected, plus the sibling
  // cert.interception_notice_shown. Shared invariants:
  //   - every tag is a low-cardinality ENUM domain — never the hostname,
  //     fingerprint, issuer CN, or raw TLS error text (PII rule);
  //   - all five are mainOnly (emitted from the packages/net seam and
  //     electron/services/certRecovery.ts / main.ts IPC handlers).
  const CERT_EVENTS = [
    'imap.cert_error',
    'cert.recovery_dialog_shown',
    'cert.trust_clicked',
    'cert.trust_rejected',
    'cert.interception_notice_shown',
  ] as const

  it.each(CERT_EVENTS)('%s is registered as a mainOnly event', (name) => {
    expect(METRIC_EVENTS[name]).toBeDefined()
    expect(METRIC_EVENTS[name].kind).toBe('event')
    expect(METRIC_EVENTS[name].mainOnly).toBe(true)
  })

  it.each(CERT_EVENTS)('%s tags every dimension as a known enum domain', (name) => {
    const tags = METRIC_EVENTS[name].tags as Record<string, string>
    expect(Object.keys(tags)).toContain('provider')
    for (const domain of Object.values(tags)) {
      expect(DOMAINS).toHaveProperty(domain)
    }
  })

  it('cert.trust_clicked reports whether the certificate body was captured', () => {
    // Without the PEM a pin is not a usable trust anchor — a population stuck
    // on 'unavailable' means self-signed servers still fail closed.
    expect(METRIC_EVENTS['cert.trust_clicked'].tags).toEqual({
      provider: 'provider',
      pem: 'cert_pin_pem',
    })
    expect(DOMAINS.cert_pin_pem).toEqual(['captured', 'unavailable', 'mismatch'])
  })

  it('cert.trust_rejected explains why a trust click stored no pin', () => {
    expect(METRIC_EVENTS['cert.trust_rejected'].tags).toEqual({
      provider: 'provider',
      reason: 'cert_trust_reject_reason',
    })
    expect(DOMAINS.cert_trust_reject_reason).toEqual([
      'fingerprint_mismatch',
      'pin_write_failed',
      // Authorization gate: a pin was requested without an open recovery
      // dialog for that endpoint/certificate. Non-zero = UI bug or attempt.
      'no_pending_offer',
      'offer_fingerprint_mismatch',
      // Native confirmation gate (main-process dialog.showMessageBox): the
      // human said no, or something tried to stack a second modal on an
      // endpoint that already had one open (a real renderer never does).
      'user_declined',
      'confirm_in_flight',
    ])
  })

  it.each(['imap.cert_error', 'cert.recovery_dialog_shown', 'cert.interception_notice_shown'] as const)(
    '%s still carries only the provider enum tag',
    (name) => {
      expect(METRIC_EVENTS[name].tags).toEqual({ provider: 'provider' })
    },
  )

  it('imap.cert_error aggregates — retry bursts collapse to windowed counts', () => {
    expect(METRIC_EVENTS['imap.cert_error'].aggregate).toBe(true)
  })

  it.each(CERT_EVENTS)('%s purpose string is non-empty', (name) => {
    expect(METRIC_EVENTS[name].purpose.length).toBeGreaterThan(0)
  })
})

describe('§2.51 — db.ai_reserve_denied schema', () => {
  // The single telemetry signal of the fail-closed AI budget cap, emitted from
  // packages/db (reserveAiCost / admitAiReservation) through the reportDbEvent
  // seam. `scripts/check-telemetry-schema.mjs` already fails CI if a call site
  // references an unregistered name; these assertions pin the PROPERTIES that
  // the checker cannot see — the PII shape, the mainOnly guard, and the burst
  // aggregation — so a later edit cannot quietly widen them.
  const NAME = 'db.ai_reserve_denied' as const

  it('is registered as an event', () => {
    expect(METRIC_EVENTS[NAME]).toBeDefined()
    expect(METRIC_EVENTS[NAME].kind).toBe('event')
    expect(METRIC_EVENTS[NAME].purpose.length).toBeGreaterThan(0)
  })

  it('carries ONLY the low-cardinality reason tag — no account/provider/model/cost', () => {
    // PII invariant: the deny reason is a closed set of db-layer literals.
    // Anything else (account id, provider key, model name, dollar amount, raw
    // sqlite error text) must stay in the local log / thrown error.
    expect(METRIC_EVENTS[NAME].tags).toEqual({ reason: 'ai_reserve_denied_reason' })
  })

  it('the reason tag is a CLOSED domain, not a free-form string', () => {
    // A bare 'string' tag type accepts whatever a call site passes, leaving
    // the PII boundary resting on a comment. The enum makes it structural: an
    // unknown value fails typecheck and check:telemetry instead of shipping.
    expect(DOMAINS.ai_reserve_denied_reason).toEqual([
      'over-cap', 'invalid-amount', 'ledger-write-failed',
    ])
  })

  it('is mainOnly — a compromised renderer cannot forge budget denials', () => {
    // Emitted exclusively from packages/db in the main process. Forgeable
    // denial telemetry would let a compromised renderer mask a real cap breach.
    expect(METRIC_EVENTS[NAME].mainOnly).toBe(true)
  })

  it('aggregates — a capped account re-denies on every call, so bursts collapse', () => {
    expect(METRIC_EVENTS[NAME].aggregate).toBe(true)
  })
})

// --- §2.122 — ai.api_key_store_op schema hardening --------------------------
//
// Emitted from electron/services/ai.ts (journalAiKeySecretOp) on every read/
// write/delete of an AI provider's stored key. The question it answers: do
// stored keys stay stored? Three invariants must hold:
//
//   1. kind=event, aggregate=true — a read happens on every AI request, so
//      per-call envelopes would flood the sink; counts are what get acted on.
//   2. mainOnly=true — the renderer bridge must reject a forged storage
//      history (tested in ipc.test.ts).
//   3. All three tags are closed enum domains, never free-form strings — the
//      key material structurally cannot ride along even as a mistake, because
//      there is no 'string' tag type here to misuse.

describe('§2.122 — ai.api_key_store_op schema hardening', () => {
  const NAME = 'ai.api_key_store_op' as const

  it('is registered in METRIC_EVENTS as an event', () => {
    expect(METRIC_EVENTS[NAME]).toBeDefined()
    expect(METRIC_EVENTS[NAME].kind).toBe('event')
  })

  it('mainOnly is true — renderer bridge must reject this event', () => {
    expect(METRIC_EVENTS[NAME].mainOnly).toBe(true)
  })

  it('aggregates — a read fires on every AI request', () => {
    expect(METRIC_EVENTS[NAME].aggregate).toBe(true)
  })

  it('carries ONLY op / provider / outcome — no key, no key id, no free text', () => {
    expect(METRIC_EVENTS[NAME].tags).toEqual({
      op: 'ai_key_op',
      provider: 'ai_key_provider',
      outcome: 'ai_key_outcome',
    })
  })

  it('ai_key_provider is closed to the three providers with a stored key', () => {
    expect(DOMAINS.ai_key_provider).toEqual(['anthropic-api', 'openai-api', 'gemini-api'])
  })

  it('ai_key_op is closed to the three secret-store operations', () => {
    expect(DOMAINS.ai_key_op).toEqual(['read', 'write', 'delete'])
  })

  it('ai_key_outcome is closed to the four outcomes — "found"/"absent" split the read, "store_error" is the previously-invisible fault', () => {
    expect(DOMAINS.ai_key_outcome).toEqual(['found', 'absent', 'ok', 'store_error'])
  })
})
