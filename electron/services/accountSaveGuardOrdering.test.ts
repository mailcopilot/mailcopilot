import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetAccountMeta = vi.hoisted(() => vi.fn())

vi.mock('../../packages/net/config', () => ({
  getAccountMeta: mockGetAccountMeta,
}))

import { saveAccountFenced } from './accountSaveFence'
import { saveAccountGuarded } from '../googleConnectPolicy'

/**
 * The guard of `accounts:save` and the per-id save queue, run together as real code
 * (the same composition as `electron/main.ts`). What this pins is the ORDER: the guard is judged against
 * the record the write will overwrite, read in the id's own queue turn, not against a record read before
 * the saves queued ahead of it have finished.
 */

type Mailbox = {
  authType: 'password' | 'oauth2'
  providerId: string
  imap: { host: string; user: string }
  smtp: { user: string }
}
type SaveInput = Partial<Pick<Mailbox, 'authType' | 'providerId'>> & { id?: number; imap: { host: string; user: string }; smtp: { user: string } }

const passwordRecord: Mailbox = {
  authType: 'password', providerId: 'generic-imap', imap: { host: 'imap.example.test', user: 'ada@example.test' }, smtp: { user: 'ada@example.test' },
}
const googleRecord: Mailbox = {
  authType: 'oauth2', providerId: 'gmail', imap: { host: 'imap.gmail.com', user: 'ada@gmail.com' }, smtp: { user: 'ada@gmail.com' },
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('guard and queue together: the guard is judged inside the queue', () => {
  let record: Mailbox | undefined
  const writes: string[] = []
  const held: Array<{ input: SaveInput; release: () => void }> = []

  /** The saver the queue wraps: a write that stays open until the test releases it, then replaces the record. */
  const hold = (input: SaveInput) => new Promise<{ id: number }>(resolve => {
    held.push({
      input,
      release: () => {
        record = {
          authType: input.authType ?? record?.authType ?? 'password',
          providerId: input.providerId ?? record?.providerId ?? 'generic-imap',
          imap: input.imap,
          smtp: input.smtp,
        }
        writes.push(`${input.imap.user}`)
        resolve({ id: input.id ?? 1 })
      },
    })
  })

  /** `accounts:save` as `main.ts` wires it. */
  const accountsSave = (input: SaveInput) => saveAccountGuarded(input, {
    getAccountMeta: (id) => mockGetAccountMeta(id),
    saveAccount: (i, gate) => saveAccountFenced(hold, i, gate),
  })

  beforeEach(() => {
    record = passwordRecord
    writes.length = 0
    held.length = 0
    mockGetAccountMeta.mockReset()
    mockGetAccountMeta.mockImplementation(() => record)
  })

  it('refuses a save that was checked against a password record but would write onto a Google one', async () => {
    // A: the Google connect turns the id into a Google sign-in record and is still inside its write.
    const connect = saveAccountFenced(hold, { id: 1, authType: 'oauth2', providerId: 'gmail', imap: googleRecord.imap, smtp: googleRecord.smtp })
    await flush()
    expect(held).toHaveLength(1)

    // B: an `accounts:save` from the renderer that only changes the address. Read now, the stored record is
    // still the password one, so the guard in front of the queue lets it through.
    const edit = accountsSave({ id: 1, imap: { host: 'imap.gmail.com', user: 'eve@gmail.com' }, smtp: { user: 'eve@gmail.com' } })
    const refused = expect(edit).rejects.toThrow('cannot be edited')
    await flush()
    expect(held).toHaveLength(1)

    held[0].release()
    await connect
    await refused

    // B never wrote.
    expect(held).toHaveLength(1)
    expect(writes).toEqual(['ada@gmail.com'])
    expect(record?.imap.user).toBe('ada@gmail.com')
  })

  it('lets the same save through when the record ahead of it left nothing the guard objects to', async () => {
    const first = saveAccountFenced(hold, { id: 1, imap: passwordRecord.imap, smtp: passwordRecord.smtp, signature: 'x' } as SaveInput)
    await flush()
    const edit = accountsSave({ id: 1, imap: { host: 'imap.example.test', user: 'eve@example.test' }, smtp: { user: 'eve@example.test' } })
    await flush()

    held[0].release()
    await first
    await flush()
    expect(held).toHaveLength(2)
    held[1].release()

    await expect(edit).resolves.toMatchObject({ id: 1 })
    expect(writes).toEqual(['ada@example.test', 'eve@example.test'])
  })

  it('returns the record the write overwrote — the one seen in the queue turn — as `previous`', async () => {
    const connect = saveAccountFenced(hold, { id: 1, authType: 'oauth2', providerId: 'gmail', imap: googleRecord.imap, smtp: googleRecord.smtp })
    await flush()
    // Same address: allowed on the Google record that A leaves behind (the edit form sends no provider change).
    const edit = accountsSave({ id: 1, imap: googleRecord.imap, smtp: googleRecord.smtp })
    await flush()

    held[0].release()
    await connect
    await flush()
    held[1].release()

    const res = await edit
    expect(res.previous).toMatchObject({ authType: 'oauth2', providerId: 'gmail' })
  })

  it('keeps serving later saves of the id after one was refused in the queue', async () => {
    const connect = saveAccountFenced(hold, { id: 1, authType: 'oauth2', providerId: 'gmail', imap: googleRecord.imap, smtp: googleRecord.smtp })
    await flush()
    const bad = accountsSave({ id: 1, imap: { host: 'imap.gmail.com', user: 'eve@gmail.com' }, smtp: { user: 'eve@gmail.com' } })
    const refused = expect(bad).rejects.toThrow()
    const good = accountsSave({ id: 1, imap: googleRecord.imap, smtp: googleRecord.smtp })
    await flush()

    held[0].release()
    await connect
    await refused
    await flush()
    expect(held).toHaveLength(2)
    held[1].release()

    await expect(good).resolves.toMatchObject({ id: 1 })
  })

  it('refuses a save whose record cannot be read, rather than judging nothing', async () => {
    mockGetAccountMeta.mockImplementationOnce(() => passwordRecord) // the guard in front of the queue
    mockGetAccountMeta.mockImplementationOnce(() => { throw new Error('store unavailable') }) // the queue turn

    await expect(accountsSave({ id: 1, imap: passwordRecord.imap, smtp: passwordRecord.smtp })).rejects.toThrow('store unavailable')
    expect(held).toHaveLength(0)
  })

  it('calls a gate with no record for a new account, and the guard refuses minting a Google one', async () => {
    const gate = vi.fn()
    const save = vi.fn(async (input: SaveInput) => ({ id: input.id ?? 9 }))
    await saveAccountFenced(save, { imap: passwordRecord.imap } as SaveInput, gate)
    expect(gate).toHaveBeenCalledWith(undefined)
    expect(mockGetAccountMeta).not.toHaveBeenCalled()

    await expect(accountsSave({ authType: 'oauth2', providerId: 'gmail', imap: googleRecord.imap, smtp: googleRecord.smtp }))
      .rejects.toThrow('can only be created by its sign-in flow')
    expect(held).toHaveLength(0)
  })

  it('does not read the store at all for a save without a gate', async () => {
    await saveAccountFenced(async () => ({ id: 1 }), { id: 1, imap: passwordRecord.imap })
    expect(mockGetAccountMeta).not.toHaveBeenCalled()
  })
})
