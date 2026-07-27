export type ParsedSearchQuery = {
  /** Free text (without operators). Each element is a separate AND condition. */
  text: string[]
  /** Free text with negation (AND NOT ...). */
  notText: string[]
  from: string[]
  notFrom: string[]
  to: string[]
  notTo: string[]
  subject: string[]
  notSubject: string[]
  body: string[]
  notBody: string[]
  /** filename: operator — search by attachment filenames */
  filename: string[]
  notFilename: string[]
  /** is:unread / is:read (true = unread, false = read) */
  isUnread?: boolean
  /** is:starred / is:flagged (true = flagged, false = unflagged) */
  isFlagged?: boolean
  /** has:attachment (true/false) */
  hasAttachment?: boolean
  /** in:SomeFolder */
  folder?: string
  /** in:anywhere */
  anywhere?: boolean
  /** before:YYYY-MM-DD */
  before?: string
  /** after:YYYY-MM-DD */
  after?: string
  /** uid:123 or uid:123,456,789 — filter by specific UIDs */
  uids: number[]
}

function tokenize(input: string): string[] {
  const s = input || ''
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++
    if (i >= s.length) break

    let tok = ''
    let inQuotes = false
    while (i < s.length) {
      const ch = s[i]!
      if (ch === '"') {
        inQuotes = !inQuotes
        i++
        continue
      }
      if (!inQuotes && /\s/.test(ch)) break
      tok += ch
      i++
    }
    if (tok) out.push(tok)
    while (i < s.length && /\s/.test(s[i]!)) i++
  }
  return out
}

function splitOperator(tok: string): { op: string; value: string } | null {
  const idx = tok.indexOf(':')
  if (idx <= 0) return null
  const op = tok.slice(0, idx).trim().toLowerCase()
  const value = tok.slice(idx + 1).trim()
  if (!op || !value) return null
  return { op, value }
}

function isIsoDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const [y, m, day] = d.split('-').map(Number)
  // Construct in UTC and verify components match (rejects 02-31 etc.)
  const date = new Date(Date.UTC(y, m - 1, day))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === day
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const q: ParsedSearchQuery = {
    text: [],
    notText: [],
    from: [],
    notFrom: [],
    to: [],
    notTo: [],
    subject: [],
    notSubject: [],
    body: [],
    notBody: [],
    filename: [],
    notFilename: [],
    uids: [],
  }

  for (const rawTok of tokenize(input)) {
    if (!rawTok) continue
    // Skip boolean operators OR/AND (case-insensitive) — do not treat as free text.
    const upper = rawTok.toUpperCase()
    if (upper === 'OR' || upper === 'AND') continue
    const neg = rawTok.startsWith('-') && rawTok.length > 1
    const tok = neg ? rawTok.slice(1) : rawTok
    if (!tok) continue

    const opv = splitOperator(tok)
    if (opv) {
      const { op, value } = opv
      const v = value.trim()
      if (!v) continue

      if (op === 'uid') {
        // uid:123 or uid:123,456,789
        if (neg) continue
        for (const part of v.split(',')) {
          const n = Number(part.trim())
          if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) q.uids.push(n)
        }
      } else if (op === 'from') (neg ? q.notFrom : q.from).push(v)
      else if (op === 'to') (neg ? q.notTo : q.to).push(v)
      else if (op === 'subject') (neg ? q.notSubject : q.subject).push(v)
      else if (op === 'body') (neg ? q.notBody : q.body).push(v)
      else if (op === 'filename') (neg ? q.notFilename : q.filename).push(v)
      else if (op === 'in') {
        if (neg) continue
        if (v.toLowerCase() === 'anywhere') q.anywhere = true
        else q.folder = v
      } else if (op === 'has') {
        if (v.toLowerCase() === 'attachment') q.hasAttachment = neg ? false : true
      } else if (op === 'is') {
        const vv = v.toLowerCase()
        if (vv === 'unread') q.isUnread = neg ? false : true
        else if (vv === 'read') q.isUnread = neg ? true : false
        else if (vv === 'starred' || vv === 'flagged') q.isFlagged = neg ? false : true
      } else if (op === 'before') {
        if (neg) continue
        if (isIsoDate(v)) q.before = v
      } else if (op === 'after') {
        if (neg) continue
        if (isIsoDate(v)) q.after = v
      } else {
        // Unknown operator — treat as free text.
        (neg ? q.notText : q.text).push(tok)
      }
      continue
    }

    (neg ? q.notText : q.text).push(tok)
  }

  return q
}

export function isAdvancedSearch(q: ParsedSearchQuery): boolean {
  return Boolean(
    q.from.length
    || q.notFrom.length
    || q.to.length
    || q.notTo.length
    || q.subject.length
    || q.notSubject.length
    || q.body.length
    || q.notBody.length
    || q.filename.length
    || q.notFilename.length
    || typeof q.isUnread === 'boolean'
    || typeof q.isFlagged === 'boolean'
    || typeof q.hasAttachment === 'boolean'
    || q.anywhere
    || Boolean(q.folder)
    || Boolean(q.before)
    || Boolean(q.after)
    || q.notText.length
    || q.uids.length
  )
}
