// Real-ImapFlow reproduction of the mutation-outcome defects: a local TLS
// server speaks just enough IMAP for the library to log in, select a folder and
// run LIST / UID STORE / UID MOVE / UID COPY / UID EXPUNGE, and each command can
// be answered, refused (NO), left unanswered, or answered by dropping the
// connection. The installed ImapFlow does NOT throw in those cases: its mutation
// commands catch the failure and return `false`, so a test double that rejects
// (`mockRejectedValue`) checks behaviour the library does not have.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  setUnread: vi.fn(),
  setFlagged: vi.fn(),
  deleteMessages: vi.fn(),
  upsertMessages: vi.fn(),
  getMessageByUid: vi.fn(() => undefined),
}))
vi.mock('../db', () => db)

import crypto from 'node:crypto'
import tls from 'node:tls'
import type { AddressInfo } from 'node:net'
import {
  deleteMessagesRemote,
  forceDisconnectImap,
  listMailboxes,
  moveMessages,
  registerAuthErrorHandler,
  setSeen,
  unregisterAuthErrorHandler,
  __setOperationDeadlineForTest,
} from './imap'
import { isImapOutcomeUndetermined } from '@mailcopilot/core/transportFailure'
import type { ImapConfig } from './types'

const CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUe7O1zl0EPagr9e5/e/nBT6w7j/gwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwNDA4MjA1NloYDzIxMjYxMDEx
MDgyMDU2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATnXQay8TAFk6r1xgPQz1zEX6O4VCRJsjjIJj5H7OG1ImwnuIYUx1dX
ER1PMtuG36VxRW88HuMMyvs2Rz9fFY2to28wbTAdBgNVHQ4EFgQUzwpxW/YqbjSF
GathhZwqqEvBg6cwHwYDVR0jBBgwFoAUzwpxW/YqbjSFGathhZwqqEvBg6cwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIgPidcNoRWPYbO85sta+REk1dI8I6O5inXsHQBFcBO+4sCIQC2
AIOppvCwlqEh+W0MCqGwtkBGiJ2r3fvP+odUx+Vzrg==
-----END CERTIFICATE-----
`
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguOasucezz8VyHIG5
xJQLGwnCZ0gBCQcXiy4ir8Iou9WhRANCAATnXQay8TAFk6r1xgPQz1zEX6O4VCRJ
sjjIJj5H7OG1ImwnuIYUx1dXER1PMtuG36VxRW88HuMMyvs2Rz9fFY2t
-----END PRIVATE KEY-----
`


type Verdict = 'ok' | 'no' | 'drop' | 'drop-once' | 'hang' | 'chatter'

/** Answers every command with OK unless `script` names a verdict for its verb
 *  (`'UID STORE'`, `'UID MOVE'`, `'UID COPY'`, `'UID EXPUNGE'`, `'LIST'`, ...). */
