import { createLogger } from '../logger'
import { captureException } from '../sentry'
import {
  getOfflineOps,
  deleteOfflineOp,
  deleteOfflineOpsForFolder,
  incrementOfflineOpRetry,
  deletePoisonOfflineOps,
  removeTempPlaceholders,
  type OfflineOp,
} from '../../packages/db'
import {
  setSeen,
  setFlagged,
  moveMessages,
  deleteMessagesRemote,
  getMailboxStatus,
} from '../../packages/net/imap'
// From the leaf module rather than the `imap` barrel on purpose: this is a
// scheduling scope with no IMAP dependency of its own, and specs that stub the
// IMAP surface (offlineReplay.test.ts does) should not have to stub it too —
// a stubbed-away scope would silently drop the tier the replay path sets.
import { withImapPriority } from '../../packages/net/imapScheduler'
import type { ImapConfig } from '../../packages/net/types'
import { startMetricSpan } from '../metrics'
import { bucketOpsCount, bucketCount } from '../metricsBuckets'

const log = createLogger('OfflineReplay')

// --- captureException dedup gate ---
//
// replayOfflineOps runs on every reconnect / replay cycle. If a systemic op
// keeps failing (e.g. server rejects every move for a folder), raw
// captureException would emit on every batch in every replay cycle. We gate
// by error signature + cooldown so the SAME repeating bug emits at most once
// per CAPTURE_COOLDOWN_MS, while a NEW failure mode still gets captured
// immediately. log.error remains unguarded so local diagnostics see every
// occurrence. Map size is bounded to CAPTURE_KEY_LIMIT (insertion-order LRU).
const CAPTURE_COOLDOWN_MS = 5 * 60 * 1000
const CAPTURE_KEY_LIMIT = 50
const captureLastSeen = new Map<string, number>()

export function captureOnce(
  key: string,
  err: unknown,
  context: Record<string, unknown>,
  cooldownMs: number = CAPTURE_COOLDOWN_MS,
): void {
  const now = Date.now()
  const last = captureLastSeen.get(key)
  if (last !== undefined && now - last < cooldownMs) return
  captureLastSeen.delete(key)
  captureLastSeen.set(key, now)
  if (captureLastSeen.size > CAPTURE_KEY_LIMIT) {
    const oldest = captureLastSeen.keys().next().value
    if (oldest !== undefined) captureLastSeen.delete(oldest)
  }
  try {
    captureException(err, context)
  } catch {
    /* telemetry must not throw */
  }
}

