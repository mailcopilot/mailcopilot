#!/usr/bin/env node
/**
 * Telemetry DISCLOSURE gate — schema → documentation direction.
 *
 * `check-telemetry-schema.mjs` guards the call-site direction for the seams it
 * can grep: `recordEvent` / `recordHistogram` / `recordGauge`, `reportNetEvent`
 * / `reportDbEvent`, and the net/db span helpers. It does NOT cover
 * `startMetricSpan` call sites, so ELECTRON_SPANS registration is
 * documentation-first (the schema says so in the comment above that block).
 * This guard checks the other direction: every name registered in
 * `electron/metricsSchema.ts` must stand as an ENTRY of a disclosure table — the
 * whole content of a row's first cell, in `docs/docs/privacy/telemetry.md` and in
 * every one of its translations.
 *
 * No VALUE export of that file goes unexamined, and that is enforced rather than
 * assumed: each top-level VALUE export of the schema must be listed either as
 * checked (SCHEMA_BLOCKS) or as registering no name at all
 * (SCHEMA_EXPORTS_WITHOUT_NAMES) — a decision in writing, either way — and one
 * that appears in neither list stops the run. Type exports are exempt by FORM,
 * not by name: a type declares nothing that leaves the machine. What the guard
 * does not do is second-guess the decision itself; an export a human puts in the
 * second list is out of scope by that human's decision ("Scope: NAMES" below).
 * What all this does and does not establish is spelled out below under "What the
 * guard proves, and what it does not"; read it before trusting this sentence as
 * "the user was informed".
 *
 * Why it exists. The consent disclosure is a legal document: CLAUDE.md §5
 * "Telemetry consent" requires it to match what the product actually sends
 * (GDPR art. 4(11) + recital 32 — consent is only informed if the disclosure
 * is complete). Nothing enforced that until now. A generator used to claim to
 * keep the page in sync (`scripts/gen-telemetry-docs.mjs`); it had a hardcoded
 * list of 14 event domains out of 29, silently dropped 57 of 95 events, wrote
 * the page by full overwrite, and exited 0 printing "95 metrics" while writing
 * 38. It was deleted (§2.130). The page is hand-written now, and this guard is
 * what keeps it honest.
 *
 * Direction of failure, for every question this guard actually decides: CLOSED.
 * (The question it does NOT decide — whether a reader sees an entry it accepted —
 * is the "what it does not prove" section below, not a branch here.) A name that
 * cannot be proven present is reported as missing; a schema block that parses to
 * zero entries is an error, not "nothing to check"; a schema file that does not
 * parse at all is an error; an entry shape the parser cannot resolve statically
 * (a spread, a shorthand, or an unresolvable name on the half being read — a
 * computed key where keys are the names, a non-literal value where values are)
 * is an error rather than a skipped entry; a value export of the schema that
 * neither list above mentions is an error, and so is an export form this guard
 * cannot enumerate (`export *`, an unnamed default, a destructured export); an
 * unreadable or absent disclosure file — canonical or translated — is an error;
 * a language the product ships without a translated disclosure is an error, and
 * so is a locale directory the product does not ship. The failure mode this
 * rules out is a green check that enumerated nothing.
 *
 * ── Why the schema is read with the TypeScript compiler, not with regexes ──
 * The first version of this guard matched entries with `/^ {2}'([\w.]+)'\s*:/m`
 * and bounded the block with `indexOf('} as const satisfies')`. Its own comment
 * argued that a reformat would drop the match count to zero and therefore throw.
 * That argument only holds when EVERY entry is reformatted at once. A single NEW
 * entry written with double quotes, at a different indent, with a character
 * outside the class, or an entry sitting after a comment that happens to contain
 * the literal terminator text, was simply skipped — while the ~110 untouched
 * entries kept the count non-zero, so nothing threw and the check stayed green.
 * That is exactly the scenario the guard exists for ("added a metric, forgot the
 * disclosure"), so the parser was the hole (§2.130, fix round 2).
 *
 * Names now come from the ACTUAL object literals, via the compiler already in
 * devDependencies (the same technique `electron/main.accountAuthStateWiring.test.ts`
 * uses on main.ts). Quoting, indentation, key characters and terminator text
 * stop being inputs to the answer.
 *
 * ── What the guard proves, and what it does not ─────────────────────────────
 * WHAT IT PROVES, stated exactly: a name registered in the schema stands as a
 * LIST ENTRY in every one of the six disclosure files — it is the whole content
 * of the FIRST cell of a table row, below that table's delimiter row, backticks
 * and surrounding spaces aside. The first cell is the name column of every
 * disclosure table, so what is checked is "this metric has an entry of its own",
 * not "this string occurs somewhere in the tables".
 *
 * A name written ANYWHERE ELSE counts for nothing, and the two halves of that
 * fail for different reasons, both deliberate:
 *
 *   1. NOT A ROW AT ALL — a standalone paragraph, heading, link target,
 *      front-matter field or MDX expression, or a table's own header row (the
 *      header stands BEFORE the delimiter). "I documented it in prose" is not
 *      documentation here.
 *
 *   2. A ROW, BUT NOT ITS NAME CELL — above all the `Tags` column, and equally
 *      the prose of the `Purpose` column. This half is not hypothetical
 *      tightening: until §2.130 round 4 a name was matched against the row's
 *      whole raw text, and `provider`, `folder_role`, `ai.provider` and
 *      `install_id_hash` ALREADY stand on all six pages as per-metric attribute
 *      detail in tags cells. Registering a metric under any of those four names
 *      and describing it on no page left the check GREEN, vouched for by the
 *      tags column of an unrelated row. That is precisely the failure this guard
 *      exists to catch (honest forgetfulness), so the unit judged is the entry,
 *      not the line.
 *
 * The name cell must hold the name and NOTHING else, which is what makes it an
 * entry rather than a mention: `metric.name`, or metric.name bare, optionally
 * padded with spaces. Anything you want to write around it — a footnote, a link,
 * a qualifier — goes in a later cell. One consequence worth stating in advance:
 * if a METRIC_SPAN_OP value ever diverges from its span name, writing that op in
 * a "Sentry op" column will NOT disclose it; it needs a row of its own. That is
 * the fail-closed direction, and it is the same rule, not an exception to it.
 *
 * WHY THIS IS NOT ROUND FOUR OF MODELLING THE RENDERER. Rounds 1–2 tried to
 * subtract what a reader cannot see (fences, backtick runs, comment shapes) and
 * each closed one construct while leaving the next. This narrowing does the
 * opposite of modelling: it does not ask what a line renders to, it says which
 * TEXT is the entry — the first cell — and compares it whole. The set of
 * constructs it has to know about stays at zero.
 *
 * WHAT IT DOES NOT PROVE: that the reader sees that entry. Recognition is by
 * SHAPE and by nothing else — there is no model of markdown here — so a
 * row-shaped line that happens to sit inside a comment, inside a hidden block,
 * or inside a conditionally rendered fragment IS counted, because the
 * recogniser never looks at the context around the line. Do not read a green
 * run as "the disclosure is visible"; read it as "the name is written in the
 * files, as an entry in the shape the tables use".
 *
 * WHOM IT DEFENDS AGAINST. Honest forgetfulness: somebody registers a metric
 * and never describes it, which is what actually happened here and what the
 * check catches. It does NOT defend against deliberate concealment, and it is
 * not meant to: hiding a name behind the gap above means deliberately drawing a
 * table where the reader will not meet it — inside a comment, a hidden block, a
 * fragment that renders only under some condition — or writing a
 * SCHEMA_EXPORTS_WITHOUT_NAMES entry whose `why` is untrue — and whoever can
 * commit that can just as well delete this file. A check that lives in the same
 * repository as its adversary cannot bind that adversary — that is a property
 * of where the check runs, not of how carefully it reads a line.
 *
 * WHAT WOULD CLOSE THE VISIBILITY GAP — a separate task, not an edit here:
 * either render the document for real (a markdown/MDX pipeline, so the question
 * becomes what the reader receives rather than what the file contains), or move
 * the inventory of disclosed names into a strictly parsed format of its own (a
 * data file the pages are generated from or validated against). TIGHTENING THE
 * ROW REGEX DOES NOT CLOSE IT, and this is not a guess: rounds 1 and 2
 * approximated the renderer (fences, inline-code runs, comment shapes) and each
 * closed one construct while leaving the next; round 3 narrowed the accepted
 * format to a row and left the one above; round 4 narrowed it to the row's name
 * cell and still leaves it. The class is closed by changing the input, not by
 * refining the recogniser.
 *
 * All 110 names are the whole first cell of a row on every one of the six pages
 * today — checked per file and per name by execution before the rule was
 * narrowed, and pinned by a test since — so demanding the name cell costs
 * nothing. If this turns red, some name is written somewhere no entry reaches:
 * give it a row whose first cell is the name. Do not widen the rule.
 *
 * (The position matters, and the alternative was measured rather than argued.
 * A position-independent form of the same idea — "the name is the whole content
 * of SOME cell" — does not close the finding: `provider` and `folder_role` are
 * the sole tag of several rows on all six pages, so each already fills a tags
 * cell whole. Only the NAME cell distinguishes an entry from an attribute.)
 *
 * Scope: NAMES, not prose. The guard asserts that every name of every export
 * classified as name-registering appears as a table entry of every disclosure
 * file — and no VALUE export escapes classification (a type declares nothing
 * that leaves the machine, so type exports are exempt by form), which is what
 * makes "every metric name" a fair short form of that. What it cannot do is
 * judge the classification itself (an export a human wrongly put in
 * SCHEMA_EXPORTS_WITHOUT_NAMES is out of scope by that human's decision, in
 * writing, which is the point of the `why` field) or judge whether the rest of
 * the entry's row describes the metric correctly. Both stay a human review
 * duty, as does the §2.82 rule about widening disclosure (bump
 * TELEMETRY_CONSENT_VERSION).
 *
 * Usage:
 *   node scripts/check-telemetry-docs.mjs            # exit 0 / 1
 *   node scripts/check-telemetry-docs.mjs --root=DIR # check a synthetic tree (tests)
 *   npm run check:telemetry                          # runs schema gate, then this one
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import ts from 'typescript'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Schema file, relative to the tree being checked. */
export const SCHEMA_RELPATH = 'electron/metricsSchema.ts'

