// ──────────────────────────────────────────────────────────────────────
// sqlGuard.ts — Table-reference extraction for the `query_db` MCP tool.
//
// Pure module (no DOM, no Electron, no DB) so the security-critical parsing
// is unit-testable without mocks. `electron/services/ai.ts` keeps only the
// wiring and the table allowlist (CLAUDE.md §5 «Hotspot policy»).
//
// ── What this defends ─────────────────────────────────────────────────
// `query_db` lets the model run a SELECT against the local SQLite cache.
// Email content influences the model (`wrapUntrusted()` reduces but does not
// remove that), the model calls `query_db`, and the rows come back into the
// conversation. The table allowlist in `ai.ts` is the layer that keeps
// `accounts`, `ai_action_log`, `ai_audit_log`, `ai_rules`, `notifications`
// and — per the comment in `ai.ts` — `sqlite_master` out of reach. That
// layer is only as good as the answer to "which tables does this query
// reference", so an under-reporting extractor is a silent bypass, not a
// degraded check: an empty table list gives the allowlist nothing to reject.
//
// ── The bug this replaces (BACKLOG §2.118) ────────────────────────────
// The previous extractor was a regex requiring WHITESPACE after FROM/JOIN:
//   SELECT * FROM messages          → ["messages"]   (guard works)
//   SELECT * FROM/**/ai_action_log  → []             (guard silently passes)
//   SELECT * FROM--x\nai_rules      → []
//   SELECT * FROM (ai_action_log)   → []             (found while fixing;
//                                                     parenthesised table
//                                                     references are legal
//                                                     SQLite, verified)
// SQLite accepts a comment — and a parenthesised table reference — wherever
// it accepts whitespace, so the separator set is not something a pattern can
// enumerate. Widening the regex is the arms race this module exists to end
// (memory rule `feedback_regex_vs_data_format`): the fix is a tokenizer that
// consumes the same lexical constructs SQLite consumes, not a bigger pattern.
//
// ── Why a tokenizer and not `EXPLAIN` (option (b), investigated) ───────
// Asking the engine which b-trees a compiled statement opens IS possible:
// `EXPLAIN <sql>` emits `OpenRead` rows whose P2 is the b-tree root page,
// and `sqlite_master.rootpage` maps root pages back to names (root page 1 is
// `sqlite_master` itself). It was rejected as the PRIMARY guard for three
// reasons, in order of weight:
//   1. It answers a NARROWER question than the allowlist asks. Virtual
//      tables and table-valued functions are not b-tree opens, so they
//      produce no `OpenRead` at all: `SELECT * FROM pragma_table_info('x')`
//      and `SELECT * FROM pragma_database_list` (both verified to run, and
//      both slipping the `\bPRAGMA\b` keyword filter because `pragma_table_info`
//      is one word) would come back as "touches no tables" → allowed. A
//      name-based allowlist refuses them by default, which is the posture we
//      want for a surface we do not enumerate.
//   2. `better-sqlite3` (12.x) exposes no authorizer binding — the only
//      statement-level introspection compiled in is `sqlite3_stmt_readonly`.
//      So the engine-authoritative route is not `sqlite3_set_authorizer` but
//      EXPLAIN opcode scraping, and SQLite documents EXPLAIN output as
//      explicitly NOT part of its API contract. A security barrier resting
//      on an unstable format fails OPEN when the format moves (no `OpenRead`
//      rows recognised ⇒ "no tables" ⇒ allow), and nothing would tell us.
//   3. It cannot be exercised in unit tests here: DB tests self-skip on
//      better-sqlite3 ABI mismatch (CLAUDE.md §5), so the barrier would ship
//      with its coverage permanently skipped.
// If an authorizer binding ever becomes available it is strictly better than
// this module and should replace it — the authority answering "which tables"
// would then be the component that executes the query.
//
// ── Posture: refuse rather than guess ─────────────────────────────────
// Every construct this tokenizer cannot account for is a REFUSAL, never a
// pass: comments (in any position, including an unterminated `/*`, which
// SQLite accepts at end of input), unterminated string/quoted identifiers,
// characters outside SQLite's lexical alphabet, a FROM/JOIN not followed by
// something that is a table name, schema qualifiers other than `main`, and
// unbalanced parentheses. Callers MUST treat `{ ok: false }` as "do not
// execute". A refusal costs the model one retry with simpler SQL; a wrong
// pass costs a data leak.
//
// An accepted statement is therefore also guaranteed PAREN-BALANCED, which
// the caller relies on: `ai.ts` executes `SELECT * FROM (<sql>) LIMIT n`, and
// a crafted imbalance can re-associate that wrapper into a different query
// than the one analysed (see the `)` branch below for the verified case).
//
// Consequence of the comment rule worth stating plainly: because comments
// are refused outright rather than stripped, the bytes this module analyses
// and the bytes SQLite executes are the same modulo whitespace. There is no
// "our normalizer vs SQLite's lexer" gap left for an attacker to aim at.
// ──────────────────────────────────────────────────────────────────────

