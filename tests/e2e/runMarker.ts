/**
 * Per-run process marker for e2e-launched apps, and the reaper that uses it.
 *
 * Why it exists: when Playwright tears a worker down (test timeout, worker
 * crash), the app that worker spawned never sees `closeApp` / `terminateProcess`.
 * It is re-parented to the nearest subreaper (`systemd --user` on a desktop) and
 * keeps running with its full Chromium process tree. In one broken local run
 * those orphans piled up to about two thousand app instances in an hour and
 * took the desktop down; CI never shows it because the job container is thrown
 * away.
 *
 * How it works:
 *  - `global-setup.ts` mints one id per Playwright run and puts it in the
 *    environment, so every worker of that run sees the same value.
 *  - Every launch site appends `runMarkerArgs()` (via `electronLaunchArgs()` in
 *    launchArgs.ts, or directly for the demo's own Chromium), tagging the
 *    process with `--mailcopilot-e2e-run=<id>`.
 *  - `global-teardown.ts` kills whatever still carries THIS run's marker.
 *
 * Matching rules, measured on Linux with Electron 43 and snap Chromium:
 *  - The marker lives in the command line, not the environment. Chromium
 *    rewrites the browser process title over the memory that held `environ`,
 *    so `/proc/<pid>/environ` of the app's main process no longer contains the
 *    environment at all.
 *  - Ordinary processes are compared by argv ELEMENT: the marker must equal one
 *    whole NUL-delimited element. A shell running a script that merely mentions
 *    the id (`sh -c '... --mailcopilot-e2e-run=<id> ...'`) has the id inside a
 *    larger element and does not match.
 *  - The rewritten Chromium title is ONE space-joined string (a single argv
 *    element) whose first word is the binary path. Only that exact shape — one
 *    element, first word a title-rewriting binary (`isTitleRewritingBinary`) —
 *    is split into words before comparing.
 *  - Only an Electron app's main process carries the switch (zygote, GPU,
 *    renderer and utility children do not). Killing the main process takes
 *    the children down with it within seconds, so matching it is sufficient.
 *  - Nothing here ever matches on a broad pattern such as "electron" or
 *    "playwright": that would kill unrelated sessions on the developer's machine.
 *
 * Signal safety, because a numeric pid is not an identity:
 *  - A candidate must belong to us: real and effective UID equal our effective
 *    UID.
 *  - Its start time (field 22 of `/proc/<pid>/stat`) is recorded at scan. Right
 *    before EVERY signal the start time, owner and match are read again; any
 *    mismatch or read failure skips the signal, so a pid reused by an unrelated
 *    process in the meantime is left alone. The window between that re-check
 *    and `kill()` itself cannot be closed without pidfd, which Node does not
 *    expose; it is microseconds instead of the seconds a scan-then-kill takes.
 */
import fs from 'node:fs/promises'

/** Environment variable carrying the id of the current Playwright run. */
export const E2E_RUN_ID_ENV = 'MAILCOPILOT_E2E_RUN_ID'

const RUN_MARKER_SWITCH = '--mailcopilot-e2e-run'

/**
 * A run id must be long and plain enough that an exact token match cannot hit
 * an unrelated process by accident. `randomUUID()` satisfies it.
 */
const RUN_ID_RE = /^[A-Za-z0-9_-]{16,128}$/

export function isValidRunId(runId: string | undefined): runId is string {
  return typeof runId === 'string' && RUN_ID_RE.test(runId)
}

export function runMarkerArg(runId: string): string {
  return `${RUN_MARKER_SWITCH}=${runId}`
}

/**
 * Marker arguments for a process launched in the current run. Empty when no
 * valid run id is set — a spec started outside the configured runner simply
 * goes untagged instead of failing.
 */
export function runMarkerArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const runId = env[E2E_RUN_ID_ENV]
  return isValidRunId(runId) ? [runMarkerArg(runId)] : []
}

/** Splits a raw `/proc/<pid>/cmdline` into its NUL-delimited argv elements. */
export function cmdlineArgv(raw: string): string[] {
  const argv = raw.split('\0')
  // The kernel terminates every element, so the split leaves a trailing empty
  // string (more than one if a rewritten title was NUL-padded).
  while (argv.length > 0 && argv[argv.length - 1] === '') argv.pop()
  return argv
}

