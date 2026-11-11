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

// Single-flight per account, with memory of the skipped trigger (the same shape
// as the mail-rules runner, CLAUDE.md §5). Replay is triggered from several
// places (before a folder sync, before IDLE starts, on reconnect), and two
// passes over the SAME snapshot of the queue send every op twice and move its
// retry counter by two, so the poison limit is stepped over instead of reached.
// A call that arrives while a pass is running starts no second pass; it asks
// for one more pass after the current one and shares its result, so every
// caller still returns only once the queue has been drained at least as far as
// it was when the caller asked.
const replayInFlight = new Map<number, Promise<ReplayResult>>()
const replayRequestedAgain = new Set<number>()

/**
 * Replay queued offline operations for a single account.
 * Groups ops by folder, checks UIDVALIDITY, then executes in fixed order.
 * At most one pass per account runs at a time; see `replayInFlight`.
 */
export function replayOfflineOps(
  accountId: number,
  getImapConfig: (accountId: number) => Promise<ImapConfig>,
): Promise<ReplayResult> {
  const running = replayInFlight.get(accountId)
  if (running) {
    replayRequestedAgain.add(accountId)
    return running
  }
  const run = (async (): Promise<ReplayResult> => {
    try {
      let total = await replayPass(accountId, getImapConfig)
      // The flag is cleared before the next pass starts, so a call that arrives
      // during it asks for yet another one instead of being lost.
      while (replayRequestedAgain.delete(accountId)) {
        const next = await replayPass(accountId, getImapConfig)
        total = { replayed: total.replayed + next.replayed, failed: next.failed }
      }
      return total
    } finally {
      replayRequestedAgain.delete(accountId)
      replayInFlight.delete(accountId)
    }
  })()
  replayInFlight.set(accountId, run)
  return run
}

