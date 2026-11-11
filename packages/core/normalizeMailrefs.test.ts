import { describe, expect, it } from 'vitest'
import { extractMailrefTargets, mailrefKey, normalizeMailrefs, parseMailrefHref, MAILREF_SCAN_MAX_CHARS } from './normalizeMailrefs'

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

describe('parseMailrefHref', () => {
  it('parses a plain reference', () => {
    expect(parseMailrefHref('mailref://1/INBOX/42')).toEqual({ accountId: 1, folder: 'INBOX', uid: 42 })
  })

  it('keeps slashes inside the folder (first slash ends the id, last starts the uid)', () => {
    expect(parseMailrefHref('mailref://3/Work/Projects/2024/17')).toEqual({ accountId: 3, folder: 'Work/Projects/2024', uid: 17 })
  })

  it('percent-decodes the folder, including spaces, brackets and non-ASCII', () => {
    expect(parseMailrefHref('mailref://1/%5BGmail%5D/%D0%92%D1%81%D1%8F%20%D0%BF%D0%BE%D1%87%D1%82%D0%B0/37084'))
      .toEqual({ accountId: 1, folder: '[Gmail]/Вся почта', uid: 37084 })
  })

  it('parses what normalizeMailrefs produced for a folder with spaces', () => {
    const normalized = normalizeMailrefs('[x](mailref://1/My Folder/9)')
    const href = /\((mailref:[^)]+)\)/.exec(normalized)![1]
    expect(parseMailrefHref(href)).toEqual({ accountId: 1, folder: 'My Folder', uid: 9 })
  })

  it.each([
    ['non-numeric account id', 'mailref://abc/INBOX/1'],
    ['non-numeric uid', 'mailref://1/INBOX/xyz'],
    ['uid with trailing text', 'mailref://1/INBOX/12abc'],
    ['decimal uid', 'mailref://1/INBOX/1.5'],
    ['zero account id', 'mailref://0/INBOX/1'],
    ['zero uid', 'mailref://1/INBOX/0'],
    ['negative uid', 'mailref://1/INBOX/-5'],
    ['negative account id', 'mailref://-1/INBOX/5'],
    ['unsafe integer uid', 'mailref://1/INBOX/99999999999999999999'],
    ['missing folder and uid', 'mailref://1'],
    ['missing uid', 'mailref://1/INBOX'],
    ['empty folder', 'mailref://1//5'],
    ['blank folder after decoding', 'mailref://1/%20%20/5'],
    ['empty account id', 'mailref:///INBOX/5'],
    ['bad percent escape', 'mailref://1/%E0%A4%A/5'],
    ['wrong scheme', 'https://1/INBOX/5'],
    ['scheme in other case', 'MAILREF://1/INBOX/5'],
    ['no scheme', '1/INBOX/5'],
    ['empty string', ''],
  ])('rejects %s', (_name, href) => {
    expect(parseMailrefHref(href)).toBeNull()
  })

  it('rejects undefined and null', () => {
    expect(parseMailrefHref(undefined)).toBeNull()
    expect(parseMailrefHref(null)).toBeNull()
  })
})

describe('extractMailrefTargets', () => {
  it('returns nothing for text without references', () => {
    expect(extractMailrefTargets('No links here, see https://example.com')).toEqual([])
    expect(extractMailrefTargets('')).toEqual([])
  })

  it('lists targets in order of first appearance', () => {
    const text = '[b](mailref://1/INBOX/2) then [a](mailref://1/INBOX/1) then [c](mailref://2/Sent/3)'
    expect(extractMailrefTargets(text).map(t => t.uid)).toEqual([2, 1, 3])
  })

  it('deduplicates the same message cited twice', () => {
    const text = '[a](mailref://1/INBOX/1) and again [again](mailref://1/INBOX/1)'
    expect(extractMailrefTargets(text)).toHaveLength(1)
  })

  it('treats the same uid in different folders or accounts as different messages', () => {
    const text = '[a](mailref://1/INBOX/1) [b](mailref://1/Sent/1) [c](mailref://2/INBOX/1)'
    expect(extractMailrefTargets(text)).toHaveLength(3)
  })

  it('finds a bare URL that is not wrapped in link syntax', () => {
    expect(extractMailrefTargets('see mailref://1/INBOX/7 for details')).toEqual([{ accountId: 1, folder: 'INBOX', uid: 7 }])
  })

  it('finds a link whose folder has spaces and brackets (normalised like the renderer does)', () => {
    expect(extractMailrefTargets('[Тема](mailref://1/[Gmail]/Вся почта/37084)'))
      .toEqual([{ accountId: 1, folder: '[Gmail]/Вся почта', uid: 37084 }])
  })

  it('finds an already percent-encoded folder', () => {
    expect(extractMailrefTargets('[x](mailref://1/Archive%202024/5)')).toEqual([{ accountId: 1, folder: 'Archive 2024', uid: 5 }])
  })

  it('skips malformed references and keeps the well-formed ones', () => {
    const text = '[bad](mailref://abc/INBOX/1) [zero](mailref://1/INBOX/0) [ok](mailref://1/INBOX/3)'
    expect(extractMailrefTargets(text)).toEqual([{ accountId: 1, folder: 'INBOX', uid: 3 }])
  })

  it('a bare and a linked form of the same message count once', () => {
    expect(extractMailrefTargets('[a](mailref://1/INBOX/1) and mailref://1/INBOX/1')).toHaveLength(1)
  })
})

