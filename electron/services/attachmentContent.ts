/**
 * Utilities for processing attachment content:
 * MIME type classification, text extraction, PDF rendering.
 */

import { createLogger } from '../logger'

const log = createLogger('AttachmentContent')

// --- Constants ---

export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024 // 10 MB
export const MAX_TEXT_CHARS = 50_000 // 50K characters (~12.5K tokens)
export const MAX_PDF_RENDER_PAGES = 5 // max pages for rendering scanned PDFs
export const MAX_IMAGE_DIMENSION = 1024 // max width/height in pixels for AI context
export const MAX_IMAGE_BASE64_BYTES = 150_000 // max base64 output size (~37K tokens)
export const MAX_PDF_SCAN_DIMENSION = 1200 // max dimension for PDF scan page renders
const MIN_TEXT_LENGTH = 50 // threshold for determining "empty" text in PDF

// --- Content classification ---

export type ContentCategory = 'text' | 'image' | 'pdf' | 'unsupported'

const TEXT_MIME_SET = new Set([
  'text/plain', 'text/csv', 'text/html', 'text/xml', 'text/markdown',
  'text/css', 'text/javascript',
  'application/json', 'application/xml', 'application/javascript',
  'application/x-yaml', 'application/toml', 'application/x-sh',
])

const TEXT_EXTENSIONS = new Set([
  '.txt', '.csv', '.json', '.xml', '.html', '.htm', '.md', '.log',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.sh', '.bash',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.css', '.sql', '.env',
])

const IMAGE_MIME_SET = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
])

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
])

export function classifyContent(contentType?: string, filename?: string): ContentCategory {
  const mime = (contentType || '').toLowerCase().split(';')[0].trim()

  if (IMAGE_MIME_SET.has(mime)) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (TEXT_MIME_SET.has(mime) || mime.startsWith('text/')) return 'text'

  // fallback by file extension
  if (filename) {
    const dotIdx = filename.lastIndexOf('.')
    if (dotIdx >= 0) {
      const ext = filename.slice(dotIdx).toLowerCase()
      if (TEXT_EXTENSIONS.has(ext)) return 'text'
      if (ext === '.pdf') return 'pdf'
      if (IMAGE_EXTENSIONS.has(ext)) return 'image'
    }
  }

  return 'unsupported'
}

// --- Types for MCP tool result content ---

type TextContentBlock = { type: 'text'; text: string }
type ImageContentBlock = { type: 'image'; data: string; mimeType: string }
type ContentBlock = TextContentBlock | ImageContentBlock

// --- Content building ---

export function buildTextContent(buffer: Buffer, filename?: string): ContentBlock[] {
  let text = buffer.toString('utf-8')
  const truncated = text.length > MAX_TEXT_CHARS
  if (truncated) {
    text = text.slice(0, MAX_TEXT_CHARS)
  }
  const header = filename ? `[File: ${filename}]` : '[File content]'
  const suffix = truncated ? `\n\n[... truncated, total ${buffer.length} bytes]` : ''
  return [{ type: 'text' as const, text: `${header}\n<<<UNTRUSTED_EMAIL_DATA>>>\n${text}\n<<<END_UNTRUSTED_EMAIL_DATA>>>${suffix}` }]
}

/**
 * Build image content for AI, resizing if the image is too large.
 * Uses @napi-rs/canvas to downscale oversized images and re-encodes as JPEG
 * to keep base64 payload within token budget.
 */
