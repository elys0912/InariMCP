/**
 * Whether `value` is one of `values`: narrows a string from the wire (or an
 * argument) to the union of a const list, without an `as`.
 */
export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((v) => v === value);
}
