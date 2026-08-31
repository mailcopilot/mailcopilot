/**
 * §2.124 — off-main-thread MIME parsing: dispatch threshold, worker lifecycle,
 * cancellation and failure policy.
 *
 * The specs drive real `worker_threads` workers (tiny CJS fixtures written to
 * a temp dir) rather than mocks, because everything that matters here is
 * lifecycle: which thread the work lands on, what happens when the thread dies
 * mid-message, and whether an abandoned job leaves anything running.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { EML_BODY_FULL_CAP_BYTES, EML_BODY_SOFT_CAP_BYTES, extractIcsFromRawEml, parseEmlBuffer } from './eml'
import {
  EML_WORKER_IDLE_SHUTDOWN_MS,
  EML_WORKER_MIN_BYTES,
  __emlWorkerStateForTest,
  __emlWorkerTerminationForTest,
  __resetEmlWorkerForTest,
  __setEmlWorkerPathForTest,
  emlParseDispatchCounts,
  planEmlParseDispatch,
  type EmlParsePath,
} from './emlWorkerClient'
import { setNetErrorReporter, setNetEventReporter } from './telemetry'
import { bucketBodySize } from '../../electron/metricsBuckets'
import { DOMAINS, METRIC_EVENTS } from '../../electron/metricsSchema'

let fixtureDir: string

/** The readiness announcement every real worker makes once its handler is
 *  installed. The client dispatches nothing to a worker that has not sent it,
 *  so every fixture that is meant to receive work has to end with this. */
const ANNOUNCE = `parentPort.postMessage({ ready: true })`

/** Replies correctly, tagging the result so a spec can tell a worker parse
 *  from an inline parse of the same bytes. */
const MARKER_WORKER = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (req) => {
  if (req.type === 'parseDetails') {
    parentPort.postMessage({
      id: req.id,
      ok: true,
      type: 'parseDetails',
      details: { uid: req.uid, envelope: { subject: 'FROM_WORKER' }, text: 'bytes:' + req.raw.length },
    })
  } else {
    parentPort.postMessage({ id: req.id, ok: true, type: 'extractIcs', ics: 'ICS_FROM_WORKER' })
  }
})
${ANNOUNCE}
`

/**
 * §2.145 — echoes `req.maxBodyBytes` back in the result text, so a spec can
 * observe what actually crossed the `postMessage` boundary rather than
 * inferring it from job-identity/coalescing behaviour alone. The coalescing
 * suite below proves two DIFFERENT limits produce two DIFFERENT jobs; this
 * fixture proves the worker RECEIVES the specific value `resolveBodyLimit`
 * resolved, not merely *a* value distinct from some other job's.
 */
const ECHO_LIMIT_WORKER = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (req) => {
  parentPort.postMessage({
    id: req.id,
    ok: true,
    type: 'parseDetails',
    details: { uid: req.uid, envelope: { subject: 'FROM_WORKER' }, text: 'limit:' + req.maxBodyBytes },
  })
})
${ANNOUNCE}
`

/** Comes up, announces itself, then dies on the very first message it is given
 *  — the shape of hostile bytes that kill a parser. Post-handshake this is a
 *  MESSAGE-specific death even though the worker had answered nothing. */
const CRASH_ON_FIRST_WORKER = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', () => { process.exit(3) })
${ANNOUNCE}
`

/** Serves one message, then dies. */
const CRASH_ON_SECOND_WORKER = `
const { parentPort } = require('node:worker_threads')
let seen = 0
parentPort.on('message', (req) => {
  seen += 1
  if (seen === 1) {
    parentPort.postMessage({ id: req.id, ok: true, type: 'parseDetails', details: { uid: req.uid, envelope: {} } })
    return
  }
  process.exit(4)
})
${ANNOUNCE}
`

/** Reports a parse failure through the protocol instead of dying. */
const FAILING_WORKER = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (req) => {
  parentPort.postMessage({ id: req.id, ok: false, error: 'parse blew up midway' })
})
${ANNOUNCE}
`

/** Never answers — stands in for a message that wedges the parser. */
const SILENT_WORKER = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', () => { /* wedged on purpose */ })
${ANNOUNCE}
`

/** Answers the first message, then wedges on every later one. Lets a spec warm
 *  the worker (so readiness is already behind us and the job timer is the only
 *  clock left running) before installing fake timers. */
const WEDGE_ON_SECOND_WORKER = `
const { parentPort } = require('node:worker_threads')
let seen = 0
parentPort.on('message', (req) => {
  seen += 1
  if (seen === 1) {
    parentPort.postMessage({ id: req.id, ok: true, type: 'parseDetails', details: { uid: req.uid, envelope: {} } })
  }
})
${ANNOUNCE}
`

/** Comes up and listens, but never announces itself. Records anything it is
 *  sent, so a spec can prove the client dispatched NOTHING while waiting. */
function neverReadyWorkerSource(received: string): string {
  return `
const fs = require('node:fs')
const RECEIVED = ${JSON.stringify(received)}
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (req) => {
  try { fs.appendFileSync(RECEIVED, 'got:' + req.id + '\\n') } catch {}
})
// No announcement on purpose: this fixture LOADS CLEANLY and stays alive, so
// the only thing that can end the wait is the readiness deadline. A fixture
// that threw at load would take the ordinary error path and this spec would
// pass without ever exercising the timeout.
`
}

/**
 * Works on its FIRST load and refuses to load on every later one, recording
 * each load attempt.
 *
 * This is the shape a session-wide flag cannot see: the first worker comes up
 * and serves a message, gets retired by the idle shutdown, and the replacement
 * then fails before it can announce itself. Nothing about the message changed.
 */
function generationAwareWorkerSource(loadLog: string): string {
  return `
const fs = require('node:fs')
const LOG = ${JSON.stringify(loadLog)}
const loads = (fs.readFileSync(LOG, 'utf8').match(/load/g) || []).length + 1
fs.appendFileSync(LOG, 'load\\n')
if (loads > 1) throw new Error('replacement worker cannot start here')
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (req) => {
  parentPort.postMessage({
    id: req.id,
    ok: true,
    type: 'parseDetails',
    details: { uid: req.uid, envelope: { subject: 'FROM_WORKER' } },
  })
})
${ANNOUNCE}
`
}

/** Answers, but only after a delay, so a spec can abort mid-flight. Writes a
 *  breadcrumb file when it finally gets around to answering, which is how the
 *  "no work left running" assertion is made. */
function slowWorkerSource(breadcrumb: string): string {
  return `
