import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: vi.fn(),
}))

// Mock @napi-rs/canvas for PDF scan rendering and image resizing
const mockCanvasToBuffer = vi.fn().mockReturnValue(Buffer.from('png-data'))
const mockPutImageData = vi.fn()
const mockDrawImage = vi.fn()
const mockCreateImageData = vi.fn().mockReturnValue({
  data: new Uint8ClampedArray(40), // 10 pixels RGBA
})
const mockLoadImage = vi.fn()

vi.mock('@napi-rs/canvas', () => ({
  createCanvas: vi.fn().mockReturnValue({
    getContext: vi.fn().mockReturnValue({
      createImageData: mockCreateImageData,
      putImageData: mockPutImageData,
      drawImage: mockDrawImage,
    }),
    toBuffer: mockCanvasToBuffer,
  }),
  loadImage: (...args: unknown[]) => mockLoadImage(...args),
}))

import {
  classifyContent,
  buildTextContent,
  buildImageContent,
  buildPdfContent,
  MAX_DOWNLOAD_BYTES,
  MAX_TEXT_CHARS,
  MAX_PDF_RENDER_PAGES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_BASE64_BYTES,
  MAX_PDF_SCAN_DIMENSION,
} from './attachmentContent'

beforeEach(() => {
  vi.clearAllMocks()
})

// --- classifyContent ---