async function replayPass(
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
        const progress = await executeBatch(cfg, folder, batch, accountId)
        replayed += progress.replayed
        failed += progress.failed
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
 * Replay one batch of same-type operations via IMAP.
 *
 * §2.17 Phase 1 — replay runs at the `sync` tier. These ops carry the user's
 * own past intent, so they must complete, but nobody is watching a particular
 * one land: a replay burst must not push the message the user is opening RIGHT
 * NOW behind a hundred STORE/MOVE commands on the same lock.
 *
 * The scope spans the WHOLE batch, not one call: a batch issues several
 * sequential IMAP commands (a STORE per seen-state, a MOVE per destination),
 * and each of them takes and releases the lock on its own. That is the intent,
 * not an oversight — the tier is a property of the reason, and the reason does
 * not change between two commands of one batch. Splitting the scope per command
 * would only give an interactive open a chance to slip in BETWEEN them, which
 * it already has: the lock is released after every command, so spanning the
 * batch does not hold it across the batch.
 *
 * Nothing is detached inside this scope — every call is awaited — so the tier
 * cannot outlive the batch here. If detached work is ever added below, it must
 * state its own tier (see the "What a scope does NOT promise" note in
 * packages/net/imapScheduler.ts).
 */
async function executeBatch(cfg: ImapConfig, folder: string, batch: OfflineOp[], accountId: number): Promise<BatchProgress> {
  return withImapPriority('sync', () => executeBatchOps(cfg, folder, batch, accountId))
}

type BatchProgress = { replayed: number; failed: number }

/**
 * Run the commands of a batch one after another, recording progress PER
 * command: a command that succeeded is done, the one that failed is the only
 * one whose outcome is in question, and the ones after it were never sent, so
 * their ops stay in the queue untouched.
 */
async function executeBatchOps(cfg: ImapConfig, folder: string, batch: OfflineOp[], accountId: number): Promise<BatchProgress> {
  let replayed = 0
  let failed = 0
  for (const command of planBatchCommands(cfg, folder, batch, accountId)) {
    try {
      await command.run()
      for (const op of command.ops) deleteOfflineOp(op.id)
      replayed += command.ops.length
    } catch (err) {
      // Any failure, an unknown outcome included, is an ordinary replay error:
      // this command's ops stay queued, count towards the poison limit and are
      // tried again by the next replay — what Thunderbird (nsImapOfflineSync)
      // and K-9 do. Nothing is shown to the user from here: the failure is
      // logged and reported (deduplicated, consent-gated) to Sentry, and after
      // MAX_REPLAY_RETRIES the op is purged without notice.
      // Re-sending is safe for the commands that are queued: a UID MOVE whose
      // message was already moved finds no such UID and does nothing (RFC 9051
      // §6.4.9: "A non-existent unique identifier is ignored without any error
      // message generated"), and +FLAGS / -FLAGS reach the same state when
      // repeated (§6.4.6). Named limit: on a server WITHOUT MOVE the move is a
      // COPY followed by a delete, and while the step after the COPY keeps
      // failing (a server refusal, a lost connection, the operation deadline)
      // every replay copies again — up to MAX_REPLAY_RETRIES copies of each
      // message in the batch. Thunderbird and K-9 accept the same risk.
      log.error(`Failed to replay ${command.ops[0]?.opType} batch for folder "${folder}" account #${accountId}:`, err)
      captureOnce(
        `replay_batch:${command.ops[0]?.opType}:${errorKey(err)}`,
        err,
        { source: 'offlineReplay', stage: 'replay_batch', opType: command.ops[0]?.opType, accountId },
      )
      incrementOfflineOpRetry(command.ops.map(op => op.id))
      failed += command.ops.length
      // The rest of the batch was not sent; it stays queued as it is.
      break
    }
  }
  return { replayed, failed }
}

/** One IMAP command of a replay batch, and the queued ops it carries out. */
type ReplayCommand = { ops: OfflineOp[]; run: () => Promise<void> }

/**
 * Plan a batch of same-type operations as the IMAP commands that carry it out.
 * Runs under the batch-wide `sync` tier set by `executeBatch`; nothing here is
 * detached, so the tier cannot outlive the batch.
 */
function planBatchCommands(cfg: ImapConfig, folder: string, batch: OfflineOp[], accountId: number): ReplayCommand[] {
  const opType = batch[0].opType
  const commands: ReplayCommand[] = []

  if (opType === 'flag_seen') {
    // Split by seen=true and seen=false
    const seenTrue = batch.filter(op => (op.payload as { seen: boolean })?.seen === true)
    const seenFalse = batch.filter(op => (op.payload as { seen: boolean })?.seen === false)
    if (seenTrue.length > 0) {
      commands.push({ ops: seenTrue, run: () => setSeen(cfg, folder, seenTrue.map(op => op.uid), true, accountId) })
    }
    if (seenFalse.length > 0) {
      commands.push({ ops: seenFalse, run: () => setSeen(cfg, folder, seenFalse.map(op => op.uid), false, accountId) })
    }
    // A payload that is neither true nor false has nothing to send; as before, such an op leaves the queue with the batch.
    const unplannedSeen = batch.filter(op => !seenTrue.includes(op) && !seenFalse.includes(op))
    if (unplannedSeen.length > 0) commands.push({ ops: unplannedSeen, run: async () => undefined })
  } else if (opType === 'flag_flagged') {
    const flagTrue = batch.filter(op => (op.payload as { flagged: boolean })?.flagged === true)
    const flagFalse = batch.filter(op => (op.payload as { flagged: boolean })?.flagged === false)
    if (flagTrue.length > 0) {
      commands.push({ ops: flagTrue, run: () => setFlagged(cfg, folder, flagTrue.map(op => op.uid), true, accountId) })
    }
    if (flagFalse.length > 0) {
      commands.push({ ops: flagFalse, run: () => setFlagged(cfg, folder, flagFalse.map(op => op.uid), false, accountId) })
    }
    const unplannedFlag = batch.filter(op => !flagTrue.includes(op) && !flagFalse.includes(op))
    if (unplannedFlag.length > 0) commands.push({ ops: unplannedFlag, run: async () => undefined })
  } else if (opType === 'move') {
    // Group by destination folder — moves from the same source to different destinations
    const byDest = new Map<string, OfflineOp[]>()
    const withoutDest: OfflineOp[] = []
    for (const op of batch) {
      const dest = (op.payload as { destFolder: string })?.destFolder
      if (!dest) { withoutDest.push(op); continue }
      const group = byDest.get(dest) || []
      group.push(op)
      byDest.set(dest, group)
    }
    for (const [dest, ops] of byDest) {
      commands.push({
        ops,
        run: async () => {
          await moveMessages(cfg, folder, dest, ops.map(op => op.uid), accountId)
          // Clean up temporary placeholders in destination — real UIDs will
          // be populated by the next folder sync after replay completes.
          try { removeTempPlaceholders(accountId, dest) } catch { /* non-critical */ }
        },
      })
    }
    // Ops with no destination have nothing to send; as before, they leave the queue with the batch.
    if (withoutDest.length > 0) commands.push({ ops: withoutDest, run: async () => undefined })
  } else if (opType === 'delete') {
    commands.push({ ops: batch, run: () => deleteMessagesRemote(cfg, folder, batch.map(op => op.uid), accountId) })
  } else {
    log.warn(`Unknown op type "${opType}", skipping batch of ${batch.length}`)
    commands.push({ ops: batch, run: async () => undefined })
  }
  return commands
}
