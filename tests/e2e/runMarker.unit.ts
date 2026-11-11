/**
 * Unit tests for the e2e orphan reaper (runMarker.ts), run by vitest — the
 * `.unit.ts` suffix keeps them out of Playwright's testMatch.
 *
 * The reaper reads `/proc`, so these tests build a fake process table in a temp
 * directory (`procRoot`) and inject `kill` / `sleep`. A fake `kill` mutates the
 * table the way the kernel would: the process directory disappears, orphans get
 * re-parented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  E2E_RUN_ID_ENV,
  carriesRunMarker,
  cmdlineArgv,
  findRunMarkedProcesses,
  parseProcStat,
  readProcSnapshot,
  reapRunMarkedProcesses,
  runMarkerArg,
  runMarkerArgs,
  type ReapDeps,
} from './runMarker'

const RUN_ID = '0f8a3c1e-1111-4222-8333-944455556666'
const OTHER_RUN_ID = '0f8a3c1e-9999-4222-8333-944455556666'
const MARKER = runMarkerArg(RUN_ID)
const UID = 1000
const SELF_PID = 4242
const ELECTRON = '/home/dev/mailcopilot/node_modules/electron/dist/electron'
const SNAP_CHROME = '/snap/chromium/3520/usr/lib/chromium-browser/chrome'

/** Command line of an Electron main process after Chromium rewrote its title (measured shape). */
const rewrittenTitle = (binary: string, ...args: string[]) => `${[binary, ...args].join(' ')}\0`
const nulArgv = (...argv: string[]) => argv.map(a => `${a}\0`).join('')

type FakeProc = {
  pid: number
  ppid?: number
  state?: string
  startTime?: number
  uid?: number
  euid?: number
  cmdline?: string
  comm?: string
}

let procRoot: string

function statLine(p: FakeProc): string {
  // Fields 5..21 are irrelevant here; field 22 is the start time.
  const middle = Array.from({ length: 17 }, () => '0').join(' ')
  return `${p.pid} (${p.comm ?? 'proc'}) ${p.state ?? 'S'} ${p.ppid ?? 1} ${middle} ${p.startTime ?? 5000} 0 0 0\n`
}

function writeProc(p: FakeProc): void {
  const dir = path.join(procRoot, String(p.pid))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'stat'), statLine(p))
  const uid = p.uid ?? UID
  const euid = p.euid ?? uid
  fs.writeFileSync(path.join(dir, 'status'), `Name:\tproc\nUid:\t${uid}\t${euid}\t${uid}\t${uid}\nGid:\t1000\t1000\t1000\t1000\n`)
  fs.writeFileSync(path.join(dir, 'cmdline'), p.cmdline ?? '')
}

const removeProc = (pid: number) => fs.rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true })

function reparent(pid: number, ppid: number): void {
  const file = path.join(procRoot, String(pid), 'stat')
  const fields = fs.readFileSync(file, 'utf8').split(' ')
  fields[3] = String(ppid)
  fs.writeFileSync(file, fields.join(' '))
}

type Signal = [number, NodeJS.Signals]

/** A fake `kill` that records signals and applies per-pid behaviour. */
function fakeKill(behaviour: Record<number, (sig: NodeJS.Signals) => void> = {}) {
  const calls: Signal[] = []
  const kill = (pid: number, sig: NodeJS.Signals) => {
    calls.push([pid, sig])
    const handler = behaviour[pid]
    if (handler) handler(sig)
    else removeProc(pid) // default: the process dies on any signal
  }
  return { calls, kill }
}

function deps(overrides: Partial<ReapDeps> = {}): ReapDeps {
  return {
    platform: 'linux',
    procRoot,
    selfPid: SELF_PID,
    selfUid: UID,
    sleep: async () => {},
    wrapperGraceMs: 300,
    termWaitMs: 300,
    ...overrides,
  }
}

beforeEach(() => {
  procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-fake-proc-'))
})

afterEach(() => {
  fs.rmSync(procRoot, { recursive: true, force: true })
})