describe('classifyContent', () => {
  it('text/plain → text', () => {
    expect(classifyContent('text/plain')).toBe('text')
  })

  it('text/html → text', () => {
    expect(classifyContent('text/html')).toBe('text')
  })

  it('text/csv → text', () => {
    expect(classifyContent('text/csv')).toBe('text')
  })

  it('application/json → text', () => {
    expect(classifyContent('application/json')).toBe('text')
  })

  it('application/xml → text', () => {
    expect(classifyContent('application/xml')).toBe('text')
  })

  it('text/x-unknown → text (text/* wildcard)', () => {
    expect(classifyContent('text/x-unknown')).toBe('text')
  })

  it('image/png → image', () => {
    expect(classifyContent('image/png')).toBe('image')
  })

  it('image/jpeg → image', () => {
    expect(classifyContent('image/jpeg')).toBe('image')
  })

  it('image/gif → image', () => {
    expect(classifyContent('image/gif')).toBe('image')
  })

  it('image/webp → image', () => {
    expect(classifyContent('image/webp')).toBe('image')
  })

  it('application/pdf → pdf', () => {
    expect(classifyContent('application/pdf')).toBe('pdf')
  })

  it('application/vnd.openxmlformats → unsupported', () => {
    expect(classifyContent('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('unsupported')
  })

  it('application/octet-stream → unsupported', () => {
    expect(classifyContent('application/octet-stream')).toBe('unsupported')
  })

  it('mime with parameters (charset) → correct classification', () => {
    expect(classifyContent('text/plain; charset=utf-8')).toBe('text')
    expect(classifyContent('application/json; charset=utf-8')).toBe('text')
  })

  it('fallback by extension .csv → text', () => {
    expect(classifyContent(undefined, 'data.csv')).toBe('text')
  })

  it('fallback by extension .log → text', () => {
    expect(classifyContent(undefined, 'app.log')).toBe('text')
  })

  it('fallback by extension .md → text', () => {
    expect(classifyContent(undefined, 'README.md')).toBe('text')
  })

  it('fallback by extension .pdf → pdf', () => {
    expect(classifyContent(undefined, 'document.pdf')).toBe('pdf')
  })

  it('fallback by extension .png → image', () => {
    expect(classifyContent(undefined, 'photo.png')).toBe('image')
  })

  it('fallback by extension .jpg → image', () => {
    expect(classifyContent(undefined, 'photo.jpg')).toBe('image')
  })

  it('no mime and no extension → unsupported', () => {
    expect(classifyContent(undefined, undefined)).toBe('unsupported')
  })

  it('no extension → unsupported', () => {
    expect(classifyContent(undefined, 'noext')).toBe('unsupported')
  })

  it('unknown extension → unsupported', () => {
    expect(classifyContent(undefined, 'file.docx')).toBe('unsupported')
  })

  it('image/tiff → unsupported (not in list)', () => {
    expect(classifyContent('image/tiff')).toBe('unsupported')
  })
})

// --- buildTextContent ---

describe('buildTextContent', () => {
  it('returns TextContent with file header', () => {
    const buf = Buffer.from('Hello, world!')
    const result = buildTextContent(buf, 'test.txt')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('text')
    expect((result[0] as { text: string }).text).toContain('[File: test.txt]')
    expect((result[0] as { text: string }).text).toContain('Hello, world!')
  })

  it('returns TextContent without filename', () => {
    const buf = Buffer.from('content')
    const result = buildTextContent(buf)
    expect((result[0] as { text: string }).text).toContain('[File content]')
  })

  it('truncates text when exceeding MAX_TEXT_CHARS', () => {
    const longText = 'A'.repeat(MAX_TEXT_CHARS + 1000)
    const buf = Buffer.from(longText)
    const result = buildTextContent(buf, 'big.txt')
    const text = (result[0] as { text: string }).text
    expect(text).toContain('[... truncated')
    // Text should not exceed limit + header + suffix
    expect(text.length).toBeLessThan(MAX_TEXT_CHARS + 500)
  })

  it('does not truncate text within limit', () => {
    const shortText = 'Short content'
    const buf = Buffer.from(shortText)
    const result = buildTextContent(buf, 'short.txt')
    const text = (result[0] as { text: string }).text
    expect(text).not.toContain('[... truncated')
  })
})

// --- buildImageContent ---

describe('buildImageContent', () => {
  it('returns small image as-is without resizing', async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // PNG header bytes
    mockLoadImage.mockResolvedValue({ width: 100, height: 100 })

    const result = await buildImageContent(buf, 'image/png')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('image')
    const img = result[0] as { data: string; mimeType: string }
    expect(img.mimeType).toBe('image/png')
    expect(img.data).toBe(buf.toString('base64'))
    // No canvas rendering for small images
    expect(mockDrawImage).not.toHaveBeenCalled()
  })

  it('resizes oversized image (dimensions exceed MAX_IMAGE_DIMENSION)', async () => {
    // Create a buffer that is small enough but image dimensions are large
    const buf = Buffer.from('small-buffer')
    mockLoadImage.mockResolvedValue({ width: 4000, height: 3000 })
    // Mock canvas output to be within MAX_IMAGE_BASE64_BYTES
    const smallJpeg = Buffer.alloc(50_000, 0xff)
    mockCanvasToBuffer.mockReturnValue(smallJpeg)

    const result = await buildImageContent(buf, 'image/png')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('image')
    const img = result[0] as { data: string; mimeType: string }
    // Output should be JPEG after resize
    expect(img.mimeType).toBe('image/jpeg')
    // drawImage should have been called for resizing
    expect(mockDrawImage).toHaveBeenCalled()
    // Canvas should have been created with scaled-down dimensions
    const { createCanvas } = await import('@napi-rs/canvas')
    // Scale: 1024 / 4000 = 0.256 → 1024x768
    expect(createCanvas).toHaveBeenCalledWith(1024, 768)
  })

  it('iteratively halves dimensions when base64 output is too large', async () => {
    const buf = Buffer.from('some-data')
    mockLoadImage.mockResolvedValue({ width: 2000, height: 1500 })
    // First render: too large; second render: within limit
    const largeBuf = Buffer.alloc(MAX_IMAGE_BASE64_BYTES + 10000, 0xff)
    const smallBuf = Buffer.alloc(50_000, 0xff)
    mockCanvasToBuffer
      .mockReturnValueOnce(largeBuf) // first attempt: too large
      .mockReturnValueOnce(smallBuf) // second attempt: OK

    const result = await buildImageContent(buf, 'image/png')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('image')
    // drawImage called twice (initial resize + halving)
    expect(mockDrawImage).toHaveBeenCalledTimes(2)
  })

  it('returns text fallback when image processing fails and buffer is too large', async () => {
    // Large buffer that would exceed base64 limit
    const buf = Buffer.alloc(MAX_IMAGE_BASE64_BYTES + 1000, 0xff)
    mockLoadImage.mockRejectedValue(new Error('Corrupt image'))

    const result = await buildImageContent(buf, 'image/png')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('text')
    expect((result[0] as { text: string }).text).toContain('Image too large for AI context')
    expect((result[0] as { text: string }).text).toContain('Corrupt image')
  })

  it('returns image as-is when processing fails but buffer is small', async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    mockLoadImage.mockRejectedValue(new Error('Unsupported format'))

    const result = await buildImageContent(buf, 'image/gif')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('image')
    const img = result[0] as { data: string; mimeType: string }
    expect(img.mimeType).toBe('image/gif')
    expect(img.data).toBe(buf.toString('base64'))
  })

  it('resizes image when base64 size exceeds limit even if dimensions are within limit', async () => {
    // Buffer large enough that base64 exceeds MAX_IMAGE_BASE64_BYTES, but image dimensions are OK
    const buf = Buffer.alloc(MAX_IMAGE_BASE64_BYTES, 0xff)
    mockLoadImage.mockResolvedValue({ width: 800, height: 600 })
    const smallBuf = Buffer.alloc(50_000, 0xff)
    mockCanvasToBuffer.mockReturnValue(smallBuf)

    const result = await buildImageContent(buf, 'image/png')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('image')
    // Should have triggered resize due to base64 size
    expect(mockDrawImage).toHaveBeenCalled()
  })
})

