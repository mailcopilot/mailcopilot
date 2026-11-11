import { describe, expect, it } from 'vitest'
import { CITATION_ALPHABET, citationHref, isCitationToken, parseCitationHref } from './aiCitation'
import { parseMailrefHref } from './normalizeMailrefs'
import { neutralizeBoundaryMarkers } from './untrustedBoundary'

describe('citation tokens', () => {
  it('the alphabet has 32 symbols and shares none with the boundary markers (wrapUntrusted cannot change a ticket)', () => {
    expect(CITATION_ALPHABET).toHaveLength(32)
    expect(new Set(CITATION_ALPHABET).size).toBe(32)
    const link = citationHref('k3f2x7ab')
    expect(neutralizeBoundaryMarkers(link)).toBe(link)
  })

  it.each([['k3f2x7ab', true], ['abcdefgh', true], ['k3f2x7a', false], ['k3f2x7abc', false], ['K3F2X7AB', false], ['k3f2x7a1', false], ['k3f2x7a8', false], ['k3f2x7a/', false]])(
    'isCitationToken(%j) is %s', (value, expected) => {
      expect(isCitationToken(value)).toBe(expected)
    },
  )
  it.each([[null], [undefined], [12], [{}]])('isCitationToken(%j) is false', value => {
    expect(isCitationToken(value)).toBe(false)
  })
})

describe('parseCitationHref', () => {
  it('accepts exactly mailref://c/<ticket>', () => {
    expect(parseCitationHref('mailref://c/k3f2x7ab')).toBe('k3f2x7ab')
  })
  it.each([
    ['mailref://c/k3f2x7ab/'], ['mailref://c/k3f2x7abc'], ['mailref://c/k3f9x2'], ['mailref://C/k3f2x7ab'],
    ['mailref://1/INBOX/42'], ['https://c/k3f2x7ab'], [''], [undefined], [null],
  ])('refuses %j', href => {
    expect(parseCitationHref(href as string | null | undefined)).toBeNull()
  })
  it('is not read as a place reference by the old parser', () => {
    expect(parseMailrefHref('mailref://c/k3f2x7ab')).toBeNull()
  })
})
