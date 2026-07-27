/**
 * Shared helpers for the custom <Select> component.
 */

/** Represents a single option in a Select dropdown. */
export type SelectOption<T extends string | number = string> = {
  /** The value emitted by onChange when this option is chosen. */
  value: T
  /** The human-readable label rendered in the trigger and the dropdown. */
  label: string
}

/**
 * Build a SelectOption array from a plain values array where label === value.
 * Useful for simple string enumerations.
 */
export function makeOptions<T extends string>(values: ReadonlyArray<T>): SelectOption<T>[] {
  return values.map(v => ({ value: v, label: v }))
}

/**
 * Build a SelectOption array from a Record<value, label> map.
 * Preserves declaration order (Object.entries order for string keys).
 */
export function optionsFromRecord<T extends string>(
  map: Record<T, string>,
): SelectOption<T>[] {
  return (Object.entries(map) as [T, string][]).map(([value, label]) => ({ value, label }))
}