async function startImapServer(opts: { caps?: string[]; script?: Record<string, Verdict>; searchResult?: number[]; greetingDelayMs?: number } = {}) {
  const commands: string[] = []
  const droppedOnce = new Set<string>()
  const caps = ['IMAP4rev1', ...(opts.caps ?? ['MOVE', 'UIDPLUS'])].join(' ')
  const server = tls.createServer({ cert: CERT, key: KEY }, (socket) => {
    closers.push(() => socket.destroy())
    const greet = () => { if (!socket.destroyed) socket.write(`* OK [CAPABILITY ${caps}] ready\r\n`) }
    if (opts.greetingDelayMs) setTimeout(greet, opts.greetingDelayMs)
    else greet()
    let buf = ''
    socket.on('error', () => { /* the test destroys sockets on purpose */ })
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const [tag, cmd = '', sub = ''] = line.split(' ')
        const verb = cmd.toUpperCase() === 'UID' ? `UID ${sub.toUpperCase()}` : cmd.toUpperCase()
        commands.push(verb)
        let verdict = opts.script?.[verb] ?? 'ok'
        if (verdict === 'drop-once') {
          verdict = droppedOnce.has(verb) ? 'ok' : 'drop'
          droppedOnce.add(verb)
        }
        if (verdict === 'drop') { socket.destroy(); return }
        if (verdict === 'hang') continue
        if (verdict === 'chatter') {
          const timer = setInterval(() => socket.write('* OK still working\r\n'), 20)
          closers.push(() => clearInterval(timer))
          socket.on('close', () => clearInterval(timer))
          continue
        }
        if (verdict === 'no') { socket.write(`${tag} NO [OVERQUOTA] refused\r\n`); continue }
        const uid = line.split(' ')[3] ?? '7'
        switch (verb) {
          case 'CAPABILITY': socket.write(`* CAPABILITY ${caps}\r\n${tag} OK done\r\n`); break
          case 'LOGIN': socket.write(`${tag} OK [CAPABILITY ${caps}] logged in\r\n`); break
          case 'LIST':
            socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Archive) "/" "Archive"\r\n')
            socket.write(`${tag} OK done\r\n`); break
          case 'STATUS': socket.write(`* STATUS "INBOX" (UNSEEN 1)\r\n${tag} OK done\r\n`); break
          case 'SELECT':
          case 'EXAMINE':
            socket.write('* 3 EXISTS\r\n* 0 RECENT\r\n* FLAGS (\\Seen \\Deleted \\Flagged)\r\n* OK [PERMANENTFLAGS (\\Seen \\Deleted \\Flagged \\*)] ok\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 20] ok\r\n')
            socket.write(`${tag} OK [READ-WRITE] selected\r\n`); break
          case 'UID MOVE': socket.write(`${tag} OK [COPYUID 1 ${uid} 1${uid}] moved\r\n`); break
          case 'UID COPY': socket.write(`${tag} OK [COPYUID 1 ${uid} 1${uid}] copied\r\n`); break
          case 'UID SEARCH': socket.write(`* SEARCH ${(opts.searchResult ?? []).join(' ')}\r\n${tag} OK done\r\n`); break
          case 'LOGOUT': socket.write(`* BYE bye\r\n${tag} OK done\r\n`); socket.end(); break
          default: socket.write(`${tag} OK done\r\n`)
        }
      }
    })
  })
  closers.push(() => server.close())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, commands }
}

const fingerprint = new crypto.X509Certificate(CERT).fingerprint256
const cfgFor = (port: number): ImapConfig => ({
  host: '127.0.0.1', port, secure: true, user: 'real@test.com', pass: 'p',
  tlsPinsSha256: [fingerprint], tlsPinnedCertsPem: [CERT],
})
const count = (commands: string[], verb: string) => commands.filter((c) => c === verb).length

const closers: Array<() => void> = []
beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  forceDisconnectImap()
  __setOperationDeadlineForTest(null)
  while (closers.length) closers.pop()!()
})