function errorKey(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}:${(err.message ?? '').slice(0, 100)}`
  }
  return `Unknown:${String(err).slice(0, 100)}`
}

/** Reset capture dedup state (for testing). */
export function resetOfflineReplayCaptureGate(): void {
  captureLastSeen.clear()
}

// Safe wrapper around startMetricSpan so a broken telemetry pipeline can
// never turn a successful replay into a failure. Mirrors the safety
// invariants in packages/net/telemetry.ts and electron/services/bodyIndexer.ts.
type SafeSpanHandle = {
  setAttributes(attrs: Record<string, string | number | boolean | undefined>): void
  end(): void
}

function safeStartReplaySpan(): SafeSpanHandle {
  let raw: ReturnType<typeof startMetricSpan> | undefined
  try {
    raw = startMetricSpan('offline.replay')
  } catch {
    raw = undefined
  }
  return {
    setAttributes(extra) {
      if (!raw) return
      try {
        const r = raw as unknown as {
          setAttributes?: (a: Record<string, unknown>) => void
          setAttribute?: (k: string, v: unknown) => void
        }
        if (typeof r.setAttributes === 'function') {
          r.setAttributes(extra)
        } else if (typeof r.setAttribute === 'function') {
          for (const [k, v] of Object.entries(extra)) {
            if (v !== undefined) r.setAttribute(k, v)
          }
        }
      } catch { /* telemetry must not throw */ }
    },
    end() {
      if (!raw) return
      try {
        (raw as unknown as { end?: () => void }).end?.()
      } catch { /* telemetry must not throw */ }
    },
  }
}

/** Fixed replay order following Thunderbird pattern: flags first, then moves, then deletes */
const OP_ORDER: Record<string, number> = {
  flag_seen: 0,
  flag_flagged: 1,
  move: 2,
  delete: 3,
}

function opPriority(opType: string): number {
  return OP_ORDER[opType] ?? 99
}

/** Max number of replay attempts before discarding a poison op */
const MAX_REPLAY_RETRIES = 5

export type ReplayResult = { replayed: number; failed: number }

/**
 * Replay queued offline operations for a single account.
 * Groups ops by folder, checks UIDVALIDITY, then executes in fixed order.
 */
export async function replayOfflineOps(
  accountId: number,
  getImapConfig: (accountId: number) => Promise<ImapConfig>,
): Promise<ReplayResult> {
  const span = safeStartReplaySpan()
  let opsCount = 0
  let failed = 0
  let uidvalidityMismatch = false
  try {
    // Purge poison ops that have exceeded max retries
    deletePoisonOfflineOps(MAX_REPLAY_RETRIES)

    const ops = getOfflineOps(accountId)
    opsCount = ops.length
    if (ops.length === 0) return { replayed: 0, failed: 0 }

    log.info(`Starting replay for account #${accountId}: ${ops.length} pending ops`)

    let cfg: ImapConfig
    try {
      cfg = await getImapConfig(accountId)
    } catch (err) {
      log.error(`Cannot get IMAP config for account #${accountId}, skipping replay:`, err)
      captureOnce(`imap_config:${errorKey(err)}`, err, { source: 'offlineReplay', stage: 'imap_config', accountId })
      failed = ops.length
      return { replayed: 0, failed }
    }

    // Group ops by folder
    const byFolder = new Map<string, OfflineOp[]>()
    for (const op of ops) {
      const list = byFolder.get(op.folder) || []
      list.push(op)
      byFolder.set(op.folder, list)
    }

    let replayed = 0

    for (const [folder, folderOps] of byFolder) {
      // Check UIDVALIDITY — if it changed, server reorganized UIDs and our ops are stale
      try {
        const status = await getMailboxStatus(accountId, cfg, folder)
        if (!status) {
          log.warn(`Folder "${folder}" not accessible for account #${accountId}, discarding ${folderOps.length} ops`)
          deleteOfflineOpsForFolder(accountId, folder)
          failed += folderOps.length
          continue
        }

        // UIDVALIDITY guard (Thunderbird pattern): compare stored uidValidity with server's current value.
        // If any op has a stored uidValidity that doesn't match, UIDs are stale — discard all ops for folder.
        const serverUidValidity = status.uidValidity
        if (serverUidValidity != null) {
          const staleOp = folderOps.find(op => op.uidValidity != null && op.uidValidity !== serverUidValidity)
          if (staleOp) {
            log.warn(`UIDVALIDITY mismatch for folder "${folder}" account #${accountId}: stored=${staleOp.uidValidity} server=${serverUidValidity}, discarding ${folderOps.length} ops`)
            deleteOfflineOpsForFolder(accountId, folder)
            failed += folderOps.length
            uidvalidityMismatch = true
            continue
          }
        }
      } catch (err) {
        log.warn(`Cannot check folder "${folder}" for account #${accountId}, skipping:`, err)
        failed += folderOps.length
        continue
      }

      // Sort by operation type priority
      folderOps.sort((a, b) => opPriority(a.opType) - opPriority(b.opType))

      // Batch same-type ops together for efficiency
      const batches = batchByOpType(folderOps)

      for (const batch of batches) {
        try {
          await executeBatch(cfg, folder, batch, accountId)
          for (const op of batch) {
            deleteOfflineOp(op.id)
          }
          replayed += batch.length
        } catch (err) {
          log.error(`Failed to replay ${batch[0].opType} batch for folder "${folder}" account #${accountId}:`, err)
          captureOnce(
            `replay_batch:${batch[0].opType}:${errorKey(err)}`,
            err,
            { source: 'offlineReplay', stage: 'replay_batch', opType: batch[0].opType, accountId },
          )
          incrementOfflineOpRetry(batch.map(op => op.id))
          failed += batch.length
        }
      }
    }

    log.info(`Replay complete for account #${accountId}: ${replayed} replayed, ${failed} failed`)
    return { replayed, failed }
  } finally {
    span.setAttributes({
      ops_count_bucket: bucketOpsCount(opsCount),
      failed_bucket: bucketCount(failed),
      uidvalidity_mismatch: uidvalidityMismatch,
    })
    span.end()
  }
}