describe('runMarkerArgs', () => {
  it('tags a launch only when the run id is valid', () => {
    expect(runMarkerArgs({ [E2E_RUN_ID_ENV]: RUN_ID })).toEqual([MARKER])
    expect(runMarkerArgs({})).toEqual([])
    expect(runMarkerArgs({ [E2E_RUN_ID_ENV]: '' })).toEqual([])
    expect(runMarkerArgs({ [E2E_RUN_ID_ENV]: 'short' })).toEqual([])
    expect(runMarkerArgs({ [E2E_RUN_ID_ENV]: `${RUN_ID} --other` })).toEqual([])
  })
})

describe('marker matching', () => {
  const argvOf = (raw: string) => cmdlineArgv(raw)

  it('matches an exact NUL-delimited argv element', () => {
    const wrapper = nulArgv('/bin/sh', '/usr/bin/xvfb-run', '-a', ELECTRON, '.', '--no-sandbox', MARKER)
    expect(carriesRunMarker(argvOf(wrapper), RUN_ID)).toBe(true)
  })

  it('does not match a shell whose script text merely contains the marker', () => {
    const script = nulArgv('sh', '-c', `pgrep -f -- ${MARKER} && echo found`)
    expect(carriesRunMarker(argvOf(script), RUN_ID)).toBe(false)
    const bash = nulArgv('/usr/bin/bash', '-c', `${ELECTRON} ${MARKER}`)
    expect(carriesRunMarker(argvOf(bash), RUN_ID)).toBe(false)
  })

  it('matches the rewritten single-string title of Electron and of snap Chromium', () => {
    expect(carriesRunMarker(argvOf(rewrittenTitle(ELECTRON, '--no-sandbox', MARKER, '.')), RUN_ID)).toBe(true)
    expect(carriesRunMarker(argvOf(rewrittenTitle('node_modules/electron/dist/electron', MARKER)), RUN_ID)).toBe(true)
    expect(carriesRunMarker(argvOf(rewrittenTitle(SNAP_CHROME, '--ozone-platform=x11', MARKER, 'about:blank')), RUN_ID)).toBe(true)
    // Padding NULs after a rewritten title do not turn it into several elements.
    expect(carriesRunMarker(argvOf(`${ELECTRON} ${MARKER}\0\0\0`), RUN_ID)).toBe(true)
  })

  it('splits a single-string command line into words only for a title-rewriting binary', () => {
    expect(carriesRunMarker(argvOf(rewrittenTitle('/usr/bin/python3', MARKER)), RUN_ID)).toBe(false)
    expect(carriesRunMarker(argvOf(rewrittenTitle('sh', '-c', MARKER)), RUN_ID)).toBe(false)
    expect(carriesRunMarker(argvOf(rewrittenTitle(`${ELECTRON}-helper`, MARKER)), RUN_ID)).toBe(false)
    expect(carriesRunMarker(argvOf(rewrittenTitle('chrome', MARKER)), RUN_ID)).toBe(false) // not an absolute path
    expect(carriesRunMarker(argvOf(rewrittenTitle('/opt/chrome-tools/chromedriver', MARKER)), RUN_ID)).toBe(false)
  })

  it('never matches another run, a prefix or an extension of the marker', () => {
    expect(carriesRunMarker(argvOf(rewrittenTitle(ELECTRON, runMarkerArg(OTHER_RUN_ID))), RUN_ID)).toBe(false)
    expect(carriesRunMarker(argvOf(nulArgv(ELECTRON, `${MARKER}-extra`, '--mailcopilot-e2e-run=')), RUN_ID)).toBe(false)
    expect(carriesRunMarker(argvOf(nulArgv(ELECTRON, `x${MARKER}`)), RUN_ID)).toBe(false)
  })
})

