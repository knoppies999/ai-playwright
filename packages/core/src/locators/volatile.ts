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
