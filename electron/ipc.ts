// Single-module IPC boundary for the main process.
//
// This is the ONLY file in the project that imports `ipcMain` from 'electron'.
// Every other file in `electron/` (and anywhere else) calls `handleIpc(...)`
// from here, which internally owns the single `ipcMain.handle(...)` call site
// plus the inflight-IPC tracking, slow-IPC logging, and error funnel.
//
// Architectural rationale (BACKLOG.md §2.13):
//
//   When `ipcMain` is not in scope anywhere except this module, every
//   previously-documented bypass (`import { ipcMain as main }`,
//   `const { handle } = ipcMain`, `Reflect.get(ipcMain, 'handle')`,
//   namespace/default-imports of 'electron', `electron.ipcMain.handle(...)`)
//   becomes structurally impossible. Reintroducing any of those requires
//   adding `import { ipcMain } from 'electron'` to another file — which
//   ESLint's `no-restricted-imports` blocks project-wide and which any
//   reviewer would catch as a single-line red flag.
//
// The ESLint `no-restricted-imports` override whitelists this file as the
// sole legitimate import site. The `no-restricted-syntax` selector for
// `ipcMain.handle` applies inside this module as a defense-in-depth guard
// against someone adding a second raw call site alongside the wrapper — so
// the only eslint-disable annotation for that rule lives below, on the one
// line where the wrapper actually calls through.

// This is the sole legitimate `ipcMain` import in the project. The
// `no-restricted-imports` ban is inverted in .eslintrc.cjs's override for
// this file; no eslint-disable comment is needed.
import { ipcMain } from 'electron'
import * as perfHooks from 'node:perf_hooks'
import { createLogger } from './logger'
import { reportIpcHandlerError } from './sentry'
import { recordEvent, recordHistogram, recordGauge, bucketDuration } from './metrics'
import { METRIC_EVENTS, DOMAINS, type MetricKind, type TagSpec, type DomainName } from './metricsSchema'
import { markFeatureReachFromEvent } from './featureReach'
import { describeErrorForLog, presentedIpcMessage } from '@mailcopilot/core/errorPresentation'

const logIpc = createLogger('IPC')
const logUiFreeze = createLogger('UiFreeze')
const logTelemetry = createLogger('Telemetry')

// Channels expected to be long-running — excluded from slow-IPC warnings.
// Network-bound IMAP/SMTP channels are inherently I/O-heavy and don't block
// the main process event loop; flagging them as "slow" only adds noise.
const SLOW_IPC_EXCLUDE = new Set<string>([
  'ai:chat',
  'ai:quickAction',
  'oauth:google:connect',
  'net:testImap',
  'net:testSmtp',
  'net:syncFolderHeaders',
  'net:inboxSummaries',
  'net:folderPage',
  'net:mailboxesAndRoles',
  'net:idleStart',
  'net:idleStop',
  'net:messageDetails',
  'net:sendMail',
  'net:saveDraft',
  'net:deleteDraft',
  'net:move',
  'net:delete',
  'net:saveAttachment',
  'net:attachmentBase64',
  'net:fetchExternalImage',
  // §2.22 fix iter2A — RSVP delivery is SMTP-bound (typical 200-2000ms);
  // not a slow-IPC anomaly.
  'mail:rsvpInvite',
  'offline:syncNow',
  'rules:applyToFolder',
  'search:remoteSearch',
  // The freeze reporter itself is registered via handleIpc (so IPC errors
  // surface in logs), which means it ends up in inflightIpc while running.
  // Excluding it here prevents a slow freeze-report from triggering a
  // slow-IPC warning, which would itself be pure noise.
  'log:uiFreeze',
])
const SLOW_IPC_THRESHOLD_MS = 500
const inflightIpc = new Map<number, { channel: string; start: number }>()
let ipcSeq = 0

