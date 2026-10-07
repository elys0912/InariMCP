// Cutting strings to a length limit (pure; bundled into the background, the
// popup and the content script).

/**
 * `text` cut to at most `max` UTF-16 code units, never between the two
 * halves of a surrogate pair (an emoji or other character outside the BMP
 * is dropped whole rather than leaving a lone surrogate).
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  const last = text.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? max - 1 : max);
}
