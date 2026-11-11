// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildInlineImageDataUri, newPendingRunId, patchPendingImages, pendingImageToken } from './pendingImages'
import { BLOCKED_IMAGE_PLACEHOLDER_DATA_URI } from './mail'

function docOf(body: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${body}</body></html>`, 'text/html')
}

describe('pendingImageToken', () => {
  it('is the inert placeholder plus a fragment, unique per (run, index)', () => {
    const t = pendingImageToken('r3', 1)
    expect(t.startsWith(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)).toBe(true)
    expect(t).not.toBe(pendingImageToken('r3', 2))
    expect(t).not.toBe(pendingImageToken('r4', 1))
  })

  it('index 1 can not match inside index 10', () => {
    const doc = docOf(`<img src="${pendingImageToken('r1', 10)}">`)
    const applied = patchPendingImages(doc, new Map([[pendingImageToken('r1', 1), 'data:image/png;base64,ONE']]))
    expect(applied.size).toBe(0)
    expect(doc.querySelector('img')!.getAttribute('src')).toBe(pendingImageToken('r1', 10))
  })
})

describe('patchPendingImages', () => {
  const uri = 'data:image/png;base64,AAAA'

  it('swaps src, srcset (keeping descriptors), inline style and <style> text', () => {
    const t = pendingImageToken('r1', 0)
    const doc = docOf(
      `<img id="a" src="${t}">`
      + `<img id="b" srcset="${t} 2x, ${BLOCKED_IMAGE_PLACEHOLDER_DATA_URI} 1x">`
      + `<div id="c" style="background-image:url(${t})"></div>`
      + `<style>.x{background:url("${t}")}</style>`,
    )
    const applied = patchPendingImages(doc, new Map([[t, uri]]))
    expect([...applied]).toEqual([t])
    expect(doc.getElementById('a')!.getAttribute('src')).toBe(uri)
    expect(doc.getElementById('b')!.getAttribute('srcset')).toBe(`${uri} 2x, ${BLOCKED_IMAGE_PLACEHOLDER_DATA_URI} 1x`)
    expect(doc.getElementById('c')!.getAttribute('style')).toContain(uri)
    expect(doc.querySelector('style')!.textContent).toContain(uri)
    expect(doc.documentElement.outerHTML).not.toContain('#mcimg-')
  })

  it('leaves tokens without bytes alone, and is idempotent', () => {
    const t0 = pendingImageToken('r1', 0)
    const t1 = pendingImageToken('r1', 1)
    const doc = docOf(`<img id="a" src="${t0}"><img id="b" src="${t1}">`)
    const map = new Map([[t0, uri]])
    expect([...patchPendingImages(doc, map)]).toEqual([t0])
    expect(patchPendingImages(doc, map).size).toBe(0)
    expect(doc.getElementById('b')!.getAttribute('src')).toBe(t1)
  })

  it('does nothing for an empty map', () => {
    const doc = docOf(`<img src="${pendingImageToken('r1', 0)}">`)
    expect(patchPendingImages(doc, new Map()).size).toBe(0)
  })
})

describe('newPendingRunId', () => {
  it('is unguessable: 128 random bits, different every call', () => {
    const a = newPendingRunId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(newPendingRunId()).not.toBe(a)
  })
})

describe('buildInlineImageDataUri', () => {
  it('builds a data URI from a plain type and base64', () => {
    expect(buildInlineImageDataUri('image/png', 'AAAA')).toBe('data:image/png;base64,AAAA')
    expect(buildInlineImageDataUri(undefined, 'AAAA')).toBe('data:application/octet-stream;base64,AAAA')
  })

  it('refuses a content type that is not a plain MIME type (sender-controlled text)', () => {
    for (const ct of ['image/png"onerror="x', 'image/png) ; background:url(https://x', 'image/png;charset=x', 'text', 'a/b c']) {
      expect(buildInlineImageDataUri(ct, 'AAAA')).toBeNull()
    }
  })

  it('refuses base64 outside its alphabet, and an empty body', () => {
    for (const b of ['AA")AA', 'AA"AA', 'AA;AA', 'AA AA', 'AA\nAA', '']) {
      expect(buildInlineImageDataUri('image/png', b)).toBeNull()
    }
  })
})
