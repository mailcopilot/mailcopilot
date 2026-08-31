/**
 * §1.26.f2 — a stored AI consent may only name a mailbox that exists.
 *
 * WHAT WENT WRONG. The four per-account AI opt-ins (`aiThreadSummaryEnabled`,
 * `aiInstantReplyEnabled`, `aiProofreadEnabled`, `aiTranslateEnabled`) are
 * `Record<stringified account id, boolean>` maps, and account ids are handed
 * out as `max(existing) + 1` — so a freed number can come back. Deleting an
 * account purges its entries (`forgetAccountAiConsents`, packages/net/config.ts),
 * but that purge is not the last word, because the store has a SECOND writer.
 * The settings window loads all four maps once (a `[]`-dependency effect) and
 * sends all four back, whole, on every save; its `accounts:changed`
 * subscription re-reads `accounts:list` and nothing else. A window that was
 * open across the deletion therefore still holds `{"2": true}`, and its next
 * ordinary save merges that entry back over the purge. Hand the freed number to
 * a new mailbox and the main-side gate reads an honest-looking `true` for an
 * owner who was never asked.
 *
 * WHY THE RULE LIVES IN MAIN. Repairing the window's own snapshot (Settings.tsx
 * does that too, so the grid on screen agrees with the store) fixes only the
 * window that performed the deletion. A second settings window, a save already
 * in flight when the deletion lands, and a compromised renderer all reach the
 * same merge. Main is the only side that can compare a submitted id against the
 * account registry at the moment the save is applied.
 *
 * WHAT THIS GUARANTEES, AND ONLY WHEN THE ROSTER CAN BE READ. A `settings:save`
 * cannot persist a consent entry for an id that is absent from the roster
 * `accounts:list` serves at the moment that save is applied — neither an entry
 * the payload carried nor one already sitting in the stored map, because the
 * prune runs over the MERGED object and so also clears entries an older build
 * left behind. Which roster that is stays with the caller (main branches on
 * `IS_E2E`, like every other account lookup there); this module is handed the
 * ids and does not choose them.
 *
 * When the roster CANNOT be read the sentence above does not hold, and saying
 * it unqualified would be the very defect this batch spent its day removing
 * from the product. That branch runs `keepStoredConsents` instead: no grant the
 * payload carried can get in, but an entry an older build already stored
 * survives the save, because absence is exactly what we failed to establish.
 * The trade is argued where it is made — see `keepStoredConsents` below.
 *
 * WHAT IT DOES NOT GUARANTEE. This is a write-side rule only. The gates that
 * read these maps live in the AI services and read `getSettings()` directly, so
 * an entry written by an older build stays readable until the next
 * `settings:save` of any kind prunes it. Closing that would mean pruning on
 * read as well, in modules this one does not own; it is not claimed here.
 *
 * FORM OF THE REFUSAL — the same as §2.167: the offending entries are dropped
 * and the rest of the save is applied. Nothing is reported back over IPC. The
 * §2.167 refusal echoes values because the settings window cannot otherwise
 * repair a payload it does not know the ceiling for; here the sender's stale
 * snapshot is the whole problem, the window that saw the deletion already drops
 * the id locally, and any other window is corrected when it next reloads. What
 * matters is that nothing it sends can take effect meanwhile.
 */

/** Result of scoping the account-keyed consent maps of one save. */
export interface ConsentScopeResult<T> {
  /**
   * The settings object to persist. The SAME object (by identity) when this
   * pass changed nothing, so the common save allocates no copy.
   */
  settings: T
  /**
   * Names of the consent fields this pass rewrote. They come from the caller's
   * closed list, never from the payload, so they are safe for a log line
   * (CLAUDE.md §8).
   */
  changedFields: string[]
  /**
   * How many map entries were dropped. A count — never the ids themselves, and
   * never the values.
   */
  droppedEntries: number
}

