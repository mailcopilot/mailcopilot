import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// The only mock in this file, and it is not a pdfjs one: `attachmentContent`
// logs through `electron-log/main`, which needs an Electron runtime. Stubbing
// the logger keeps the production adapter importable under plain vitest while
// leaving `pdfjs-dist` itself completely real.
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

/**
 * §2.110 — pdfjs-dist crossed a MAJOR (5.4.624 → 6.2.108). Every other pdfjs
 * test in this repo (attachmentContent.test.ts) mocks `getDocument()` and its
 * whole document/page/task shape entirely, so none of them would have failed
 * if the real 6.x API had actually changed underneath the mocks — and it did:
 * `PDFDocumentProxy.destroy()` was dropped, and `attachmentContent.ts` now
 * tears down through the LOADING TASK instead (see the comment above
 * `extractPdfText`). A mock suite cannot catch that class of break by
 * construction.
 *
 * This file drives the actual `pdfjs-dist` package — unmocked — against a
 * minimal, hand-built PDF (valid PDF 1.4 built as a template string; no
 * binary fixture to keep in the repo). It pins exactly the API surface
 * `attachmentContent.ts` depends on, so a future pdfjs bump that removes or
 * reshapes any of it fails here first, not as a silent behavior change behind
 * mocks. Runs under plain vitest — pdfjs's legacy Node build needs no
 * Electron or DOM.
 */

const require = createRequire(import.meta.url)

/** Builds a minimal, valid single-page PDF containing the given text lines. */
function buildPdf(lines: string[]): Buffer {
  const stream = ['BT', '/F1 24 Tf', '72 700 Td']
    .concat(lines.map((l, i) => (i === 0 ? `(${l}) Tj` : `0 -30 Td (${l}) Tj`)))
    .concat(['ET'])
    .join('\n')
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

describe('pdfjs-dist 6.x contract (real module)', () => {
  it('resolves the worker script as a file URL, the same way attachmentContent.ts does', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    // This is the exact call `getPdfjs()` makes; if the export path moves in
    // a future major, this throws instead of `attachmentContent.ts` silently
    // falling back to "process in main thread" for every PDF.
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
    expect(workerPath).toContain('pdf.worker.mjs')

    // The URL form is the whole point, and asserting it is what this test was
    // missing: a bare filesystem path is accepted on POSIX and rejected by the
    // ESM loader on Windows ("Received protocol 'c:'"), which made every PDF
    // attachment fail there while this test stayed green. Assert the scheme
    // rather than the platform, so the guarantee holds on the machine that
    // does not reproduce the bug.
    const workerSrc = pathToFileURL(workerPath).href
    expect(workerSrc.startsWith('file://')).toBe(true)
    expect(/^[a-zA-Z]:[\\/]/.test(workerSrc)).toBe(false)

    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe(workerSrc)
    // Explicit budget, not the 5 s default: this case pays for the FIRST import
    // of the real pdfjs bundle in the worker, which takes ~2.6 s idle and
    // overruns the default under a full parallel `npm test` — a red that says
    // nothing about the contract being asserted.
  }, 30_000)

  it('extracts exact text and page count from a generated PDF, then tears down via the task', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const expectedLines = ['Hello World', 'This is a test document with enough text', 'Third line here']
    const task = pdfjs.getDocument({ data: new Uint8Array(buildPdf(expectedLines)) })
    const doc = await task.promise

    expect(doc.numPages).toBe(1)

    const page = await doc.getPage(1)
    const content = await page.getTextContent()
    const text = content.items
      .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
      .map(item => item.str)
      .join(' ')

    // Exact match, not `.toContain` — pins the whitespace-joining behavior
    // `extractPdfText` relies on (`.join(' ')` across text run items).
    expect(text).toBe('Hello World This is a test document with enough text Third line here')

    // §2.110 — pdfjs 6 dropped PDFDocumentProxy.destroy(). A revert of
    // attachmentContent.ts to `doc.destroy()` must fail loudly, not silently
    // stop releasing the worker.
    expect((doc as unknown as { destroy?: unknown }).destroy).toBeUndefined()
    expect(typeof task.destroy).toBe('function')

    await expect(task.destroy()).resolves.toBeUndefined()
  })

  it('exposes the operatorList / objs.get shape renderPdfAsImages depends on', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: new Uint8Array(buildPdf(['scan'])) })
    const doc = await task.promise
    try {
      const page = await doc.getPage(1)
      const ops = await page.getOperatorList()
      expect(Array.isArray(ops.fnArray)).toBe(true)
      expect(Array.isArray(ops.argsArray)).toBe(true)
      expect(typeof page.objs.get).toBe('function')
      // The named operator constants `extractPageImage` matches against.
      expect(typeof pdfjs.OPS.paintImageXObject).toBe('number')
    } finally {
      await task.destroy()
    }
  })

  // The three cases above pin pdfjs's own shapes, which is necessary but not
  // sufficient: they would all still pass if `attachmentContent.ts` reverted to
  // the pdfjs 5 `doc.destroy()` teardown, because nothing there runs OUR code.
  // The mocked suite cannot cover it either — its mocks supply whatever shape
  // they are told to. So drive the production entry point over the real module.
  it('runs the production adapter end to end over the real module', async () => {
    const { buildPdfContent } = await import('./attachmentContent')
    const lines = ['Hello World', 'This is a test document with enough text', 'Third line here']

    const blocks = await buildPdfContent(buildPdf(lines), 'contract.pdf')

    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
    const text = (blocks[0] as { text: string }).text
    // A teardown that throws (a `doc.destroy()` revert) surfaces here as the
    // caught failure string rather than extracted text.
    expect(text).not.toContain('Failed to read PDF')
    expect(text).toContain('[PDF: contract.pdf, 1 pages]')
    for (const line of lines) expect(text).toContain(line)
    // The untrusted-content boundary still wraps the extracted body.
    expect(text).toContain('<<<UNTRUSTED_EMAIL_DATA>>>')
    expect(text).toContain('<<<END_UNTRUSTED_EMAIL_DATA>>>')
  })
})