/** Group consecutive ops of the same type into batches */
function batchByOpType(ops: OfflineOp[]): OfflineOp[][] {
  const batches: OfflineOp[][] = []
  let current: OfflineOp[] = []

  for (const op of ops) {
    if (current.length > 0 && current[0].opType !== op.opType) {
      batches.push(current)
      current = []
    }
    current.push(op)
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Execute a batch of same-type operations via IMAP.
 *
 * §2.17 Phase 1 — replay runs at the `sync` tier. These ops carry the user's
 * own past intent, so they must complete, but nobody is watching a particular
 * one land: a replay burst must not push the message the user is opening RIGHT
 * NOW behind a hundred STORE/MOVE commands on the same lock.
 *
 * The scope spans the WHOLE batch, not one call: `executeBatchOps` issues
 * several sequential IMAP commands (up to two STOREs, one MOVE per destination
 * folder), and each of them takes and releases the lock on its own. That is the
 * intent, not an oversight — the tier is a property of the reason, and the
 * reason does not change between two STOREs of one batch. Splitting the scope
 * per command would only give an interactive open a chance to slip in BETWEEN
 * them, which it already has: the lock is released after every command, so
 * spanning the batch does not hold it across the batch.
 *
 * Nothing is detached inside this scope — every call is awaited — so the tier
 * cannot outlive the batch here. If detached work is ever added below, it must
 * state its own tier (see the "What a scope does NOT promise" note in
 * packages/net/imapScheduler.ts).
 */
async function executeBatch(cfg: ImapConfig, folder: string, batch: OfflineOp[], accountId: number): Promise<void> {
  return withImapPriority('sync', () => executeBatchOps(cfg, folder, batch, accountId))
}

async function executeBatchOps(cfg: ImapConfig, folder: string, batch: OfflineOp[], accountId: number): Promise<void> {
  const opType = batch[0].opType

  if (opType === 'flag_seen') {
    // Split by seen=true and seen=false
    const seenTrue = batch.filter(op => (op.payload as { seen: boolean })?.seen === true)
    const seenFalse = batch.filter(op => (op.payload as { seen: boolean })?.seen === false)
    if (seenTrue.length > 0) {
      await setSeen(cfg, folder, seenTrue.map(op => op.uid), true, accountId)
    }
    if (seenFalse.length > 0) {
      await setSeen(cfg, folder, seenFalse.map(op => op.uid), false, accountId)
    }
  } else if (opType === 'flag_flagged') {
    const flagTrue = batch.filter(op => (op.payload as { flagged: boolean })?.flagged === true)
    const flagFalse = batch.filter(op => (op.payload as { flagged: boolean })?.flagged === false)
    if (flagTrue.length > 0) {
      await setFlagged(cfg, folder, flagTrue.map(op => op.uid), true, accountId)
    }
    if (flagFalse.length > 0) {
      await setFlagged(cfg, folder, flagFalse.map(op => op.uid), false, accountId)
    }
  } else if (opType === 'move') {
    // Group by destination folder — moves from the same source to different destinations
    const byDest = new Map<string, number[]>()
    for (const op of batch) {
      const dest = (op.payload as { destFolder: string })?.destFolder
      if (!dest) continue
      const uids = byDest.get(dest) || []
      uids.push(op.uid)
      byDest.set(dest, uids)
    }
    for (const [dest, uids] of byDest) {
      await moveMessages(cfg, folder, dest, uids, accountId)
      // Clean up temporary placeholders in destination — real UIDs will
      // be populated by the next folder sync after replay completes.
      try { removeTempPlaceholders(accountId, dest) } catch { /* non-critical */ }
    }
  } else if (opType === 'delete') {
    await deleteMessagesRemote(cfg, folder, batch.map(op => op.uid), accountId)
  } else {
    log.warn(`Unknown op type "${opType}", skipping batch of ${batch.length}`)
  }
}