describe('mutation outcomes against the real ImapFlow', () => {
  it('control: a healthy server applies STORE and MOVE and the cache follows', async () => {
    const srv = await startImapServer()
    const cfg = cfgFor(srv.port)
    await setSeen(cfg, 'INBOX', [7], true, 81)
    expect(db.setUnread).toHaveBeenCalledTimes(1)
    await moveMessages(cfg, 'INBOX', 'Archive', [7], 81)
    expect(db.deleteMessages).toHaveBeenCalledTimes(1)
  })

  it('STORE whose connection drops after the command is an undetermined outcome, not a success', async () => {
    const srv = await startImapServer({ script: { 'UID STORE': 'drop' } })
    const caught = await setSeen(cfgFor(srv.port), 'INBOX', [7], true, 82).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    expect(isImapOutcomeUndetermined(caught)).toBe(true)
    expect(count(srv.commands, 'UID STORE')).toBe(1) // never re-sent
    expect(db.setUnread).not.toHaveBeenCalled() // the cache did not claim success
  }, 20_000)

  it('MOVE whose connection drops after the command is an undetermined outcome and is not re-sent', async () => {
    const srv = await startImapServer({ script: { 'UID MOVE': 'drop' } })
    const caught = await moveMessages(cfgFor(srv.port), 'INBOX', 'Archive', [7], 83).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    expect(isImapOutcomeUndetermined(caught)).toBe(true)
    expect(count(srv.commands, 'UID MOVE')).toBe(1)
    expect(db.deleteMessages).not.toHaveBeenCalled()
  }, 20_000)

  it('a server NO on a MOVE of ONE message is a plain failure: not retried, not reported as unknown', async () => {
    const srv = await startImapServer({ script: { 'UID MOVE': 'no' } })
    const caught = await moveMessages(cfgFor(srv.port), 'INBOX', 'Archive', [7], 84).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    expect(isImapOutcomeUndetermined(caught)).toBe(false)
    expect(count(srv.commands, 'UID MOVE')).toBe(1)
    expect(db.deleteMessages).not.toHaveBeenCalled()
  })

  it('a server NO on a MOVE of SEVERAL messages is an unknown outcome for the set (RFC 6851 §3.3: it may fail partway)', async () => {
    const srv = await startImapServer({ script: { 'UID MOVE': 'no' } })
    const caught = await moveMessages(cfgFor(srv.port), 'INBOX', 'Archive', [7, 8], 84).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    expect(isImapOutcomeUndetermined(caught)).toBe(true)
    expect(count(srv.commands, 'UID MOVE')).toBe(1) // not re-sent
    expect(db.deleteMessages).not.toHaveBeenCalled()
  })

  it('a server NO on STORE is a plain failure and does not update the cache', async () => {
    const srv = await startImapServer({ script: { 'UID STORE': 'no' } })
    const caught = await setSeen(cfgFor(srv.port), 'INBOX', [7], true, 85).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    expect(isImapOutcomeUndetermined(caught)).toBe(false)
    expect(db.setUnread).not.toHaveBeenCalled()
  })

  describe('a server without MOVE (RFC 6851): COPY, then STORE \\Deleted, then UID EXPUNGE', () => {
    it('a refused COPY (OVERQUOTA) leaves the original untouched on the server and in the cache', async () => {
      const srv = await startImapServer({ caps: ['UIDPLUS'], script: { 'UID COPY': 'no' } })
      const caught = await moveMessages(cfgFor(srv.port), 'INBOX', 'Archive', [7], 86).catch((e: unknown) => e)
      expect(caught).toBeInstanceOf(Error)
      expect(isImapOutcomeUndetermined(caught)).toBe(false)
      // The defect: the library went on to flag \Deleted and expunge after the refused COPY.
      expect(count(srv.commands, 'UID STORE')).toBe(0)
      expect(count(srv.commands, 'UID EXPUNGE')).toBe(0)
      expect(db.deleteMessages).not.toHaveBeenCalled()
    })

    it('COPY done, then the connection drops during STORE: unknown outcome, the original stays in the cache', async () => {
      const srv = await startImapServer({ caps: ['UIDPLUS'], script: { 'UID STORE': 'drop' } })
      const caught = await moveMessages(cfgFor(srv.port), 'INBOX', 'Archive', [7], 87).catch((e: unknown) => e)
      expect(caught).toBeInstanceOf(Error)
      expect(isImapOutcomeUndetermined(caught)).toBe(true)
      expect(count(srv.commands, 'UID COPY')).toBe(1) // not re-copied: no duplicate
      expect(db.deleteMessages).not.toHaveBeenCalled()
    }, 20_000)

    it('COPY and STORE done, EXPUNGE refused: incomplete move is reported as unknown, cache untouched', async () => {
      const srv = await startImapServer({ caps: ['UIDPLUS'], script: { 'UID EXPUNGE': 'no' } })
      const caught = await moveMessages(cfgFor(srv.port), 'INBOX', 'Archive', [7], 88).catch((e: unknown) => e)
      expect(isImapOutcomeUndetermined(caught)).toBe(true)
      expect(db.deleteMessages).not.toHaveBeenCalled()
    })

    it('the happy path moves with COPY + STORE + UID EXPUNGE', async () => {
      const srv = await startImapServer({ caps: ['UIDPLUS'] })
      await moveMessages(cfgFor(srv.port), 'INBOX', 'Archive', [7], 89)
      expect(count(srv.commands, 'UID COPY')).toBe(1)
      expect(count(srv.commands, 'UID STORE')).toBeGreaterThanOrEqual(1)
      expect(count(srv.commands, 'UID EXPUNGE')).toBe(1)
      expect(db.deleteMessages).toHaveBeenCalledTimes(1)
    })
  })

  it('deleteMessagesRemote: a refused STORE \\Deleted is a failure, not a silent "deleted"', async () => {
    const srv = await startImapServer({ script: { 'UID STORE': 'no' } })
    const caught = await deleteMessagesRemote(cfgFor(srv.port), 'INBOX', [7], 90).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    expect(db.deleteMessages).not.toHaveBeenCalled()
  })
})