describe('mailrefKey', () => {
  it('is equal for equal references and differs when any component differs', () => {
    const base = { accountId: 1, folder: 'INBOX', uid: 5 }
    expect(mailrefKey(base)).toBe(mailrefKey({ ...base }))
    expect(mailrefKey(base)).not.toBe(mailrefKey({ ...base, accountId: 2 }))
    expect(mailrefKey(base)).not.toBe(mailrefKey({ ...base, folder: 'Sent' }))
    expect(mailrefKey(base)).not.toBe(mailrefKey({ ...base, uid: 6 }))
  })

  it('cannot be forged by a folder name that spells another key', () => {
    expect(mailrefKey({ accountId: 1, folder: 'a/2', uid: 3 })).not.toBe(mailrefKey({ accountId: 1, folder: 'a', uid: 2 }))
    expect(mailrefKey({ accountId: 1, folder: '",2,"', uid: 3 })).not.toBe(mailrefKey({ accountId: 1, folder: '', uid: 3 }))
  })

  it('ignores extra fields on the object', () => {
    const withExtra = { accountId: 1, folder: 'INBOX', uid: 5, subject: 'x' } as { accountId: number; folder: string; uid: number }
    expect(mailrefKey(withExtra)).toBe(mailrefKey({ accountId: 1, folder: 'INBOX', uid: 5 }))
  })
})

describe('linear time on hostile model text', () => {
  const timed = (fn: () => unknown): number => { const t = Date.now(); fn(); return Date.now() - t }
  const hostile: Array<[string, string]> = [
    ['an open bracket repeated', '['.repeat(80_000)],
    ['brackets then a half link', `${'['.repeat(40_000)}](mailref://1/${'a'.repeat(40_000)}`],
    ['"[x " repeated', '[x '.repeat(27_000)],
    ['a link prefix repeated', '[a](mailref://1/'.repeat(5_000)],
    ['link prefixes each followed by 512 open brackets', `](mailref://1/${'['.repeat(512)}`.repeat(300)],
  ]

  it.each(hostile)('normalizeMailrefs stays fast on %s', (_name, text) => {
    expect(timed(() => normalizeMailrefs(text))).toBeLessThan(500)
  })

  it.each(hostile)('extractMailrefTargets stays fast on %s', (_name, text) => {
    expect(timed(() => extractMailrefTargets(text))).toBeLessThan(500)
  })

  it('drops a link that straddles the limit instead of reading it with a shortened uid', () => {
    const tail = '[m](mailref://1/INBOX/12345)'
    const filler = 'x'.repeat(MAILREF_SCAN_MAX_CHARS - 'see [m](mailref://1/INBOX/12'.length) + ' '
    // the cut lands inside "12345": the link is not a citation, and above all not citation "12"
    expect(extractMailrefTargets(`${filler}see ${tail}`)).toEqual([])
  })

  it('reads no further than MAILREF_SCAN_MAX_CHARS: a link beyond the limit is not a citation', () => {
    const filler = 'x'.repeat(MAILREF_SCAN_MAX_CHARS)
    expect(extractMailrefTargets(`${filler}[m](mailref://1/INBOX/5)`)).toEqual([])
    expect(extractMailrefTargets('[m](mailref://1/INBOX/5)')).toEqual([{ accountId: 1, folder: 'INBOX', uid: 5 }])
  })
})

describe('normalizeMailrefs: a bare citation link', () => {
  const T = 'k3f2x7ab'
  it('is wrapped when it ends at a space, the end of the text, or sentence punctuation', () => {
    expect(normalizeMailrefs(`see mailref://c/${T} now`)).toBe(`see [email](mailref://c/${T}) now`)
    expect(normalizeMailrefs(`see mailref://c/${T}`)).toBe(`see [email](mailref://c/${T})`)
    expect(normalizeMailrefs(`see mailref://c/${T}.`)).toBe(`see [email](mailref://c/${T}).`)
    expect(normalizeMailrefs(`(see mailref://c/${T})`)).toBe(`(see [email](mailref://c/${T}))`)
    expect(normalizeMailrefs(`mailref://c/${T}, and`)).toBe(`[email](mailref://c/${T}), and`)
  })
  it.each([['1'], ['a'], ['_'], ['-'], ['/x'], ['.txt'], ['?x=1'], ['#h'], ['%41']])('a ticket with %s glued to it is a distorted link: left as text, never repaired', suffix => {
    const text = `see mailref://c/${T}${suffix} now`
    expect(normalizeMailrefs(text)).toBe(text)
  })
})