/**
 * The product's language registry, relative to the tree being checked. Source of
 * truth for which languages ship (CLAUDE.md §4 "Источники истины"), and the
 * reason this guard reads it rather than trusting a copy: a language added to
 * the product without a documentation directory has to be LOUD here. Listing
 * "whatever directories exist" would make exactly that case invisible.
 */
export const I18N_INDEX_RELPATH = 'src/i18n/index.ts'

/** The export inside I18N_INDEX_RELPATH that enumerates shipped languages. */
export const SUPPORTED_LANGUAGES_EXPORT = 'SUPPORTED_LANGUAGES'

/** English canonical disclosure page, relative to the tree being checked. */
export const CANON_RELPATH = 'docs/docs/privacy/telemetry.md'

/** The language served by CANON_RELPATH rather than by a docs/i18n directory. */
export const CANON_LOCALE = 'en'

/** Root of the Docusaurus translations, relative to the tree being checked. */
export const I18N_RELPATH = 'docs/i18n'

/** Path of a locale's disclosure page inside a Docusaurus i18n tree. */
export function localeDisclosureRelpath(locale) {
  return `${I18N_RELPATH}/${locale}/docusaurus-plugin-content-docs/current/privacy/telemetry.md`
}

/**
 * Schema exports that register the telemetry strings which leave the machine.
 *
 * `side: 'keys'`   — the object's keys are the telemetry names.
 * `side: 'values'` — the object's values are, and the keys are checked elsewhere.
 *
 * METRIC_EVENTS  — discrete events, histograms and gauges.
 * NET_SPANS      — IMAP/SMTP performance spans (Sentry tracing sink).
 * ELECTRON_SPANS — main-process service spans (body indexer, offline replay,
 *                  FTS search, message details, and the four AI spans).
 * DB_SPANS       — SQLite performance spans (Sentry tracing sink).
 * METRIC_SPAN_OP — span name → Sentry `op`. Its KEYS are already covered by the
 *                  three span blocks, but its VALUES are strings that leave the
 *                  machine: `op` is a first-class field of every span we send and
 *                  the field Sentry groups by. The schema explicitly permits an
 *                  op to diverge from its name ("e.g. grouping several names
 *                  under a common op"), so a divergent value is a telemetry
 *                  string that no page names. Today all fourteen values equal
 *                  their keys, so including them adds zero names and zero
 *                  documentation work — and the moment one diverges, the
 *                  disclosure has to say so.
 *
 * Anything the schema exports and this list omits must appear in
 * SCHEMA_EXPORTS_WITHOUT_NAMES instead; an export in neither list fails the run
 * (`assertExportsAccountedFor`). The two lists together are a claim about the
 * file, so keep them that way.
 *
 * (An earlier revision justified excluding ELECTRON_SPANS by claiming the pages
 * described those spans by category rather than by name. The claim was checkable
 * and wrong: all eight members are named individually on all six pages, which is
 * why including the block — since §2.130 round 1 — left the tree green. While
 * the exclusion stood, the span half of the registry could ship an undisclosed
 * name with the check still green. The lesson is in this list's shape: an
 * exclusion has to rest on something a reader can verify.)
 */
