/**
 * Pure navigation logic for auto-advance after mail removal.
 * Finds the next mail to navigate to after removing one or more mails from the list.
 */

export type AutoAdvanceMode = 'off' | 'newer' | 'older' | 'back_to_list'

/**
 * Given a mail list, the index of the active mail being removed, and the auto-advance mode,
 * finds the next mail to navigate to. Skips items whose keys are in `removedKeys`.
 *
 * @returns The next item to navigate to, or `null` if none found or mode is 'off'/'back_to_list'.
 */
export function findNextAfterRemoval<T>(
  list: T[],
  activeIdx: number,
  mode: AutoAdvanceMode,
  removedKeys: Set<string>,
  keyFn: (item: T) => string,
): T | null {
  if (mode === 'off' || mode === 'back_to_list' || activeIdx < 0) return null

  const primaryDir = mode === 'newer' ? -1 : 1

  // Search in primary direction
  for (let i = activeIdx + primaryDir; i >= 0 && i < list.length; i += primaryDir) {
    if (!removedKeys.has(keyFn(list[i]))) return list[i]
  }

  // Fallback: search in opposite direction
  for (let i = activeIdx - primaryDir; i >= 0 && i < list.length; i -= primaryDir) {
    if (!removedKeys.has(keyFn(list[i]))) return list[i]
  }

  return null
}