/** Own enumerable entries of a plain object, or `null` for anything else. */
function asConsentMap(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Whether a map key names a live mailbox.
 *
 * The round-trip (`String(id) === key`) is load-bearing, not decoration. Every
 * writer of these maps keys with `String(accountId)`, and the purge in
 * `forgetAccountAiConsents` deletes exactly that string — so `"02"`, `"+2"`,
 * `" 2"`, `"2.0"` and `"2e0"` are shapes no honest writer produces and the
 * purge cannot remove. A numeric-only check would let all five keep naming a
 * live mailbox in a form nothing else can withdraw.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger` for the reason spelled
 * out for `messages.uid` (CLAUDE.md §5, "Хранилище"): `1e100` is an integer to
 * JS and is not an id.
 */
function isKnownAccountKey(key: string, knownAccountIds: ReadonlySet<number>): boolean {
  const id = Number(key)
  if (!Number.isSafeInteger(id) || String(id) !== key) return false
  return knownAccountIds.has(id)
}

/**
 * Drop every consent entry whose key does not name one of `knownAccountIds`.
 *
 * `fields` is supplied by the caller rather than imported so this module stays
 * a pure function library; the caller passes `ACCOUNT_KEYED_CONSENT_FIELDS`,
 * which is the single registration point for a fifth opt-in.
 *
 * A field that is absent, or whose value is not a plain object, is left exactly
 * as it is: this function narrows a map, it does not validate one. Whether such
 * a value may be persisted at all is decided upstream (the renderer-writable
 * schema refuses it) and downstream (`settingsSchema.parse`).
 */
export function pruneUnknownAccountConsents<T extends object>(
  settings: T,
  fields: readonly string[],
  knownAccountIds: ReadonlySet<number>,
): ConsentScopeResult<T> {
  const source = settings as unknown as Record<string, unknown>
  let copy: Record<string, unknown> | null = null
  const changedFields: string[] = []
  let droppedEntries = 0

  for (const field of fields) {
    const map = asConsentMap(source[field])
    if (!map) continue
    let next: Record<string, unknown> | null = null
    for (const key of Object.keys(map)) {
      if (isKnownAccountKey(key, knownAccountIds)) continue
      next ??= { ...map }
      delete next[key]
      droppedEntries++
    }
    if (!next) continue
    copy ??= { ...source }
    copy[field] = next
    changedFields.push(field)
  }

  return { settings: (copy ?? source) as unknown as T, changedFields, droppedEntries }
}

/**
 * Fallback for the one case where the account registry cannot be read: put the
 * STORED consent maps back and let the rest of the save through.
 *
 * Not "prune everything" and not "let it pass". Pruning against an empty set
 * would withdraw every consent in the profile over a transient read failure —
 * the safe DIRECTION (§2.82), but a silent, self-inflicted loss the user would
 * have to repair by hand. Letting the payload through is the vulnerability this
 * module exists to close. Restoring the stored value does neither: no new grant
 * can be written, no recorded answer is destroyed, and the save's other fields
 * still land.
 *
 * Identity comparison against the stored object is exact for this call site,
 * where `settings` is `{ ...stored, ...payload }`: a field the payload omitted
 * is the very object `stored` holds, and a field it carried is a fresh one. A
 * payload that re-sent a byte-identical map is therefore reported as changed
 * and restored to an equal value — a log line, not a behaviour difference.
 */
export function keepStoredConsents<T extends object>(
  settings: T,
  stored: object,
  fields: readonly string[],
): ConsentScopeResult<T> {
  const source = settings as unknown as Record<string, unknown>
  const persisted = stored as Record<string, unknown>
  let copy: Record<string, unknown> | null = null
  const changedFields: string[] = []

  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue
    if (source[field] === persisted[field]) continue
    copy ??= { ...source }
    if (Object.prototype.hasOwnProperty.call(persisted, field)) {
      copy[field] = persisted[field]
    } else {
      delete copy[field]
    }
    changedFields.push(field)
  }

  // `droppedEntries` is 0 on this path by construction: no map was inspected
  // entry by entry, because there was nothing to compare an entry against.
  return { settings: (copy ?? source) as unknown as T, changedFields, droppedEntries: 0 }
}
