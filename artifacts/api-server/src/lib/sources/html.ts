// Minimal HTML-to-text helper for job board APIs (Greenhouse) that return
// descriptions as HTML. No dependency added on purpose - this is a best
// effort strip, not a full HTML parser.

// Looked up by an arbitrary regex match below, so the `string` index
// signature is load-bearing.
// eslint-disable-next-line anti-slop/no-known-value-widening
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&[a-z]+;/gi, (match) => ENTITIES[match] ?? match);
}

export function stripHtml(html: string): string {
  const withBreaks = html
    // Turn common block-level boundaries into newlines before stripping tags.
    .replace(/<\/(p|div|li|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "- ");
  const withoutTags = withBreaks.replace(/<[^>]+>/g, "");
  const decoded = decodeEntities(withoutTags);
  const lines = decoded.split("\n").map((line) => line.trim());
  // Collapse runs of blank lines down to a single blank line.
  const collapsed = lines.filter((line, index) => line.length > 0 || lines[index - 1] !== "");
  return collapsed.join("\n").trim();
}
