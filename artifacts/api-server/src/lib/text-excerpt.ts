// Shared "strip HTML, collapse whitespace, truncate on a word boundary"
// excerpt for a posting description. Used by the anonymous trial matcher
// (lib/anonymous-match.ts, which originated this logic) and the shared-pool
// search endpoint (lib/explore-search.ts, lot J2), so a posting's
// card-sized description snippet is built the same way everywhere the pool
// renders one.

/** Truncates `description` to at most `maxLength` characters, breaking on a
 * word boundary when there is a reasonable one to break on. */
export function excerpt(description: string, maxLength: number): string {
  const plain = description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (plain.length <= maxLength) return plain;
  const cut = plain.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  const boundary = lastSpace > 40 ? lastSpace : maxLength;
  return `${cut.slice(0, boundary).trimEnd()}…`;
}