export async function buildImageContent(buffer: Buffer, mimeType: string): Promise<ContentBlock[]> {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const img = await loadImage(buffer)
    let w = img.width
    let h = img.height

    // Check if resizing is needed
    const maxDim = Math.max(w, h)
    const base64Len = Math.ceil(buffer.length * 4 / 3)
    const needsResize = maxDim > MAX_IMAGE_DIMENSION || base64Len > MAX_IMAGE_BASE64_BYTES

    if (!needsResize) {
      return [{ type: 'image' as const, data: buffer.toString('base64'), mimeType }]
    }

    // Downscale to fit within MAX_IMAGE_DIMENSION
    if (maxDim > MAX_IMAGE_DIMENSION) {
      const scale = MAX_IMAGE_DIMENSION / maxDim
      w = Math.round(w * scale)
      h = Math.round(h * scale)
    }

    // Render on canvas and encode as JPEG for smaller size
    let outBuf = renderOnCanvas(createCanvas, img, w, h, 'image/jpeg', 80)

    // If still too large, halve dimensions iteratively
    while (outBuf.length > MAX_IMAGE_BASE64_BYTES && w > 64 && h > 64) {
      w = Math.round(w / 2)
      h = Math.round(h / 2)
      outBuf = renderOnCanvas(createCanvas, img, w, h, 'image/jpeg', 70)
    }

    log.info(`Image resized: ${img.width}x${img.height} → ${w}x${h}, ${buffer.length} → ${outBuf.length} bytes`)
    return [{ type: 'image' as const, data: outBuf.toString('base64'), mimeType: 'image/jpeg' }]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`Image processing failed, returning as-is: ${msg}`)
    // Fallback: if image is too large even without processing, return text notice
    const base64Len = Math.ceil(buffer.length * 4 / 3)
    if (base64Len > MAX_IMAGE_BASE64_BYTES) {
      return [{ type: 'text' as const, text: `[Image too large for AI context: ${(buffer.length / 1024).toFixed(0)} KB. Processing failed: ${msg}]` }]
    }
    return [{ type: 'image' as const, data: buffer.toString('base64'), mimeType }]
  }
}

/** Render an image onto a canvas at the given dimensions and encode. */
function renderOnCanvas(
  createCanvas: typeof import('@napi-rs/canvas').createCanvas,
  img: { width: number; height: number },
  w: number,
  h: number,
  format: 'image/jpeg' | 'image/png',
  quality?: number,
): Buffer {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img as never, 0, 0, w, h)
  if (format === 'image/jpeg') {
    return Buffer.from(quality != null ? canvas.toBuffer(format, quality) : canvas.toBuffer(format))
  }
  return Buffer.from(canvas.toBuffer(format))
}

export async function buildPdfContent(buffer: Buffer, filename?: string): Promise<ContentBlock[]> {
  try {
    // Step 1: extract text via pdfjs-dist
    const { text, numPages } = await extractPdfText(buffer)

    if (text.length >= MIN_TEXT_LENGTH) {
      // Text-based PDF — return text
      const truncated = text.length > MAX_TEXT_CHARS
      const trimmed = truncated ? text.slice(0, MAX_TEXT_CHARS) : text
      const header = filename
        ? `[PDF: ${filename}, ${numPages} pages]`
        : `[PDF, ${numPages} pages]`
      const suffix = truncated ? `\n\n[... truncated, total ${numPages} pages]` : ''
      log.info(`PDF text-based: ${text.length} characters, ${numPages} pages`)
      return [{ type: 'text' as const, text: `${header}\n<<<UNTRUSTED_EMAIL_DATA>>>\n${trimmed}\n<<<END_UNTRUSTED_EMAIL_DATA>>>${suffix}` }]
    }

    // Step 2: text is empty — scanned PDF. Render pages as PNG.
    log.info(`PDF scan (text: ${text.length} characters), rendering up to ${MAX_PDF_RENDER_PAGES} pages`)
    return await renderPdfAsImages(buffer, filename)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`PDF processing error: ${msg}`)
    return [{ type: 'text' as const, text: `Failed to read PDF: ${msg}` }]
  }
}

// --- PDF helper functions ---

// Cached import of pdfjs-dist with configured workerSrc.
// In Electron, Vite bundles pdfjs-dist into a separate chunk, and the worker file
// becomes inaccessible via relative path. We specify the path via require.resolve().
let _pdfjsModule: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null

async function getPdfjs() {
  if (_pdfjsModule) return _pdfjsModule
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  } catch {
    log.warn('Could not find pdf.worker.mjs — PDF will be processed in main thread')
  }
  _pdfjsModule = pdfjs
  return pdfjs
}

async function extractPdfText(buffer: Buffer): Promise<{ text: string; numPages: number }> {
  const pdfjs = await getPdfjs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
  const parts: string[] = []

  try {
    const pagesToRead = Math.min(doc.numPages, 50) // read up to 50 pages of text
    for (let i = 1; i <= pagesToRead; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .map(item => item.str)
        .join(' ')
      if (pageText.trim()) parts.push(pageText)
    }
    return { text: parts.join('\n\n'), numPages: doc.numPages }
  } finally {
    await doc.destroy()
  }
}

/**
 * Extracts original images from scanned PDFs via pdfjs-dist operatorList.
 *
 * pdf-to-png-converter (via @napi-rs/canvas) may incorrectly render
 * embedded JPEG images in PDFs (artifacts — horizontal lines).
 * Instead, we extract decoded pixels directly from pdfjs-dist
 * and convert them to PNG via @napi-rs/canvas.createCanvas().
 */