const ELECTRON_BINARY_PATH = 'node_modules/electron/dist/electron'
/**
 * Browser binaries that rewrite their title the same way. Measured: snap
 * Chromium, whose every process reads
 * `/snap/chromium/<rev>/usr/lib/chromium-browser/chrome ...` as one string.
 * Not measured, listed because they are the same browser binary under their
 * install names: Google Chrome (`/opt/google/chrome/chrome`), Debian Chromium
 * (`/usr/lib/chromium/chromium`). A `DEMO_BROWSER_BIN` whose real binary has
 * another basename goes unreaped.
 */
const CHROMIUM_BINARY_NAMES = new Set(['chrome', 'chromium'])

/** Whether a word is the path of a binary that rewrites its title into one string. */
export function isTitleRewritingBinary(word: string): boolean {
  if (word === ELECTRON_BINARY_PATH || word.endsWith(`/${ELECTRON_BINARY_PATH}`)) return true
  return word.startsWith('/') && CHROMIUM_BINARY_NAMES.has(word.slice(word.lastIndexOf('/') + 1))
}

/** The words a marker is compared against — see the matching rules above. */
export function markerCandidates(argv: string[]): string[] {
  if (argv.length === 1) {
    const words = argv[0].split(' ').filter(Boolean)
    if (words.length > 0 && isTitleRewritingBinary(words[0])) return words
  }
  return argv
}

export function carriesRunMarker(argv: string[], runId: string): boolean {
  return markerCandidates(argv).includes(runMarkerArg(runId))
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/**
 * `xvfb-run` (used when no X display is available) receives the app's
 * arguments too, so it carries the marker. Measured argv:
 * `/bin/sh /usr/bin/xvfb-run -a <electron> ...`.
 */
export function isXvfbRunWrapper(argv: string[]): boolean {
  return argv.slice(0, 2).some(a => basename(a) === 'xvfb-run')
}

/** The X server `xvfb-run` starts. Measured argv: `Xvfb :99 -screen 0 ...`. */
export function isXvfbServer(argv: string[]): boolean {
  return argv.length > 0 && basename(argv[0]) === 'Xvfb'
}

export type ProcSnapshot = {
  pid: number
  ppid: number
  /** One-letter state from `/proc/<pid>/stat` (`Z` zombie, `X` dead). */
  state: string
  /** Field 22 of `/proc/<pid>/stat`; with the pid it names exactly one process. */
  startTime: string
  realUid: number
  effectiveUid: number
  argv: string[]
}

type StatFields = { state: string; ppid: number; startTime: string }

/** Parses `/proc/<pid>/stat`. `comm` may contain spaces and parentheses, so fields are counted from the LAST `)`. */
export function parseProcStat(raw: string): StatFields | null {
  const close = raw.lastIndexOf(')')
  if (close < 0) return null
  // After ") " the fields start at field 3 (state); field 22 is index 19.
  const fields = raw.slice(close + 2).trim().split(' ')
  const [state, ppid, startTime] = [fields[0], Number(fields[1]), fields[19]]
  if (!state || !Number.isInteger(ppid) || !startTime || !/^\d+$/.test(startTime)) return null
  return { state, ppid, startTime }
}

function parseUids(status: string): { realUid: number; effectiveUid: number } | null {
  const m = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status)
  return m ? { realUid: Number(m[1]), effectiveUid: Number(m[2]) } : null
}

const readProcFile = (procRoot: string, pid: number, file: string) =>
  fs.readFile(`${procRoot}/${pid}/${file}`, 'utf8')

/**
 * Reads one process. `null` when it is gone, unreadable or malformed. The stat
 * file is read before and after the other files and must not change start
 * time, so a pid reused mid-read never yields a snapshot mixing two processes.
 */
export async function readProcSnapshot(procRoot: string, pid: number): Promise<ProcSnapshot | null> {
  try {
    const before = parseProcStat(await readProcFile(procRoot, pid, 'stat'))
    const uids = parseUids(await readProcFile(procRoot, pid, 'status'))
    const cmdline = await readProcFile(procRoot, pid, 'cmdline')
    const after = parseProcStat(await readProcFile(procRoot, pid, 'stat'))
    if (!before || !after || !uids || before.startTime !== after.startTime) return null
    return { pid, ...after, ...uids, argv: cmdlineArgv(cmdline) }
  } catch {
    return null
  }
}

/** Thrown when the process table itself cannot be listed — not a per-process read failure. */
export class ProcScanError extends Error {}

