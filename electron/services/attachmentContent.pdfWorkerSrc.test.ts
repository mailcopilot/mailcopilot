import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * getPdfjs() (the private helper inside attachmentContent.ts that sets
 * `pdfjs.GlobalWorkerOptions.workerSrc`) is exercised HERE through
 * buildPdfContent() itself — not through pdfjsContract.test.ts, which pins
 * the URL-construction contract against the real pdfjs-dist module in
 * isolation, and would stay green even if attachmentContent.ts's own
 * getPdfjs() reverted to the bare-path form. This test instead proves
 * attachmentContent.ts's actual code writes that URL, by giving the mocked
 * pdfjs-dist module a real `GlobalWorkerOptions` object and reading back what
 * landed in `workerSrc` after a PDF is processed.
 *
 * Isolated into its own file (fresh module registry per test, via
 * vi.resetModules() + dynamic import) because getPdfjs() caches its result at
 * module scope (`_pdfjsModule`): the workerSrc assignment runs ONCE, on the
 * first call ever made against a given module instance. Sharing this
 * assertion with attachmentContent.test.ts would make it depend on running
 * before every other buildPdfContent test in that file — exactly the
 * "no dependencies between tests" rule this project's own test-gen policy
 * calls out.
 *
 * attachmentContent.test.ts's top-of-file mock of
 * `pdfjs-dist/legacy/build/pdf.mjs` deliberately omits `GlobalWorkerOptions`
 * — the assignment there throws ("Cannot set property 'workerSrc' of
 * undefined") and is silently swallowed by getPdfjs()'s `catch` (which exists
 * to handle "module missing", not this). That is why none of the existing
 * buildPdfContent tests would have caught the Windows regression: they never
 * let the assignment run at all.
 */

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

beforeEach(() => {
  vi.resetModules()
})

describe('attachmentContent getPdfjs() — worker script URL (2026-08-27 Windows fix)', () => {
  it('assigns workerSrc as a file:// URL, not a bare filesystem path', async () => {
    const rejection = Promise.reject(new Error('stop before real PDF parsing'))
    rejection.catch(() => { /* attachmentContent.ts awaits this; suppress the unhandled-rejection warning */ })
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      getDocument: vi.fn().mockReturnValue({
        // The document never needs to actually load — getPdfjs() (and its
        // workerSrc assignment) runs before this promise is even awaited.
        promise: rejection,
        destroy: vi.fn().mockResolvedValue(undefined),
      }),
      GlobalWorkerOptions: { workerSrc: '' },
    }))

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as {
      GlobalWorkerOptions: { workerSrc: string }
    }
    const { buildPdfContent } = await import('./attachmentContent')

    // The mocked rejection above routes buildPdfContent into its `catch` and
    // returns the "Failed to read PDF" text block — irrelevant here. What
    // matters is the side effect: getPdfjs() ran and wrote workerSrc before
    // the (mocked) document ever failed to load.
    const result = await buildPdfContent(Buffer.from('irrelevant'), 'doc.pdf')
    expect((result[0] as { text: string }).text).toContain('Failed to read PDF')

    expect(pdfjs.GlobalWorkerOptions.workerSrc).toMatch(/^file:\/\//)
    // The regression this pins: `require.resolve(...)` alone returns a bare
    // filesystem path. On POSIX that starts with '/' — exactly what the OLD
    // code (before the pathToFileURL wrap) would have produced here, and
    // exactly the shape that is `C:\...` on Windows and gets rejected by the
    // ESM loader ("Received protocol 'c:'").
    expect(pdfjs.GlobalWorkerOptions.workerSrc.startsWith('/')).toBe(false)
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toContain('pdf.worker.mjs')
  })
})