describe('/proc parsing', () => {
  it('reads state, ppid and start time past a comm containing spaces and parentheses', () => {
    const middle = Array.from({ length: 17 }, (_, i) => String(i + 5)).join(' ')
    expect(parseProcStat(`77 (Web (Content) x) S 12 ${middle} 987654 23 24\n`)).toEqual({
      state: 'S',
      ppid: 12,
      startTime: '987654',
    })
    expect(parseProcStat('garbage')).toBeNull()
    expect(parseProcStat('77 (x) S 12')).toBeNull()
  })

  it.runIf(process.platform === 'linux')('reads the current process from the real /proc', async () => {
    const snap = await readProcSnapshot('/proc', process.pid)
    expect(snap).not.toBeNull()
    expect(snap!.effectiveUid).toBe(process.geteuid!())
    expect(snap!.startTime).toMatch(/^\d+$/)
    expect(snap!.argv.length).toBeGreaterThan(0)
  })
})

describe('findRunMarkedProcesses', () => {
  it('lists only live processes of ours that carry this run marker', async () => {
    writeProc({ pid: 100, cmdline: rewrittenTitle(ELECTRON, '--no-sandbox', MARKER, '.') })
    writeProc({ pid: 101, cmdline: rewrittenTitle(ELECTRON, runMarkerArg(OTHER_RUN_ID)) })
    writeProc({ pid: 102, cmdline: nulArgv('sh', '-c', `kill ${MARKER}`) })
    writeProc({ pid: 103, cmdline: rewrittenTitle(ELECTRON, MARKER), uid: 1001 }) // another user's
    writeProc({ pid: 104, cmdline: rewrittenTitle(ELECTRON, MARKER), euid: 0 }) // effective uid differs
    writeProc({ pid: 105, cmdline: rewrittenTitle(ELECTRON, MARKER), state: 'Z' })
    writeProc({ pid: SELF_PID, cmdline: rewrittenTitle(ELECTRON, MARKER) })
    fs.mkdirSync(path.join(procRoot, '106')) // vanished mid-scan: no files left
    fs.mkdirSync(path.join(procRoot, 'self'))

    const scan = await findRunMarkedProcesses(RUN_ID, { procRoot, selfPid: SELF_PID, selfUid: UID })

    expect(scan.processes.map(p => p.pid)).toEqual([100])
    expect(scan.processes[0]).toMatchObject({ startTime: '5000', realUid: UID, effectiveUid: UID })
    expect(scan.unreadable).toBe(1)
  })
})

