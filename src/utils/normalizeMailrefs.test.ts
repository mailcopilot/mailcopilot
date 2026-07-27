import { describe, expect, it } from 'vitest'
import { normalizeMailrefs } from './normalizeMailrefs'

describe('normalizeMailrefs', () => {
  // --- Step 1: Encode problematic chars in existing markdown links ---

  describe('encode folder paths with spaces and brackets', () => {
    it('encodes spaces in folder name', () => {
      const input = '[Subject](mailref://1/Вся почта/42)'
      const result = normalizeMailrefs(input)
      expect(result).toBe('[Subject](mailref://1/%D0%92%D1%81%D1%8F%20%D0%BF%D0%BE%D1%87%D1%82%D0%B0/42)')
    })

    it('encodes brackets and spaces in nested folder path', () => {
      const input = '[Тема письма](mailref://1/[Gmail]/Вся почта/37084)'
      const result = normalizeMailrefs(input)
      expect(result).toBe('[Тема письма](mailref://1/%5BGmail%5D/%D0%92%D1%81%D1%8F%20%D0%BF%D0%BE%D1%87%D1%82%D0%B0/37084)')
    })

    it('does not modify links without problematic chars', () => {
      const input = '[Subject](mailref://1/INBOX/42)'
      expect(normalizeMailrefs(input)).toBe('[Subject](mailref://1/INBOX/42)')
    })

    it('handles multiple links in text', () => {
      const input = 'See [A](mailref://1/[Gmail]/Вся почта/1) and [B](mailref://2/INBOX/2)'
      const result = normalizeMailrefs(input)
      expect(result).toContain('[A](mailref://1/%5BGmail%5D/%D0%92%D1%81%D1%8F%20%D0%BF%D0%BE%D1%87%D1%82%D0%B0/1)')
      expect(result).toContain('[B](mailref://2/INBOX/2)')
    })

    it('encodes only brackets (no spaces)', () => {
      const input = '[Subject](mailref://1/[Gmail]/INBOX/99)'
      const result = normalizeMailrefs(input)
      expect(result).toBe('[Subject](mailref://1/%5BGmail%5D/INBOX/99)')
    })

    it('preserves link text as-is', () => {
      const input = '[Заканчиваются деньги на Облачном счёте](mailref://1/[Gmail]/Вся почта/37084)'
      const result = normalizeMailrefs(input)
      expect(result).toContain('[Заканчиваются деньги на Облачном счёте]')
    })
  })

  // --- Step 2: Convert bare mailref:// URLs to markdown links ---

  describe('bare mailref URLs', () => {
    it('wraps bare mailref URL in markdown link', () => {
      const input = 'Check mailref://1/INBOX/42 please'
      expect(normalizeMailrefs(input)).toBe('Check [email](mailref://1/INBOX/42) please')
    })

    it('wraps multiple bare mailref URLs', () => {
      const input = 'mailref://1/INBOX/1 and mailref://2/Sent/5'
      const result = normalizeMailrefs(input)
      expect(result).toBe('[email](mailref://1/INBOX/1) and [email](mailref://2/Sent/5)')
    })

    it('does not double-wrap already linked mailref URLs', () => {
      const input = '[Subject](mailref://1/INBOX/42)'
      const result = normalizeMailrefs(input)
      // Should not produce [email]([Subject](mailref://...))
      expect(result).toBe('[Subject](mailref://1/INBOX/42)')
    })
  })

  // --- Combined ---

  describe('combined scenarios', () => {
    it('encodes problematic link and wraps bare URL in same text', () => {
      const input = 'See [A](mailref://1/[Gmail]/Вся почта/1) and also mailref://2/INBOX/5'
      const result = normalizeMailrefs(input)
      expect(result).toContain('[A](mailref://1/%5BGmail%5D/%D0%92%D1%81%D1%8F%20%D0%BF%D0%BE%D1%87%D1%82%D0%B0/1)')
      expect(result).toContain('[email](mailref://2/INBOX/5)')
    })

    it('returns empty string as-is', () => {
      expect(normalizeMailrefs('')).toBe('')
    })

    it('returns text without mailrefs as-is', () => {
      const input = 'Just some text with [a link](https://example.com)'
      expect(normalizeMailrefs(input)).toBe(input)
    })
  })
})