const { parentPort } = require('node:worker_threads')
const fs = require('node:fs')
const BREADCRUMB = ${JSON.stringify(breadcrumb)}
parentPort.on('message', (req) => {
  setTimeout(() => {
    try { fs.appendFileSync(BREADCRUMB, 'finished:' + req.id + '\\n') } catch {}
    parentPort.postMessage({ id: req.id, ok: true, type: 'parseDetails', details: { uid: req.uid, envelope: {} } })
  }, 3000)
})
${ANNOUNCE}
`
}

function writeFixture(name: string, source: string): string {
  const file = path.join(fixtureDir, name)
  fs.writeFileSync(file, source, 'utf8')
  return file
}

/** A syntactically valid RFC822 message of at least `bytes` bytes. */
function messageOfSize(bytes: number): Buffer {
  const head = [
    'From: Alice <alice@example.com>',
    'To: Bob <bob@example.com>',
    'Subject: Size fixture',
    'Date: Mon, 4 Aug 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    '',
  ].join('\r\n')
  const padding = Math.max(0, bytes - Buffer.byteLength(head, 'utf8'))
  return Buffer.from(head + 'x'.repeat(padding), 'utf8')
}

/** Poll a client-state predicate on real timers. Dispatch is now gated on the
 *  worker announcing itself, so "has the job started" is thread-boot latency
 *  away from the call that queued it — a fixed sleep would be a flake. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-eml-worker-'))
})

afterAll(() => {
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

afterEach(() => {
  __resetEmlWorkerForTest()
  __setEmlWorkerPathForTest(undefined)
  setNetEventReporter(null)
  setNetErrorReporter(null)
  vi.useRealTimers()
})

/** Collect what packages/net would hand the main-process telemetry bridge. */
type CapturedEvent = { name: string; tags: Record<string, string | number | boolean> }
function captureNetEvents(): CapturedEvent[] {
  const events: CapturedEvent[] = []
  setNetEventReporter((name, tags) => { events.push({ name, tags }) })
  return events
}

function dispatchEvents(events: CapturedEvent[]): CapturedEvent[] {
  return events.filter(e => e.name === 'eml.parse_dispatch')
}

function unavailableEvents(events: CapturedEvent[]): CapturedEvent[] {
  return events.filter(e => e.name === 'eml.parse_worker_unavailable')
}

describe('§2.124 offload threshold', () => {
  it('parses just under the threshold inline, without starting a worker', async () => {
    __setEmlWorkerPathForTest(writeFixture('marker-under.cjs', MARKER_WORKER))
    const raw = messageOfSize(EML_WORKER_MIN_BYTES - 1)
    expect(raw.length).toBe(EML_WORKER_MIN_BYTES - 1)

    const details = await parseEmlBuffer(11, raw)

    expect(details.envelope?.subject).toBe('Size fixture')
    expect(__emlWorkerStateForTest().hasWorker).toBe(false)
  })

  it('offloads at exactly the threshold', async () => {
    __setEmlWorkerPathForTest(writeFixture('marker-at.cjs', MARKER_WORKER))
    const raw = messageOfSize(EML_WORKER_MIN_BYTES)
    expect(raw.length).toBe(EML_WORKER_MIN_BYTES)

    const details = await parseEmlBuffer(12, raw)

    expect(details.envelope?.subject).toBe('FROM_WORKER')
    expect(details.text).toBe(`bytes:${EML_WORKER_MIN_BYTES}`)
  })

  it('offloads the calendar scan on the same threshold', async () => {
    __setEmlWorkerPathForTest(writeFixture('marker-ics.cjs', MARKER_WORKER))

    const small = await extractIcsFromRawEml(messageOfSize(EML_WORKER_MIN_BYTES - 1))
    expect(small).toBeUndefined()
    expect(__emlWorkerStateForTest().hasWorker).toBe(false)

    const large = await extractIcsFromRawEml(messageOfSize(EML_WORKER_MIN_BYTES))
    expect(large).toBe('ICS_FROM_WORKER')
  })

  it('keeps parsing inline when no worker script exists', async () => {
    __setEmlWorkerPathForTest(null)
    const details = await parseEmlBuffer(13, messageOfSize(EML_WORKER_MIN_BYTES * 2))
    expect(details.envelope?.subject).toBe('Size fixture')
    expect(__emlWorkerStateForTest().hasWorker).toBe(false)
  })
})

describe('§2.124 worker failure policy', () => {
  it('falls back to the inline parse when the worker cannot start at all', async () => {
    // A path that exists but is not loadable stands in for a broken build.
    __setEmlWorkerPathForTest(writeFixture('not-a-worker.cjs', 'throw new Error("boom at load")\n'))

    const details = await parseEmlBuffer(21, messageOfSize(EML_WORKER_MIN_BYTES))

    expect(details.envelope?.subject).toBe('Size fixture')
    expect(__emlWorkerStateForTest().unavailable).toBe(true)
  })

  it('stops attempting to offload once the worker is known unavailable', async () => {
    // "Cannot start" is now a load failure, i.e. a worker that never announced
    // itself — a worker that dies ON A MESSAGE is a different case entirely
    // (see the readiness describe block).
    __setEmlWorkerPathForTest(writeFixture('unloadable-latch.cjs', 'throw new Error("boom at load")\n'))

    const first = await parseEmlBuffer(22, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(first.envelope?.subject).toBe('Size fixture')
    expect(__emlWorkerStateForTest().unavailable).toBe(true)

    const second = await parseEmlBuffer(23, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(second.envelope?.subject).toBe('Size fixture')
    expect(__emlWorkerStateForTest().hasWorker).toBe(false)
  })

  it('propagates instead of retrying inline when a ready worker dies on a message', async () => {
    __setEmlWorkerPathForTest(writeFixture('crash-second.cjs', CRASH_ON_SECOND_WORKER))

    const ok = await parseEmlBuffer(24, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(ok.uid).toBe(24)

    await expect(parseEmlBuffer(25, messageOfSize(EML_WORKER_MIN_BYTES))).rejects.toThrow(/exited with code 4/)
    expect(__emlWorkerStateForTest().unavailable).toBe(false)
  })

  it('recovers on the next message after a crash', async () => {
    __setEmlWorkerPathForTest(writeFixture('crash-second-b.cjs', CRASH_ON_SECOND_WORKER))

    await parseEmlBuffer(26, messageOfSize(EML_WORKER_MIN_BYTES))
    await expect(parseEmlBuffer(27, messageOfSize(EML_WORKER_MIN_BYTES))).rejects.toThrow()

    // A fresh worker is spawned, so the fixture's counter starts over and the
    // next message succeeds again.
    const third = await parseEmlBuffer(28, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(third.uid).toBe(28)
  })

  it('surfaces a mid-parse failure reported through the protocol', async () => {
    __setEmlWorkerPathForTest(writeFixture('failing.cjs', FAILING_WORKER))

    await expect(parseEmlBuffer(29, messageOfSize(EML_WORKER_MIN_BYTES))).rejects.toThrow(
      'parse blew up midway',
    )
  })

  it('degrades the calendar scan to "no invite" when the parse fails, instead of failing the open', async () => {
    __setEmlWorkerPathForTest(writeFixture('failing-ics.cjs', FAILING_WORKER))

    await expect(extractIcsFromRawEml(messageOfSize(EML_WORKER_MIN_BYTES))).resolves.toBeUndefined()
  })

  it('cannot be wedged by a message the parser never finishes', async () => {
    __setEmlWorkerPathForTest(writeFixture('wedge-second.cjs', WEDGE_ON_SECOND_WORKER))

    // Warm the worker on real timers first: readiness has its own deadline, and
    // a fake clock started before the thread boots would trip THAT instead of
    // the job timeout this spec is about.
    await parseEmlBuffer(29_500, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(__emlWorkerStateForTest().currentWorkerReady).toBe(true)

    vi.useFakeTimers()
    const pending = parseEmlBuffer(30, messageOfSize(EML_WORKER_MIN_BYTES))
    const assertion = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(60_000)
    // The caller is released on the main thread's own timer, whatever the
    // worker is doing — that is the liveness guarantee, and it settles here.
    await assertion
    vi.useRealTimers()

    expect(__emlWorkerStateForTest().hasWorker).toBe(false)
    expect(__emlWorkerStateForTest().active).toBe(false)

    // ...but `hasWorker === false` only proves the client dropped its
    // reference. The thread is gone only when terminate() settles: Node
    // resolves it with the exit code after the worker has actually stopped.
    // Without this assertion the spec would still pass if the client merely
    // abandoned a live thread, which is the wedge it claims to bound.
    const termination = __emlWorkerTerminationForTest()
    expect(termination).not.toBeNull()
    await expect(termination).resolves.toEqual(expect.any(Number))
  })
})

describe('§2.124 replacement workers are not credited with a predecessor\'s readiness', () => {
  it('treats a replacement that never comes up as unavailable, not as a poisoned message', async () => {
    const loads = path.join(fixtureDir, 'generation-loads.txt')
    fs.writeFileSync(loads, '', 'utf8')
    __setEmlWorkerPathForTest(writeFixture('generation.cjs', generationAwareWorkerSource(loads)))
    const events = captureNetEvents()
    const errors: Array<{ source: string; context?: Record<string, unknown> }> = []
    setNetErrorReporter((source, _err, context) => { errors.push({ source, context }) })

    // Fake timers from the start: the idle shutdown below is scheduled during
    // the first parse, so a timer installed afterwards could not fire it.
    // Worker messages are real events and arrive regardless.
    vi.useFakeTimers()

    // 1. A worker comes up, announces itself and serves a real message.
    const first = await parseEmlBuffer(60, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(first.envelope?.subject).toBe('FROM_WORKER')
    expect(__emlWorkerStateForTest().currentWorkerReady).toBe(true)

    // 2. The idle shutdown retires it — an ordinary session where one large
    //    message arrives and nothing follows for a minute.
    await vi.advanceTimersByTimeAsync(EML_WORKER_IDLE_SHUTDOWN_MS)
    vi.useRealTimers()
    expect(__emlWorkerStateForTest().hasWorker).toBe(false)

    // 3. The replacement dies before it can announce itself, so nothing was
    //    dispatched to it and the message cannot be the cause: the documented
    //    fallback must engage — parse inline and latch. Letting the replacement
    //    inherit its predecessor's standing rejected the message here instead.
    const second = await parseEmlBuffer(61, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(second.envelope?.subject).toBe('Size fixture')

    const state = __emlWorkerStateForTest()
    expect(state.unavailable).toBe(true)
    expect(state.unavailableReason).toBe('startup_failed')
    expect(state.generation).toBe(2)
    expect(unavailableEvents(events)).toEqual([
      { name: 'eml.parse_worker_unavailable', tags: { reason: 'startup_failed' } },
    ])
    expect(errors).toEqual([
      { source: 'eml.parse.worker', context: { exit_reason: 'startup_failed' } },
    ])
    expect(dispatchEvents(events).map(e => e.tags.path)).toEqual(['worker', 'inline_unavailable'])

    // 4. And the latch holds: the third message pays no spawn at all.
    const third = await parseEmlBuffer(62, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(third.envelope?.subject).toBe('Size fixture')
    expect(fs.readFileSync(loads, 'utf8')).toBe('load\nload\n')
    expect(unavailableEvents(events)).toHaveLength(1)
  }, 15_000)

  it('still blames the message when the worker that died had announced itself', async () => {
    // The other half of the asymmetry, and the reason generation scoping is not
    // simply "always fall back": a worker that came up is demonstrably running,
    // so these bytes must not be retried on the main thread.
    __setEmlWorkerPathForTest(writeFixture('generation-ready.cjs', CRASH_ON_SECOND_WORKER))

    await parseEmlBuffer(63, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(__emlWorkerStateForTest().currentWorkerReady).toBe(true)

    await expect(parseEmlBuffer(64, messageOfSize(EML_WORKER_MIN_BYTES))).rejects.toThrow(
      /exited with code 4/,
    )
    expect(__emlWorkerStateForTest().unavailable).toBe(false)
  })

  it('reports a crash of a ready worker with a context key the sanitiser keeps', async () => {
    // `stage` / `startup` were passed here once and silently dropped by the
    // allowlist in electron/services/netErrorTelemetry.ts, leaving the alert
    // with no diagnostic at all. `exit_reason` is the allowlisted
    // code-controlled enum key, so this value actually reaches Sentry.
    __setEmlWorkerPathForTest(writeFixture('generation-exit-reason.cjs', CRASH_ON_SECOND_WORKER))
    const errors: Array<{ source: string; context?: Record<string, unknown> }> = []
    setNetErrorReporter((source, _err, context) => { errors.push({ source, context }) })

    await parseEmlBuffer(65, messageOfSize(EML_WORKER_MIN_BYTES))
    await expect(parseEmlBuffer(66, messageOfSize(EML_WORKER_MIN_BYTES))).rejects.toThrow()

    expect(errors).toEqual([
      { source: 'eml.parse.worker', context: { exit_reason: 'job_crash' } },
    ])
  })
})

/**
 * §2.124 readiness handshake — the fix for the security finding that hostile
 * bytes could be re-parsed on the main thread.
 *
 * The threat: a remote sender crafts MIME that kills the parser. Opened as the
 * first large message after launch (or after the 60 s idle retirement), it
 * killed a worker that had answered nothing; the client read that as "workers
 * do not run here", latched, and handed the same bytes to the main process.
 * With the handshake, "died before it announced itself" is causally
 * independent of the message, because nothing is dispatched before the
 * announcement.
 */
describe('§2.124 readiness handshake', () => {
  it('rejects hostile bytes that kill a fresh worker instead of re-parsing them inline', async () => {
    // Announces itself, then dies on the first message it is given — a worker
    // that has answered nothing, which is exactly the case the old policy got
    // wrong.
    __setEmlWorkerPathForTest(writeFixture('hostile-first.cjs', CRASH_ON_FIRST_WORKER))
    const events = captureNetEvents()

    await expect(parseEmlBuffer(70, messageOfSize(EML_WORKER_MIN_BYTES))).rejects.toThrow(
      /exited with code 3/,
    )

    // The point of the whole finding: no inline fallback, and no latch. The
    // bytes never touched the main thread, and the feature is intact for every
    // other message.
    const state = __emlWorkerStateForTest()
    expect(state.unavailable).toBe(false)
    expect(state.unavailableReason).toBeNull()
    expect(dispatchEvents(events).map(e => e.tags.path)).toEqual(['worker_failed'])
    expect(emlParseDispatchCounts().inline_unavailable).toBe(0)
  })

  it('degrades the calendar scan to "no invite" rather than scanning hostile bytes inline', async () => {
    __setEmlWorkerPathForTest(writeFixture('hostile-first-ics.cjs', CRASH_ON_FIRST_WORKER))
    const events = captureNetEvents()

    await expect(extractIcsFromRawEml(messageOfSize(EML_WORKER_MIN_BYTES))).resolves.toBeUndefined()

    // Best-effort means "no RSVP card", never "run the full attachment-buffering
    // parse of the bytes that just killed a thread on the main loop".
    expect(dispatchEvents(events).map(e => e.tags.path)).toEqual(['worker_failed'])
    expect(emlParseDispatchCounts().inline_unavailable).toBe(0)
  })

  it('dispatches nothing until the worker announces itself, then falls back when it never does', async () => {
    const received = path.join(fixtureDir, 'never-ready-received.txt')
    fs.writeFileSync(received, '', 'utf8')
    __setEmlWorkerPathForTest(writeFixture('never-ready.cjs', neverReadyWorkerSource(received)))
    const events = captureNetEvents()

    vi.useFakeTimers()
    const pending = parseEmlBuffer(71, messageOfSize(EML_WORKER_MIN_BYTES))

    // The worker is spawned synchronously, and the client is now waiting for an
    // announcement that will never come.
    expect(__emlWorkerStateForTest().hasWorker).toBe(true)
    expect(__emlWorkerStateForTest().currentWorkerReady).toBe(false)
    // The job is still QUEUED — not handed to an unannounced worker, and not
    // lost in a limbo the admission bound cannot see.
    expect(__emlWorkerStateForTest().queued).toBe(1)
    expect(__emlWorkerStateForTest().active).toBe(false)

    // The readiness deadline expires: message-independent by construction,
    // because nothing was dispatched. The inline fallback that follows runs on
    // the same (fake) clock — the MIME splitter yields once per line — so it
    // has to be driven to completion before real timers come back.
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.runAllTimersAsync()
    vi.useRealTimers()

    const details = await pending
    expect(details.envelope?.subject).toBe('Size fixture')
    expect(fs.readFileSync(received, 'utf8')).toBe('')
    expect(__emlWorkerStateForTest().unavailableReason).toBe('startup_failed')
    expect(dispatchEvents(events).map(e => e.tags.path)).toEqual(['inline_unavailable'])
  }, 20_000)
})

/**
 * §2.124 admission control — the fix for the unbounded-queue finding.
 *
 * Every queued job pins a raw message buffer in the main process, and
 * `net:messageDetails` is a whitelisted preload channel: a compromised renderer
 * can burst it before any cache is warm and pin one buffer per call.
 */
describe('§2.124 admission control', () => {
  /** Distinct bytes of a given size — an attacker's burst is not duplicates,
   *  so coalescing must not be what saves us here. */
  function distinctMessage(bytes: number, tag: number): Buffer {
    const base = messageOfSize(bytes)
    base.write(`X-Tag: ${tag}`, 40, 'utf8')
    return base
  }

  it('refuses work past the queue bound instead of pinning it, and never parses it inline', async () => {
    // A worker that answers nothing keeps every job queued, which is what lets
    // a burst accumulate.
    __setEmlWorkerPathForTest(writeFixture('bound-silent.cjs', SILENT_WORKER))
    const errors: Array<{ source: string; context?: Record<string, unknown> }> = []
    setNetErrorReporter((source, _err, context) => { errors.push({ source, context }) })
    const events = captureNetEvents()

    const outcomes: string[] = []
    // Deliberately not awaited: the admitted jobs never settle (the worker is
    // wedged by design), and that is the whole shape of the attack — the client
    // has to refuse without needing anything to complete. Each promise carries
    // its own handler, so the reset in afterEach settles them harmlessly.
    for (let i = 0; i < 20; i++) {
      void parseEmlBuffer(80 + i, distinctMessage(EML_WORKER_MIN_BYTES, i))
        .then(() => { outcomes.push('parsed') }, (err: Error) => { outcomes.push(err.name) })
    }
    await waitFor(() => outcomes.length > 0, 'the first refusal')

    // One job active plus at most MAX_QUEUED_JOBS waiting; the rest refused.
    const refusals = outcomes.filter(o => o === 'EmlParseQueueOverflowError').length
    expect(refusals).toBeGreaterThan(0)
    expect(__emlWorkerStateForTest().queued).toBeLessThanOrEqual(8)
    expect(__emlWorkerStateForTest().refused).toBe(refusals)

    // A refusal is not a fallback: nothing was parsed on the main thread, and
    // nothing was counted as a dispatch, because no parse took place.
    expect(emlParseDispatchCounts().inline_unavailable).toBe(0)
    expect(dispatchEvents(events)).toEqual([])

    // One report per episode — a burst is one incident, and a reporter that
    // fired per refusal would amplify the flood it is reporting.
    expect(errors).toEqual([
      { source: 'eml.parse.queue', context: { exit_reason: 'queue_overflow' } },
    ])
  })

  it('bounds queued bytes, not just entries', async () => {
    __setEmlWorkerPathForTest(writeFixture('bound-bytes-silent.cjs', SILENT_WORKER))
    const big = 12 * 1024 * 1024

    const outcomes: string[] = []
    // Seven 12 MiB messages stays under the eight-entry bound and goes over the
    // 64 MiB byte bound, so only the byte bound can stop this.
    for (let i = 0; i < 7; i++) {
      void parseEmlBuffer(200 + i, distinctMessage(big, i))
        .then(() => { outcomes.push('parsed') }, (err: Error) => { outcomes.push(err.name) })
    }
    await waitFor(() => outcomes.length > 0, 'the first refusal')

    expect(outcomes.filter(o => o === 'EmlParseQueueOverflowError').length).toBeGreaterThan(0)
    expect(__emlWorkerStateForTest().queued).toBeLessThan(8)
    expect(__emlWorkerStateForTest().pendingBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
  }, 20_000)

  it('never refuses a lone message, however large', async () => {
    __setEmlWorkerPathForTest(writeFixture('bound-lone.cjs', MARKER_WORKER))

    // Bigger than the whole byte bound, arriving on an empty queue. The bound
    // exists to stop accumulation, not to change what one message costs — a
    // refusal here would be a behaviour regression dressed up as a fix.
    const details = await parseEmlBuffer(90, messageOfSize(80 * 1024 * 1024))

    expect(details.envelope?.subject).toBe('FROM_WORKER')
    expect(__emlWorkerStateForTest().refused).toBe(0)
  }, 30_000)

  it('admits work again once the queue drains, and reports the next episode', async () => {
    __setEmlWorkerPathForTest(writeFixture('bound-recovery.cjs', MARKER_WORKER))
    const errors: Array<{ source: string; context?: Record<string, unknown> }> = []
    setNetErrorReporter((source, _err, context) => { errors.push({ source, context }) })

    // A worker that answers drains the queue between bursts, so the refusals
    // here are transient rather than a standing condition.
    for (let i = 0; i < 12; i++) {
      await parseEmlBuffer(300 + i, distinctMessage(EML_WORKER_MIN_BYTES, i)).catch(() => { /* refusals are the point elsewhere */ })
    }

    const after = await parseEmlBuffer(320, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(after.envelope?.subject).toBe('FROM_WORKER')
    expect(__emlWorkerStateForTest().refused).toBe(0)
    expect(errors).toEqual([])
  })
})

describe('§2.124 coalescing', () => {
  it('joins a second request for the same message to the parse already in flight', async () => {
    __setEmlWorkerPathForTest(writeFixture('coalesce-slow.cjs', slowWorkerSource(path.join(fixtureDir, 'coalesce-crumb.txt'))))
    const raw = messageOfSize(EML_WORKER_MIN_BYTES)
    const events = captureNetEvents()

    const first = parseEmlBuffer(100, raw)
    // Same message, requested again while the first parse is still running —
    // the repeated click on a message that has not finished loading.
    await waitFor(() => __emlWorkerStateForTest().active, 'the first parse to start')
    const second = parseEmlBuffer(100, Buffer.from(raw))

    const state = __emlWorkerStateForTest()
    expect(state.active).toBe(true)
    // One job, two callers: the second did not queue a second copy of the same
    // megabytes.
    expect(state.queued).toBe(0)
    expect(state.waiters).toBe(2)

    await expect(first).resolves.toMatchObject({ uid: 100 })
    await expect(second).resolves.toMatchObject({ uid: 100 })
    // Both callers were served by ONE parse, but each is still a dispatch from
    // the caller's point of view.
    expect(dispatchEvents(events).map(e => e.tags.path)).toEqual(['worker', 'worker'])
  }, 15_000)

  it('does not join two different messages that happen to be the same size', async () => {
    __setEmlWorkerPathForTest(writeFixture('coalesce-distinct.cjs', slowWorkerSource(path.join(fixtureDir, 'coalesce-crumb2.txt'))))
    const a = messageOfSize(EML_WORKER_MIN_BYTES)
    const b = messageOfSize(EML_WORKER_MIN_BYTES)
    b.write('X-Tag: other', 40, 'utf8')

    const first = parseEmlBuffer(101, a)
    await waitFor(() => __emlWorkerStateForTest().active, 'the first parse to start')
    const second = parseEmlBuffer(101, b)

    // Same type, same uid, same length, different bytes. Coalescing on a
    // fingerprint would merge these and hand one caller the other message's
    // parsed content; identity here is byte-exact for that reason.
    const state = __emlWorkerStateForTest()
    expect(state.queued).toBe(1)
    expect(state.waiters).toBe(2)

    await Promise.all([first, second])
  }, 15_000)

  it('keeps the shared parse running when one of the joined callers walks away', async () => {
    __setEmlWorkerPathForTest(writeFixture('coalesce-abort.cjs', slowWorkerSource(path.join(fixtureDir, 'coalesce-crumb3.txt'))))
    const raw = messageOfSize(EML_WORKER_MIN_BYTES)
    const ac = new AbortController()

    const staying = parseEmlBuffer(102, raw)
    await waitFor(() => __emlWorkerStateForTest().active, 'the shared parse to start')
    const leaving = parseEmlBuffer(102, Buffer.from(raw), { signal: ac.signal })
    expect(__emlWorkerStateForTest().waiters).toBe(2)

    ac.abort()
    await expect(leaving).rejects.toMatchObject({ name: 'AbortError' })

    // One caller abandoning a SHARED job must not cancel it for the other —
    // otherwise closing one window would break another window's open.
    expect(__emlWorkerStateForTest().active).toBe(true)
    expect(__emlWorkerStateForTest().waiters).toBe(1)
    await expect(staying).resolves.toMatchObject({ uid: 102 })
  }, 15_000)

  // §2.145 — the body limit joined the coalescing key alongside (type, uid,
  // bytes). "Show full message" is, by construction, a second request for the
  // SAME uid and the SAME raw bytes as the first-tier open that is already in
  // flight — the only thing that differs is `maxBodyBytes`. Before this test's
  // subject landed, `findCoalescible` would have merged the two and answered
  // the click with the very first-tier truncation it exists to escape.
  it('does not join a "show full" request to a same-message parse already in flight at the first tier', async () => {
    __setEmlWorkerPathForTest(writeFixture('coalesce-tier.cjs', slowWorkerSource(path.join(fixtureDir, 'coalesce-crumb4.txt'))))
    const raw = messageOfSize(EML_WORKER_MIN_BYTES)

    const firstTier = parseEmlBuffer(103, raw)
    await waitFor(() => __emlWorkerStateForTest().active, 'the first-tier parse to start')
    // Same uid, same bytes, raised tier — the exact shape of a "show full"
    // click on a message whose first-tier open has not finished yet.
    const raisedTier = parseEmlBuffer(103, Buffer.from(raw), { full: true })

    const state = __emlWorkerStateForTest()
    expect(state.active).toBe(true)
    // A distinct job, not a shared one: joining the second caller as a fourth
    // waiter on the first job would answer it with the first-tier body.
    expect(state.queued).toBe(1)
    expect(state.waiters).toBe(2)

    await Promise.all([firstTier, raisedTier])
  }, 15_000)

  it('DOES join two identical requests for the raised tier — the limit is part of identity, not a reason to skip coalescing entirely', async () => {
    __setEmlWorkerPathForTest(writeFixture('coalesce-tier-same.cjs', slowWorkerSource(path.join(fixtureDir, 'coalesce-crumb5.txt'))))
    const raw = messageOfSize(EML_WORKER_MIN_BYTES)

    const first = parseEmlBuffer(104, raw, { full: true })
    await waitFor(() => __emlWorkerStateForTest().active, 'the shared raised-tier parse to start')
    const second = parseEmlBuffer(104, Buffer.from(raw), { full: true })

    const state = __emlWorkerStateForTest()
    expect(state.active).toBe(true)
    expect(state.queued).toBe(0)
    expect(state.waiters).toBe(2)

    await Promise.all([first, second])
  }, 15_000)

  // codex-bg-review Part B, MEDIUM — the coalescing tests above prove job
  // IDENTITY includes the body limit (two different limits never merge into
  // one job). None of them prove FORWARDING: that the number the worker
  // actually receives on `req.maxBodyBytes` is the one `resolveBodyLimit`
  // (eml.ts) resolved for that request, as opposed to some other value making
  // it across by coincidence. A fake worker that ignores `req.maxBodyBytes`
  // entirely (every fixture above does) would pass every coalescing test
  // unchanged even if the field were dropped on the way into `postMessage`.
  it('forwards the resolved body limit to the worker, distinct for the default and raised tiers', async () => {
    __setEmlWorkerPathForTest(writeFixture('echo-limit.cjs', ECHO_LIMIT_WORKER))

    const defaultTier = await parseEmlBuffer(107, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(defaultTier.text).toBe(`limit:${EML_BODY_SOFT_CAP_BYTES}`)

    const raisedTier = await parseEmlBuffer(108, messageOfSize(EML_WORKER_MIN_BYTES), { full: true })
    expect(raisedTier.text).toBe(`limit:${EML_BODY_FULL_CAP_BYTES}`)
  })
})

describe('§2.124 cancellation', () => {
  it('rejects without starting a worker when the signal is already aborted', async () => {
    __setEmlWorkerPathForTest(writeFixture('marker-aborted.cjs', MARKER_WORKER))
    const ac = new AbortController()
    ac.abort()

    await expect(
      parseEmlBuffer(31, messageOfSize(EML_WORKER_MIN_BYTES), { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(__emlWorkerStateForTest().hasWorker).toBe(false)
  })

  it('stops the running parse and leaves nothing pending when aborted mid-flight', async () => {
    const breadcrumb = path.join(fixtureDir, 'slow-breadcrumb.txt')
    fs.writeFileSync(breadcrumb, '', 'utf8')
    __setEmlWorkerPathForTest(writeFixture('slow.cjs', slowWorkerSource(breadcrumb)))

    const ac = new AbortController()
    const pending = parseEmlBuffer(32, messageOfSize(EML_WORKER_MIN_BYTES), { signal: ac.signal })
    // Let the job reach the worker before abandoning it. Dispatch waits for the
    // readiness announcement, so this is thread-boot latency, not a fixed wait.
    await waitFor(() => __emlWorkerStateForTest().active, 'the parse to reach the worker')

    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const state = __emlWorkerStateForTest()
    expect(state.active).toBe(false)
    expect(state.queued).toBe(0)
    expect(state.hasWorker).toBe(false)

    // The abandoned parse must not still be running: the fixture would have
    // written its breadcrumb 3 s in.
    await new Promise(resolve => setTimeout(resolve, 3200))
    expect(fs.readFileSync(breadcrumb, 'utf8')).toBe('')
  }, 15_000)

  it('drops a queued job on abort and still serves the rest', async () => {
    __setEmlWorkerPathForTest(writeFixture('marker-queue.cjs', MARKER_WORKER))
    const ac = new AbortController()

    const first = parseEmlBuffer(33, messageOfSize(EML_WORKER_MIN_BYTES))
    const second = parseEmlBuffer(34, messageOfSize(EML_WORKER_MIN_BYTES), { signal: ac.signal })
    const third = parseEmlBuffer(35, messageOfSize(EML_WORKER_MIN_BYTES))
    ac.abort()

    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await expect(first).resolves.toMatchObject({ uid: 33 })
    await expect(third).resolves.toMatchObject({ uid: 35 })
    expect(__emlWorkerStateForTest().queued).toBe(0)
  })

  it('re-dispatches queued work to a fresh worker after the active job is aborted', async () => {
    __setEmlWorkerPathForTest(writeFixture('marker-redispatch.cjs', MARKER_WORKER))
    const ac = new AbortController()

    const aborted = parseEmlBuffer(36, messageOfSize(EML_WORKER_MIN_BYTES), { signal: ac.signal })
    const queued = parseEmlBuffer(37, messageOfSize(EML_WORKER_MIN_BYTES))
    ac.abort()

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await expect(queued).resolves.toMatchObject({ uid: 37 })
  })
})

/**
 * §2.124 telemetry. The failure this covers is the one nothing else can see:
 * the client falls back to the inline parse when the worker cannot start, so a
 * missing build chunk leaves the app fully working and ~10× slower, with no
 * crash, no error and no watchdog line (the UiFreeze detector measures the
 * worst SINGLE event-loop gap, and this failure mode is thousands of
 * microsecond yields — a 27 s inline parse was measured NOT to trip it).
 */
describe('§2.124 dispatch telemetry', () => {
  it('counts an ordinary small message as the healthy below-threshold path', async () => {
    __setEmlWorkerPathForTest(writeFixture('tele-small.cjs', MARKER_WORKER))
    const events = captureNetEvents()

    await parseEmlBuffer(40, messageOfSize(2_000))

    expect(dispatchEvents(events)).toEqual([
      { name: 'eml.parse_dispatch', tags: { path: 'inline_below_threshold', size_bucket: '1-10KB' } },
    ])
    // Small messages must never make an unavailable worker look like an
    // incident — the worker is not consulted at all below the threshold.
    expect(unavailableEvents(events)).toEqual([])
    expect(emlParseDispatchCounts().inline_below_threshold).toBe(1)
  })

  it('counts an offloaded parse as the worker path, with the size band', async () => {
    __setEmlWorkerPathForTest(writeFixture('tele-worker.cjs', MARKER_WORKER))
    const events = captureNetEvents()

    const details = await parseEmlBuffer(41, messageOfSize(EML_WORKER_MIN_BYTES))

    expect(details.envelope?.subject).toBe('FROM_WORKER')
    expect(dispatchEvents(events)).toEqual([
      { name: 'eml.parse_dispatch', tags: { path: 'worker', size_bucket: '10-100KB' } },
    ])
    expect(emlParseDispatchCounts().worker).toBe(1)
  })

  it('counts the calendar scan on the same vocabulary', async () => {
    __setEmlWorkerPathForTest(writeFixture('tele-ics.cjs', MARKER_WORKER))
    const events = captureNetEvents()

    await extractIcsFromRawEml(messageOfSize(EML_WORKER_MIN_BYTES))

    expect(dispatchEvents(events).map(e => e.tags.path)).toEqual(['worker'])
  })

  it('separates "inline because the worker is missing" from "inline because it is small"', async () => {
    // The build/packaging failure mode: no worker chunk next to the bundle.
    __setEmlWorkerPathForTest(null)
    const events = captureNetEvents()

    await parseEmlBuffer(42, messageOfSize(EML_WORKER_MIN_BYTES * 2))

    expect(dispatchEvents(events)).toEqual([
      { name: 'eml.parse_dispatch', tags: { path: 'inline_unavailable', size_bucket: '100KB-1MB' } },
    ])
    expect(unavailableEvents(events)).toEqual([
      { name: 'eml.parse_worker_unavailable', tags: { reason: 'script_missing' } },
    ])
  })

  it('reports the missing-worker transition once, not once per message', async () => {
    __setEmlWorkerPathForTest(null)
    const events = captureNetEvents()

    for (const uid of [43, 44, 45]) {
      await parseEmlBuffer(uid, messageOfSize(EML_WORKER_MIN_BYTES))
    }

    // The ongoing cost is what the dispatch counter carries; the transition is
    // a single event, or it drowns in the volume it causes.
    expect(dispatchEvents(events)).toHaveLength(3)
    expect(unavailableEvents(events)).toHaveLength(1)
    expect(emlParseDispatchCounts().inline_unavailable).toBe(3)
  })

  it('reports a worker that never starts once, Sentry side included', async () => {
    __setEmlWorkerPathForTest(writeFixture('tele-unloadable.cjs', 'throw new Error("boom at load")\n'))
    const events = captureNetEvents()
    const errors: Array<{ source: string; context?: Record<string, unknown> }> = []
    setNetErrorReporter((source, _err, context) => { errors.push({ source, context }) })

    await parseEmlBuffer(46, messageOfSize(EML_WORKER_MIN_BYTES))
    await parseEmlBuffer(47, messageOfSize(EML_WORKER_MIN_BYTES))

    expect(unavailableEvents(events)).toEqual([
      { name: 'eml.parse_worker_unavailable', tags: { reason: 'startup_failed' } },
    ])
    // The reason has to survive the main-side sanitiser's context allowlist,
    // or the Sentry alert says only that "something about the worker failed".
    expect(errors).toEqual([
      { source: 'eml.parse.worker', context: { exit_reason: 'startup_failed' } },
    ])
    expect(dispatchEvents(events).map(e => e.tags.path)).toEqual([
      'inline_unavailable',
      'inline_unavailable',
    ])
  })

  it('reports the transition once when several messages are already in flight', async () => {
    // The queue is the case a sequential spec cannot reach: the first job
    // trips the failure, and every job already queued behind it then finds a
    // client that refuses to spawn. Each of those refusals passes through the
    // same reporting path, so without the latch one broken build produces an
    // event per queued message — and the later ones would carry 'spawn_failed'
    // instead of the reason that actually happened.
    const loads = path.join(fixtureDir, 'tele-queue-loads.txt')
    fs.writeFileSync(loads, '', 'utf8')
    __setEmlWorkerPathForTest(writeFixture(
      'tele-unloadable-queue.cjs',
      `require('node:fs').appendFileSync(${JSON.stringify(loads)}, 'load\\n')\nthrow new Error("boom at load")\n`,
    ))
    const events = captureNetEvents()
    const errors: Array<{ source: string; context?: Record<string, unknown> }> = []
    setNetErrorReporter((source, _err, context) => { errors.push({ source, context }) })

    await Promise.all([
      parseEmlBuffer(54, messageOfSize(EML_WORKER_MIN_BYTES)),
      parseEmlBuffer(55, messageOfSize(EML_WORKER_MIN_BYTES)),
      parseEmlBuffer(56, messageOfSize(EML_WORKER_MIN_BYTES)),
    ])

    expect(unavailableEvents(events)).toEqual([
      { name: 'eml.parse_worker_unavailable', tags: { reason: 'startup_failed' } },
    ])
    expect(errors).toEqual([
      { source: 'eml.parse.worker', context: { exit_reason: 'startup_failed' } },
    ])
    expect(__emlWorkerStateForTest().unavailableReason).toBe('startup_failed')
    expect(dispatchEvents(events)).toHaveLength(3)
    // And the stranded jobs do not each pay for a doomed spawn: one attempt
    // proved the worker cannot start here, which is what "offload stays off
    // for the rest of the session" has to mean for work already queued.
    expect(fs.readFileSync(loads, 'utf8')).toBe('load\n')
  })

  it('counts a message that kills a proven worker as a failure, not as unavailability', async () => {
    __setEmlWorkerPathForTest(writeFixture('tele-crash-second.cjs', CRASH_ON_SECOND_WORKER))
    const events = captureNetEvents()

    await parseEmlBuffer(48, messageOfSize(EML_WORKER_MIN_BYTES))
    await expect(parseEmlBuffer(49, messageOfSize(EML_WORKER_MIN_BYTES))).rejects.toThrow()

    expect(dispatchEvents(events).map(e => e.tags.path)).toEqual(['worker', 'worker_failed'])
    // The feature is intact — one message died, not the worker mechanism.
    expect(unavailableEvents(events)).toEqual([])
    expect(__emlWorkerStateForTest().unavailable).toBe(false)
  })

  it('counts a degraded calendar scan as a worker failure rather than a silent success', async () => {
    __setEmlWorkerPathForTest(writeFixture('tele-failing-ics.cjs', FAILING_WORKER))
    const events = captureNetEvents()

    await expect(extractIcsFromRawEml(messageOfSize(EML_WORKER_MIN_BYTES))).resolves.toBeUndefined()

    expect(dispatchEvents(events).map(e => e.tags.path)).toEqual(['worker_failed'])
  })

  it('does not count an abandoned open as a parse failure', async () => {
    __setEmlWorkerPathForTest(writeFixture('tele-abort.cjs', MARKER_WORKER))
    const events = captureNetEvents()
    const ac = new AbortController()
    ac.abort()

    await expect(
      parseEmlBuffer(50, messageOfSize(EML_WORKER_MIN_BYTES), { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(dispatchEvents(events).map(e => e.tags.path)).toEqual(['worker_aborted'])
    expect(emlParseDispatchCounts().worker_failed).toBe(0)
  })

  it('cannot break the parse when the telemetry sink throws', async () => {
    __setEmlWorkerPathForTest(writeFixture('tele-throwing.cjs', MARKER_WORKER))
    setNetEventReporter(() => { throw new Error('sink is on fire') })
    setNetErrorReporter(() => { throw new Error('error sink is on fire too') })

    const offloaded = await parseEmlBuffer(51, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(offloaded.envelope?.subject).toBe('FROM_WORKER')

    const inline = await parseEmlBuffer(52, messageOfSize(2_000))
    expect(inline.envelope?.subject).toBe('Size fixture')

    // ...including on the path that reports the unavailable transition, which
    // fires from inside the dispatch decision itself.
    __setEmlWorkerPathForTest(null)
    const fallback = await parseEmlBuffer(53, messageOfSize(EML_WORKER_MIN_BYTES))
    expect(fallback.envelope?.subject).toBe('Size fixture')

    // The in-process counters survive a broken sink — they are what an e2e
    // gate keys on to prove the worker really ran.
    expect(emlParseDispatchCounts().worker).toBe(1)
    expect(emlParseDispatchCounts().inline_below_threshold).toBe(1)
    expect(emlParseDispatchCounts().inline_unavailable).toBe(1)
  })

  it('plans below-threshold work without consulting the worker at all', () => {
    __setEmlWorkerPathForTest(null)

    expect(planEmlParseDispatch({ length: EML_WORKER_MIN_BYTES - 1 })).toEqual({
      path: 'inline_below_threshold',
    })
    // Deciding for a small message must not latch the unavailable state, or
    // the first small message of the session would mask a later real one.
    expect(__emlWorkerStateForTest().unavailableReason).toBeNull()

    expect(planEmlParseDispatch({ length: EML_WORKER_MIN_BYTES })).toEqual({
      path: 'inline_unavailable',
      reason: 'script_missing',
    })
  })
})

describe('§2.124 telemetry schema agreement', () => {
  it('emits only paths the schema declares', () => {
    const emitted = Object.keys(emlParseDispatchCounts()) as EmlParsePath[]
    expect([...emitted].sort()).toEqual([...DOMAINS.eml_parse_path].sort())
  })

  it('emits only size bands the schema declares', () => {
    const sizes = [0, 1, 1023, 1024, 9_999, 10 * 1024, EML_WORKER_MIN_BYTES, 999_999, 5 * 1024 * 1024]
    const bands = new Set(sizes.map(bucketBodySize))
    for (const band of bands) {
      expect(DOMAINS.eml_size_bucket as readonly string[]).toContain(band)
    }
  })

  it('keeps the dispatch counter un-aggregated and main-only', () => {
    const def = METRIC_EVENTS['eml.parse_dispatch'] as { aggregate?: boolean; mainOnly?: boolean }
    // Aggregation buffers for 10 s and emits nothing at all while the consent
    // gate is closed — which would remove the local `Metrics` log line in
    // exactly the situations where it is the only evidence (fresh profile,
    // e2e run, a user who declined telemetry).
    expect(def.aggregate).not.toBe(true)
    // Emitted from packages/net through a main-only seam: a renderer must not
    // be able to fabricate evidence that off-thread parsing is healthy.
    expect(def.mainOnly).toBe(true)
  })
})
