import { describe, it, expect } from 'vitest'
import {
  ExternalOpenGate,
  EXTERNAL_OPEN_BUCKET_CAPACITY,
  EXTERNAL_OPEN_REFILL_INTERVAL_MS,
  EXTERNAL_OPEN_ANOMALY_THRESHOLD,
  isTrustedOpenSource,
} from './externalOpenGate'
import { MailLinkRouter, DEDUP_WINDOW_MS } from './mailLinkRouter'

/**
 * BACKLOG §2.25 (re-diagnosis) — centralized external-open token-bucket gate.
 *
 * This suite proves the limiter that fronts every `shell.openExternal` call:
 *   - a legitimate burst (up to capacity) passes,
 *   - a sustained flood (an OS xdg-open/snap-firefox re-launch loop) is
 *     bounded to the steady refill rate,
 *   - the anomaly signal fires EXACTLY once per storm (one Sentry event, not
 *     one per suppressed call),
 *   - the gate self-heals after a quiet period, and a fresh storm reports a
 *     fresh anomaly.
 *
 * Pure state machine with an injectable clock — same testing style as
 * mailLinkRouter.test.ts; no Electron, no fake timers.
 */

describe('ExternalOpenGate — burst allowance', () => {
  it('allows a back-to-back burst up to the bucket capacity', () => {
    const clock = 1_000
    const gate = new ExternalOpenGate(() => clock)

    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) {
      expect(gate.tryAcquire().allowed).toBe(true)
    }
  })

  it('denies the first request past the capacity in a tight burst', () => {
    const clock = 1_000
    const gate = new ExternalOpenGate(() => clock)

    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) {
      gate.tryAcquire()
    }
    const denied = gate.tryAcquire()
    expect(denied.allowed).toBe(false)
    expect(denied.suppressedCount).toBe(1)
    expect(denied.anomaly).toBe(false)
  })
})

describe('ExternalOpenGate — steady-state refill', () => {
  it('grants one more token after exactly one refill interval', () => {
    let clock = 0
    const gate = new ExternalOpenGate(() => clock)

    // Drain the bucket.
    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) gate.tryAcquire()
    expect(gate.tryAcquire().allowed).toBe(false)

    // One refill interval later: exactly one token is available again.
    clock += EXTERNAL_OPEN_REFILL_INTERVAL_MS
    expect(gate.tryAcquire().allowed).toBe(true)
    // ...but only one — the next is denied again.
    expect(gate.tryAcquire().allowed).toBe(false)
  })

  it('accrues fractional tokens — half an interval is not enough on its own', () => {
    let clock = 0
    const gate = new ExternalOpenGate(() => clock)

    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) gate.tryAcquire()

    // Half an interval: 0.5 tokens accrued — still below 1, still denied.
    clock += EXTERNAL_OPEN_REFILL_INTERVAL_MS / 2
    expect(gate.tryAcquire().allowed).toBe(false)

    // Another half interval: the two halves sum to a whole token — allowed.
    // (Proves accrual is not lost to rounding between the two checks.)
    clock += EXTERNAL_OPEN_REFILL_INTERVAL_MS / 2
    expect(gate.tryAcquire().allowed).toBe(true)
  })

  it('caps the bucket at capacity — a long idle does not bank unlimited burst', () => {
    let clock = 0
    const gate = new ExternalOpenGate(() => clock)

    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) gate.tryAcquire()

    // Idle for ten full intervals — far more than capacity worth of refill.
    clock += EXTERNAL_OPEN_REFILL_INTERVAL_MS * 10

    // Only `capacity` tokens are available, not ten.
    let allowed = 0
    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY * 3; i++) {
      if (gate.tryAcquire().allowed) allowed++
    }
    expect(allowed).toBe(EXTERNAL_OPEN_BUCKET_CAPACITY)
  })
})