/** The only schema qualifier accepted on a table reference. */
const MAIN_SCHEMA = 'main'

/**
 * Why the guard refused to hand back a table list. Stable, PII-free codes:
 * safe to log and to surface to the model verbatim.
 */
export type SqlGuardRefusalReason =
  /** Empty / whitespace-only input. */
  | 'empty'
  /** A line comment or a block comment anywhere in the query. */
  | 'comment'
  /** A `'...'` string literal that never closes. */
  | 'unterminated-string'
  /** A `"..."`, `` `...` `` or `[...]` identifier that never closes. */
  | 'unterminated-identifier'
  /** A character outside SQLite's lexical alphabet (e.g. `#`). */
  | 'invalid-character'
  /** FROM/JOIN (or a comma inside a FROM clause) not followed by a table name. */
  | 'missing-table-name'
  /** A schema qualifier other than `main` (e.g. `temp.x`, `a.b.c`). */
  | 'unsupported-schema'
  /** Parentheses do not balance, so the analysed statement is not self-contained. */
  | 'unbalanced-parentheses'

export type SqlTableReferences =
  | { ok: true; tables: string[] }
  | { ok: false; reason: SqlGuardRefusalReason }

// ── Tokenizer ─────────────────────────────────────────────────────────

type TokenKind =
  /** Bare or quoted identifier — the only thing allowed in a table position. */
  | 'name'
  /** One of the few keywords whose grammar we actually track. */
  | 'keyword'
  /** Structural punctuation: `(`, `)`, `,`, `.`. */
  | 'punct'
  /** Literals, operators, parameters — never a table name. */
  | 'other'

interface Token {
  kind: TokenKind
  /** Lowercased identifier text for `name`, uppercased word for `keyword`, raw for the rest. */
  value: string
}

/**
 * Keywords whose grammar this scanner tracks. Deliberately MINIMAL: any bare
 * word not listed here is treated as a `name`, and a `name` appearing where a
 * table is expected is recorded and checked against the allowlist. Adding
 * keywords can only ever make the scanner record FEWER names, so the small
 * set is the conservative one.
 */
const TRACKED_KEYWORDS = new Set([
  'FROM', 'JOIN', 'SELECT', 'VALUES', 'WITH',
  // FROM-clause terminators: after these, a comma at the same paren depth is
  // part of some other list (GROUP BY, ORDER BY, LIMIT a, b) and must not be
  // read as another table reference.
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'WINDOW',
  'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING',
])

const FROM_CLAUSE_TERMINATORS = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'WINDOW',
  'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING', 'VALUES',
])

/** Tokens that, right after an opening paren in a table position, mean "derived table". */
const SUBQUERY_STARTERS = new Set(['SELECT', 'VALUES', 'WITH'])

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v'])

/**
 * Characters SQLite accepts as operators / parameter sigils. Anything not in
 * here and not an identifier, number, literal or quote opener is refused —
 * SQLite would reject it too (`#` verified), and guessing is not an option.
 */
const OPERATOR_CHARS = new Set([
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '~', '&', '|', ';', '?', ':', '@', '$',
])

const STRUCTURAL_CHARS = new Set(['(', ')', ',', '.'])

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/**
 * SQLite identifier characters: ASCII letters, digits, `_`, and anything
 * >= 0x80 (it treats all non-ASCII bytes as identifier characters).
 * `$` is handled as a parameter sigil instead — a table named `$x` is not a
 * case we need, and misreading a parameter as a table name would only ever
 * produce a refusal.
 */
function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch.charCodeAt(0) >= 0x80
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch)
}