/**
 * Re-throwable copy of a handler failure carrying a presentation key.
 *
 * Measured on Electron 40 (real main+preload+renderer round trip): a rejected
 * `ipcMain.handle` reaches the renderer as a brand-new plain `Error` whose only
 * own properties are `message` and `stack`. `.errors[]`, `.code`, `.cause` and
 * any custom own property set here are dropped by the serializer — the message
 * text is the ONLY carrier that survives. That is why the classification has to
 * happen here, in the process that still holds the real error object, and why
 * the verdict rides inside the message.
 *
 * BACKLOG §2.127: without this the renderer rendered `String(e)` of an
 * AggregateError, whose `message` is empty by construction, and the user read
 * "Sync error: Error: Error invoking remote method 'net:inboxSummaries':
 * AggregateError".
 *
 * The key is computed from the error OBJECT first (codes,
 * `authenticationFailed`, the AggregateError tree), with two short text
 * patterns as a fallback for servers that only say it in prose — see
 * `classifyErrorPresentation`. Either way the verdict is reached HERE, in main,
 * once; the renderer never re-derives one from text, which is the arms race
 * this format exists to end. The original text is kept after the tag for
 * DevTools; the UI reads the tag and renders a fixed sentence from a closed
 * vocabulary, so untrusted server text never reaches the screen.
 *
 * The original text after the tag is LOAD-BEARING, not a courtesy: two renderer
 * consumers already substring-match it and would break silently if a future
 * cleanup dropped it —
 *   - src/hooks/useCertRecovery.ts (`cert_trust_*` rejection codes → inline
 *     dialog errors),
 *   - src/sentry.ts beforeSend (isTransientNetworkError over the wrapped
 *     message, which keeps update:* network noise out of Sentry).
 * Both match by substring, so prepending the tag is safe; removing the text is
 * not. What must NOT happen is the UI rendering that text — the renderer picks
 * a sentence by key (packages/core/errorPresentation.ts).
 *
 * Retry/rollback behaviour is untouched: nothing in the main process consumes
 * this rejection — `ipcMain.handle`'s reply path is its only consumer — and
 * Sentry still receives the ORIGINAL error object (see below), so transient
 * filtering keeps working on the real tree.
 *
 * Never throws: if anything about the error is hostile, the original value is
 * re-thrown unchanged.
 */
function toPresentedIpcError(err: unknown): unknown {
  try {
    const presented = new Error(presentedIpcMessage(err))
    // `cause` is assigned rather than passed to the constructor: tsconfig
    // targets ES2020, where the two-argument Error constructor is not typed.
    // It is main-process-only diagnostics anyway — the IPC serializer drops it.
    if (err != null) (presented as { cause?: unknown }).cause = err
    return presented
  } catch {
    return err
  }
}

/**
 * Wrap `ipcMain.handle` with:
 *   - inflight-IPC tracking (so freeze reporters can show what's stuck);
 *   - slow-IPC warnings + `ipc.slow_ms` histogram for channels that finish
 *     above `SLOW_IPC_THRESHOLD_MS` and aren't on the long-running allowlist;
 *   - a uniform error funnel that logs via electron-log, reports a PII-free
 *     synthetic event to Sentry, and re-throws so the call still REJECTS for
 *     the renderer.
 *
 * What is re-thrown is NOT the original value: since §2.127 it is a substitute
 * `Error` built by `toPresentedIpcError`, whose message is the original text
 * with a `[mcerr:<key>]` tag prepended (the original is kept on `.cause`, which
 * the IPC serializer drops anyway). Callers that inspect the rejection are
 * therefore looking at a NEW object with a CHANGED message — the two renderer
 * consumers that substring-match that message are listed on
 * `toPresentedIpcError`, and anything added later must read the tag rather than
 * assume the text is verbatim. Only the fact of rejection is unchanged.
 *
 * Every IPC handler in the main process MUST go through this wrapper. Raw
 * `ipcMain.handle(...)` is banned by ESLint project-wide; the only exception
 * is the one call site below, annotated for defense-in-depth.
 */