describe('deleteMessagesRemote: flag, then expunge only our UIDs', () => {
  it('with UIDPLUS: a drop during UID EXPUNGE is an unknown outcome and is not re-sent', async () => {
    const srv = await startImapServer({ script: { 'UID EXPUNGE': 'drop' } })
    const caught = await deleteMessagesRemote(cfgFor(srv.port), 'INBOX', [7], 94).catch((e: unknown) => e)
    expect(isImapOutcomeUndetermined(caught)).toBe(true)
    expect(count(srv.commands, 'UID EXPUNGE')).toBe(1)
    expect(db.deleteMessages).not.toHaveBeenCalled()
  }, 20_000)

  it('without UIDPLUS and with no one else\'s \\Deleted mail: STORE, then a plain EXPUNGE', async () => {
    const srv = await startImapServer({ caps: [], searchResult: [] })
    await deleteMessagesRemote(cfgFor(srv.port), 'INBOX', [7], 95)
    expect(count(srv.commands, 'EXPUNGE')).toBe(1)
    expect(db.deleteMessages).toHaveBeenCalledTimes(1)
  })

  it('without UIDPLUS and with someone else\'s \\Deleted mail present: only flag ours, never EXPUNGE', async () => {
    const srv = await startImapServer({ caps: [], searchResult: [99] })
    await deleteMessagesRemote(cfgFor(srv.port), 'INBOX', [7], 96)
    expect(count(srv.commands, 'UID STORE')).toBe(1)
    expect(count(srv.commands, 'EXPUNGE')).toBe(0)
    expect(count(srv.commands, 'UID EXPUNGE')).toBe(0)
  })

  it('a drop during the READ-ONLY search for foreign \\Deleted mail precedes any mutation, so it is retried', async () => {
    const srv = await startImapServer({ caps: [], searchResult: [], script: { 'UID SEARCH': 'drop-once' } })
    await deleteMessagesRemote(cfgFor(srv.port), 'INBOX', [7], 97)
    expect(count(srv.commands, 'UID SEARCH')).toBe(2)
    expect(count(srv.commands, 'EXPUNGE')).toBe(1)
  }, 20_000)
})

describe('a failed read is not an empty result', () => {
  it('a refused SEARCH for foreign \\Deleted mail never turns into a broad EXPUNGE', async () => {
    const srv = await startImapServer({ caps: [], script: { 'UID SEARCH': 'no' } })
    const caught = await deleteMessagesRemote(cfgFor(srv.port), 'INBOX', [7], 98).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    expect(count(srv.commands, 'EXPUNGE')).toBe(0)
    expect(count(srv.commands, 'UID STORE')).toBe(0)
    expect(db.deleteMessages).not.toHaveBeenCalled()
  })
})

