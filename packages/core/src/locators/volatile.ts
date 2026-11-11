// Values that are data, not structure (docs/12 §5): record ids and prices change between runs and
// environments, so they must not end up in stored locators or URL patterns.

/**
 * A token of 16+ letters and digits that mixes both: ULIDs (01M4KFJHJFJBXR3A2RWKK2Z7GK), nanoids,
 * Mongo ObjectIds. Bounded by the start/end or a separator, so ordinary words don't match.
 */
export const MIXED_ID_TOKEN = /(?:^|[-_:./])(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{16,}(?=$|[-_:./])/i;

/** True if a URL path segment is a record id: digits, a GUID, long hex, or a ULID-like token. */
export function isIdSegment(seg: string): boolean {
  return /^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{16,}$/i.test(seg) || MIXED_ID_TOKEN.test(seg);
}

/** A trailing keyboard-shortcut hint: "Search Ctrl K" on Windows is "Search ⌘ K" on a Mac. */
const SHORTCUT_HINT = /\s+(?:(?:ctrl|control|cmd|command|alt|option|shift|meta|win|⌘|⌥|⇧|⌃)\s*\+?\s*)+\S{1,3}$/i;

/** The name without a trailing keyboard-shortcut hint, or undefined when it has none (or nothing would be left). */
export function withoutShortcutHint(name: string): string | undefined {
  const m = SHORTCUT_HINT.exec(name);
  if (!m) return undefined;
  const rest = name.slice(0, m.index).trim();
  return rest.length >= 3 ? rest : undefined;
}

/** A price or amount in a name: "$14.15", "R 1 299,00" (rand), "12.50". */
const PRICE = /[$€£¥₹]\s?\d|\bR\s?\d[\d\s]*[.,]\d{2}\b|\b\d+[.,]\d{2}\b/;

/**
 * For an accessible name that embeds a price (a product card link: "Combination Pliers … $14.15"), the
 * stable part before it ("Combination Pliers"). Undefined when the name has no price or the rest is too short.
 */
export function stableNamePrefix(name: string): string | undefined {
  const m = PRICE.exec(name);
  if (!m) return undefined;
  const prefix = name.slice(0, m.index).trim();
  // Card names repeat the title ("Pliers Compare Pliers CO₂: A B"); the first few words are enough.
  const words = prefix.split(/\s+/).slice(0, 4).join(' ');
  return words.length >= 3 ? words : undefined;
}

/**
 * A trailing counter, with whatever joins it to the name: "N of M" (" : 2 of 1,395", " (3 of 12)", " 2 / 5"), or a
 * count in brackets (" (3)", " (99+)"). A bare trailing number is not one: "Page 2" and "Order 1002" are identities.
 */
const COUNTER = /[\s:–—(-]*\b\d[\d,.]*\s*(?:of|\/)\s*\d[\d,.]*\)?\s*$|\s*\(\d[\d,.]*\+?\)\s*$/i;

/**
 * For a name that ends in a counter ("Next page : 2 of 1,395", "Photo 3 of 12"), the part before it. The total is
 * data: GOV.UK's search gained pages and the recorded "… 2 of 1,395" no longer matched. Undefined when the name has
 * no counter or too little is left.
 */
export function withoutCounter(name: string): string | undefined {
  const m = COUNTER.exec(name);
  if (!m) return undefined;
  const rest = name.slice(0, m.index).trim();
  return rest.length >= 3 ? rest : undefined;
}

/**
 * For expected text that ends in "N of M" ("1 of 1,396"), the text without the total ("1 of"), and the total. An
 * assertion about page 2 that quotes the number of pages breaks when the site gains one. Undefined when the text
 * has no such ending.
 */
export function withoutCounterTotal(text: string): { text: string; total: string } | undefined {
  const m = /^(.*\b\d[\d,.]*\s+of)\s+(\d[\d,.]*?)[).]?\s*$/i.exec(text);
  return m ? { text: m[1]!, total: m[2]! } : undefined;
}