/**
 * Read a quoted identifier. `"` and `` ` `` double their delimiter to escape
 * it (`"a""b"` is the single identifier `a"b`); `[...]` has no escape at all.
 * Getting this wrong is the same class of bug as the one being fixed — a
 * naive scanner that stops at the first delimiter would let
 * `FROM "a""b"` desynchronise the rest of the token stream — so the
 * doubling rule is honoured explicitly.
 */
function readQuotedIdent(sql: string, start: number, open: string): { value: string; next: number } | null {
  const close = open === '[' ? ']' : open
  const doubling = open !== '['
  let out = ''
  let i = start + 1
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === close) {
      if (doubling && sql[i + 1] === close) {
        out += close
        i += 2
        continue
      }
      return { value: out, next: i + 1 }
    }
    out += ch
    i += 1
  }
  return null // unterminated
}

function tokenize(sql: string): { ok: true; tokens: Token[] } | { ok: false; reason: SqlGuardRefusalReason } {
  const tokens: Token[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]

    if (WHITESPACE.has(ch)) { i += 1; continue }

    // Comments are refused, not stripped. SQLite accepts a comment wherever
    // it accepts whitespace (including an UNTERMINATED `/*` at end of input,
    // verified), which is exactly what made the old regex bypassable. A
    // query the model wrote has no legitimate need for one, and refusing
    // removes any gap between what we parse and what SQLite executes.
    if (ch === '-' && sql[i + 1] === '-') return { ok: false, reason: 'comment' }
    if (ch === '/' && sql[i + 1] === '*') return { ok: false, reason: 'comment' }

    if (ch === "'") {
      // String literal — `''` escapes a quote. Its contents are NOT SQL: a
      // `--` or `/*` inside a literal is data, and a `'` inside a comment is
      // not a literal opener (moot here, since comments are refused).
      let j = i + 1
      let closed = false
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          closed = true
          j += 1
          break
        }
        j += 1
      }
      if (!closed) return { ok: false, reason: 'unterminated-string' }
      tokens.push({ kind: 'other', value: 'string' })
      i = j
      continue
    }

    if (ch === '"' || ch === '`' || ch === '[') {
      const read = readQuotedIdent(sql, i, ch)
      if (!read) return { ok: false, reason: 'unterminated-identifier' }
      tokens.push({ kind: 'name', value: read.value.toLowerCase() })
      i = read.next
      continue
    }

    if (isIdentStart(ch)) {
      let j = i + 1
      while (j < sql.length && isIdentPart(sql[j])) j += 1
      const word = sql.slice(i, j)
      const upper = word.toUpperCase()
      if (TRACKED_KEYWORDS.has(upper)) tokens.push({ kind: 'keyword', value: upper })
      else tokens.push({ kind: 'name', value: word.toLowerCase() })
      i = j
      continue
    }

    if (isDigit(ch)) {
      // Numeric literal. The exact numeric grammar does not matter: the token
      // is `other`, so it can never be mistaken for a table name; consuming a
      // maximal run of word/dot characters just keeps the stream in sync.
      let j = i + 1
      while (j < sql.length && (isIdentPart(sql[j]) || sql[j] === '.')) j += 1
      tokens.push({ kind: 'other', value: 'number' })
      i = j
      continue
    }

    if (STRUCTURAL_CHARS.has(ch)) {
      tokens.push({ kind: 'punct', value: ch })
      i += 1
      continue
    }

    if (OPERATOR_CHARS.has(ch)) {
      tokens.push({ kind: 'other', value: ch })
      i += 1
      continue
    }

    return { ok: false, reason: 'invalid-character' }
  }
  return { ok: true, tokens }
}

// ── Table-reference scan ──────────────────────────────────────────────

/**
 * Extract every table name referenced by a SQL statement, or refuse.
 *
 * Recognised table positions:
 *   - directly after `FROM` / `JOIN` (any join flavour — every form of join
 *     contains the `JOIN` keyword),
 *   - after a comma inside an open FROM clause at the same paren depth
 *     (`FROM a, b, c`),
 *   - inside parentheses used as a table reference (`FROM (a)`, `FROM ((a))`,
 *     `FROM (a JOIN b)`) — legal SQLite that the previous regex ignored.
 *
 * Derived tables (`FROM (SELECT … FROM x)`) contribute nothing at the paren
 * itself; their inner `FROM` is picked up by the same linear scan, so
 * subqueries at any nesting depth are covered.
 *
 * Names are returned lowercased and de-duplicated. Table-valued functions
 * (`FROM pragma_table_info('x')`) come back as their function name, so an
 * allowlist check refuses them without needing to know they exist.
 *
 * @param sql Raw SQL as supplied by the model. Never trusted.
 * @returns `{ ok: true, tables }` only when every construct was accounted
 *          for; `{ ok: false, reason }` otherwise. A refusal MUST NOT be
 *          treated as "no tables referenced".
 */