describe('ExternalOpenGate — sustained flood (the OS re-launch storm)', () => {
  it('bounds a tight flood to the burst allowance', () => {
    const clock = 0
    const gate = new ExternalOpenGate(() => clock)

    // 2000 requests in the same instant — the runaway shape. Only the burst
    // capacity gets through; everything else is suppressed.
    let allowed = 0
    let denied = 0
    for (let i = 0; i < 2000; i++) {
      if (gate.tryAcquire().allowed) allowed++
      else denied++
    }
    expect(allowed).toBe(EXTERNAL_OPEN_BUCKET_CAPACITY)
    expect(denied).toBe(2000 - EXTERNAL_OPEN_BUCKET_CAPACITY)
  })

  it('reports an anomaly EXACTLY once per storm', () => {
    const clock = 0
    const gate = new ExternalOpenGate(() => clock)

    const anomalies: number[] = []
    for (let i = 0; i < 500; i++) {
      const r = gate.tryAcquire()
      if (r.anomaly) anomalies.push(i)
    }

    // One and only one anomaly across the whole storm.
    expect(anomalies).toHaveLength(1)
  })

  it('fires the anomaly on the denial that first REACHES the threshold', () => {
    const clock = 0
    const gate = new ExternalOpenGate(() => clock)

    let anomalyAtSuppressedCount = -1
    for (let i = 0; i < 500; i++) {
      const r = gate.tryAcquire()
      if (r.anomaly) {
        anomalyAtSuppressedCount = r.suppressedCount ?? -1
        break
      }
    }
    // suppressedCount counts denials; the anomaly fires on the denial whose
    // count first reaches the threshold (denial #10), not the one past it.
    expect(anomalyAtSuppressedCount).toBe(EXTERNAL_OPEN_ANOMALY_THRESHOLD)
  })

  it('fires the anomaly at exactly the threshold-th denial — not #9, not #11', () => {
    const clock = 0
    const gate = new ExternalOpenGate(() => clock)

    // Drain the burst so every subsequent acquire is a denial.
    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) gate.tryAcquire()

    const anomalyDenials: number[] = []
    for (let denial = 1; denial <= 15; denial++) {
      if (gate.tryAcquire().anomaly) anomalyDenials.push(denial)
    }
    // Exactly one anomaly, on denial #THRESHOLD (10) — proves the boundary is
    // `>=` (fires at 10) and the latch prevents #9 or #11 from also firing.
    expect(anomalyDenials).toEqual([EXTERNAL_OPEN_ANOMALY_THRESHOLD])
  })

  it('does NOT fire an anomaly for a small sub-threshold suppression', () => {
    const clock = 0
    const gate = new ExternalOpenGate(() => clock)

    // Spend the burst, then deny one fewer than the threshold count — never
    // reaching it, so no anomaly.
    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) gate.tryAcquire()

    let sawAnomaly = false
    for (let i = 0; i < EXTERNAL_OPEN_ANOMALY_THRESHOLD - 1; i++) {
      if (gate.tryAcquire().anomaly) sawAnomaly = true
    }
    expect(sawAnomaly).toBe(false)
  })

  it('reports a growing suppressedCount for each denial in the dry spell', () => {
    const clock = 0
    const gate = new ExternalOpenGate(() => clock)

    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) gate.tryAcquire()

    const counts: number[] = []
    for (let i = 0; i < 5; i++) {
      counts.push(gate.tryAcquire().suppressedCount ?? -1)
    }
    expect(counts).toEqual([1, 2, 3, 4, 5])
  })
})

