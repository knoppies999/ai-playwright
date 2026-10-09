// Generated-value filter (docs/12 §5): ids and text that change between builds or page loads must
// never end up in a stored locator.

export const DEFAULT_REJECT_ID_PATTERNS: readonly RegExp[] = [
  /^:r[0-9a-z]+:$/i, // React useId
  /radix-/i,
  /^(ember|ext-gen|ui-id-|mat-[a-z-]+-|headlessui-[a-z-]+-|downshift-)\d+/i, // framework counters
  /[0-9a-f]{8}-[0-9a-f]{4}-/i, // GUIDs
  /^[0-9a-f]{8,}$/i, // long hex
  /\d{4,}/, // long digit runs
  /__[A-Za-z0-9_-]{5,}$/, // CSS-module hashes
  /^sc-[A-Za-z]{5,}/, // styled-components
];

export function isGeneratedId(id: string, patterns: readonly RegExp[] = DEFAULT_REJECT_ID_PATTERNS): boolean {
  return id.trim() === '' || patterns.some((re) => new RegExp(re.source, re.flags).test(id));
}

/** Static text suitable for getByText / filter({ hasText }): short, and no numbers that may be data. */
export function isStableText(text: string): boolean {
  const t = text.trim();
  return t.length >= 2 && t.length <= 60 && !/\d/.test(t);
}