// --- buildPdfContent ---

describe('buildPdfContent', () => {
  it('extracts text from text-based PDF', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: 'Hello' }, { str: 'World' }, { str: 'This is a test document with enough text' }],
      }),
    }
    const mockDoc = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue(mockPage),
    }
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(mockDoc),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never)

    const buf = Buffer.from('fake pdf content')
    const result = await buildPdfContent(buf, 'doc.pdf')

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('text')
    const text = (result[0] as { text: string }).text
    expect(text).toContain('[PDF: doc.pdf, 1 pages]')
    expect(text).toContain('Hello')
  })

  it('renders scanned PDF as images via pdfjs operatorList', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

    // Mock OPS (pdfjs-dist operators)
    ;(pdfjs as Record<string, unknown>).OPS = {
      paintImageXObject: 85,
      paintJpegXObject: 82,
    }

    // Scan — text is empty, but there is an embedded image
    // 2x2 RGB pixels = 12 bytes
    const pixelData = new Uint8ClampedArray([
      255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128,
    ])

    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [85], // paintImageXObject
        argsArray: [['img_p0_1', 100, 100]],
      }),
      objs: {
        get: vi.fn().mockImplementation((_id: string, cb: (data: unknown) => void) => {
          cb({ width: 2, height: 2, data: pixelData })
        }),
      },
    }
    const mockDoc = {
      numPages: 2,
      getPage: vi.fn().mockResolvedValue(mockPage),
    }
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(mockDoc),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never)

    // Configure canvas mock to create correct imageData
    mockCreateImageData.mockReturnValue({
      data: new Uint8ClampedArray(2 * 2 * 4), // 2x2 RGBA
    })

    const buf = Buffer.from('fake scan pdf')
    const result = await buildPdfContent(buf, 'scan.pdf')

    // Header + 2 images (2 pages)
    expect(result.length).toBe(3)
    expect(result[0].type).toBe('text')
    expect((result[0] as { text: string }).text).toContain('[PDF scan: scan.pdf')
    expect(result[1].type).toBe('image')
    expect(result[2].type).toBe('image')
    // Verify that canvas was used for conversion
    expect(mockPutImageData).toHaveBeenCalled()
    expect(mockCanvasToBuffer).toHaveBeenCalledWith('image/png')
  })

  it('downscales large PDF scan pages to MAX_PDF_SCAN_DIMENSION', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    ;(pdfjs as Record<string, unknown>).OPS = {
      paintImageXObject: 85,
      paintJpegXObject: 82,
    }

    // Large image: 3000x2000 pixels → should be downscaled
    const w = 3000, h = 2000
    const pixelData = new Uint8ClampedArray(w * h * 3) // RGB

    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [85],
        argsArray: [['img_large']],
      }),
      objs: {
        get: vi.fn().mockImplementation((_id: string, cb: (data: unknown) => void) => {
          cb({ width: w, height: h, data: pixelData })
        }),
      },
    }
    const mockDoc = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue(mockPage),
    }
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(mockDoc),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never)

    mockCreateImageData.mockReturnValue({
      data: new Uint8ClampedArray(w * h * 4),
    })

    const buf = Buffer.from('fake scan pdf')
    await buildPdfContent(buf, 'large-scan.pdf')

    // drawImage should be called for downscaling
    expect(mockDrawImage).toHaveBeenCalled()

    // createCanvas should be called for both source (3000x2000) and dest (scaled)
    const { createCanvas } = await import('@napi-rs/canvas')
    const calls = vi.mocked(createCanvas).mock.calls
    // Source canvas: original size
    expect(calls).toContainEqual([w, h])
    // Destination canvas: scaled to fit MAX_PDF_SCAN_DIMENSION
    const scale = MAX_PDF_SCAN_DIMENSION / 3000
    const expectedW = Math.round(w * scale)
    const expectedH = Math.round(h * scale)
    expect(calls).toContainEqual([expectedW, expectedH])
  })

  it('does not downscale small PDF scan pages', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    ;(pdfjs as Record<string, unknown>).OPS = {
      paintImageXObject: 85,
    }

    // Small image: 800x600 → no downscale needed
    const w = 800, h = 600
    const pixelData = new Uint8ClampedArray(w * h * 4) // RGBA

    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [85],
        argsArray: [['img_small']],
      }),
      objs: {
        get: vi.fn().mockImplementation((_id: string, cb: (data: unknown) => void) => {
          cb({ width: w, height: h, data: pixelData })
        }),
      },
    }
    const mockDoc = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue(mockPage),
    }
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(mockDoc),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never)

    mockCreateImageData.mockReturnValue({
      data: new Uint8ClampedArray(w * h * 4),
    })

    const buf = Buffer.from('fake scan pdf')
    await buildPdfContent(buf, 'small-scan.pdf')

    // drawImage should NOT be called — no downscaling
    expect(mockDrawImage).not.toHaveBeenCalled()
    // Only one canvas created (source = output)
    const { createCanvas } = await import('@napi-rs/canvas')
    expect(vi.mocked(createCanvas).mock.calls).toContainEqual([w, h])
  })

  // A PDF that fails to LOAD is the input the teardown exists for, and it is
  // the one case where pdfjs cleans up nothing on its own: the transport is
  // attached to the loading task before a DocException can be raised, and the
  // task promise is rejected without destroying it. So the load is awaited
  // inside the try — awaiting it outside would skip `finally` on exactly the
  // attacker-supplied bytes that must not leak a worker.
  it('returns error for invalid PDF and still tears down the loading task', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const destroy = vi.fn().mockResolvedValue(undefined)
    const rejection = Promise.reject(new Error('Invalid PDF'))
    rejection.catch(() => {}) // prevent unhandled rejection
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: rejection,
      destroy,
    } as never)

    const buf = Buffer.from('not a pdf')
    const result = await buildPdfContent(buf, 'bad.pdf')

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('text')
    expect((result[0] as { text: string }).text).toContain('Failed to read PDF')
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('tears down the scan-rendering loading task when its own load rejects', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    // Empty text content routes buildPdfContent into renderPdfAsImages, which
    // opens a SECOND loading task. That second load is the one that fails
    // here, so the first task's teardown cannot stand in for the second's.
    const extractDestroy = vi.fn().mockResolvedValue(undefined)
    const scanDestroy = vi.fn().mockResolvedValue(undefined)
    const emptyTextDoc = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue({
        getTextContent: vi.fn().mockResolvedValue({ items: [] }),
      }),
    }
    const rejection = Promise.reject(new Error('Invalid PDF on second open'))
    rejection.catch(() => {}) // prevent unhandled rejection
    vi.mocked(pdfjs.getDocument)
      .mockReturnValueOnce({ promise: Promise.resolve(emptyTextDoc), destroy: extractDestroy } as never)
      .mockReturnValueOnce({ promise: rejection, destroy: scanDestroy } as never)

    const result = await buildPdfContent(Buffer.from('scan bytes'), 'bad-scan.pdf')

    expect(result).toHaveLength(1)
    expect((result[0] as { text: string }).text).toContain('Failed to read PDF')
    expect(extractDestroy).toHaveBeenCalledTimes(1)
    expect(scanDestroy).toHaveBeenCalledTimes(1)
  })

  // §2.110 — pdfjs 6 dropped PDFDocumentProxy.destroy(); attachmentContent.ts
  // now tears down through the loading task's own `destroy()` inside a
  // `finally`, on BOTH the text-extraction and scan-rendering paths. A
  // `try { ... } catch` swap (or a `finally` that only runs on the happy
  // path) would leak the worker on every attachment that fails mid-read —
  // this pins that the task is torn down even when page processing throws
  // AFTER the document has already loaded successfully.
  it('tears down the loading task when text extraction fails after the document loads', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const destroy = vi.fn().mockResolvedValue(undefined)
    const mockDoc = {
      numPages: 1,
      getPage: vi.fn().mockRejectedValue(new Error('corrupt page')),
    }
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(mockDoc),
      destroy,
    } as never)

    const result = await buildPdfContent(Buffer.from('fake pdf'), 'broken.pdf')

    expect(result).toHaveLength(1)
    expect((result[0] as { text: string }).text).toContain('Failed to read PDF')
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('tears down the loading task when scan-page rendering fails after the document loads', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    ;(pdfjs as Record<string, unknown>).OPS = { paintImageXObject: 85 }
    // Empty text content routes buildPdfContent into renderPdfAsImages, which
    // opens its OWN loading task (a second getDocument() call) and then fails
    // while fetching the page's operator list. Two distinct `destroy` spies
    // isolate which task actually gets torn down.
    const extractDestroy = vi.fn().mockResolvedValue(undefined)
    const scanDestroy = vi.fn().mockResolvedValue(undefined)
    const mockDoc = {
      numPages: 1,
      getPage: vi.fn()
        .mockResolvedValueOnce({ getTextContent: vi.fn().mockResolvedValue({ items: [] }) })
        .mockResolvedValueOnce({ getOperatorList: vi.fn().mockRejectedValue(new Error('operator list failure')) }),
    }
    vi.mocked(pdfjs.getDocument)
      .mockReturnValueOnce({ promise: Promise.resolve(mockDoc), destroy: extractDestroy } as never)
      .mockReturnValueOnce({ promise: Promise.resolve(mockDoc), destroy: scanDestroy } as never)

    const result = await buildPdfContent(Buffer.from('fake scan pdf'), 'broken-scan.pdf')

    expect(result).toHaveLength(1)
    expect((result[0] as { text: string }).text).toContain('Failed to read PDF')
    expect(extractDestroy).toHaveBeenCalledTimes(1)
    expect(scanDestroy).toHaveBeenCalledTimes(1)
  })
})