export function handleIpc(channel: string, handler: Parameters<typeof ipcMain.handle>[1]) {
  // eslint-disable-next-line no-restricted-syntax -- handleIpc is the wrapper itself
  ipcMain.handle(channel, async (event, ...args) => {
    const id = ++ipcSeq
    const start = Date.now()
    inflightIpc.set(id, { channel, start })
    try {
      return await handler(event, ...args)
    } catch (err) {
      // describeErrorForLog, not `err.message`: an AggregateError's message is
      // the empty string, so the four §2.127 incidents left log lines with no
      // cause in them at all. The flattened tree (messages + codes of every
      // node) is the diagnostic record — local log only, never Sentry.
      logIpc.error(`[${channel}]`, describeErrorForLog(err))
      // electron-log has NO Sentry bridge (CLAUDE.md §8), so before this the
      // entire IPC surface — every handler in the app — was invisible in error
      // monitoring. reportIpcHandlerError sends a PII-free synthetic event
      // (channel + instanceof-derived error class only; never the raw error,
      // whose message routinely carries bodies, addresses, queries and paths)
      // and drops transient network noise at the source. It never throws; the
      // extra guard here is belt-and-braces so telemetry can never convert a
      // handled rejection into an unhandled one.
      try { reportIpcHandlerError(channel, err) } catch { /* telemetry must never throw */ }
      // Re-throw so the renderer still receives the rejection — now tagged with
      // a closed-vocabulary presentation key (see toPresentedIpcError).
      throw toPresentedIpcError(err)
    } finally {
      const dur = Date.now() - start
      inflightIpc.delete(id)
      if (dur >= SLOW_IPC_THRESHOLD_MS && !SLOW_IPC_EXCLUDE.has(channel)) {
        logIpc.warn(`slow [${channel}] ${dur}ms`)
        recordHistogram('ipc.slow_ms', dur, {
          channel,
          duration_bucket: bucketDuration(dur),
        })
      }
    }
  })
}

/**
 * Telemetry bridge: renderer-side metrics arrive here as fire-and-forget
 * `ipc.send('metrics:record', ...)` messages. We validate the payload
 * against METRIC_EVENTS before forwarding to the typed
 * recordEvent/recordHistogram/recordGauge pipeline — a compromised renderer
 * can never smuggle an unknown event or a tag outside the registered set.
 *
 * This uses `ipcMain.on` (not `ipcMain.handle`) because metrics are
 * fire-and-forget: the renderer does not wait for a reply.
 */
export function registerMetricsRecordHandler(): void {
  ipcMain.on('metrics:record', (_event, payload: unknown) => {
    try {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { name?: unknown; kind?: unknown; value?: unknown; tags?: unknown }
      if (typeof p.name !== 'string' || typeof p.kind !== 'string') return
      const def = (METRIC_EVENTS as Record<string, {
        kind: MetricKind
        tags: Record<string, TagSpec>
        mainOnly?: boolean
      }>)[p.name]
      if (!def) {
        logTelemetry.warn(`rejecting unknown metric: ${p.name}`)
        return
      }
      if (def.kind !== p.kind) {
        logTelemetry.warn(`metric kind mismatch: ${p.name} renderer=${p.kind} schema=${def.kind}`)
        return
      }
      // §2.19 iter4 — `mainOnly: true` events MUST NOT be accepted from
      // the renderer. These events (`update.*`) are emitted exclusively by
      // main-process autoUpdater listeners, where we control the source of
      // every tag value (bucketed via classifyUpdateError). A compromised
      // renderer could otherwise emit `update.download_failed` with a
      // raw `error_class` string and smuggle PII (paths, version strings,
      // server hostnames) into Sentry through the metrics sink.
      if (def.mainOnly === true) {
        logTelemetry.warn(`rejecting main-only metric from renderer: ${p.name}`)
        return
      }
      // Strip tag keys that aren't in the schema. This is defence-in-depth:
      // compile-time types already prevent this, but a compromised renderer
      // could bypass TS.
      const allowedTagKeys = new Set(Object.keys(def.tags))
      const tags: Record<string, string | number | boolean> = {}
      if (p.tags && typeof p.tags === 'object') {
        for (const [k, v] of Object.entries(p.tags as Record<string, unknown>)) {
          if (!allowedTagKeys.has(k)) continue
          if (v === undefined) continue
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            // §2.19 iter4 — when the schema declares an enum domain for this
            // tag (e.g. `source: 'update_check_source'`), reject any value
            // not in the enum. Defense in depth: even if a future event is
            // added that the renderer is allowed to emit but whose tag is
            // a low-cardinality enum, we won't accept arbitrary strings.
            const spec = def.tags[k]
            if (typeof spec === 'string' && spec !== 'string' && spec !== 'number' && spec !== 'boolean') {
              const domain = (DOMAINS as Record<string, readonly (string | number | boolean)[]>)[spec as DomainName]
              if (domain && !domain.includes(v)) {
                logTelemetry.warn(`rejecting out-of-domain tag value: ${p.name}.${k}=${String(v)} (domain=${spec})`)
                continue
              }
            }
            tags[k] = v
          }
        }
      }
      // Mark feature reach on the renderer path explicitly. The typed
      // recordEvent/recordHistogram in metrics.ts already do this for
      // main-side call sites; the IPC bridge uses the same hook here.
      markFeatureReachFromEvent(p.name)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const typedName = p.name as any
      if (p.kind === 'event') {
        recordEvent(typedName, tags)
      } else if (p.kind === 'histogram') {
        const value = typeof p.value === 'number' ? p.value : 0
        recordHistogram(typedName, value, tags)
      } else if (p.kind === 'gauge') {
        const value = typeof p.value === 'number' ? p.value : 0
        recordGauge(typedName, value, tags)
      }
    } catch (err) {
      logTelemetry.warn('metrics:record handler failed', err instanceof Error ? err.message : err)
    }
  })
}