async function listPids(procRoot: string, selfPid: number): Promise<number[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(procRoot)
  } catch (err) {
    throw new ProcScanError(`cannot list ${procRoot}: ${(err as Error).message}`)
  }
  const pids = entries.filter(n => /^\d+$/.test(n)).map(Number)
  // A real procfs always lists at least the reading process itself, so an
  // empty listing is a broken scan, not "no processes".
  if (pids.length === 0) throw new ProcScanError(`no process entries under ${procRoot}`)
  return pids.filter(pid => pid !== selfPid).sort((a, b) => a - b)
}

const isDead = (p: ProcSnapshot): boolean => p.state === 'Z' || p.state === 'X'
const ownedBy = (p: ProcSnapshot, uid: number): boolean => p.realUid === uid && p.effectiveUid === uid

export type ScanDeps = { procRoot?: string; selfPid?: number; selfUid?: number }

export type MarkedScan = {
  processes: ProcSnapshot[]
  /** Entries that vanished or could not be read mid-scan; the scan itself still succeeded. */
  unreadable: number
}

/**
 * Lists live processes owned by us whose command line carries exactly this
 * run's marker. Throws `ProcScanError` only when the process table cannot be
 * listed at all.
 */
export async function findRunMarkedProcesses(runId: string, deps: ScanDeps = {}): Promise<MarkedScan> {
  const procRoot = deps.procRoot ?? '/proc'
  const selfUid = deps.selfUid ?? process.geteuid?.()
  const pids = await listPids(procRoot, deps.selfPid ?? process.pid)
  const processes: ProcSnapshot[] = []
  let unreadable = 0
  for (const pid of pids) {
    // Cheap pre-filter on the command line alone; the full snapshot is read
    // only for the few processes that could match.
    let raw: string
    try {
      raw = await readProcFile(procRoot, pid, 'cmdline')
    } catch {
      unreadable++
      continue
    }
    if (!carriesRunMarker(cmdlineArgv(raw), runId)) continue
    const snap = await readProcSnapshot(procRoot, pid)
    if (!snap) {
      unreadable++
      continue
    }
    if (isDead(snap) || selfUid === undefined || !ownedBy(snap, selfUid)) continue
    if (carriesRunMarker(snap.argv, runId)) processes.push(snap)
  }
  return { processes, unreadable }
}

export type ReapDeps = ScanDeps & {
  platform?: NodeJS.Platform
  kill?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
  /** How long an `xvfb-run` wrapper gets to exit on its own (and stop its Xvfb) after its app died. */
  wrapperGraceMs?: number
  /** How long a SIGTERMed wrapper or Xvfb gets before SIGKILL. */
  termWaitMs?: number
}

export type ReapResult =
  | { status: 'skipped'; reason: 'invalid-run-id' | 'unsupported-platform' }
  | { status: 'scan-failed'; error: string }
  | {
      status: 'done'
      /** Processes carrying this run's marker at scan time. */
      found: number
      /** Distinct processes (marked ones and orphaned Xvfb servers) that received at least one signal. */
      killed: number
      /** Entries unreadable during the scan (usually processes that exited mid-scan). */
      unreadable: number
      /** Signals skipped because the pid no longer named the scanned process. */
      identityChanged: number
      /** Whether looking up the Xvfb servers of stuck wrappers failed (their servers may leak). */
      xvfbScanFailed: boolean
    }

const POLL_MS = 100

/**
 * Kills every process that carries this run's marker, oldest-pid first:
 *  1. apps — SIGKILL;
 *  2. `xvfb-run` wrappers — given `wrapperGraceMs` to exit on their own, which
 *     runs their cleanup and stops their Xvfb. A wrapper still alive after
 *     that has its Xvfb child recorded FIRST (once the wrapper dies the server
 *     is re-parented and can no longer be tied to it), then gets SIGTERM, then
 *     SIGKILL after `termWaitMs`;
 *  3. that Xvfb, if it survived its wrapper — SIGTERM, then SIGKILL. Measured:
 *     a dash `xvfb-run` killed by SIGTERM does not run its cleanup and leaves
 *     the server running.
 *
 * Never throws; Linux only (reads `/proc`), a documented no-op elsewhere.
 */