export const SCHEMA_BLOCKS = [
  { exportName: 'METRIC_EVENTS', label: 'event', side: 'keys' },
  { exportName: 'NET_SPANS', label: 'net span', side: 'keys' },
  { exportName: 'ELECTRON_SPANS', label: 'electron span', side: 'keys' },
  { exportName: 'DB_SPANS', label: 'db span', side: 'keys' },
  { exportName: 'METRIC_SPAN_OP', label: 'span op', side: 'values' },
]

/**
 * Schema exports deliberately out of scope, each with the reason it registers no
 * telemetry name. An entry here is a decision recorded in writing, not a way to
 * silence the check: whoever adds one states, in `why`, what a reader can verify.
 *
 * The rule the exclusions rest on — statable and checkable, rather than asserted:
 *
 *   THIS GUARD CHECKS NAMES. ATTRIBUTE-LEVEL DETAIL IS NOT A NAME.
 *
 * The guard already does not check the `tags:` / `attributes:` keys nested inside
 * the SCHEMA_BLOCKS objects, and DOMAINS is that same category one level out.
 * Widening the scope to attribute-level detail is a deliberate decision about
 * what the disclosure enumerates, not a parser tweak — hence not a reflex.
 *
 * The reverse direction is checked too: an entry naming an export the schema no
 * longer has is an error, so this list stays a description of the file rather
 * than a graveyard that could one day cover an unrelated export reusing the name.
 */
export const SCHEMA_EXPORTS_WITHOUT_NAMES = [
  {
    exportName: 'DOMAINS',
    why:
      'attribute-level detail, not names: its keys are tag names (`platform`, ' +
      '`folder_role`) and its values are the enum vocabularies those tags may take. ' +
      'Both are per-metric detail, described in the prose of the row that owns the ' +
      'metric, not standalone entries anybody could look up.',
  },
]

// ============================================================================
// TypeScript-backed extraction
// ============================================================================

/**
 * Syntax errors of a parsed source file.
 *
 * `parseDiagnostics` is where the compiler puts them and it has been present on
 * SourceFile for the whole 5.x line, but it is not part of the published typings,
 * so a future build could stop exposing it. `transpileModule` reports the same
 * syntactic diagnostics through public API and is the fallback — slower, but this
 * runs once per file per CI run.
 */
function syntaxErrorsOf(sourceFile, src) {
  const parsed = sourceFile.parseDiagnostics
  if (Array.isArray(parsed)) return parsed
  return ts.transpileModule(src, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  }).diagnostics ?? []
}

/**
 * Parses a TypeScript source file, refusing to work with one that does not parse.
 *
 * A truncated or malformed schema is the shape the old terminator check tried to
 * catch, and it must stay a hard failure: the compiler recovers from a missing
 * brace and would happily hand back a SHORTER, plausible-looking name set.
 *
 * @throws when the file has any syntax error.
 */
export function parseSourceFile(relPath, src) {
  const sourceFile = ts.createSourceFile(relPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const errors = syntaxErrorsOf(sourceFile, src)
  if (errors.length > 0) {
    const first = errors[0]
    const where = first.start === undefined
      ? ''
      : ` at line ${sourceFile.getLineAndCharacterOfPosition(first.start).line + 1}`
    throw new Error(
      `${relPath}: syntax error${where} — ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}. ` +
        `The guard refuses to enumerate telemetry names from a file it cannot parse: ` +
        `the compiler recovers from a missing brace and would return a silently ` +
        `truncated set.`,
    )
  }
  return sourceFile
}

/** Strips `as const`, `satisfies T` and parentheses off an initializer. */
function unwrapExpression(expr) {
  let current = expr
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression
      continue
    }
    return current
  }
}

/** Initializer of a top-level `export const NAME = ...`, or null. */
function findExportedInitializer(sourceFile, exportName) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue
      if (decl.name.text !== exportName) continue
      return decl.initializer ?? null
    }
  }
  return null
}