describe('a mutation is never re-sent after an OAuth token refresh', () => {
  afterEach(() => unregisterAuthErrorHandler(91))

  it('an auth-looking failure after MOVE was sent does not invoke the refresh handler or re-run MOVE', async () => {
    // The source folder is called LOGIN: any text that mentions it used to read as an auth failure.
    const srv = await startImapServer({ script: { 'UID MOVE': 'drop' } })
    const refresh = vi.fn().mockResolvedValue('fresh-token')
    registerAuthErrorHandler(91, refresh)
    await moveMessages(cfgFor(srv.port), 'LOGIN', 'Archive', [7], 91).catch(() => undefined)
    expect(refresh).not.toHaveBeenCalled()
    expect(count(srv.commands, 'UID MOVE')).toBe(1)
  }, 20_000)
})

describe('an operation has an overall deadline', () => {
  it('a LIST that keeps trickling untagged OK lines but never completes ends at the deadline, once, and frees the connection', async () => {
    const srv = await startImapServer({ script: { LIST: 'chatter' } })
    __setOperationDeadlineForTest(600)
    const cfg = cfgFor(srv.port)
    const started = Date.now()
    const caught = await listMailboxes(92, cfg).catch((e: unknown) => e)
    const elapsed = Date.now() - started
    expect((caught as { code?: string }).code).toBe('ERR_IMAP_OPERATION_DEADLINE')
    expect(elapsed).toBeGreaterThanOrEqual(550)
    expect(elapsed).toBeLessThan(5_000)
    // The singleton was released: the next operation on the same account proceeds.
    __setOperationDeadlineForTest(null)
    const okSrv = await startImapServer()
    await expect(listMailboxes(92, cfgFor(okSrv.port))).resolves.toBeDefined()
  }, 20_000)

  it('an attempt abandoned while still CONNECTING never completes, publishes, or mutates afterwards', async () => {
    // The server holds its greeting back past the deadline, then speaks.
    const srv = await startImapServer({ greetingDelayMs: 1_200 })
    __setOperationDeadlineForTest(400)
    const caught = await moveMessages(cfgFor(srv.port), 'INBOX', 'Archive', [7], 99).catch((e: unknown) => e)
    expect((caught as { code?: string }).code).toBe('ERR_IMAP_OPERATION_DEADLINE')
    // The dropped attempt would have logged in, selected the folder and moved the
    // message once the greeting arrived. Let it arrive, and look.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(count(srv.commands, 'UID MOVE')).toBe(0)
    expect(count(srv.commands, 'UID COPY')).toBe(0)
    expect(count(srv.commands, 'LOGIN')).toBe(0)
    expect(db.deleteMessages).not.toHaveBeenCalled()
    // And the singleton is free for the next operation.
    __setOperationDeadlineForTest(null)
    const okSrv = await startImapServer()
    await expect(moveMessages(cfgFor(okSrv.port), 'INBOX', 'Archive', [7], 99)).resolves.toBeUndefined()
  }, 20_000)

  it('an attempt abandoned while the PREVIOUS account is still logging out never connects to the next one', async () => {
    // Account X's server never completes LOGOUT; a deadline-bound operation on
    // account Y has to log X out before it can connect, and stalls there.
    const x = await startImapServer({ script: { LOGOUT: 'chatter' } })
    const y = await startImapServer()
    await setSeen(cfgFor(x.port), 'INBOX', [7], true, 100)
    __setOperationDeadlineForTest(600)
    const caught = await setSeen(cfgFor(y.port), 'INBOX', [7], true, 101).catch((e: unknown) => e)
    expect((caught as { code?: string }).code).toBe('ERR_IMAP_OPERATION_DEADLINE')
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(y.commands).toEqual([]) // not even a LOGIN reached the second server
  }, 20_000)

  it('a mutation cut off by the deadline is reported as an undetermined outcome', async () => {
    const srv = await startImapServer({ script: { 'UID STORE': 'hang' } })
    __setOperationDeadlineForTest(600)
    const caught = await setSeen(cfgFor(srv.port), 'INBOX', [7], true, 93).catch((e: unknown) => e)
    expect((caught as { code?: string }).code).toBe('ERR_IMAP_OPERATION_DEADLINE')
    expect(isImapOutcomeUndetermined(caught)).toBe(true)
    expect(count(srv.commands, 'UID STORE')).toBe(1)
  }, 20_000)
})
