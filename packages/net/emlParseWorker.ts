/**
 * §2.124 — worker entry for off-thread MIME parsing.
 *
 * Runs the two parses of the message-open path on the worker's own libuv
 * loop. The reason this matters is not CPU but event-loop turns: the MIME
 * splitter yields once per line (~1 turn per 77 bytes), and a turn on the
 * Electron main loop costs ~0.1–0.25 ms against ~3 µs here. See
 * `emlWorkerClient.ts` for the full measurement.
 *
 * The worker holds no state between jobs and touches nothing but the bytes it
 * is handed: no database, no filesystem, no network, no Electron API. One job
 * at a time — the client serialises — so a wedged job can be resolved by
 * terminating the thread without collateral damage.
 *
 * READINESS HANDSHAKE. The last thing this module does is announce itself, and
 * the client dispatches nothing until it hears that. The point is not startup
 * ordering — `postMessage` would queue anyway — it is ATTRIBUTION. Without an
 * announcement the client cannot tell "this thread never came up" from "this
 * thread came up and died on the bytes I gave it", and it resolved that
 * ambiguity by falling back to an inline parse — handing bytes that had just
 * killed a thread to the main process. With the handshake the two are
 * distinguishable by construction: a death BEFORE this line cannot have been
 * caused by a message, because no message had been sent.
 */
import { parentPort } from 'node:worker_threads'
import { extractIcsFromRawEmlInline, parseEmlBufferInline } from './eml'
import type { EmlWorkerRequest, EmlWorkerResponse } from './emlWorkerClient'

function toBuffer(view: Uint8Array): Buffer {
  return Buffer.isBuffer(view) ? view : Buffer.from(view.buffer, view.byteOffset, view.byteLength)
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function reply(message: EmlWorkerResponse): void {
  parentPort?.postMessage(message)
}

async function handle(request: EmlWorkerRequest): Promise<void> {
  try {
    if (request.type === 'parseDetails') {
      const details = await parseEmlBufferInline(request.uid, toBuffer(request.raw))
      reply({ id: request.id, ok: true, type: 'parseDetails', details })
      return
    }
    const ics = await extractIcsFromRawEmlInline(toBuffer(request.raw))
    reply({ id: request.id, ok: true, type: 'extractIcs', ics })
  } catch (err) {
    // Only the message text crosses back — never a fragment of the message
    // itself. mailparser's errors are structural ("Unexpected end of input"),
    // but a stack could still carry buffer slices in some failure modes.
    reply({ id: request.id, ok: false, error: describe(err) })
  }
}

parentPort?.on('message', (request: EmlWorkerRequest) => {
  void handle(request)
})

// Ordered deliberately: the handler above is installed first, so nothing can
// arrive before there is something to receive it. See READINESS HANDSHAKE.
reply({ ready: true })