export function analyzeTableReferences(sql: string): SqlTableReferences {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { ok: false, reason: 'empty' }
  }

  const lexed = tokenize(sql)
  if (!lexed.ok) return lexed
  const tokens = lexed.tokens

  const tables: string[] = []
  let depth = 0
  /** Per-paren-depth flag: is a FROM clause currently open at this depth? */
  const fromOpen: boolean[] = [false]
  /** The next significant token must be a table name. */
  let expectTable = false

  const openFrom = (): void => { fromOpen[depth] = true }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]

    if (token.kind === 'punct' && token.value === '(') {
      depth += 1
      fromOpen[depth] = false
      if (expectTable) {
        // `FROM (` is either a parenthesised table reference or a derived
        // table; the next token decides. Keeping `expectTable` set for the
        // non-subquery case is what closes the `FROM (ai_action_log)` hole.
        const next = tokens[i + 1]
        if (!next) return { ok: false, reason: 'missing-table-name' }
        if (next.kind === 'keyword' && SUBQUERY_STARTERS.has(next.value)) expectTable = false
      }
      continue
    }

    if (token.kind === 'punct' && token.value === ')') {
      if (expectTable) return { ok: false, reason: 'missing-table-name' } // `FROM ()`
      // A closing paren with nothing open means the statement is not
      // self-contained, and the caller wraps it (`SELECT * FROM (<sql>) LIMIT n`).
      // A crafted imbalance re-associates the wrapper's own parens and can
      // graft a table reference the scan never sees, e.g.
      //   SELECT * FROM messages) , ai_action_log , (SELECT 1
      // which wraps into the perfectly valid
      //   SELECT * FROM (SELECT * FROM messages) , ai_action_log , (SELECT 1) LIMIT 201
      // (verified against SQLite: it returns the `ai_action_log` rows). Refuse.
      if (depth === 0) return { ok: false, reason: 'unbalanced-parentheses' }
      fromOpen[depth] = false
      depth -= 1
      continue
    }

    if (expectTable) {
      if (token.kind !== 'name') return { ok: false, reason: 'missing-table-name' }
      let name = token.value
      const dot = tokens[i + 1]
      if (dot && dot.kind === 'punct' && dot.value === '.') {
        const qualified = tokens[i + 2]
        if (!qualified || qualified.kind !== 'name') return { ok: false, reason: 'missing-table-name' }
        // Only `main.` is understood. `temp.` and attached-database aliases
        // name objects this guard has no allowlist for, so they are refused
        // rather than silently reduced to their unqualified name.
        if (name !== MAIN_SCHEMA) return { ok: false, reason: 'unsupported-schema' }
        name = qualified.value
        i += 2
        const extraDot = tokens[i + 1]
        if (extraDot && extraDot.kind === 'punct' && extraDot.value === '.') {
          return { ok: false, reason: 'unsupported-schema' }
        }
      }
      tables.push(name)
      expectTable = false
      continue
    }

    if (token.kind === 'keyword') {
      if (token.value === 'FROM' || token.value === 'JOIN') {
        expectTable = true
        openFrom()
        continue
      }
      if (fromOpen[depth] && FROM_CLAUSE_TERMINATORS.has(token.value)) fromOpen[depth] = false
      continue
    }

    if (token.kind === 'punct' && token.value === ',' && fromOpen[depth]) {
      expectTable = true
      continue
    }
  }

  // Trailing `FROM` with nothing after it.
  if (expectTable) return { ok: false, reason: 'missing-table-name' }
  // Unclosed parens — the mirror image of the case above, and equally unsafe
  // to hand to a caller that appends its own `)`.
  if (depth !== 0) return { ok: false, reason: 'unbalanced-parentheses' }

  return { ok: true, tables: [...new Set(tables)] }
}