/** Text of a string-shaped node, or null if the node is not a plain string. */
function stringLiteralText(node) {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

/**
 * Keys (or values) of an exported object literal in a parsed source file.
 *
 * Every property must be a plain `key: value` assignment: a spread, a shorthand
 * or a method is an entry this guard cannot resolve at all, and an unresolvable
 * entry is a name that would go unchecked — so it throws instead of being
 * skipped.
 *
 * Beyond that the demand is on the HALF that holds the names, not on both: with
 * `side: 'keys'` a computed key throws, and with `side: 'values'` a non-literal
 * value throws. The other half may be anything, because the guard never reads
 * it — a computed key on the values side hides no name, since the value is what
 * is collected (and the keys of the one values-side block are covered by the
 * span blocks anyway).
 *
 * @throws when the export is absent, is not an object literal, holds an entry
 *   shape that cannot be resolved statically, holds an unresolvable name on the
 *   side being read, or resolves to zero entries.
 */
function readNamesFromExport(sourceFile, relPath, exportName, side) {
  const initializer = findExportedInitializer(sourceFile, exportName)
  if (!initializer) {
    throw new Error(
      `${relPath}: 'export const ${exportName}' not found. The disclosure guard ` +
        `cannot enumerate telemetry names, so it refuses to pass. If the export was ` +
        `renamed, update SCHEMA_BLOCKS in scripts/check-telemetry-docs.mjs.`,
    )
  }
  const object = unwrapExpression(initializer)
  if (!ts.isObjectLiteralExpression(object)) {
    throw new Error(
      `${relPath}: ${exportName} is not an object literal (found ` +
        `${ts.SyntaxKind[object.kind]}). Refusing to guess its telemetry names.`,
    )
  }

  const names = []
  for (const prop of object.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      throw new Error(
        `${relPath}: ${exportName} contains a ${ts.SyntaxKind[prop.kind]} entry, which ` +
          `this guard cannot resolve to a telemetry name (spreads, shorthand and ` +
          `methods hide names from the check). Write it as a plain 'name': value entry.`,
      )
    }
    if (side === 'keys') {
      let key = null
      if (ts.isIdentifier(prop.name)) key = prop.name.text
      else if (!ts.isComputedPropertyName(prop.name)) key = stringLiteralText(prop.name)
      if (key === null) {
        throw new Error(
          `${relPath}: ${exportName} has an entry whose key is not a literal ` +
            `(${prop.name.getText()}). A key this guard cannot resolve is a name it ` +
            `cannot check, so it fails closed. Use a literal key.`,
        )
      }
      names.push(key)
      continue
    }
    const value = stringLiteralText(prop.initializer)
    if (value === null) {
      throw new Error(
        `${relPath}: ${exportName}['${prop.name.getText()}'] is not a string literal ` +
          `(${prop.initializer.getText()}). Its VALUE is the telemetry string that ` +
          `leaves the machine, so a value this guard cannot resolve fails closed.`,
      )
    }
    names.push(value)
  }

  if (names.length === 0) {
    throw new Error(
      `${relPath}: ${exportName} parsed to zero entries. An empty parse is treated ` +
        `as a failure, not as "nothing to disclose".`,
    )
  }
  return names
}

/**
 * Extracts the telemetry names registered by one schema export.
 *
 * @param {string} src schema source text
 * @param {string} exportName e.g. 'METRIC_EVENTS'
 * @param {'keys'|'values'} side which half of the object holds the names
 * @throws see readNamesFromExport / parseSourceFile.
 */
export function parseNameBlock(src, exportName, side = 'keys') {
  const sourceFile = parseSourceFile(SCHEMA_RELPATH, src)
  return readNamesFromExport(sourceFile, SCHEMA_RELPATH, exportName, side)
}

// ============================================================================
// Every export of the schema is accounted for
// ============================================================================

/** True when a statement carries the `export` keyword. */
function hasExportModifier(stmt) {
  return stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

/**
 * Names of every top-level VALUE export of a parsed source file.
 *
 * The split is by FORM, deliberately, because a name-based one would be the very
 * hole this function exists to close. A type alias or an interface declares
 * nothing that can be sent, so those forms are skipped; everything that exists at
 * runtime — const/let/var, function, class, enum, namespace, a name re-exported
 * through an export clause — is returned and has to be classified by a human.
 *
 * A form whose exported names cannot be enumerated statically (`export *`, an
 * unnamed default, a destructured export) throws: an export the guard cannot
 * name is one it cannot account for, and skipping it is the silent pass the whole
 * mechanism is against.
 *
 * One asymmetry worth knowing before classifying: a name that reaches the outside
 * through an export clause (`export { HELPER }`) is listed here, but SCHEMA_BLOCKS
 * can only READ an `export const NAME = {...}`. Putting such a name in the checked
 * list therefore fails with "not found" until the declaration is written that way.
 * The exclusion list has no such requirement.
 *
 * @throws on an export form that cannot be enumerated.
 */
export function listValueExports(sourceFile, relPath) {
  /** Throws; the call sites below rely on it never returning. */
  const refuse = (form, remedy) => {
    throw new Error(
      `${relPath}: this file uses an export form the disclosure guard cannot ` +
        `enumerate (${form}). The guard has to know every value this file exports, ` +
        `so that no export can register telemetry names it never checks; an export ` +
        `it cannot even name is one it cannot account for, so it fails closed. ${remedy}`,
    )
  }

  const names = []
  for (const stmt of sourceFile.statements) {
    // Types cannot carry a telemetry string; `export type` / `export interface`
    // and type-only clauses are out of scope by form.
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) continue

    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue
      if (!stmt.exportClause) {
        refuse(
          "`export * from ...`",
          `Re-export the names explicitly (\`export { A, B } from ...\`) so each one ` +
            `can be classified.`,
        )
      }
      if (ts.isNamespaceExport(stmt.exportClause)) {
        names.push(stmt.exportClause.name.text)
        continue
      }
      for (const element of stmt.exportClause.elements) {
        if (element.isTypeOnly) continue
        names.push(element.name.text)
      }
      continue
    }

    if (ts.isExportAssignment(stmt)) {
      refuse(
        '`export default` / `export =`',
        `Give the value a name: \`export const NAME = ...\`.`,
      )
    }

    if (!hasExportModifier(stmt)) continue

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          refuse(
            `a destructured export (\`${decl.name.getText()}\`)`,
            `Declare it as its own \`export const NAME = ...\`.`,
          )
        }
        names.push(decl.name.text)
      }
      continue
    }

    if (stmt.name && ts.isIdentifier(stmt.name)) {
      // function / class / enum / namespace declarations.
      names.push(stmt.name.text)
      continue
    }

    refuse(
      `an exported ${ts.SyntaxKind[stmt.kind]} with no resolvable name`,
      `Declare it as a named \`export const NAME = ...\`.`,
    )
  }
  return names
}

