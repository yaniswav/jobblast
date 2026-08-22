// Shared helpers for headless-Claude-CLI source fetchers (aiscout.ts,
// notion-inbox.ts, ...) that ask the CLI agent to return "STRICT JSON: an
// array of objects" and need to validate + parse that response.
//
// Factored out of aiscout.ts, which was the first fetcher to need this.

/** True for a string with non-whitespace content. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True if `value` parses as an http(s) URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Finds the first top-level `[...]` array in `raw` by bracket-matching
 * (respecting string literals so a `[`/`]` inside a URL or description
 * doesn't confuse the count) and returns its text, or null if none closes.
 * The model is told to output ONLY the JSON array, but in practice
 * sometimes appends trailing commentary after it despite that instruction
 * (observed live) - this recovers the array instead of discarding a
 * response that's actually valid apart from the trailing text.
 */
export function extractJsonArrayText(raw: string): string | null {
  const start = raw.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parses `raw` as a JSON array, tolerating trailing non-JSON text after the
 * array (see extractJsonArrayText). Returns null - never throws - if no
 * valid JSON array can be recovered at all.
 */
export function parseJsonArrayResponse(raw: string): unknown[] | null {
  try {
    const direct = JSON.parse(raw);
    if (Array.isArray(direct)) return direct;
  } catch {
    // fall through to bracket-matched extraction below
  }

  const extracted = extractJsonArrayText(raw);
  if (!extracted) return null;
  try {
    const parsed = JSON.parse(extracted);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
