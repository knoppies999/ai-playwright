// Test-id attribute handling (docs/12 §4). Apps spell these differently, so matching works on a
// normalised attribute name: lowercase, with everything that isn't a letter or digit removed.

export const DEFAULT_TEST_ID_ATTRIBUTES: readonly string[] = [
  'data-testid',
  'data-test-id',
  'datatestid',
  'data-test',
  'data-qa',
  'data-cy',
  'data-pw',
  'data-automation-id',
];

export const DEFAULT_REJECT_TEST_ID_VALUES: readonly RegExp[] = [/^[0-9a-f]{8,}$/i, /\d{5,}/];

/** Normalised names that count as test-id attributes for auto-detection. */
const TEST_ID_NAME_PATTERN = /^(data)?(test|qa|cy|pw|e2e|automation)(id)?$/;

/** `data-Test_Id` → `datatestid`. */
export function normaliseAttributeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True if the attribute name looks like a test-id attribute in any common spelling. */
export function looksLikeTestIdAttribute(name: string): boolean {
  return TEST_ID_NAME_PATTERN.test(normaliseAttributeName(name));
}

/** True if `name` is one of the configured attributes, ignoring spelling differences. */
export function isConfiguredTestIdAttribute(name: string, attributes: readonly string[]): boolean {
  const wanted = normaliseAttributeName(name);
  return attributes.some((a) => normaliseAttributeName(a) === wanted);
}

/** True if the value looks generated (hashes, long digit runs) and must not be used in a locator. */
export function isRejectedTestIdValue(value: string, rejectValues: readonly RegExp[]): boolean {
  // Copy each pattern so a caller's /g or /y flag can't make results depend on lastIndex.
  return value.trim() === '' || rejectValues.some((re) => new RegExp(re.source, re.flags).test(value));
}

export interface DetectedTestIdAttribute {
  /** Exact attribute name as found in the DOM. */
  attribute: string;
  /** Number of elements carrying it. */
  count: number;
}

/**
 * Auto-detection: given attribute-name → element counts collected from a page, return the test-id
 * attributes present on at least `minCount` elements. Ordered by count (desc), then name, so the
 * result is deterministic.
 */
export function detectTestIdAttributes(
  counts: Readonly<Record<string, number>>,
  minCount = 5,
): DetectedTestIdAttribute[] {
  return Object.entries(counts)
    .filter(([attribute, count]) => count >= minCount && looksLikeTestIdAttribute(attribute))
    .map(([attribute, count]) => ({ attribute, count }))
    .sort((a, b) => b.count - a.count || a.attribute.localeCompare(b.attribute));
}