describe('ExternalOpenGate — recovery and re-arming', () => {
  it('self-heals after a quiet period — opens are allowed again', () => {
    let clock = 0
    const gate = new ExternalOpenGate(() => clock)

    // Storm: drain + many denials.
    for (let i = 0; i < 100; i++) gate.tryAcquire()
    expect(gate.tryAcquire().allowed).toBe(false)

    // Quiet long enough for the bucket to refill to full capacity.
    clock += EXTERNAL_OPEN_REFILL_INTERVAL_MS * EXTERNAL_OPEN_BUCKET_CAPACITY

    // Normal use works again, with a fresh full burst.
    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) {
      expect(gate.tryAcquire().allowed).toBe(true)
    }
  })

  it('a fresh storm after recovery reports a fresh anomaly', () => {
    let clock = 0
    const gate = new ExternalOpenGate(() => clock)

    // First storm → one anomaly.
    let firstStormAnomalies = 0
    for (let i = 0; i < 200; i++) {
      if (gate.tryAcquire().anomaly) firstStormAnomalies++
    }
    expect(firstStormAnomalies).toBe(1)

    // Recover fully (bucket back to capacity → dry-spell counters reset).
    clock += EXTERNAL_OPEN_REFILL_INTERVAL_MS * EXTERNAL_OPEN_BUCKET_CAPACITY

    // Second storm → its OWN single anomaly, proving the gate re-armed.
    let secondStormAnomalies = 0
    for (let i = 0; i < 200; i++) {
      if (gate.tryAcquire().anomaly) secondStormAnomalies++
    }
    expect(secondStormAnomalies).toBe(1)
  })

  it('mid-storm trickle (one allowed open per interval) does NOT reset the dry spell', () => {
    let clock = 0
    const gate = new ExternalOpenGate(() => clock)

    // Drain and trip the anomaly.
    let anomalies = 0
    for (let i = 0; i < 200; i++) {
      if (gate.tryAcquire().anomaly) anomalies++
    }
    expect(anomalies).toBe(1)

    // The storm keeps hammering, but slow enough that one token trickles
    // through each interval. The bucket never reaches FULL (it is consumed as
    // soon as it accrues), so the dry spell — and the already-reported
    // anomaly — must persist: no second anomaly fires.
    let moreAnomalies = 0
    for (let i = 0; i < 50; i++) {
      clock += EXTERNAL_OPEN_REFILL_INTERVAL_MS
      // One accrued token is consumed here...
      gate.tryAcquire()
      // ...and the immediate follow-up in the same instant is denied again.
      if (gate.tryAcquire().anomaly) moreAnomalies++
    }
    expect(moreAnomalies).toBe(0)
  })

  it('re-arm boundary: 1ms before a full refill does NOT reset the dry spell', () => {
    let clock = 0
    const gate = new ExternalOpenGate(() => clock)

    // Storm trips the anomaly and drains the bucket to empty (lastRefill=0).
    let anomalies = 0
    for (let i = 0; i < 200; i++) if (gate.tryAcquire().anomaly) anomalies++
    expect(anomalies).toBe(1)

    // Advance to ONE ms short of a full refill: tokens accrue to just under
    // capacity, so the bucket never hits FULL and the dry spell is not reset.
    const fullRefillMs = EXTERNAL_OPEN_BUCKET_CAPACITY * EXTERNAL_OPEN_REFILL_INTERVAL_MS
    clock = fullRefillMs - 1

    // The newly-accrued tokens get consumed, then denials resume — but the
    // already-reported anomaly stays latched, so no fresh anomaly fires.
    let reArmAnomalies = 0
    for (let i = 0; i < 200; i++) if (gate.tryAcquire().anomaly) reArmAnomalies++
    expect(reArmAnomalies).toBe(0)
  })

  it('re-arm boundary: exactly at a full refill resets the dry spell and re-arms', () => {
    let clock = 0
    const gate = new ExternalOpenGate(() => clock)

    let anomalies = 0
    for (let i = 0; i < 200; i++) if (gate.tryAcquire().anomaly) anomalies++
    expect(anomalies).toBe(1)

    // Advance to EXACTLY a full refill: the bucket reaches capacity, the dry
    // spell resets, and a fresh storm reports its own single anomaly.
    const fullRefillMs = EXTERNAL_OPEN_BUCKET_CAPACITY * EXTERNAL_OPEN_REFILL_INTERVAL_MS
    clock = fullRefillMs

    let reArmAnomalies = 0
    for (let i = 0; i < 200; i++) if (gate.tryAcquire().anomaly) reArmAnomalies++
    expect(reArmAnomalies).toBe(1)
  })

  it('clock regression: now() going backwards mints no tokens and does not reset the dry spell', () => {
    let clock = 10_000
    const gate = new ExternalOpenGate(() => clock)

    // Drain the burst, then accumulate three denials in the dry spell.
    for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) gate.tryAcquire()
    for (let i = 0; i < 3; i++) gate.tryAcquire()

    // Wall clock jumps backwards (NTP step / suspend-resume). refill() guards
    // on `elapsed <= 0`, so no tokens are minted and lastRefill is unchanged.
    clock = 0
    const r = gate.tryAcquire()

    // Still denied (no phantom token), and the dry spell continued — the 4th
    // denial — rather than being silently reset by the backwards jump.
    expect(r.allowed).toBe(false)
    expect(r.suppressedCount).toBe(4)
  })
})

describe('ExternalOpenGate — normal usage never trips', () => {
  it('a user clicking links at human pace is always allowed and never flagged', () => {
    let clock = 0
    const gate = new ExternalOpenGate(() => clock)

    // 20 links over ~60 seconds (one every ~3s) — realistic human cadence,
    // slower than the refill rate so the bucket stays healthy.
    for (let i = 0; i < 20; i++) {
      const r = gate.tryAcquire()
      expect(r.allowed).toBe(true)
      expect(r.anomaly).toBeFalsy()
      clock += 3_000
    }
  })

  it('an OAuth flow (a couple of opens back-to-back) is always allowed', () => {
    const clock = 0
    const gate = new ExternalOpenGate(() => clock)

    // Two opens in the same instant — consent page + a follow-up. Capacity 5
    // leaves ample headroom.
    expect(gate.tryAcquire().allowed).toBe(true)
    expect(gate.tryAcquire().allowed).toBe(true)
  })
})