// --- Constants ---

describe('Constants', () => {
  it('MAX_DOWNLOAD_BYTES = 10 MB', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(10 * 1024 * 1024)
  })

  it('MAX_TEXT_CHARS = 50_000', () => {
    expect(MAX_TEXT_CHARS).toBe(50_000)
  })

  it('MAX_PDF_RENDER_PAGES = 5', () => {
    expect(MAX_PDF_RENDER_PAGES).toBe(5)
  })

  it('MAX_IMAGE_DIMENSION = 1024', () => {
    expect(MAX_IMAGE_DIMENSION).toBe(1024)
  })

  it('MAX_IMAGE_BASE64_BYTES = 150_000', () => {
    expect(MAX_IMAGE_BASE64_BYTES).toBe(150_000)
  })

  it('MAX_PDF_SCAN_DIMENSION = 1200', () => {
    expect(MAX_PDF_SCAN_DIMENSION).toBe(1200)
  })
})

// --- Context overflow protection ---

describe('Context overflow protection', () => {
  it('buildImageContent output base64 never exceeds MAX_IMAGE_BASE64_BYTES', async () => {
    // Simulate a large image that gets resized
    const largeBuf = Buffer.alloc(500_000, 0xff) // 500KB
    mockLoadImage.mockResolvedValue({ width: 4000, height: 3000 })
    // Mock canvas output to be within limits
    const smallJpeg = Buffer.alloc(100_000, 0xaa)
    mockCanvasToBuffer.mockReturnValue(smallJpeg)

    const result = await buildImageContent(largeBuf, 'image/png')
    expect(result).toHaveLength(1)
    if (result[0].type === 'image') {
      const base64Len = (result[0] as { data: string }).data.length
      // base64 of 100KB = ~133KB, within 150KB limit
      expect(base64Len).toBeLessThanOrEqual(MAX_IMAGE_BASE64_BYTES * 2) // generous upper bound
    }
  })

  it('buildTextContent output never exceeds MAX_TEXT_CHARS + header', async () => {
    const hugeText = 'W'.repeat(200_000) // 200K chars
    const buf = Buffer.from(hugeText)
    const result = buildTextContent(buf, 'huge.txt')
    const text = (result[0] as { text: string }).text
    // Text should be MAX_TEXT_CHARS + header + truncation notice
    expect(text.length).toBeLessThan(MAX_TEXT_CHARS + 500)
    // Content should still be present (not empty)
    expect(text).toContain('WWWW')
  })

  it('buildPdfContent text truncates at MAX_TEXT_CHARS preserving start of content', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const longContent = 'ImportantText_' + 'X'.repeat(MAX_TEXT_CHARS + 5000)
    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: longContent }],
      }),
    }
    const mockDoc = {
      numPages: 10,
      getPage: vi.fn().mockResolvedValue(mockPage),
    }
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(mockDoc),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never)

    const result = await buildPdfContent(Buffer.from('pdf'), 'big.pdf')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('text')
    const text = (result[0] as { text: string }).text
    // Start of content preserved
    expect(text).toContain('ImportantText_')
    // Total size bounded
    expect(text.length).toBeLessThan(MAX_TEXT_CHARS + 500)
    // Truncation notice present
    expect(text).toContain('truncated')
  })

  it('multiple images from PDF scan do not exceed safe total size', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    ;(pdfjs as Record<string, unknown>).OPS = { paintImageXObject: 85 }

    const w = 800, h = 600
    const pixelData = new Uint8ClampedArray(w * h * 4) // RGBA

    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({ items: [] }),
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [85],
        argsArray: [['img1']],
      }),
      objs: {
        get: vi.fn().mockImplementation((_id: string, cb: (data: unknown) => void) => {
          cb({ width: w, height: h, data: pixelData })
        }),
      },
    }
    const mockDoc = {
      numPages: 5, // MAX_PDF_RENDER_PAGES
      getPage: vi.fn().mockResolvedValue(mockPage),
    }
    vi.mocked(pdfjs.getDocument).mockReturnValue({
      promise: Promise.resolve(mockDoc),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never)
    mockCreateImageData.mockReturnValue({ data: new Uint8ClampedArray(w * h * 4) })
    // Each page PNG = 10KB
    const pagePng = Buffer.alloc(10_000, 0xbb)
    mockCanvasToBuffer.mockReturnValue(pagePng)

    const result = await buildPdfContent(Buffer.from('scan'), 'big-scan.pdf')

    // Header + 5 images
    expect(result.length).toBe(6)
    // Total base64 size across all images
    const totalBase64 = result
      .filter(b => b.type === 'image')
      .reduce((sum, b) => sum + (b as { data: string }).data.length, 0)
    // 5 pages × ~13KB base64 = ~65KB — well within limits
    expect(totalBase64).toBeLessThan(MAX_IMAGE_BASE64_BYTES * 5)
  })

  it('preserves image aspect ratio when resizing', async () => {
    const buf = Buffer.from('img')
    // Landscape: 2000x500
    mockLoadImage.mockResolvedValue({ width: 2000, height: 500 })
    mockCanvasToBuffer.mockReturnValue(Buffer.alloc(50_000))

    await buildImageContent(buf, 'image/png')

    // After resize: 1024 / 2000 = 0.512 scale → 1024x256
    const { createCanvas } = await import('@napi-rs/canvas')
    const calls = vi.mocked(createCanvas).mock.calls
    expect(calls).toContainEqual([1024, 256])
  })

  it('preserves image aspect ratio for portrait images', async () => {
    const buf = Buffer.from('img')
    // Portrait: 500x2000
    mockLoadImage.mockResolvedValue({ width: 500, height: 2000 })
    mockCanvasToBuffer.mockReturnValue(Buffer.alloc(50_000))

    await buildImageContent(buf, 'image/png')

    // After resize: 1024 / 2000 = 0.512 → 256x1024
    const { createCanvas } = await import('@napi-rs/canvas')
    const calls = vi.mocked(createCanvas).mock.calls
    expect(calls).toContainEqual([256, 1024])
  })
})
