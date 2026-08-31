/**
 * §2.124 — the worker entry's side of the protocol. Driven through a fake
 * `parentPort` instead of a real thread, so the specs assert the contract
 * (one reply per request, correlation id preserved, failures reported rather
 * than thrown into the void) without paying for thread startup.
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EmlWorkerResponse } from './emlWorkerClient'

type FakePort = EventEmitter & { postMessage: (msg: EmlWorkerResponse) => void }

type JobReply = Exclude<EmlWorkerResponse, { ready: true }>

function makePort(): { port: FakePort; sent: EmlWorkerResponse[] } {
  const sent: EmlWorkerResponse[] = []
  const port = new EventEmitter() as FakePort
  port.postMessage = (msg: EmlWorkerResponse) => { sent.push(msg) }
  return { port, sent }
}

/** Everything the entry posts except the readiness announcement, which every
 *  load emits and which no request causes. */
function replies(sent: EmlWorkerResponse[]): JobReply[] {
  return sent.filter((msg): msg is JobReply => !('ready' in msg))
}

/** Load the worker entry against a fake parentPort. Optionally swap `./eml`
 *  so a spec can force a parse failure. */
async function loadEntry(emlOverride?: Record<string, unknown>) {
  vi.resetModules()
  const { port, sent } = makePort()
  vi.doMock('node:worker_threads', () => ({ parentPort: port }))
  if (emlOverride) vi.doMock('./eml', () => emlOverride)
  await import('./emlParseWorker')
  return { port, sent }
}

/** Waits for the entry's async handler to post its reply. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve))
}

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:evt-1@example.com',
  'DTSTART:20260901T090000Z',
  'SUMMARY:Standup',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

function plainMessage(): Buffer {
  return Buffer.from([
    'From: Alice <alice@example.com>',
    'To: Bob <bob@example.com>',
    'Subject: Hello there',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Body text.',
    '',
  ].join('\r\n'), 'utf8')
}

function inviteMessage(): Buffer {
  return Buffer.from([
    'From: Alice <alice@example.com>',
    'To: Bob <bob@example.com>',
    'Subject: Invite',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please come.',
    '--B',
    'Content-Type: text/calendar; charset=utf-8; method=REQUEST',
    'Content-Disposition: attachment; filename="invite.ics"',
    '',
    ICS,
    '--B--',
    '',
  ].join('\r\n'), 'utf8')
}

afterEach(() => {
  vi.doUnmock('node:worker_threads')
  vi.doUnmock('./eml')
  vi.resetModules()
})

describe('§2.124 EML parse worker entry', () => {
  it('announces itself on load, before any request is served', async () => {
    const { sent } = await loadEntry()

    // The client refuses to dispatch untrusted bytes until it sees this, and
    // uses "died before it" as proof that a death was not caused by a message.
    // Without the announcement the entry looks identical to a thread that
    // never came up.
    expect(sent).toEqual([{ ready: true }])
  })

  it('installs its request handler before announcing, not after', async () => {
    const { port, sent } = await loadEntry()

    // Emitting immediately after load stands in for a client that dispatches
    // the instant it hears the announcement: if the entry announced first and
    // subscribed second, this request would land on nothing and never be
    // answered.
    port.emit('message', { id: 1, type: 'parseDetails', uid: 3, raw: plainMessage() })
    await drain()

    expect(replies(sent)).toHaveLength(1)
    expect(replies(sent)[0]).toMatchObject({ id: 1, ok: true })
  })

  it('answers a parseDetails request with the parsed message and the same id', async () => {
    const { port, sent } = await loadEntry()

    port.emit('message', { id: 7, type: 'parseDetails', uid: 99, raw: plainMessage() })
    await drain()

    expect(replies(sent)).toHaveLength(1)
    const reply = replies(sent)[0]
    expect(reply).toMatchObject({ id: 7, ok: true, type: 'parseDetails' })
    if (reply.ok && reply.type === 'parseDetails') {
      expect(reply.details.uid).toBe(99)
      expect(reply.details.envelope?.subject).toBe('Hello there')
      expect(reply.details.text?.trim()).toBe('Body text.')
    }
  })

  it('accepts the plain Uint8Array that structured clone actually delivers', async () => {
    const { port, sent } = await loadEntry()
    const buf = plainMessage()
    // A Buffer sent through postMessage arrives on the other side as a
    // Uint8Array view, not as a Buffer.
    const view = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))

    port.emit('message', { id: 8, type: 'parseDetails', uid: 1, raw: view })
    await drain()

    const reply = replies(sent)[0]
    expect(reply.ok).toBe(true)
    if (reply.ok && reply.type === 'parseDetails') {
      expect(reply.details.envelope?.subject).toBe('Hello there')
    }
  })

  it('answers an extractIcs request with the calendar payload', async () => {
    const { port, sent } = await loadEntry()

    port.emit('message', { id: 9, type: 'extractIcs', raw: inviteMessage() })
    await drain()

    const reply = replies(sent)[0]
    expect(reply).toMatchObject({ id: 9, ok: true, type: 'extractIcs' })
    if (reply.ok && reply.type === 'extractIcs') {
      expect(reply.ics).toContain('BEGIN:VCALENDAR')
      expect(reply.ics).toContain('UID:evt-1@example.com')
    }
  })

  it('answers extractIcs with undefined when the message carries no invite', async () => {
    const { port, sent } = await loadEntry()

    port.emit('message', { id: 10, type: 'extractIcs', raw: plainMessage() })
    await drain()

    const reply = replies(sent)[0]
    expect(reply).toMatchObject({ id: 10, ok: true, type: 'extractIcs' })
    if (reply.ok && reply.type === 'extractIcs') expect(reply.ics).toBeUndefined()
  })

  it('reports a parse failure back over the protocol instead of dying', async () => {
    const { port, sent } = await loadEntry({
      parseEmlBufferInline: vi.fn().mockRejectedValue(new Error('malformed MIME midway')),
      extractIcsFromRawEmlInline: vi.fn().mockResolvedValue(undefined),
    })

    port.emit('message', { id: 11, type: 'parseDetails', uid: 5, raw: plainMessage() })
    await drain()

    expect(replies(sent)).toHaveLength(1)
    expect(replies(sent)[0]).toEqual({ id: 11, ok: false, error: 'malformed MIME midway' })
  })

  it('keeps serving after a failed request', async () => {
    const parseInline = vi.fn()
      .mockRejectedValueOnce(new Error('first one is bad'))
      .mockResolvedValueOnce({ uid: 2, envelope: { subject: 'second' } })
    const { port, sent } = await loadEntry({
      parseEmlBufferInline: parseInline,
      extractIcsFromRawEmlInline: vi.fn().mockResolvedValue(undefined),
    })

    port.emit('message', { id: 12, type: 'parseDetails', uid: 1, raw: plainMessage() })
    await drain()
    port.emit('message', { id: 13, type: 'parseDetails', uid: 2, raw: plainMessage() })
    await drain()

    expect(replies(sent)).toHaveLength(2)
    expect(replies(sent)[0]).toMatchObject({ id: 12, ok: false })
    expect(replies(sent)[1]).toMatchObject({ id: 13, ok: true })
  })
})
