// ──────────────────────────────────────────────────────────────────────
// untrustedBoundary.ts — Canonical untrusted-data boundary marker vocabulary
// and the ONE neutralize-then-wrap primitive shared by every path that puts
// attacker-controlled text into an AI prompt.
//
// Two independent AI contours consume email content:
//   1. The interactive MCP contour (electron/services/ai.ts `wrapUntrusted`),
//      which wraps every tool result and prompt-context blob.
//   2. The background AI Rules pipeline (packages/core/aiRules.ts +
//      electron/services/aiRulesPipeline.ts), which wraps every email field
//      before batch classification.
//
// Both used to carry their OWN copy of the boundary markers and their own
// wrap function. That duplication (a) drifted (the pricing/model-matching
// copies had already diverged) and (b) shared the SAME latent hole: the
// wrapper stamped `<<<UNTRUSTED_EMAIL_DATA>>>` / `<<<END_...>>>` around the
// content WITHOUT neutralizing those exact strings inside the content. An
// attacker who wrote the END marker into an email body/subject could close
// the boundary early and have the trailing bytes read as trusted operator
// instruction — a prompt-injection boundary escape (CLAUDE.md §5).
//
// This module is the single source of truth. `neutralizeBoundaryMarkers`
// GLOBALLY rewrites both marker strings (case-insensitively, robust to
// overlapping/partial crafted runs) to an inert sentinel BEFORE wrapping, so
// no attacker-supplied bytes can forge a boundary. `wrapUntrusted` composes
// neutralize + wrap and is the primitive both contours call.
// ──────────────────────────────────────────────────────────────────────

/** Opening boundary marker for untrusted (attacker-controlled) email data. */
export const DATA_BOUNDARY_START = '<<<UNTRUSTED_EMAIL_DATA>>>';
/** Closing boundary marker for untrusted email data. */
export const DATA_BOUNDARY_END = '<<<END_UNTRUSTED_EMAIL_DATA>>>';

// Inert replacements. They are NOT valid boundary markers (the model is told
// the boundary vocabulary is the `<<<...>>>` forms above), so once content is
// neutralized it can never re-open or close a wrapper. We keep them
// human-readable so an operator reading a leaked prompt can see that a
// neutralization happened rather than silent corruption.
const NEUTRALIZED_START = '(untrusted-start-marker)';
const NEUTRALIZED_END = '(untrusted-end-marker)';

// A single global, case-insensitive regex over BOTH markers. Building one
// alternation (rather than two sequential `replaceAll`s) means a crafted run
// like `<<<END_<<<UNTRUSTED_EMAIL_DATA>>>_UNTRUSTED_EMAIL_DATA>>>` cannot use
// the residue of a first pass to reconstruct a second marker: the regex
// engine scans left-to-right and consumes each full match, and because END is
// listed before START in the alternation, the longer/prefix-overlapping END
// marker is preferred where both could begin at the same index.
//
// `escapeRegExp` keeps this correct even though the current markers contain no
// regex metacharacters beyond nothing special — future edits to the marker
// constants stay safe.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BOUNDARY_MARKER_RE = new RegExp(
  `${escapeRegExp(DATA_BOUNDARY_END)}|${escapeRegExp(DATA_BOUNDARY_START)}`,
  'gi',
);

/**
 * Neutralize every occurrence of either boundary marker inside untrusted text.
 *
 * Guarantees:
 *   - GLOBAL: every occurrence is rewritten, not just the first.
 *   - CASE-INSENSITIVE: `<<<end_untrusted_email_data>>>` is caught too, so an
 *     attacker cannot bypass by changing case.
 *   - OVERLAP-SAFE: applied once, left-to-right, over a combined alternation —
 *     because the regex consumes each full match, no residue from one
 *     replacement can be spliced with adjacent bytes to rebuild a marker that
 *     survives. (A second pass would be redundant: the sentinels contain no
 *     `<<<`/`>>>` runs, so they can never themselves participate in a marker.)
 *
 * The output is safe to place between literal boundary markers.
 */
export function neutralizeBoundaryMarkers(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(BOUNDARY_MARKER_RE, (m) => {
    // Distinguish which marker matched so the sentinel is informative. The
    // match is already the canonical (case-folded by the engine only for
    // matching — `m` is the ORIGINAL casing) marker text; compare
    // case-insensitively.
    return m.toLowerCase() === DATA_BOUNDARY_END.toLowerCase()
      ? NEUTRALIZED_END
      : NEUTRALIZED_START;
  });
}

/**
 * Neutralize attacker-controlled boundary markers inside `text`, then wrap the
 * (now inert) content in literal boundary markers. This is the ONE primitive
 * both AI contours use so the model sees a single, un-forgeable untrusted-data
 * vocabulary and no email content can escape its boundary.
 *
 * NOTE for the interactive contour: `electron/services/ai.ts` wraps this to
 * additionally bump the per-request Privacy-Panel wrap counter
 * (AsyncLocalStorage). That wrapper MUST call this function so the
 * neutralization is applied identically on both paths.
 */
export function wrapUntrusted(text: string): string {
  return `${DATA_BOUNDARY_START}\n${neutralizeBoundaryMarkers(text)}\n${DATA_BOUNDARY_END}`;
}