/**
 * Fails unless every value export of the schema is classified by a human.
 *
 * This is the half of the check that survives forgetfulness. Reading the listed
 * blocks proves those blocks are disclosed; it says nothing about a block nobody
 * listed — which is exactly how the ELECTRON_SPANS registration once sat
 * unchecked behind a green run (§2.130). The compiler already has the file, so
 * the guard enumerates what it exports and demands a decision on each name.
 *
 * @throws when an export is in neither list, or when an exclusion names an export
 *   the file no longer has.
 */
export function assertExportsAccountedFor(
  sourceFile,
  relPath,
  { blocks = SCHEMA_BLOCKS, excluded = SCHEMA_EXPORTS_WITHOUT_NAMES } = {},
) {
  const exported = listValueExports(sourceFile, relPath)
  const checked = new Set(blocks.map((b) => b.exportName))
  const skipped = new Set(excluded.map((e) => e.exportName))

  const unaccounted = exported.filter((name) => !checked.has(name) && !skipped.has(name))
  if (unaccounted.length > 0) {
    const list = unaccounted.map((n) => `'${n}'`).join(', ')
    // A renamed block shows up as one unknown export plus one checked export the
    // file no longer has. Saying both turns a puzzling message into the obvious
    // one. (A block that is simply GONE is left to readNamesFromExport, which
    // owns that message.)
    const vanished = blocks.map((b) => b.exportName).filter((name) => !exported.includes(name))
    const renameHint =
      vanished.length === 0
        ? ''
        : `SCHEMA_BLOCKS also names ${vanished.map((n) => `'${n}'`).join(', ')}, which ` +
          `this file no longer exports — if that is a rename, edit that entry instead ` +
          `of adding a new one.\n\n`
    throw new Error(
      `${relPath} exports ${list}, which the telemetry disclosure guard has never ` +
        `been told about.\n` +
        `\n` +
        renameHint +
        `Every value this file exports has to be classified, because an export the ` +
        `guard does not know about is a set of telemetry names it never checks. That ` +
        `is not hypothetical: while the ELECTRON_SPANS block was missing from the ` +
        `checked list, eight span names could ship undisclosed with this check green ` +
        `(§2.130).\n` +
        `\n` +
        `Decide which kind each one is, and edit scripts/check-telemetry-docs.mjs:\n` +
        `  - it registers telemetry strings that leave the machine (event, span or ` +
        `Sentry op names) — add { exportName: '<NAME>', label: '<what one entry is>', ` +
        `side: 'keys' | 'values' } to SCHEMA_BLOCKS, and write every one of its names ` +
        `into a table entry — the whole first cell of a row — of ${CANON_RELPATH} ` +
        `and of each translation;\n` +
        `  - it registers no such string (per-metric detail like DOMAINS, a helper, a ` +
        `lookup used only inside the process) — add { exportName: '<NAME>', why: ` +
        `'<what a reader can verify about it>' } to SCHEMA_EXPORTS_WITHOUT_NAMES.\n` +
        `\n` +
        `Leaving it out of both lists is not a third option: that is the case this ` +
        `message exists for. (Types need no entry — an \`export type\` declares ` +
        `nothing that leaves the machine.)`,
    )
  }

  const stale = [...skipped].filter((name) => !exported.includes(name))
  if (stale.length > 0) {
    throw new Error(
      `SCHEMA_EXPORTS_WITHOUT_NAMES lists ${stale.map((n) => `'${n}'`).join(', ')}, ` +
        `which ${relPath} does not export. Remove the entry (or restore the export): ` +
        `an exclusion that names nothing describes nothing, and left standing it would ` +
        `silently cover a future export that reuses the name.`,
    )
  }
}

/**
 * Parses every block of SCHEMA_BLOCKS into a flat, de-duplicated name list,
 * after checking that the schema exports nothing unclassified.
 *
 * @param {string} src schema source text
 * @param {{blocks?: object[], excluded?: object[]}} [lists] injection point for
 *   tests; production always uses the module-level lists.
 */
export function collectSchemaNames(src, { blocks = SCHEMA_BLOCKS, excluded = SCHEMA_EXPORTS_WITHOUT_NAMES } = {}) {
  const sourceFile = parseSourceFile(SCHEMA_RELPATH, src)
  assertExportsAccountedFor(sourceFile, SCHEMA_RELPATH, { blocks, excluded })
  const seen = new Map()
  for (const { exportName, label, side } of blocks) {
    for (const name of readNamesFromExport(sourceFile, SCHEMA_RELPATH, exportName, side)) {
      if (!seen.has(name)) seen.set(name, { name, label, exportName })
    }
  }
  return [...seen.values()]
}

/**
 * Languages the product ships, read from SUPPORTED_LANGUAGES.
 *
 * @throws when the export is absent, is not an array of string literals, or is empty.
 */
