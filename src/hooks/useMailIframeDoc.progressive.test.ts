// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useMailIframeDoc } from './useMailIframeDoc'
import type { AttachmentMeta, MailSummary, MessageDetails } from '../../packages/net/types'
import { pendingImageToken } from '../utils/pendingImages'
import { MAX_EXTERNAL_IMAGE_URLS } from '../utils/mail'

/**
 * §2.308 — progressive images. The body is shown as soon as it is sanitized;
 * inline (CID) and allowed external images are inert placeholders until their
 * bytes arrive, and are then written into the LIVE iframe document, without a
 * reload. An image that never arrives delays nothing.
 */
const mockInvoke = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
  writable: true,
})

const frameRef: { current: HTMLIFrameElement | null } = { current: null }

function active(uid = 1): MailSummary {
  return {
    accountId: 1, folder: 'INBOX', uid, subject: 's', from: 'a@test', fromAddr: 'a@test',
    date: '2026-01-01T00:00:00Z', unread: false, flagged: false, hasAttachments: false,
  }
}

function inline(part: string, cid: string): AttachmentMeta {
  return { part, filename: `${cid}.png`, contentType: 'image/png', size: 10, cid, disposition: 'inline' } as AttachmentMeta
}

function params(html: string, attachments: AttachmentMeta[] = [], over: Record<string, unknown> = {}) {
  const details: MessageDetails = { uid: 1, html, text: '', attachments }
  return {
    iframeRef: frameRef, active: active(), details, alwaysLoadImages: false, showExternalImages: false,
    darkModeEmails: false, theme: 'light' as const, quotedTextLabel: 'q', ...over,
  }
}

type Hook = { current: { doc: string | null; onIframeLoad: () => void; hiddenAttachments: AttachmentMeta[] } }

/** What React does: mount the current srcdoc into an iframe, then fire onLoad. */
function mount(result: Hook): Document {
  frameRef.current?.remove()
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const d = frame.contentDocument!
  d.open(); d.write(result.current.doc ?? ''); d.close()
  frameRef.current = frame
  act(() => { result.current.onIframeLoad() })
  return d
}

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const parts = (result: Hook) => result.current.hiddenAttachments.map(a => a.part)

/** Resolvable IPC replies, keyed by attachment part / external URL; the OLDEST open request is answered first. */
function controlledIpc() {
  const pending = new Map<string, Array<(v: unknown) => void>>()
  mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
    const key = channel === 'net:attachmentBase64' ? String(args[3]) : channel === 'net:fetchExternalImage' ? String(args[0]) : ''
    return new Promise(resolve => { pending.set(key, [...(pending.get(key) ?? []), resolve]) })
  })
  return {
    reply: (key: string, base64: string, contentType = 'image/png') => pending.get(key)!.shift()!({ ok: true, contentBase64: base64, contentType }),
    requested: (key: string) => (pending.get(key)?.length ?? 0) > 0,
  }
}