/**
 * Register the `log:uiFreeze` IPC handler. The renderer reports JS event-loop
 * lag here; we log it with a snapshot of currently-inflight IPC channels so
 * hangs can be correlated with background main-process work.
 *
 * Colocated with `inflightIpc` because the handler reads the map directly
 * (and the map is module-internal).
 */
export function registerUiFreezeHandler(): void {
  handleIpc('log:uiFreeze', (_event, info: unknown) => {
    const { lagMs, deltaMs, at, startup } = (info ?? {}) as {
      lagMs?: number
      deltaMs?: number
      at?: string
      startup?: boolean
    }
    if (startup) {
      logUiFreeze.info(`renderer freeze detector active (at=${at ?? '?'})`)
      return
    }
    const now = Date.now()
    // Exclude the freeze reporter itself from the snapshot — handleIpc inserts
    // the current channel into inflightIpc before invoking the handler, so
    // without this filter every freeze report would list itself and inflate
    // inflight_count by 1.
    const others = Array.from(inflightIpc.values()).filter((x) => x.channel !== 'log:uiFreeze')
    const inflight = others
      .map((x) => `${x.channel}(${now - x.start}ms)`)
      .slice(0, 10)
    logUiFreeze.warn(
      `UI(renderer) blocked ~${lagMs ?? '?'}ms (delta=${deltaMs ?? '?'}ms at=${at ?? '?'}) inflight-ipc=[${inflight.join(', ')}]`,
    )
    // Metrics: bucket lag so dashboards stay low-cardinality.
    // `oldest_inflight` is context, NOT attribution (§2.156): a handler can be
    // oldest because it is waiting on the network, which costs the event loop
    // nothing. It was named `top_inflight` and read as "the culprit"; it never
    // was one.
    const oldestInflight = others.length > 0
      ? [...others].sort((a, b) => a.start - b.start)[0]!.channel
      : 'none'
    recordHistogram('ui.freeze.renderer_ms', lagMs ?? 0, {
      duration_bucket: bucketDuration(lagMs ?? 0),
      inflight_count: others.length,
      oldest_inflight: oldestInflight,
    })
  })
}