export function parseSupportedLanguages(src) {
  const sourceFile = parseSourceFile(I18N_INDEX_RELPATH, src)
  const initializer = findExportedInitializer(sourceFile, SUPPORTED_LANGUAGES_EXPORT)
  if (!initializer) {
    throw new Error(
      `${I18N_INDEX_RELPATH}: 'export const ${SUPPORTED_LANGUAGES_EXPORT}' not found. ` +
        `This is the source of truth for which languages ship; without it the guard ` +
        `cannot tell which translated disclosures must exist, so it fails closed.`,
    )
  }
  const array = unwrapExpression(initializer)
  if (!ts.isArrayLiteralExpression(array)) {
    throw new Error(
      `${I18N_INDEX_RELPATH}: ${SUPPORTED_LANGUAGES_EXPORT} is not an array literal ` +
        `(found ${ts.SyntaxKind[array.kind]}). Refusing to guess the language set.`,
    )
  }
  const languages = []
  for (const element of array.elements) {
    const text = stringLiteralText(element)
    if (text === null) {
      throw new Error(
        `${I18N_INDEX_RELPATH}: ${SUPPORTED_LANGUAGES_EXPORT} contains a non-literal ` +
          `entry (${element.getText()}). A language this guard cannot resolve is a ` +
          `disclosure it cannot require, so it fails closed.`,
      )
    }
    languages.push(text)
  }
  if (languages.length === 0) {
    throw new Error(
      `${I18N_INDEX_RELPATH}: ${SUPPORTED_LANGUAGES_EXPORT} is empty. Treated as a ` +
        `failure, not as "no translations to check".`,
    )
  }
  return languages
}

/** Shipped languages minus the one served by the canonical page. */
export function docLocalesFrom(languages) {
  if (!languages.includes(CANON_LOCALE)) {
    throw new Error(
      `${I18N_INDEX_RELPATH}: ${SUPPORTED_LANGUAGES_EXPORT} does not contain ` +
        `'${CANON_LOCALE}', but ${CANON_RELPATH} is the ${CANON_LOCALE} disclosure. ` +
        `The guard cannot tell which file serves which language, so it fails closed.`,
    )
  }
  return languages.filter((l) => l !== CANON_LOCALE)
}

/** Reads the shipped language set from a tree and returns its translated locales. */
export async function readExpectedLocales(root) {
  let src
  try {
    src = await readFile(path.join(root, I18N_INDEX_RELPATH), 'utf8')
  } catch (err) {
    throw new Error(
      `cannot read ${I18N_INDEX_RELPATH} (${err.code ?? 'error'}). It is the source ` +
        `of truth for the shipped language set; without it the guard cannot know ` +
        `which translated disclosures to require, so it fails closed.`,
    )
  }
  return docLocalesFrom(parseSupportedLanguages(src))
}

// ============================================================================
// The accepted disclosure format: an entry — the name cell of a table row
// ============================================================================

/**
 * True for a line shaped like a table row: it begins and ends with a cell
 * separator. Shape only — this predicate reads neither what a cell says nor
 * what surrounds the line.
 */
function isRowShaped(line) {
  return line.length >= 2 && line.startsWith('|') && line.endsWith('|')
}

/** True for a table's delimiter row (`| --- | :---: |`), alignment colons and all. */
function isDelimiterRow(line) {
  return /^\|[\s:|-]*-[\s:|-]*\|$/.test(line)
}

/**
 * The lines of `text` shaped like a table body row.
 *
 * A row is recognised by SHAPE, and by shape alone: a line that begins and ends
 * with a cell separator, standing under the delimiter row of its own table.
 * That last condition is what excludes the header row (it comes BEFORE the
 * delimiter) and a stray pipe-shaped line that no delimiter row precedes within
 * its own uninterrupted run of row-shaped lines.
 *
 * THE LIMIT OF THAT, stated here so nobody rediscovers it as a bug: this
 * function never looks at what surrounds a line, so a row-shaped line inside a
 * comment, inside a hidden block, or inside a fragment that renders
 * conditionally is returned like any other row. It answers "is this line shaped
 * like a row of a table?" — never "does the reader see it?". Proving the second
 * needs a real rendering of the document or a separate machine-readable
 * inventory; refining the predicates here does not get there (file header,
 * "What the guard proves, and what it does not").
 *
 * Rows are returned verbatim; `listEntryNames` is what turns one into an entry.
 */
export function tableRows(text) {
  const rows = []
  let underDelimiter = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!isRowShaped(line)) {
      underDelimiter = false
      continue
    }
    if (isDelimiterRow(line)) {
      underDelimiter = true
      continue
    }
    if (underDelimiter) rows.push(line)
  }
  return rows
}

/**
 * The raw text of a row's first cell — the name cell of a disclosure table.
 *
 * `\|` is the markdown escape for a literal pipe inside a cell, so it does not
 * end the cell; it is the one piece of cell syntax this function knows, and it
 * is here to prevent a FALSE RED rather than to model anything. Every other
 * character, backslashes included, is passed through untouched.
 *
 * @param {string} row a trimmed line that starts and ends with '|'
 */
export function firstCellOf(row) {
  let cell = ''
  for (let i = 1; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
      continue
    }
    if (row[i] === '|') break
    cell += row[i]
  }
  return cell
}

/**
 * A cell's content with one surrounding code span and its padding removed.
 *
 * All 110 names are written as `metric.name` code spans on all six pages; a
 * bare name is accepted too, so the rule does not depend on a formatting habit.
 * Nothing else is stripped — bold, a footnote marker or a link around the name
 * leaves the cell holding more than the name, and more than the name is not an
 * entry (file header).
 */
function unwrapCodeSpan(cell) {
  const trimmed = cell.trim()
  const span = /^(`+)([^`]*)\1$/.exec(trimmed)
  return (span ? span[2] : trimmed).trim()
}

