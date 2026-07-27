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
import { recordEvent, recordHistogram, recordGauge, bucketDuration } from './metrics'
import { METRIC_EVENTS, DOMAINS, type MetricKind, type TagSpec, type DomainName } from './metricsSchema'
import { markFeatureReachFromEvent } from './featureReach'

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
 * Wrap `ipcMain.handle` with:
 *   - inflight-IPC tracking (so freeze reporters can show what's stuck);
 *   - slow-IPC warnings + `ipc.slow_ms` histogram for channels that finish
 *     above `SLOW_IPC_THRESHOLD_MS` and aren't on the long-running allowlist;
 *   - a uniform error funnel that logs via electron-log and re-throws so the
 *     renderer still sees the rejection.
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
      logIpc.error(`[${channel}]`, err instanceof Error ? err.message : err)
      throw err // re-throw so the renderer receives the error
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
    // Attribute the freeze to the OLDEST-inflight channel — that's the one most
    // likely to be the source of the block, not the most recently started one.
    const topInflight = others.length > 0
      ? [...others].sort((a, b) => a.start - b.start)[0]!.channel
      : 'none'
    recordHistogram('ui.freeze.renderer_ms', lagMs ?? 0, {
      duration_bucket: bucketDuration(lagMs ?? 0),
      inflight_count: others.length,
      top_inflight: topInflight,
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
 * Colocated with the renderer-freeze handler because both read `inflightIpc`
 * directly to attribute the stall to the oldest-inflight channel.
 */
export function startMainLoopFreezeWatchdog(): void {
  const histogram = perfHooks.monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  const FREEZE_THRESHOLD_MS = 200
  setInterval(() => {
    const maxNs = histogram.max
    histogram.reset()
    if (!Number.isFinite(maxNs) || maxNs <= 0) return
    const maxMs = Math.round(maxNs / 1e6)
    if (maxMs >= FREEZE_THRESHOLD_MS) {
      const now = Date.now()
      const inflight = Array.from(inflightIpc.values())
        .map((x) => `${x.channel}(${now - x.start}ms)`)
        .slice(0, 10)
      logUiFreeze.warn(
        `Main blocked ~${maxMs}ms (event loop max delay) inflight-ipc=[${inflight.join(', ')}]`,
      )
      // Oldest-inflight = most likely culprit of the block (longest-running).
      const topInflight = inflightIpc.size > 0
        ? Array.from(inflightIpc.values()).sort((a, b) => a.start - b.start)[0]!.channel
        : 'none'
      recordHistogram('ui.freeze.main_ms', maxMs, {
        duration_bucket: bucketDuration(maxMs),
        inflight_count: inflightIpc.size,
        top_inflight: topInflight,
      })
    }
  }, 1000).unref()
}