describe('reapRunMarkedProcesses', () => {
  it('does nothing for an invalid run id or off Linux', async () => {
    const { calls, kill } = fakeKill()
    writeProc({ pid: 100, cmdline: rewrittenTitle(ELECTRON, MARKER) })

    expect(await reapRunMarkedProcesses(undefined, deps({ kill }))).toEqual({ status: 'skipped', reason: 'invalid-run-id' })
    expect(await reapRunMarkedProcesses('short', deps({ kill }))).toEqual({ status: 'skipped', reason: 'invalid-run-id' })
    expect(await reapRunMarkedProcesses(RUN_ID, deps({ kill, platform: 'darwin' }))).toEqual({
      status: 'skipped',
      reason: 'unsupported-platform',
    })
    expect(calls).toEqual([])
  })

  it('SIGKILLs this run apps and nothing else', async () => {
    writeProc({ pid: 100, cmdline: rewrittenTitle(ELECTRON, '--no-sandbox', MARKER, '.') })
    writeProc({ pid: 101, cmdline: rewrittenTitle(ELECTRON, runMarkerArg(OTHER_RUN_ID)) })
    writeProc({ pid: 102, cmdline: nulArgv('sh', '-c', `echo ${MARKER}`) })
    writeProc({ pid: 103, cmdline: rewrittenTitle(ELECTRON, MARKER), uid: 1001 })
    writeProc({ pid: 104, cmdline: rewrittenTitle(ELECTRON, MARKER), state: 'Z' })
    writeProc({ pid: 105, cmdline: rewrittenTitle(SNAP_CHROME, MARKER, 'https://accounts.google.com') })
    writeProc({ pid: SELF_PID, cmdline: rewrittenTitle(ELECTRON, MARKER) })
    fs.mkdirSync(path.join(procRoot, '106'))
    const { calls, kill } = fakeKill()

    const result = await reapRunMarkedProcesses(RUN_ID, deps({ kill }))

    expect(calls).toEqual([[100, 'SIGKILL'], [105, 'SIGKILL']])
    expect(result).toEqual({
      status: 'done',
      found: 2,
      killed: 2,
      unreadable: 1,
      identityChanged: 0,
      xvfbScanFailed: false,
    })
  })

  it('tolerates ESRCH when a process exits right before the signal', async () => {
    writeProc({ pid: 100, cmdline: rewrittenTitle(ELECTRON, MARKER) })
    writeProc({ pid: 101, cmdline: rewrittenTitle(ELECTRON, MARKER) })
    const { calls, kill } = fakeKill({
      100: () => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      },
    })

    const result = await reapRunMarkedProcesses(RUN_ID, deps({ kill }))

    expect(calls).toEqual([[100, 'SIGKILL'], [101, 'SIGKILL']])
    expect(result).toMatchObject({ status: 'done', found: 2, killed: 1 })
  })

  it('skips a pid whose start time changed between scan and signal (pid reuse)', async () => {
    writeProc({ pid: 100, cmdline: rewrittenTitle(ELECTRON, MARKER) })
    writeProc({ pid: 101, cmdline: rewrittenTitle(ELECTRON, MARKER), startTime: 5000 })
    const { calls, kill } = fakeKill({
      100: () => {
        removeProc(100)
        // 101 exits and an unrelated process reuses its pid before its signal.
        writeProc({ pid: 101, cmdline: rewrittenTitle(ELECTRON, MARKER), startTime: 9000 })
      },
    })

    const result = await reapRunMarkedProcesses(RUN_ID, deps({ kill }))

    expect(calls).toEqual([[100, 'SIGKILL']])
    expect(result).toMatchObject({ found: 2, killed: 1, identityChanged: 1 })
  })

  it('skips a pid that changed owner or command line between scan and signal', async () => {
    writeProc({ pid: 100, cmdline: rewrittenTitle(ELECTRON, MARKER) })
    writeProc({ pid: 101, cmdline: rewrittenTitle(ELECTRON, MARKER) })
    writeProc({ pid: 102, cmdline: rewrittenTitle(ELECTRON, MARKER) })
    const { calls, kill } = fakeKill({
      100: () => {
        removeProc(100)
        writeProc({ pid: 101, cmdline: nulArgv('/usr/bin/vim', 'notes.txt') }) // exec'd, same start time
        writeProc({ pid: 102, cmdline: rewrittenTitle(ELECTRON, MARKER), uid: 0 })
      },
    })

    const result = await reapRunMarkedProcesses(RUN_ID, deps({ kill }))

    expect(calls).toEqual([[100, 'SIGKILL']])
    expect(result).toMatchObject({ killed: 1, identityChanged: 2 })
  })

  describe('xvfb-run wrappers', () => {
    const WRAPPER = 200
    const XVFB = 201
    const XAUTH = 202

    function writeWrapperTree(): void {
      writeProc({ pid: 100, ppid: WRAPPER, cmdline: rewrittenTitle(ELECTRON, '--no-sandbox', MARKER, '.') })
      writeProc({
        pid: WRAPPER,
        cmdline: nulArgv('/bin/sh', '/usr/bin/xvfb-run', '-a', ELECTRON, '.', '--no-sandbox', MARKER),
      })
      writeProc({ pid: XVFB, ppid: WRAPPER, cmdline: nulArgv('Xvfb', ':99', '-screen', '0', '1280x1024x24') })
      writeProc({ pid: XAUTH, ppid: WRAPPER, cmdline: nulArgv('xauth', 'source', '-') })
    }

    it('leaves a wrapper that exits on its own after its app died, and its Xvfb, to clean up', async () => {
      writeWrapperTree()
      const { calls, kill } = fakeKill()
      let sleeps = 0
      const sleep = async () => {
        sleeps++
        if (sleeps === 1) {
          removeProc(WRAPPER)
          removeProc(XVFB)
        }
      }

      const result = await reapRunMarkedProcesses(RUN_ID, deps({ kill, sleep }))

      expect(calls).toEqual([[100, 'SIGKILL']])
      expect(sleeps).toBe(1)
      expect(result).toMatchObject({ found: 2, killed: 1 })
    })

    it('kills apps first, then SIGTERMs a stuck wrapper, SIGKILLs it after the wait and stops its orphaned Xvfb', async () => {
      writeWrapperTree()
      let sleeps = 0
      const { calls, kill } = fakeKill({
        [WRAPPER]: sig => {
          if (sig !== 'SIGKILL') return // ignores SIGTERM
          removeProc(WRAPPER)
          reparent(XVFB, 1)
          reparent(XAUTH, 1)
        },
      })

      const result = await reapRunMarkedProcesses(
        RUN_ID,
        deps({ kill, sleep: async () => { sleeps++ } }),
      )

      expect(calls).toEqual([
        [100, 'SIGKILL'],
        [WRAPPER, 'SIGTERM'],
        [WRAPPER, 'SIGKILL'],
        [XVFB, 'SIGTERM'],
      ])
      // 3 polls of grace (300 ms) + 3 polls of SIGTERM wait (300 ms); the Xvfb died on SIGTERM.
      expect(sleeps).toBe(6)
      expect(fs.existsSync(path.join(procRoot, String(XAUTH)))).toBe(true)
      expect(result).toMatchObject({ found: 2, killed: 3, xvfbScanFailed: false })
    })

    it('SIGKILLs an Xvfb that survives both its wrapper dying on SIGTERM and its own SIGTERM', async () => {
      writeWrapperTree()
      const { calls, kill } = fakeKill({
        [WRAPPER]: () => {
          // Measured with dash: SIGTERM kills xvfb-run without its cleanup.
          removeProc(WRAPPER)
          reparent(XVFB, 1)
        },
        [XVFB]: sig => {
          if (sig === 'SIGKILL') removeProc(XVFB)
        },
      })

      const result = await reapRunMarkedProcesses(RUN_ID, deps({ kill }))

      expect(calls).toEqual([
        [100, 'SIGKILL'],
        [WRAPPER, 'SIGTERM'],
        [XVFB, 'SIGTERM'],
        [XVFB, 'SIGKILL'],
      ])
      expect(result).toMatchObject({ killed: 3 })
    })

    it('does not touch an Xvfb that is not the stuck wrapper child or not ours', async () => {
      writeWrapperTree()
      writeProc({ pid: XVFB, ppid: WRAPPER, uid: 1001, cmdline: nulArgv('Xvfb', ':99') })
      writeProc({ pid: 300, ppid: 1, cmdline: nulArgv('Xvfb', ':100') })
      const { calls, kill } = fakeKill({ [WRAPPER]: () => removeProc(WRAPPER) })

      await reapRunMarkedProcesses(RUN_ID, deps({ kill }))

      expect(calls).toEqual([[100, 'SIGKILL'], [WRAPPER, 'SIGTERM']])
    })
  })

  it('reports a failure to list the process table instead of an empty successful scan', async () => {
    const { calls, kill } = fakeKill()

    const missing = await reapRunMarkedProcesses(RUN_ID, deps({ kill, procRoot: path.join(procRoot, 'missing') }))
    expect(missing).toMatchObject({ status: 'scan-failed' })
    expect((missing as { error: string }).error).toContain('cannot list')

    const empty = await reapRunMarkedProcesses(RUN_ID, deps({ kill }))
    expect(empty).toMatchObject({ status: 'scan-failed' })
    expect((empty as { error: string }).error).toContain('no process entries')

    expect(calls).toEqual([])
  })
})