/**
 * The names this text declares as entries: the unwrapped first cell of every
 * table body row.
 *
 * THE RULE: a name counts as disclosed only when it IS one of these strings.
 * Two ways to fail it, both intended (file header, "What the guard proves"):
 * a line that is not a row declares no entry at all — a paragraph, a heading, a
 * standalone link target, the front matter, an MDX expression, a table's own
 * header row; and a row's LATER cells declare nothing either — the tags column
 * lists per-metric attributes (`provider`, `folder_role`, `install_id_hash` and
 * `ai.provider` all stand there today), and the purpose column is prose. Before
 * §2.130 round 4 a name was matched against the row's whole raw text, so any of
 * those four names could be registered as a metric, described nowhere, and pass.
 *
 * Comparison is by EQUALITY, which is where the old boundary-matching went: an
 * entry and a name are two whole strings, so documenting `app.session_started`
 * cannot vouch for `app.session_start` — they are simply not the same string,
 * with no notion of a boundary needed to say so.
 */
export function listEntryNames(text) {
  const names = []
  for (const row of tableRows(text)) {
    const name = unwrapCodeSpan(firstCellOf(row))
    if (name.length > 0) names.push(name)
  }
  return names
}

/**
 * Resolves the disclosure files of a tree and reads them.
 *
 * Also validates the locale set against the languages the product actually
 * ships: every one of them must have a readable page, and `docs/i18n` must
 * contain no directory outside that set. Both are hard errors — see the header
 * note on direction of failure. Symlinked locale directories are resolved, so a
 * stray language cannot hide behind one.
 *
 * @throws on a missing/unreadable file, a missing i18n root, a dangling link, or
 *   a locale directory the product does not ship.
 */
export async function readDisclosures(root, locales) {
  const files = [{ locale: null, relPath: CANON_RELPATH }]
  for (const locale of locales) {
    files.push({ locale, relPath: localeDisclosureRelpath(locale) })
  }

  const i18nDir = path.join(root, I18N_RELPATH)
  let entries
  try {
    entries = await readdir(i18nDir, { withFileTypes: true })
  } catch (err) {
    throw new Error(
      `cannot read ${I18N_RELPATH} (${err.code ?? 'error'}). The guard cannot ` +
        `confirm that the translated disclosures exist, so it fails closed.`,
    )
  }

  const present = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      present.push(entry.name)
      continue
    }
    if (!entry.isSymbolicLink()) continue
    // A symlinked locale directory is still a locale directory; `isDirectory()`
    // is false for links, so without this a stray language could ship as a link
    // and skip the unknown-locale check entirely.
    let target
    try {
      target = await stat(path.join(i18nDir, entry.name))
    } catch (err) {
      throw new Error(
        `${I18N_RELPATH}/${entry.name} is a symlink that cannot be resolved ` +
          `(${err.code ?? 'error'}). The guard cannot tell whether it is a locale ` +
          `directory, so it fails closed.`,
      )
    }
    if (target.isDirectory()) present.push(entry.name)
  }
  present.sort()

  const unknown = present.filter((l) => !locales.includes(l))
  if (unknown.length > 0) {
    throw new Error(
      `unknown locale(s) under ${I18N_RELPATH}: ${unknown.join(', ')}. Every ` +
        `documentation locale must be a language the product ships — add it to ` +
        `${SUPPORTED_LANGUAGES_EXPORT} in ${I18N_INDEX_RELPATH} (and translate ` +
        `${CANON_RELPATH}), or remove the directory.`,
    )
  }

  const out = []
  for (const file of files) {
    let text
    try {
      text = await readFile(path.join(root, file.relPath), 'utf8')
    } catch (err) {
      throw new Error(
        `cannot read ${file.relPath} (${err.code ?? 'error'}). This is the ` +
          `${file.locale ? `'${file.locale}' translation` : 'canonical'} telemetry ` +
          `disclosure; without it the guard cannot check whether the schema's ` +
          `names stand in its tables, so it fails closed.`,
      )
    }
    // Only the entries are kept — the name cell of each table body row. The
    // rest of the page counts for nothing: neither the prose around the tables
    // nor the other cells of a row (see `listEntryNames`, including the limit of
    // shape-only recognition). A file that declares no entry therefore has
    // nothing that can count, and every name is reported missing — the
    // fail-closed reading of "the tables are gone or malformed".
    const rowCount = tableRows(text).length
    const entries = listEntryNames(text)
    // `rawText` decides NOTHING. It exists so the failure report can tell the
    // two shapes of "missing" apart — "this name is nowhere in the file" versus
    // "it is written here, but only as a mention" — which is the difference
    // between forgetting a metric and thinking a tags cell disclosed it. Match
    // against `entries`, never against this.
    out.push({ ...file, entries: new Set(entries), rawText: text, rowCount })
  }
  return out
}

/**
 * True when `name` occurs in `text` as a whole word.
 *
 * DIAGNOSTIC ONLY — nothing passes or fails on this. It answers "is the name
 * written somewhere in this file at all?", so the report can say *why* an entry
 * is missing. Boundary-checked so `provider_id` does not read as a mention of
 * `provider`.
 */
function occursAsWord(text, name) {
  const boundary = (ch) => ch === '' || !/[A-Za-z0-9_.]/.test(ch)
  for (let from = 0; ; ) {
    const at = text.indexOf(name, from)
    if (at < 0) return false
    if (boundary(at === 0 ? '' : text[at - 1]) && boundary(text[at + name.length] ?? '')) return true
    from = at + 1
  }
}