describe('ExternalOpenGate — trust-class routing (OAuth starvation guard)', () => {
  it('classifies oauth and update_dialog as trusted, everything else as untrusted', () => {
    expect(isTrustedOpenSource('oauth')).toBe(true)
    expect(isTrustedOpenSource('update_dialog')).toBe(true)
    expect(isTrustedOpenSource('window_open')).toBe(false)
    expect(isTrustedOpenSource('ui_ipc')).toBe(false)
    expect(isTrustedOpenSource('unsubscribe')).toBe(false)
    expect(isTrustedOpenSource('mail_link')).toBe(false)
    expect(isTrustedOpenSource('')).toBe(false)
  })

  it('a storm on the untrusted bucket never starves a trusted (OAuth) open', () => {
    const clock = 0
    // Two independent buckets, exactly as wired in main.ts.
    const untrusted = new ExternalOpenGate(() => clock)
    const trusted = new ExternalOpenGate(() => clock)

    // Email-content-driven storm hammers the UNTRUSTED bucket dry.
    let untrustedDenied = 0
    for (let i = 0; i < 500; i++) {
      const gate = isTrustedOpenSource('unsubscribe') ? trusted : untrusted
      if (!gate.tryAcquire().allowed) untrustedDenied++
    }
    expect(untrustedDenied).toBeGreaterThan(0)

    // A legitimate OAuth open arrives mid-storm — routed to the TRUSTED bucket,
    // which the storm never touched, so it is still allowed.
    const oauthGate = isTrustedOpenSource('oauth') ? trusted : untrusted
    expect(oauthGate.tryAcquire().allowed).toBe(true)
  })

  it('the buckets are symmetric — a trusted storm does not starve untrusted opens', () => {
    const clock = 0
    const untrusted = new ExternalOpenGate(() => clock)
    const trusted = new ExternalOpenGate(() => clock)

    // Drain the trusted bucket (a pathological OAuth/update loop).
    for (let i = 0; i < 500; i++) {
      const gate = isTrustedOpenSource('oauth') ? trusted : untrusted
      gate.tryAcquire()
    }

    // A normal user link click on the untrusted bucket is unaffected.
    const linkGate = isTrustedOpenSource('window_open') ? trusted : untrusted
    expect(linkGate.tryAcquire().allowed).toBe(true)
  })
})

describe('§2.25 gate + mailLinkRouter interplay — documented 1Hz loop bound', () => {
  // Documented hole: MailLinkRouter's per-webContents dedup collapses identical
  // URL emissions within DEDUP_WINDOW_MS (600ms). At 1Hz (1000ms period), every
  // emission is past that window — the router treats each as a fresh user click.
  // The router's circuit breaker (ANOMALY_THRESHOLD=3 within ANOMALY_WINDOW_MS=
  // 2000ms) also does not trip: at 1Hz, at most 2 emissions land in any 2s
  // window, which is below the threshold. The router provides NO protection
  // against a 1Hz same-URL loop. ExternalOpenGate is the only defence.

  it('documented hole: 1Hz same-URL flood passes MailLinkRouter unchecked (period > DEDUP_WINDOW_MS)', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    const url = 'https://evil.example/loop'
    const FLOOD_INTERVAL_MS = 1_000 // 1Hz

    // Confirm the flood period is above the dedup window — the assertion makes
    // the relationship explicit and will fail if DEDUP_WINDOW_MS is ever raised
    // above 1000ms without revisiting this test.
    expect(FLOOD_INTERVAL_MS).toBeGreaterThan(DEDUP_WINDOW_MS)

    let passedRouter = 0
    for (let tick = 0; tick < 60; tick++) {
      if (router.shouldEmit(url)) {
        router.noteEmit(url)
        passedRouter++
      }
      clock += FLOOD_INTERVAL_MS
    }

    // All 60 attempts reach "shell.openExternal" territory — the router
    // provides no protection against this flood shape.
    expect(passedRouter).toBe(60)
    // Circuit breaker never triggered (storm is too slow to be detected here).
    expect(router.isBreakerOpen()).toBe(false)
  })

  it('ExternalOpenGate bounds the 1Hz flood to ≤ capacity + 60s-refill-quota even when MailLinkRouter passes everything through', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    const gate = new ExternalOpenGate(() => clock)
    const url = 'https://evil.example/loop'
    let dispatched = 0

    for (let tick = 0; tick < 60; tick++) {
      // MailLinkRouter: passes all 60 at 1Hz (documented hole confirmed above).
      if (router.shouldEmit(url)) {
        router.noteEmit(url)
        // openExternalGated in production calls gate.tryAcquire() here.
        if (gate.tryAcquire().allowed) {
          dispatched++
        }
      }
      clock += 1_000
    }

    // Theoretical maximum = initial capacity (5) + tokens refilled over 60s.
    // Refill: 1 token per EXTERNAL_OPEN_REFILL_INTERVAL_MS = 1 per 2s → 30 tokens.
    // Total available ≤ 5 + 30 = 35. Dispatches cannot exceed tokens consumed.
    const theoreticalMax =
      EXTERNAL_OPEN_BUCKET_CAPACITY +
      Math.floor(60_000 / EXTERNAL_OPEN_REFILL_INTERVAL_MS)
    expect(dispatched).toBeLessThanOrEqual(theoreticalMax)

    // Substantially fewer than the 60 the router passed through — the gate
    // provides the hard bound the router alone cannot give.
    expect(dispatched).toBeLessThan(60)
  })
})
