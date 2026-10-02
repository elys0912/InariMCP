/**
 * `text` cut to at most `max` code points, with `ellipsis` appended when
 * something was cut. Counting code points (not UTF-16 units, as
 * String#length / #slice do) never leaves half of a surrogate pair, which
 * would show as U+FFFD to the human reading it.
 */
export function truncateCodePoints(text: string, max: number, ellipsis = '…'): string {
  // Fewer UTF-16 units than `max` means fewer code points too.
  if (text.length <= max) return text;
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('') + ellipsis;
}