/** Returns one entry per (file, missing name), in file order then schema order. */
export function findMissing(names, disclosures) {
  const problems = []
  for (const doc of disclosures) {
    const declared = doc.entries instanceof Set ? doc.entries : new Set(doc.entries ?? [])
    for (const entry of names) {
      if (declared.has(entry.name)) continue
      problems.push({
        relPath: doc.relPath,
        locale: doc.locale,
        rowCount: doc.rowCount ?? null,
        // Written in the file, but not as an entry — a tags cell, a purpose
        // cell, or prose. Reported differently because the fix differs.
        mentionedOnly: typeof doc.rawText === 'string' && occursAsWord(doc.rawText, entry.name),
        ...entry,
      })
    }
  }
  return problems
}

/** Formats the operational failure report: which names, which files, what to do. */
export function formatReport(problems, locales) {
  const byFile = new Map()
  for (const p of problems) {
    if (!byFile.has(p.relPath)) byFile.set(p.relPath, [])
    byFile.get(p.relPath).push(p)
  }
  const lines = [
    `Telemetry disclosure check FAILED — ${problems.length} undisclosed name(s) ` +
      `across ${byFile.size} file(s). A name is disclosed when it stands as an ENTRY: ` +
      `the whole first cell of a table row.`,
    '',
  ]
  let anyMentionedOnly = false
  for (const [relPath, items] of byFile) {
    const locale = items[0].locale ? `translation '${items[0].locale}'` : 'canonical page'
    lines.push(`${relPath}  (${locale}) — ${items.length} name(s) with no entry:`)
    if (items[0].rowCount === 0) {
      lines.push('  ! this file contains no table rows at all — its disclosure tables are')
      lines.push('    missing or malformed, so nothing in it can count as a disclosure')
    }
    for (const item of items) {
      const where = item.mentionedOnly
        ? '  <- written in this file, but only as a MENTION, not as an entry'
        : ''
      if (item.mentionedOnly) anyMentionedOnly = true
      lines.push(`  - ${item.name}  (${item.label}, ${item.exportName})${where}`)
    }
    lines.push('')
  }
  if (anyMentionedOnly) {
    lines.push(
      'About the names marked "only as a MENTION": that string does occur in the file,',
      'but not where an entry is declared — so it is written down without being',
      'disclosed. The usual cases are the Tags column, which lists the per-metric',
      'attributes of some OTHER metric (`provider`, `folder_role`, `install_id_hash`',
      'and `ai.provider` all stand there already), the Purpose column, and prose',
      'outside the tables. A tags cell describes an attribute of a row, not a metric of',
      'its own, so it discloses nothing about a metric that happens to share its name.',
      'Give the metric its own row.',
      '',
    )
  }
  lines.push(
    'What to do: every telemetry name registered in electron/metricsSchema.ts must',
    `appear in ${CANON_RELPATH} AND in all ${locales.length} translations`,
    `(${locales.join(', ')}) — as a TABLE ENTRY.`,
    '',
    'THE RULE: a name counts as disclosed only when it IS the whole content of the',
    'FIRST cell of a table row — the name column — below that table\'s "| --- |"',
    'delimiter row. Backticks are fine: `metric.name` is how all six pages write',
    'every name; a bare name works too. Two ways to miss it, and they need',
    'different fixes:',
    '  - the name is not in a row at all — a paragraph, a heading, a link target,',
    '    the front matter, an MDX expression, or the table\'s own header row;',
    '  - the name is in a row, but in a LATER cell — the Tags column or the Purpose',
    '    prose. That cell belongs to another metric\'s entry and says nothing about',
    '    this one.',
    'And the name cell must hold the name and nothing else: a footnote, a link or a',
    'qualifier around it makes the cell a description rather than an entry, so put',
    'those in a later cell.',
    'The reason is the reader — the tables are what a user reads, and what a reader',
    'scans for a metric is the name column.',
    '',
    'So if you documented the metric in prose, or only as somebody else\'s tag, give',
    'it a row of its own. Add one row per name, in the language of that file — or, if',
    'the metric is gone, remove it from metricsSchema.ts. If the disclosure genuinely',
    'widens (a new category of data), also bump TELEMETRY_CONSENT_VERSION so users are',
    'asked again.',
    '',
    'These pages are HAND-WRITTEN. There is no generator: the old one silently',
    'dropped 60% of the schema and overwrote the page, and was removed (§2.130).',
    'Edit them by hand.',
  )
  return lines.join('\n')
}

/**
 * Runs the full check against a tree.
 *
 * Returns the parsed names, the expected locales, the read disclosures and the
 * problems found. An undisclosed name is a returned problem, never a throw;
 * everything the guard cannot enumerate, cannot read, or has not been told about
 * does throw (see the header note on direction of failure).
 */
export async function runCheck(root = ROOT) {
  const src = await readFile(path.join(root, SCHEMA_RELPATH), 'utf8')
  const names = collectSchemaNames(src)
  const locales = await readExpectedLocales(root)
  const disclosures = await readDisclosures(root, locales)
  const problems = findMissing(names, disclosures)
  return { names, locales, disclosures, problems }
}

export function parseArgs(argv) {
  let root = null
  for (const arg of argv) {
    const m = /^--root=(.+)$/.exec(arg)
    if (!m) throw new Error(`unknown argument: ${arg}`)
    root = m[1]
  }
  return { root }
}

async function main() {
  const { root } = parseArgs(process.argv.slice(2))
  const { names, locales, problems } = await runCheck(root ?? ROOT)
  if (problems.length > 0) {
    console.error(formatReport(problems, locales))
    process.exit(1)
  }
  // Says what was proven, not what a reader sees: recognition is by row shape
  // only (file header, "What the guard proves, and what it does not").
  console.log(
    `Telemetry disclosure check OK — all ${names.length} schema names stand as a ` +
      `table entry (the whole first cell of a row) in each of ${locales.length + 1} ` +
      `files (row shape only; an entry inside a comment or a hidden block counts too).`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Telemetry disclosure check FAILED: ${err.message}`)
    process.exit(1)
  })
}