/**
 * Main-process event loop watchdog. `monitorEventLoopDelay()` runs in libuv
 * and records the gap between scheduled and actual timer firings. We poll it
 * every second and warn whenever the max delay since last poll crosses the
 * threshold.
 *
 * This catches synchronous main-thread blocking (better-sqlite3, sync FS,
 * JSON parsing of huge payloads) that otherwise wouldn't show up in slow-IPC
 * logs because the offending code path may not be inside a handleIpc handler.
 *
 * ── Attribution (§2.156) ─────────────────────────────────────────────────
 * The inflight-IPC snapshot is CONTEXT, not a culprit. A handler that is
 * awaiting the network, or delegating to the search worker thread, occupies no
 * event-loop time whatsoever — yet it is exactly the kind of handler that ends
 * up "oldest", which is how the field log came to blame `net:setSeen` for 67 s
 * and `search:coverageStats` (worker-bound) for 3 s while 216 of 229 stalls
 * stayed unattributed.
 *
 * Real attribution comes from `drainSlowSql`: better-sqlite3 is synchronous, so
 * a slow statement IS a blocked loop. Two rules make the attribution honest,
 * and both are load-bearing:
 *
 *  - drain on EVERY poll, not only on a freeze — otherwise a statement from a
 *    quiet window is carried forward and blamed for the next, unrelated stall;
 *  - keep only samples whose completion falls inside the window the delay was
 *    measured over. The buffer is filled by packages/db, which instruments
 *    itself when the database opens — that is BEFORE this watchdog starts, so
 *    the first poll would otherwise inherit the schema migrations and hand
 *    them to whatever froze afterwards. Older samples are not silently
 *    dropped: they are logged once, on their own line, attributed to nothing.
 *
 * No statement text reaches this file, in any form: a sample carries a
 * "<verb> <table>" digest and an 8-hex fingerprint of the statement, and
 * packages/db/sqlTiming.ts drops the text after hashing it. `sql=a3f19c2b` in a
 * log line is resolved with `node scripts/sql-fingerprint.mjs a3f19c2b`.
 *
 * Colocated with the renderer-freeze handler because both read `inflightIpc`.
 */
export type SlowSqlSampleForFreeze = { digest: string; fingerprint: string; durationMs: number; at: number }
export type SlowSqlProbe = () => SlowSqlSampleForFreeze[]

export function startMainLoopFreezeWatchdog(options?: { drainSlowSql?: SlowSqlProbe }): void {
  const histogram = perfHooks.monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  const FREEZE_THRESHOLD_MS = 200
  const drainSlowSql = options?.drainSlowSql
  // Start of the window the next poll will report on. Everything the buffer
  // already holds at this point belongs to startup, not to any freeze this
  // watchdog will observe.
  let windowStart = Date.now()
  setInterval(() => {
    const maxNs = histogram.max
    histogram.reset()
    const polledAt = Date.now()
    let drained: SlowSqlSampleForFreeze[] = []
    if (drainSlowSql) {
      try { drained = drainSlowSql() } catch { drained = [] }
    }
    const slowSql = drained.filter((s) => s.at >= windowStart)
    const beforeWindow = drained.filter((s) => s.at < windowStart)
    if (beforeWindow.length > 0) {
      // Reported, but never attributed: these ran before the watchdog existed.
      logUiFreeze.info(
        `slow SQL from before the watchdog started (not attributed to any freeze): [${
          beforeWindow.slice(0, 3).map((s) => `${s.durationMs}ms ${s.digest} sql=${s.fingerprint}`).join(' | ')
        }]`,
      )
    }
    windowStart = polledAt
    if (!Number.isFinite(maxNs) || maxNs <= 0) return
    const maxMs = Math.round(maxNs / 1e6)
    if (maxMs >= FREEZE_THRESHOLD_MS) {
      const now = Date.now()
      const inflight = Array.from(inflightIpc.values())
        .map((x) => `${x.channel}(${now - x.start}ms)`)
        .slice(0, 10)
      const sqlForLog = slowSql
        .slice(0, 3)
        .map((s) => `${s.durationMs}ms ${s.digest} sql=${s.fingerprint}`)
      logUiFreeze.warn(
        `Main blocked ~${maxMs}ms (event loop max delay) slow-sql=[${sqlForLog.join(' | ')}] inflight-ipc=[${inflight.join(', ')}]`,
      )
      const oldestInflight = inflightIpc.size > 0
        ? Array.from(inflightIpc.values()).sort((a, b) => a.start - b.start)[0]!.channel
        : 'none'
      const worst = slowSql[0]
      recordHistogram('ui.freeze.main_ms', maxMs, {
        duration_bucket: bucketDuration(maxMs),
        inflight_count: inflightIpc.size,
        oldest_inflight: oldestInflight,
        top_sql: worst ? worst.digest : 'none',
        sql_ms: worst ? worst.durationMs : 0,
      })
    }
  }, 1000).unref()
}
