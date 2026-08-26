// Operator-configured quota caps (docs/SAAS-ARCHITECTURE.md section 5). One
// env var per kind, with the doc's own defaults; unset/zero means unlimited.
//
// selfhosted always returns null (unlimited) for every kind, so behavior
// there is unchanged - the caps exist to protect a BYOK account from a
// runaway loop against its own metered key, which selfhosted has no
// equivalent of (a CLI subscription costs nothing marginal).

import { IS_SAAS } from "./mode";
import type { UsageKind } from "./quotas";

const DEFAULTS = {
  tailor: 40,
  fit: 60,
  brief: 5,
} satisfies Record<UsageKind, number>;

const ENV_NAMES = {
  tailor: "JOBBLAST_QUOTA_TAILOR_PER_DAY",
  fit: "JOBBLAST_QUOTA_FIT_PER_DAY",
  brief: "JOBBLAST_QUOTA_BRIEF_PER_DAY",
} satisfies Record<UsageKind, string>;

/**
 * The daily cap for one usage kind, or null for unlimited.
 *
 * selfhosted: always null.
 * saas: the env override when set (0 explicitly means "no cap" - an
 * operator escape hatch), otherwise the doc's default.
 */
export function quotaCapFor(kind: UsageKind): number | null {
  if (!IS_SAAS) return null;

  const raw = process.env[ENV_NAMES[kind]];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed === 0 ? null : parsed;
    }
  }
  return DEFAULTS[kind];
}
