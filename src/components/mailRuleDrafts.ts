/**
 * mailRuleDrafts — turns a `rules:list` row into the shape the rules screen
 * edits, without ever handing the UI a value it will crash on.
 *
 * Why this exists. Rules are stored as two JSON strings, and the screen used to
 * `JSON.parse` them and use the result directly. `JSON.parse` only promises the
 * text was valid JSON, not that it decoded into a list of conditions: a row
 * holding `"null"` reached `rule.conditions.length` and took the whole Rules tab
 * down with it, and `"{}"` survived the list only to break the editor at
 * `.map`. Such a row cannot be created by this editor, but an assistant or a
 * build older than the structural check could write one — and structural
 * validation on save does nothing for rows already in the database.
 *
 * The consequence is what makes it worth a module: a user whose row is shaped
 * that way could neither see it, nor disable it, nor delete it. The whole point
 * of leaving "disable / rename / delete" unguarded is that the user always has
 * a way out of a rule that no longer works, and a crashing tab removes it.
 *
 * So a row that is not a well-formed rule is kept — with its id, name and
 * enabled flag intact — and marked {@link MailRuleDraft.malformed}. Its halves
 * are presented as empty, which is what the engine effectively sees anyway, and
 * the screen says so instead of pretending the rule has zero conditions.
 *
 * The shape check is `parseMailRuleParts` from `@mailcopilot/core` — the same
 * one the save paths and the runner go through. A second opinion here could
 * only drift from it.
 */

import { parseMailRuleParts } from '@mailcopilot/core'
import type { RuleConditionDraft } from './RuleConditionRow'

/** One action row of the editor. */
export interface MailRuleActionDraft {
  type: string
  folder?: string
}

/** A rule as the settings screen holds it. */
export interface MailRuleDraft {
  id: string
  accountId: string | null
  name: string
  enabled: boolean
  priority: number
  conditions: RuleConditionDraft[]
  actions: MailRuleActionDraft[]
  stopProcessing: boolean
  /**
   * True when the stored halves are not a rule this client can apply, so the
   * lists above are empty because they could not be read — NOT because the rule
   * has none. Screens must say which of the two it is; the counts alone would
   * read as "0 conditions", i.e. a rule the user simply left unfinished.
   */
  malformed: boolean
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Normalise one `rules:list` row.
 *
 * Never throws and never drops the row: the identity fields are read
 * defensively and always present, so the enable toggle and the delete button
 * keep working for a rule whose body could not be read. That is the evacuation
 * path, and it has to survive exactly the rows that need it most.
 */
export function toMailRuleDraft(row: unknown): MailRuleDraft {
  const r = (row !== null && typeof row === 'object' ? row : {}) as Record<string, unknown>
  const parts = parseMailRuleParts(readString(r.conditions), readString(r.actions))

  return {
    id: readString(r.id),
    accountId: typeof r.accountId === 'string' ? r.accountId : null,
    name: readString(r.name),
    enabled: r.enabled === true,
    priority: typeof r.priority === 'number' ? r.priority : 0,
    conditions: parts ? parts.conditions : [],
    actions: parts ? parts.actions : [],
    stopProcessing: r.stopProcessing === true,
    malformed: parts === null,
  }
}

/** Normalise a whole `rules:list` reply; a non-list reply yields no rules. */
export function toMailRuleDrafts(raw: unknown): MailRuleDraft[] {
  return Array.isArray(raw) ? raw.map(toMailRuleDraft) : []
}

/**
 * True when this action is a `move` that names no folder.
 *
 * Mirrors the structural check the save path applies (`parseMailRuleParts`):
 * a `move` carries its target in the action, and one without it moves nothing
 * while the caller records the move as applied. Such a rule is now refused as
 * `malformed_rule`, which is a truthful but unhelpful thing to tell someone
 * looking straight at the empty field — hence this predicate, so the editor can
 * say it at the field, before the save.
 *
 * Blank counts as absent: a folder name made of spaces addresses no mailbox.
 * Only the DECISION trims — the value itself must never be trimmed on its way
 * to storage, because a space is a legal character in an IMAP mailbox name.
 */
export function isMoveMissingFolder(action: unknown): boolean {
  if (action === null || typeof action !== 'object') return false

  const { type, folder } = action as { type?: unknown; folder?: unknown }
  if (type !== 'move') return false
  return typeof folder !== 'string' || folder.trim() === ''
}

/** True when any action of a draft rule is a `move` with no folder named. */
export function hasMoveMissingFolder(actions: unknown): boolean {
  return Array.isArray(actions) && actions.some(isMoveMissingFolder)
}