describe('useMailIframeDoc — progressive images (§2.308)', () => {
  beforeEach(() => { mockInvoke.mockReset(); frameRef.current = null })
  afterEach(() => { frameRef.current?.remove(); cleanup() })

  it('shows the text at once when an inline image never arrives, and keeps its chip', async () => {
    mockInvoke.mockImplementation(() => new Promise(() => { /* never settles */ }))
    const { result } = renderHook(p => useMailIframeDoc(p), { initialProps: params('<p>hello text</p><img src="cid:a@x">', [inline('1.1', 'a@x')]) })

    // No timers, no waiting: the body is there as soon as the effect ran.
    expect(result.current.doc).toContain('<p>hello text</p>')
    expect(result.current.doc).not.toContain('cid:a@x')
    const live = mount(result)
    await tick()
    expect(live.body.textContent).toContain('hello text')
    expect(parts(result)).toEqual([])
  })

  it('never leaves a cid: URL in the iframe: a reference with no part at all ends as the blocked-image placeholder', async () => {
    mockInvoke.mockImplementation(() => new Promise(() => { /* never settles */ }))
    const { result } = renderHook(p => useMailIframeDoc(p), {
      initialProps: params(
        '<p>text</p><img id="gone" src="cid:gone@x" alt="gap"><img id="have" src="cid:a@x"><div id="bg" style="background:url(cid:gone@x)"></div>',
        [inline('1.1', 'a@x')],
      ),
    })
    expect(result.current.doc).not.toMatch(/cid:gone/i)
    const live = mount(result)
    await tick()
    expect(live.getElementById('gone')!.getAttribute('src')).toContain('data:image/svg+xml')
    expect(live.getElementById('gone')!.getAttribute('src')).not.toMatch(/^cid:/i)
    expect(live.getElementById('gone')!.getAttribute('alt')).toBe('gap')
    expect(live.getElementById('bg')!.getAttribute('style')).not.toMatch(/cid:/i)
    expect(live.body.innerHTML).not.toMatch(/cid:/i)
    expect(parts(result)).toEqual([])
  })

  it.each([
    ['a refused reply', () => Promise.resolve({ ok: false, error: 'not found' })],
    ['a rejected request', () => Promise.reject(new Error('ipc failed'))],
  ])('an inline part that fails (%s) stays the placeholder in the live document, and its chip stays', async (_label, reply) => {
    mockInvoke.mockImplementation(reply)
    const { result } = renderHook(p => useMailIframeDoc(p), {
      initialProps: params('<p>t</p><img id="i1" src="cid:a@x">', [inline('1.1', 'a@x')]),
    })
    const live = mount(result)
    await tick(); await tick()
    expect(live.getElementById('i1')!.getAttribute('src')).toContain('data:image/svg+xml')
    expect(live.body.innerHTML).not.toMatch(/cid:/i)
    expect(parts(result)).toEqual([])
  })

  it('keeps an external url() hidden from the cid pass: no raw host text is left when a cid: sits inside its quotes', async () => {
    mockInvoke.mockImplementation(() => new Promise(() => { /* never settles */ }))
    const { result } = renderHook(p => useMailIframeDoc(p), {
      initialProps: params('<div style="background:url(&quot;//evil.example/a url(cid:b) c&quot;)">x</div>'),
    })
    expect(result.current.doc).not.toContain('evil.example')
    expect(result.current.doc).not.toMatch(/cid:b/i)
  })

  it('shows the text at once when an allowed external image never arrives', async () => {
    mockInvoke.mockImplementation(() => new Promise(() => { /* never settles */ }))
    const { result } = renderHook(p => useMailIframeDoc(p), {
      initialProps: params('<p>hello</p><img src="https://a.test/x.png">', [], { alwaysLoadImages: true }),
    })
    expect(result.current.doc).toContain('<p>hello</p>')
    expect(result.current.doc).not.toContain('a.test')
  })

  it('writes a late image into the same document without reloading it, one image at a time', async () => {
    const ipc = controlledIpc()
    const { result } = renderHook(p => useMailIframeDoc(p), {
      initialProps: params('<p id="keep">text</p><img id="i1" src="cid:a@x"><img id="i2" src="cid:b@x">', [inline('1.1', 'a@x'), inline('1.2', 'b@x')]),
    })
    const live = mount(result)
    const keep = live.getElementById('keep')
    expect(live.getElementById('i1')!.getAttribute('src')).toContain('data:image/svg+xml')

    ipc.reply('1.2', 'BBBB')
    await tick()
    expect(live.getElementById('i2')!.getAttribute('src')).toBe('data:image/png;base64,BBBB')
    expect(live.getElementById('i1')!.getAttribute('src')).not.toContain('base64')
    expect(parts(result)).toEqual(['1.2'])

    ipc.reply('1.1', 'AAAA')
    await tick()
    expect(live.getElementById('i1')!.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(parts(result).sort()).toEqual(['1.1', '1.2'])
    // Same document, same node: nothing was reloaded, so scroll position survives.
    expect(frameRef.current!.contentDocument).toBe(live)
    expect(live.getElementById('keep')).toBe(keep)
  })

  it('applies images that arrived before the iframe loaded when it does load', async () => {
    const ipc = controlledIpc()
    const { result } = renderHook(p => useMailIframeDoc(p), {
      initialProps: params('<img id="i1" src="cid:a@x">', [inline('1.1', 'a@x')]),
    })
    await waitFor(() => { expect(ipc.requested('1.1')).toBe(true) })
    ipc.reply('1.1', 'AAAA')
    await tick()
    expect(parts(result)).toEqual([]) // no document to write into yet: nothing claimed
    const live = mount(result)
    expect(live.getElementById('i1')!.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(parts(result)).toEqual(['1.1'])
  })

  it('re-applies arrived images when the iframe document is recreated', async () => {
    const ipc = controlledIpc()
    const { result } = renderHook(p => useMailIframeDoc(p), {
      initialProps: params('<img id="i1" src="cid:a@x">', [inline('1.1', 'a@x')]),
    })
    mount(result)
    ipc.reply('1.1', 'AAAA')
    await tick()
    const second = mount(result) // a fresh document from the same srcdoc
    expect(second.getElementById('i1')!.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('discards late bytes after the user moved to another message', async () => {
    const ipc = controlledIpc()
    const first = params('<p>first</p><img id="i1" src="cid:a@x">', [inline('1.1', 'a@x')])
    const { result, rerender } = renderHook((p: typeof first) => useMailIframeDoc(p), { initialProps: first })
    await waitFor(() => { expect(ipc.requested('1.1')).toBe(true) })

    // The next message reuses the same part number and Content-ID: a stale reply must still not land in it.
    const second = params('<p>second</p><img id="i1" src="cid:a@x">', [inline('1.1', 'a@x')], { active: active(2) })
    rerender(second)
    const live = mount(result)
    expect(live.body.textContent).toContain('second')

    ipc.reply('1.1', 'STALE')
    await tick()
    expect(live.documentElement.outerHTML).not.toContain('STALE')
    expect(live.getElementById('i1')!.getAttribute('src')).toContain('data:image/svg+xml')
    expect(parts(result)).toEqual([])
  })

  it('lets an external image arrive later and never exposes a raw URL at any moment', async () => {
    const ipc = controlledIpc()
    const { result } = renderHook(p => useMailIframeDoc(p), {
      initialProps: params(
        '<img id="i1" src="https://a.test/p.png"><div id="d" style="background-image:url(https://a.test/bg.png)"></div>',
        [], { alwaysLoadImages: true },
      ),
    })
    expect(result.current.doc).not.toMatch(/https?:\/\//)
    const live = mount(result)
    await waitFor(() => { expect(ipc.requested('https://a.test/p.png')).toBe(true) })
    expect(live.documentElement.outerHTML).not.toMatch(/https?:\/\/a\.test/)

    ipc.reply('https://a.test/p.png', 'PPPP')
    ipc.reply('https://a.test/bg.png', 'GGGG', 'image/webp')
    await tick()
    expect(live.getElementById('i1')!.getAttribute('src')).toBe('data:image/png;base64,PPPP')
    expect(live.getElementById('d')!.getAttribute('style')).toContain('data:image/webp;base64,GGGG')
    expect(live.documentElement.outerHTML).not.toMatch(/https?:\/\/a\.test/)
  })

  it('does not fetch anything for external images the user has not allowed', async () => {
    const { result } = renderHook(p => useMailIframeDoc(p), { initialProps: params('<img src="https://a.test/p.png">') })
    mount(result)
    await tick()
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(result.current.doc).not.toContain('a.test')
    expect(result.current.hasExternalImages).toBe(true)
  })

  it('refuses a reply whose content type is sender-controlled text, leaving placeholder and chip', async () => {
    const ipc = controlledIpc()
    const att = { ...inline('1.1', 'a@x'), contentType: 'image/png"onerror="x' } as AttachmentMeta
    const { result } = renderHook(p => useMailIframeDoc(p), { initialProps: params('<img id="i1" src="cid:a@x">', [att]) })
    const live = mount(result)
    await waitFor(() => { expect(ipc.requested('1.1')).toBe(true) })
    ipc.reply('1.1', 'AAAA', 'image/png"onerror="x')
    await tick()
    expect(live.getElementById('i1')!.getAttribute('src')).not.toContain('base64')
    expect(live.getElementById('i1')!.hasAttribute('onerror')).toBe(false)
    expect(parts(result)).toEqual([])
  })

  it('a token the sender wrote into the message is not patched and does not hide a chip', async () => {
    const ipc = controlledIpc()
    // Tokens carry a random per-run id, so a guess can not match; whatever the sender writes stays inert.
    const forged = pendingImageToken('0', 0)
    const { result } = renderHook(p => useMailIframeDoc(p), {
      initialProps: params(`<img id="f" src="${forged}"><img src="cid:a@x">`, [inline('1.1', 'a@x')]),
    })
    const live = mount(result)
    await waitFor(() => { expect(ipc.requested('1.1')).toBe(true) })
    ipc.reply('1.1', 'AAAA')
    await tick()
    expect(live.getElementById('f')!.getAttribute('src')).toBe(forged)
    expect(live.documentElement.innerHTML).toContain('base64,AAAA') // the real image landed, in its own place
  })

  it('fetches exactly the budgeted number of external images across all batches; the rest stay placeholders', async () => {
    mockInvoke.mockImplementation(async (channel: string) =>
      channel === 'net:fetchExternalImage' ? { ok: true, contentBase64: 'AAAA', contentType: 'image/png' } : { ok: false },
    )
    const total = MAX_EXTERNAL_IMAGE_URLS + 10
    const html = Array.from({ length: total }, (_, i) => `<img id="i${i}" src="https://a.test/${i}.png">`).join('')
    const { result } = renderHook(p => useMailIframeDoc(p), { initialProps: params(html, [], { alwaysLoadImages: true }) })
    expect(result.current.doc).not.toMatch(/https?:\/\//)
    const live = mount(result)

    // Every batch is answered; the sequence ends when the budgeted images are all in.
    await waitFor(() => {
      const drawn = Array.from(live.querySelectorAll('img')).filter(i => (i.getAttribute('src') ?? '').includes('base64,AAAA'))
      expect(drawn).toHaveLength(MAX_EXTERNAL_IMAGE_URLS)
    })
    expect(mockInvoke.mock.calls.filter(c => c[0] === 'net:fetchExternalImage')).toHaveLength(MAX_EXTERNAL_IMAGE_URLS)
    // The images past the budget are inert placeholders, never fetched, never raw URLs.
    for (let i = MAX_EXTERNAL_IMAGE_URLS; i < total; i++) {
      const src = live.getElementById(`i${i}`)!.getAttribute('src')!
      expect(src).toContain('data:image/svg+xml')
      expect(src).not.toContain('base64,')
    }
    expect(live.documentElement.outerHTML).not.toMatch(/https?:\/\/a\.test/)
  })
})