async function renderPdfAsImages(buffer: Buffer, filename?: string): Promise<ContentBlock[]> {
  const pdfjs = await getPdfjs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
  const pagesToProcess = Math.min(doc.numPages, MAX_PDF_RENDER_PAGES)

  const content: ContentBlock[] = []
  const header = filename
    ? `[PDF scan: ${filename}, showing first ${pagesToProcess} pages]`
    : `[PDF scan, showing first ${pagesToProcess} pages]`
  content.push({ type: 'text' as const, text: header })

  try {
    const { createCanvas } = await import('@napi-rs/canvas')

    for (let i = 1; i <= pagesToProcess; i++) {
      const page = await doc.getPage(i)
      const pngBuf = await extractPageImage(pdfjs, page, createCanvas)
      if (pngBuf) {
        content.push({
          type: 'image' as const,
          data: pngBuf.toString('base64'),
          mimeType: 'image/png',
        })
      }
    }
  } finally {
    await doc.destroy()
  }

  return content
}

/**
 * Extracts an image from a single page of a scanned PDF.
 * Looks for paintImageXObject / paintJpegXObject operator in operatorList,
 * obtains decoded RGB/RGBA pixels and converts them to PNG.
 * Downscales to MAX_PDF_SCAN_DIMENSION if the original is too large.
 */
async function extractPageImage(
  pdfjs: Awaited<ReturnType<typeof getPdfjs>>,
  page: { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>; objs: { get(id: string, cb: (data: unknown) => void): void } },
  createCanvas: typeof import('@napi-rs/canvas').createCanvas,
): Promise<Buffer | null> {
  const ops = await page.getOperatorList()
  const OPS = pdfjs.OPS

  // Find the first image drawing operator
  for (let j = 0; j < ops.fnArray.length; j++) {
    const fn = ops.fnArray[j]
    if (fn !== OPS.paintImageXObject && fn !== (OPS as Record<string, number>).paintJpegXObject) continue

    const imgId = ops.argsArray[j][0]
    if (typeof imgId !== 'string') continue

    const imgData = await new Promise<Record<string, unknown> | null>((resolve) => {
      page.objs.get(imgId, (data) => resolve(data as Record<string, unknown> | null))
    })
    if (!imgData?.data || !imgData.width || !imgData.height) continue

    const origW = imgData.width as number
    const origH = imgData.height as number
    const pixels = imgData.data as Uint8ClampedArray | Uint8Array

    // Build source canvas at original size
    const srcCanvas = createCanvas(origW, origH)
    const srcCtx = srcCanvas.getContext('2d')
    const imageData = srcCtx.createImageData(origW, origH)

    const expectedRgba = origW * origH * 4
    const expectedRgb = origW * origH * 3

    if (pixels.length === expectedRgba) {
      // RGBA — copy as is
      imageData.data.set(pixels)
    } else if (pixels.length === expectedRgb) {
      // RGB → RGBA
      for (let p = 0, q = 0; p < pixels.length; p += 3, q += 4) {
        imageData.data[q] = pixels[p]
        imageData.data[q + 1] = pixels[p + 1]
        imageData.data[q + 2] = pixels[p + 2]
        imageData.data[q + 3] = 255
      }
    } else {
      log.warn(`Page: unexpected pixel size ${pixels.length} (expected ${expectedRgba} RGBA or ${expectedRgb} RGB)`)
      continue
    }

    srcCtx.putImageData(imageData, 0, 0)

    // Downscale if needed
    const maxDim = Math.max(origW, origH)
    if (maxDim > MAX_PDF_SCAN_DIMENSION) {
      const scale = MAX_PDF_SCAN_DIMENSION / maxDim
      const newW = Math.round(origW * scale)
      const newH = Math.round(origH * scale)
      const dstCanvas = createCanvas(newW, newH)
      const dstCtx = dstCanvas.getContext('2d')
      dstCtx.drawImage(srcCanvas as never, 0, 0, newW, newH)
      log.info(`PDF scan page downscaled: ${origW}x${origH} → ${newW}x${newH}`)
      return Buffer.from(dstCanvas.toBuffer('image/png'))
    }

    return Buffer.from(srcCanvas.toBuffer('image/png'))
  }

  log.warn('PDF scan page: no embedded images found')
  return null
}