export async function reapRunMarkedProcesses(runId: string | undefined, deps: ReapDeps = {}): Promise<ReapResult> {
  if (!isValidRunId(runId)) return { status: 'skipped', reason: 'invalid-run-id' }
  const platform = deps.platform ?? process.platform
  const selfUid = deps.selfUid ?? process.geteuid?.()
  if (platform !== 'linux' || selfUid === undefined) return { status: 'skipped', reason: 'unsupported-platform' }

  const procRoot = deps.procRoot ?? '/proc'
  const selfPid = deps.selfPid ?? process.pid
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal) })
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const graceMs = deps.wrapperGraceMs ?? 2_000
  const termWaitMs = deps.termWaitMs ?? 3_000

  let scan: MarkedScan
  try {
    scan = await findRunMarkedProcesses(runId, { procRoot, selfPid, selfUid })
  } catch (err) {
    return { status: 'scan-failed', error: err instanceof Error ? err.message : String(err) }
  }

  type Matcher = (argv: string[]) => boolean
  const marked: Matcher = argv => carriesRunMarker(argv, runId)
  const signalled = new Set<number>()
  let identityChanged = 0
  let xvfbScanFailed = false

  /** Whether the pid still names the scanned process: same start time, owner and match, not a zombie. */
  const verify = async (target: ProcSnapshot, matches: Matcher): Promise<'same' | 'gone' | 'changed'> => {
    const now = await readProcSnapshot(procRoot, target.pid)
    if (!now) return 'gone'
    if (now.startTime !== target.startTime) return 'changed'
    if (isDead(now)) return 'gone'
    return ownedBy(now, selfUid) && matches(now.argv) ? 'same' : 'changed'
  }

  const signal = async (target: ProcSnapshot, sig: NodeJS.Signals, matches: Matcher): Promise<void> => {
    const identity = await verify(target, matches)
    if (identity === 'changed') identityChanged++
    if (identity !== 'same') return
    try {
      kill(target.pid, sig)
      signalled.add(target.pid)
    } catch {
      // ESRCH: exited between the re-check and the signal.
    }
  }

  const stillAlive = async (targets: ProcSnapshot[], matches: Matcher): Promise<ProcSnapshot[]> => {
    const alive: ProcSnapshot[] = []
    for (const t of targets) if ((await verify(t, matches)) === 'same') alive.push(t)
    return alive
  }

  const waitForExit = async (targets: ProcSnapshot[], timeoutMs: number, matches: Matcher): Promise<ProcSnapshot[]> => {
    let alive = await stillAlive(targets, matches)
    // Counted in polls, not wall-clock time, so an injected sleep stays deterministic.
    for (let poll = 0; poll < Math.ceil(timeoutMs / POLL_MS) && alive.length > 0; poll++) {
      await sleep(POLL_MS)
      alive = await stillAlive(alive, matches)
    }
    return alive
  }

  const terminate = async (targets: ProcSnapshot[], matches: Matcher): Promise<void> => {
    for (const t of targets) await signal(t, 'SIGTERM', matches)
    for (const t of await waitForExit(targets, termWaitMs, matches)) await signal(t, 'SIGKILL', matches)
  }

  const findXvfbChildren = async (wrappers: ProcSnapshot[]): Promise<ProcSnapshot[]> => {
    const parents = new Set(wrappers.map(w => w.pid))
    let pids: number[]
    try {
      pids = await listPids(procRoot, selfPid)
    } catch {
      xvfbScanFailed = true
      return []
    }
    const servers: ProcSnapshot[] = []
    for (const pid of pids) {
      const stat = await readProcFile(procRoot, pid, 'stat').then(parseProcStat, () => null)
      if (!stat || !parents.has(stat.ppid)) continue
      const snap = await readProcSnapshot(procRoot, pid)
      if (snap && parents.has(snap.ppid) && !isDead(snap) && ownedBy(snap, selfUid) && isXvfbServer(snap.argv)) {
        servers.push(snap)
      }
    }
    return servers
  }

  const wrappers = scan.processes.filter(p => isXvfbRunWrapper(p.argv))
  const apps = scan.processes.filter(p => !isXvfbRunWrapper(p.argv))

  for (const app of apps) await signal(app, 'SIGKILL', marked)

  const stuckWrappers = await waitForExit(wrappers, graceMs, marked)
  if (stuckWrappers.length > 0) {
    const servers = await findXvfbChildren(stuckWrappers)
    await terminate(stuckWrappers, marked)
    await terminate(servers, isXvfbServer)
  }

  return {
    status: 'done',
    found: scan.processes.length,
    killed: signalled.size,
    unreadable: scan.unreadable,
    identityChanged,
    xvfbScanFailed,
  }
}
