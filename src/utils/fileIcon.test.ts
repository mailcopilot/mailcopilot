// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { isValidElement } from 'react'
import { fileIcon } from './fileIcon'

describe('fileIcon', () => {
  it('returns PDF descriptor for application/pdf (previewable)', () => {
    const res = fileIcon('application/pdf', 'report.pdf')
    expect(res.label).toBe('attachments.iconLabel.pdf')
    expect(res.previewable).toBe(true)
    expect(isValidElement(res.icon)).toBe(true)
  })

  it('handles MIME with parameters (e.g. "application/pdf; charset=binary")', () => {
    const res = fileIcon('application/pdf; charset=binary', 'x.pdf')
    expect(res.label).toBe('attachments.iconLabel.pdf')
    expect(res.previewable).toBe(true)
  })

  it('returns image descriptor (previewable) for supported image MIMEs', () => {
    const mimes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ]
    for (const m of mimes) {
      const res = fileIcon(m, 'file.img')
      expect(res.label).toBe('attachments.iconLabel.image')
      expect(res.previewable).toBe(true)
    }
  })

  // Aligns `previewable` with `electron/services/attachmentContent.ts` —
  // formats outside PNG/JPEG/GIF/WEBP fall back to download, so the badge must
  // not lie to the user.
  it.each([
    ['image/svg+xml'],
    ['image/heic'],
    ['image/heif'],
    ['image/tiff'],
    ['image/bmp'],
    ['image/x-icon'],
    ['image/avif'],
  ])('returns image descriptor but NOT previewable for unsupported image MIME %s', (mime) => {
    const res = fileIcon(mime, 'picture.img')
    expect(res.label).toBe('attachments.iconLabel.image')
    expect(res.previewable).toBe(false)
  })

  it('returns archive descriptor for known archive MIMEs', () => {
    const mimes = [
      'application/zip',
      'application/x-zip-compressed',
      'application/x-tar',
      'application/x-gzip',
    ]
    for (const m of mimes) {
      const res = fileIcon(m, 'bundle')
      expect(res.label).toBe('attachments.iconLabel.archive')
      expect(res.previewable).toBe(false)
    }
  })

  it('returns doc descriptor for Word / ODT MIMEs', () => {
    const mimes = [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.oasis.opendocument.text',
    ]
    for (const m of mimes) {
      const res = fileIcon(m, 'doc')
      expect(res.label).toBe('attachments.iconLabel.doc')
      expect(res.previewable).toBe(false)
    }
  })

  it('returns spreadsheet descriptor for Excel / ODS MIMEs', () => {
    const mimes = [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.oasis.opendocument.spreadsheet',
    ]
    for (const m of mimes) {
      const res = fileIcon(m, 'sheet')
      expect(res.label).toBe('attachments.iconLabel.spreadsheet')
      expect(res.previewable).toBe(false)
    }
  })

  it('returns presentation descriptor for PowerPoint / ODP MIMEs', () => {
    const mimes = [
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.presentation',
    ]
    for (const m of mimes) {
      const res = fileIcon(m, 'deck')
      expect(res.label).toBe('attachments.iconLabel.presentation')
      expect(res.previewable).toBe(false)
    }
  })

  it('returns text descriptor for text/plain and text/markdown', () => {
    expect(fileIcon('text/plain', 'notes.txt').label).toBe('attachments.iconLabel.text')
    expect(fileIcon('text/markdown', 'readme.md').label).toBe('attachments.iconLabel.text')
  })

  it('returns eml descriptor for message/rfc822', () => {
    const res = fileIcon('message/rfc822', 'fwd.eml')
    expect(res.label).toBe('attachments.iconLabel.eml')
    expect(res.previewable).toBe(false)
  })

  it('falls back to extension for application/octet-stream: .pdf → pdf descriptor', () => {
    const res = fileIcon('application/octet-stream', 'invoice.pdf')
    expect(res.label).toBe('attachments.iconLabel.pdf')
    expect(res.previewable).toBe(true)
  })

  it('falls back to extension for application/octet-stream: .png → image descriptor', () => {
    const res = fileIcon('application/octet-stream', 'photo.PNG')
    expect(res.label).toBe('attachments.iconLabel.image')
    expect(res.previewable).toBe(true)
  })

  it('falls back to extension for application/octet-stream: .zip → archive descriptor', () => {
    const res = fileIcon('application/octet-stream', 'pack.zip')
    expect(res.label).toBe('attachments.iconLabel.archive')
  })

  it('falls back to extension for application/octet-stream: .docx → doc descriptor', () => {
    const res = fileIcon('application/octet-stream', 'report.docx')
    expect(res.label).toBe('attachments.iconLabel.doc')
  })

  it('falls back to extension for application/octet-stream: .xlsx → spreadsheet descriptor', () => {
    const res = fileIcon('application/octet-stream', 'data.xlsx')
    expect(res.label).toBe('attachments.iconLabel.spreadsheet')
  })

  it('falls back to extension for application/octet-stream: .pptx → presentation descriptor', () => {
    const res = fileIcon('application/octet-stream', 'slides.pptx')
    expect(res.label).toBe('attachments.iconLabel.presentation')
  })

  it('falls back to extension for application/octet-stream: .txt → text descriptor', () => {
    const res = fileIcon('application/octet-stream', 'notes.txt')
    expect(res.label).toBe('attachments.iconLabel.text')
  })

  it('falls back to extension for application/octet-stream: .eml → eml descriptor', () => {
    const res = fileIcon('application/octet-stream', 'message.eml')
    expect(res.label).toBe('attachments.iconLabel.eml')
  })

  it('falls back to extension when MIME is empty', () => {
    const res = fileIcon('', 'photo.jpeg')
    expect(res.label).toBe('attachments.iconLabel.image')
    expect(res.previewable).toBe(true)
  })

  it('falls back to extension when MIME is undefined', () => {
    const res = fileIcon(undefined, 'diagram.svg')
    expect(res.label).toBe('attachments.iconLabel.image')
    // SVG is not inline-previewable by the app.
    expect(res.previewable).toBe(false)
  })

  it('returns generic descriptor for unknown extension on octet-stream', () => {
    const res = fileIcon('application/octet-stream', 'mystery.xyz')
    expect(res.label).toBe('attachments.iconLabel.generic')
    expect(res.previewable).toBe(false)
  })

  it('returns generic descriptor when both MIME and filename are missing', () => {
    const res = fileIcon(undefined, undefined)
    expect(res.label).toBe('attachments.iconLabel.generic')
    expect(res.previewable).toBe(false)
  })

  it('returns generic descriptor when MIME is unknown and filename has no extension', () => {
    const res = fileIcon('application/x-weird-thing', 'README')
    expect(res.label).toBe('attachments.iconLabel.generic')
  })

  it('treats dotfiles without additional extension as no-extension', () => {
    const res = fileIcon('application/octet-stream', '.gitignore')
    expect(res.label).toBe('attachments.iconLabel.generic')
  })

  it('ignores trailing-dot filenames gracefully', () => {
    const res = fileIcon('application/octet-stream', 'weirdname.')
    expect(res.label).toBe('attachments.iconLabel.generic')
  })

  it('normalizes MIME to lowercase', () => {
    const res = fileIcon('APPLICATION/PDF', 'X.PDF')
    expect(res.label).toBe('attachments.iconLabel.pdf')
  })

  // --- Gap-fill: exhaustive octet-stream → extension coverage ------------
  // Each case corresponds to a branch in `extensionToMime`. We previously had
  // one image/doc/sheet/etc. sample each; this block hits every remaining
  // extension so a regression in `extensionToMime` surfaces immediately.

  it.each([
    ['.jpg', 'photo.jpg', 'attachments.iconLabel.image', true],
    ['.jpeg', 'photo.jpeg', 'attachments.iconLabel.image', true],
    ['.gif', 'anim.gif', 'attachments.iconLabel.image', true],
    ['.webp', 'pic.webp', 'attachments.iconLabel.image', true],
    ['.svg', 'vector.svg', 'attachments.iconLabel.image', false],
    ['.heic', 'iphone.heic', 'attachments.iconLabel.image', false],
    ['.tar', 'archive.tar', 'attachments.iconLabel.archive', false],
    ['.gz', 'data.gz', 'attachments.iconLabel.archive', false],
    ['.tgz', 'bundle.tgz', 'attachments.iconLabel.archive', false],
    ['.doc', 'legacy.doc', 'attachments.iconLabel.doc', false],
    ['.odt', 'open.odt', 'attachments.iconLabel.doc', false],
    ['.xls', 'old.xls', 'attachments.iconLabel.spreadsheet', false],
    ['.ods', 'calc.ods', 'attachments.iconLabel.spreadsheet', false],
    ['.ppt', 'legacy.ppt', 'attachments.iconLabel.presentation', false],
    ['.odp', 'impress.odp', 'attachments.iconLabel.presentation', false],
    ['.md', 'readme.md', 'attachments.iconLabel.text', false],
    ['.markdown', 'post.markdown', 'attachments.iconLabel.text', false],
  ])('octet-stream extension fallback: %s → correct descriptor', (_ext, name, label, previewable) => {
    const res = fileIcon('application/octet-stream', name)
    expect(res.label).toBe(label)
    expect(res.previewable).toBe(previewable)
  })

  it('treats uppercase extension identically (case-insensitive)', () => {
    const res = fileIcon('application/octet-stream', 'PHOTO.JPG')
    expect(res.label).toBe('attachments.iconLabel.image')
    expect(res.previewable).toBe(true)
  })

  it('handles filenames with multiple dots (uses only the last segment)', () => {
    const res = fileIcon('application/octet-stream', 'archive.tar.gz')
    expect(res.label).toBe('attachments.iconLabel.archive')
  })

  it('trims whitespace around MIME before classification', () => {
    const res = fileIcon('  application/pdf  ', 'x.pdf')
    expect(res.label).toBe('attachments.iconLabel.pdf')
  })

  it('returns generic when MIME is whitespace-only and no filename', () => {
    const res = fileIcon('   ', undefined)
    expect(res.label).toBe('attachments.iconLabel.generic')
  })
})
