import { describe, it, expect } from 'vitest'
import { analyzeTableReferences } from './sqlGuard'

/** Table names of a query that must be accepted. Fails loudly on a refusal. */
function tablesOf(sql: string): string[] {
  const result = analyzeTableReferences(sql)
  if (!result.ok) throw new Error(`expected acceptance, got refusal: ${result.reason}`)
  return result.tables
}

/** Refusal reason of a query that must be refused. Fails loudly on acceptance. */
function refusalOf(sql: string): string {
  const result = analyzeTableReferences(sql)
  if (result.ok) throw new Error(`expected refusal, got tables: ${JSON.stringify(result.tables)}`)
  return result.reason
}

describe('analyzeTableReferences', () => {
  // ── The reported bypass class: separators SQLite accepts instead of a space.
  // Each of these used to return an EMPTY table list, which gave the allowlist
  // in ai.ts nothing to reject (BACKLOG §2.118).
  describe('comment separators between FROM/JOIN and the table name', () => {
    it('refuses a block comment used as the FROM separator', () => {
      expect(refusalOf('SELECT * FROM/**/ai_action_log')).toBe('comment')
    })

    it('refuses a line comment used as the FROM separator', () => {
      expect(refusalOf('SELECT * FROM--x\nai_rules')).toBe('comment')
    })

    it('refuses a block comment surrounded by whitespace after FROM', () => {
      expect(refusalOf('SELECT * FROM /**/ ai_action_log')).toBe('comment')
    })

    it('refuses a comment between JOIN and the table name', () => {
      expect(refusalOf('SELECT * FROM messages JOIN/**/sqlite_master ON 1=1')).toBe('comment')
    })

    it('refuses a comment in the table-name position of a comma-separated list', () => {
      expect(refusalOf('SELECT * FROM messages,/**/accounts')).toBe('comment')
    })

    it('refuses a comment before the statement', () => {
      expect(refusalOf('/*x*/SELECT * FROM messages')).toBe('comment')
    })

    it('refuses a trailing line comment on an otherwise allowed query', () => {
      expect(refusalOf('SELECT * FROM messages -- trailing note\n')).toBe('comment')
    })

    it('refuses an unterminated block comment (SQLite accepts it at end of input)', () => {
      expect(refusalOf('SELECT * FROM messages /* never closed')).toBe('comment')
    })

    it('refuses a comment that contains a quote character', () => {
      // A naive stripper that treats the quote as a literal opener would
      // desynchronise from here on; refusing removes the question entirely.
      expect(refusalOf("SELECT * FROM /* it's here */ ai_audit_log")).toBe('comment')
    })

    it('refuses a comment hiding a second table reference', () => {
      expect(refusalOf('SELECT * FROM messages JOIN /**/ accounts ON 1=1')).toBe('comment')
    })
  })

  // `#` is NOT a comment introducer in SQLite (verified: it is a syntax
  // error), so it must be refused as an invalid character rather than
  // silently swallowing the rest of the line.
  describe('non-SQLite comment syntax', () => {
    it('refuses a hash character used as a comment introducer', () => {
      expect(refusalOf('SELECT * FROM#x\nai_action_log')).toBe('invalid-character')
    })

    it('refuses a hash character anywhere else', () => {
      expect(refusalOf('SELECT * FROM messages#note')).toBe('invalid-character')
    })
  })

  describe('parenthesised table references', () => {
    it('sees a table wrapped in parentheses', () => {
      // Legal SQLite (verified) that the previous regex skipped entirely
      // because it refused to look past an opening paren.
      expect(tablesOf('SELECT * FROM (ai_action_log)')).toEqual(['ai_action_log'])
    })

    it('sees a table wrapped in nested parentheses', () => {
      expect(tablesOf('SELECT * FROM ((ai_action_log))')).toEqual(['ai_action_log'])
    })

    it('sees both sides of a parenthesised join', () => {
      const tables = tablesOf('SELECT * FROM (messages JOIN accounts ON 1=1)')
      expect(tables).toEqual(['messages', 'accounts'])
    })

    it('sees a table listed after a derived table', () => {
      const tables = tablesOf('SELECT * FROM (SELECT 1) x, ai_action_log')
      expect(tables).toEqual(['ai_action_log'])
    })

    it('refuses an empty parenthesised table position', () => {
      expect(refusalOf('SELECT * FROM ()')).toBe('missing-table-name')
    })
  })

  // The caller executes `SELECT * FROM (<sql>) LIMIT n`. A statement whose
  // parens do not balance is therefore NOT the statement that runs: the
  // wrapper's own parens re-associate around the imbalance. Verified against
  // SQLite — the first case below returns the ai_action_log rows once wrapped.
  describe('unbalanced parentheses cannot re-associate the caller wrapper', () => {
    it('refuses an imbalance that grafts an extra table onto the wrapper', () => {
      expect(refusalOf('SELECT * FROM messages) , ai_action_log , (SELECT 1'))
        .toBe('unbalanced-parentheses')
    })

    it('refuses a stray closing paren', () => {
      expect(refusalOf('SELECT * FROM messages)')).toBe('unbalanced-parentheses')
    })

    it('refuses a stray closing paren before further clauses', () => {
      expect(refusalOf('SELECT * FROM messages) WHERE 1=1')).toBe('unbalanced-parentheses')
    })

    it('refuses an unclosed paren', () => {
      expect(refusalOf('SELECT * FROM (SELECT uid FROM messages')).toBe('unbalanced-parentheses')
    })

    it('refuses an unclosed paren that would swallow the wrapper LIMIT', () => {
      expect(refusalOf('SELECT * FROM messages WHERE uid IN (SELECT uid FROM messages'))
        .toBe('unbalanced-parentheses')
    })
  })

  describe('whitespace forms', () => {
    it('accepts a tab separator', () => {
      expect(tablesOf('SELECT * FROM\tmessages')).toEqual(['messages'])
    })

    it('accepts a newline separator', () => {
      expect(tablesOf('SELECT * FROM\nmessages')).toEqual(['messages'])
    })

    it('accepts multiple mixed whitespace characters', () => {
      expect(tablesOf('SELECT * FROM \t\r\n  messages')).toEqual(['messages'])
    })

    it('accepts a quoted name with no separator at all', () => {
      expect(tablesOf('SELECT * FROM"sqlite_master"')).toEqual(['sqlite_master'])
    })

    it('accepts a bracketed name with no separator at all', () => {
      expect(tablesOf('SELECT * FROM[sqlite_master]')).toEqual(['sqlite_master'])
    })
  })

  describe('string literals are data, not SQL', () => {
    it('does not treat a double dash inside a literal as a comment', () => {
      expect(tablesOf("SELECT 'a--b' FROM messages")).toEqual(['messages'])
    })

    it('does not treat a block-comment opener inside a literal as a comment', () => {
      expect(tablesOf("SELECT '/*' FROM messages")).toEqual(['messages'])
    })

    it('handles a doubled quote inside a literal without losing the FROM', () => {
      expect(tablesOf("SELECT 'it''s' FROM messages")).toEqual(['messages'])
    })

    it('does not read a table name out of a string literal', () => {
      expect(tablesOf("SELECT * FROM messages WHERE subject = 'FROM accounts'")).toEqual(['messages'])
    })

    it('refuses an unterminated string literal', () => {
      expect(refusalOf("SELECT * FROM messages WHERE subject = 'oops")).toBe('unterminated-string')
    })

    it('refuses an unterminated quoted identifier', () => {
      expect(refusalOf('SELECT * FROM "messages')).toBe('unterminated-identifier')
    })

    it('refuses an unterminated bracket identifier', () => {
      expect(refusalOf('SELECT * FROM [messages')).toBe('unterminated-identifier')
    })

    it('keeps the token stream in sync across an escaped quote in an identifier', () => {
      // `"a""b"` is the single identifier `a"b`; a scanner that stopped at the
      // second quote would misread everything after it.
      const tables = tablesOf('SELECT * FROM "a""b", accounts')
      expect(tables).toEqual(['a"b', 'accounts'])
    })
  })

  describe('table-valued functions and virtual tables', () => {
    it('reports a pragma table-valued function under its own name', () => {
      // `pragma_table_info` slips the \bPRAGMA\b keyword filter in ai.ts, so
      // the allowlist is what must refuse it — which needs the name.
      expect(tablesOf("SELECT * FROM pragma_table_info('messages')")).toEqual(['pragma_table_info'])
    })

    it('reports pragma_database_list under its own name', () => {
      expect(tablesOf('SELECT * FROM pragma_database_list')).toEqual(['pragma_database_list'])
    })
  })

  describe('schema qualifiers', () => {
    it('accepts a main-qualified table and reports the bare name', () => {
      expect(tablesOf('SELECT * FROM main.messages')).toEqual(['messages'])
    })

    it('accepts a main-qualified table with whitespace around the dot', () => {
      expect(tablesOf('SELECT * FROM main . messages')).toEqual(['messages'])
    })

    it('still reports a main-qualified forbidden table', () => {
      expect(tablesOf('SELECT * FROM main.sqlite_master')).toEqual(['sqlite_master'])
    })

    it('refuses a temp-qualified table', () => {
      expect(refusalOf('SELECT * FROM temp.secrets')).toBe('unsupported-schema')
    })

    it('refuses an attached-database qualifier', () => {
      expect(refusalOf('SELECT * FROM other.messages')).toBe('unsupported-schema')
    })

    it('refuses a three-part qualified name', () => {
      expect(refusalOf('SELECT * FROM main.messages.extra')).toBe('unsupported-schema')
    })
  })

  describe('happy paths that must keep working', () => {
    it('extracts a single FROM table', () => {
      expect(tablesOf('SELECT * FROM messages')).toEqual(['messages'])
    })

    it('extracts comma-separated tables', () => {
      expect(tablesOf('SELECT * FROM messages, contacts')).toEqual(['messages', 'contacts'])
    })

    it('extracts JOIN tables with aliases', () => {
      const tables = tablesOf('SELECT m.uid FROM messages m JOIN contacts c ON m.from_addr=c.email')
      expect(tables).toEqual(['messages', 'contacts'])
    })

    it('extracts tables from a LEFT OUTER JOIN', () => {
      const tables = tablesOf('SELECT * FROM messages LEFT OUTER JOIN contacts ON 1=1')
      expect(tables).toEqual(['messages', 'contacts'])
    })

    it('extracts comma-separated tables with aliases', () => {
      const tables = tablesOf('SELECT * FROM messages m, sqlite_master s WHERE 1=1')
      expect(tables).toEqual(['messages', 'sqlite_master'])
    })

    it('does not extract column names from the SELECT list', () => {
      expect(tablesOf('SELECT uid, subject FROM messages')).toEqual(['messages'])
    })

    it('extracts double-quoted table names', () => {
      expect(tablesOf('SELECT * FROM "sqlite_master"')).toEqual(['sqlite_master'])
    })

    it('extracts backtick-quoted table names', () => {
      expect(tablesOf('SELECT * FROM `sqlite_master`')).toEqual(['sqlite_master'])
    })

    it('extracts bracket-quoted table names', () => {
      expect(tablesOf('SELECT * FROM [sqlite_master]')).toEqual(['sqlite_master'])
    })

    it('extracts quoted tables after JOIN', () => {
      const tables = tablesOf('SELECT * FROM messages JOIN "contacts" ON 1=1')
      expect(tables).toEqual(['messages', 'contacts'])
    })

    it('extracts tables from a subquery in the WHERE clause', () => {
      const tables = tablesOf('SELECT * FROM messages WHERE uid IN (SELECT uid FROM sqlite_master)')
      expect(tables).toEqual(['messages', 'sqlite_master'])
    })

    it('extracts tables from a scalar subquery in the SELECT list', () => {
      const tables = tablesOf('SELECT (SELECT a FROM accounts) FROM messages')
      expect(tables).toEqual(['accounts', 'messages'])
    })

    it('extracts tables from a derived table', () => {
      const tables = tablesOf('SELECT * FROM (SELECT uid FROM messages) AS x')
      expect(tables).toEqual(['messages'])
    })

    it('extracts tables from both arms of a UNION', () => {
      const tables = tablesOf('SELECT uid FROM messages UNION SELECT uid FROM contacts')
      expect(tables).toEqual(['messages', 'contacts'])
    })

    it('de-duplicates repeated references', () => {
      expect(tablesOf('SELECT * FROM messages a JOIN messages b ON 1=1')).toEqual(['messages'])
    })

    it('is case-insensitive on keywords and names', () => {
      expect(tablesOf('select * from MESSAGES')).toEqual(['messages'])
    })

    it('accepts an fts MATCH query', () => {
      expect(tablesOf("SELECT uid FROM messages_fts WHERE messages_fts MATCH 'test'")).toEqual(['messages_fts'])
    })

    it('accepts a query with no table at all', () => {
      expect(tablesOf('SELECT 1')).toEqual([])
    })

    it('accepts a trailing semicolon', () => {
      expect(tablesOf('SELECT * FROM messages;')).toEqual(['messages'])
    })

    it('accepts bound-parameter placeholders', () => {
      expect(tablesOf('SELECT * FROM messages WHERE uid = ? AND folder_path = :folder')).toEqual(['messages'])
    })

    it('accepts JSON arrow operators', () => {
      expect(tablesOf("SELECT a->>'b' FROM messages")).toEqual(['messages'])
    })

    it('accepts a non-ASCII identifier', () => {
      expect(tablesOf('SELECT * FROM папка')).toEqual(['папка'])
    })
  })

  describe('commas outside the FROM clause are not table positions', () => {
    it('ignores commas in a GROUP BY list', () => {
      expect(tablesOf('SELECT a, b FROM messages GROUP BY a, b')).toEqual(['messages'])
    })

    it('ignores commas in an ORDER BY list', () => {
      expect(tablesOf('SELECT * FROM messages ORDER BY date, uid')).toEqual(['messages'])
    })

    it('ignores commas in a LIMIT offset form', () => {
      expect(tablesOf('SELECT * FROM messages LIMIT 1, 2')).toEqual(['messages'])
    })

    it('ignores commas inside a function call in an ON clause', () => {
      const tables = tablesOf('SELECT * FROM messages JOIN contacts ON substr(a, 1) = b')
      expect(tables).toEqual(['messages', 'contacts'])
    })

    it('ignores commas inside a USING clause', () => {
      const tables = tablesOf('SELECT * FROM messages JOIN contacts USING (a, b)')
      expect(tables).toEqual(['messages', 'contacts'])
    })

    it('ignores commas inside an IN list', () => {
      expect(tablesOf('SELECT * FROM messages WHERE uid IN (1, 2, 3)')).toEqual(['messages'])
    })
  })

  describe('malformed input is refused, never guessed at', () => {
    it('refuses an empty query', () => {
      expect(refusalOf('')).toBe('empty')
    })

    it('refuses a whitespace-only query', () => {
      expect(refusalOf('   \n\t ')).toBe('empty')
    })

    it('refuses a trailing FROM with nothing after it', () => {
      expect(refusalOf('SELECT * FROM')).toBe('missing-table-name')
    })

    it('refuses a number in the table position', () => {
      expect(refusalOf('SELECT * FROM 42')).toBe('missing-table-name')
    })

    it('refuses a string literal in the table position', () => {
      expect(refusalOf("SELECT * FROM 'messages'")).toBe('missing-table-name')
    })

    it('refuses a keyword in the table position', () => {
      expect(refusalOf('SELECT * FROM WHERE x')).toBe('missing-table-name')
    })

    it('refuses a dangling comma in the FROM clause', () => {
      expect(refusalOf('SELECT * FROM messages,')).toBe('missing-table-name')
    })

    it('refuses a non-SQL character', () => {
      expect(refusalOf('SELECT * FROM messages ^ 1')).toBe('invalid-character')
    })

    it('refuses a non-string input', () => {
      // Defensive: the tool schema types this as a string, but the guard is
      // the last line before execution and must not trust that.
      expect(analyzeTableReferences(undefined as unknown as string)).toEqual({ ok: false, reason: 'empty' })
    })
  })
})
