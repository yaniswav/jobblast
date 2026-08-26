// Operator identity + data policy, for the Privacy page (v0.4 pre-beta lot,
// docs/SAAS-ARCHITECTURE.md section 8). Public (no session needed - it has
// to be reachable from the login screen) and saas only.
//
// This is a from-the-ground-up open source project: every operator running
// their own beta puts their own identity here, in environment variables,
// never hardcoded in the repo. An operator who leaves them unset gets
// `available: false` back rather than a page full of nulls - the frontend
// then shows a plain "not configured" notice instead of pretending an
// identity exists.

import { Router, type IRouter } from "express";
import { GetLegalInfoResponse } from "@workspace/api-zod";
import { isEmailEnabled } from "../lib/email";
import {
  INACTIVITY_DELETE_AFTER_DAYS,
  INACTIVITY_WARNING_AFTER_DAYS,
  INACTIVITY_WARNING_GRACE_DAYS,
} from "../lib/queue/inactivity-selection";
import { quotaCapFor } from "../lib/quota-config";
import { IS_SAAS } from "../lib/mode";

const router: IRouter = Router();

const POSTINGS_RETENTION_DAYS_DEFAULT = 90;

function postingsRetentionDays(): number {
  const raw = Number(process.env["JOBBLAST_POSTING_RETENTION_DAYS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : POSTINGS_RETENTION_DAYS_DEFAULT;
}

function envValue(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? raw : null;
}

router.get("/legal", (_req, res) => {
  if (!IS_SAAS) {
    res.status(404).json({ error: "There is no operator to describe on a self-hosted install" });
    return;
  }

  const operator = envValue("JOBBLAST_LEGAL_OPERATOR");
  const address = envValue("JOBBLAST_LEGAL_ADDRESS");
  const contact = envValue("JOBBLAST_LEGAL_CONTACT");
  const country = envValue("JOBBLAST_LEGAL_COUNTRY");
  const emailEnabled = isEmailEnabled();

  res.json(
    GetLegalInfoResponse.parse({
      // False when the operator has not filled in JOBBLAST_LEGAL_* yet - the
      // frontend shows a plain "not configured" notice instead of a page
      // full of blanks.
      available: operator !== null,
      operator,
      address,
      contact,
      country,
      postingsRetentionDays: postingsRetentionDays(),
      quotas: {
        tailorPerDay: quotaCapFor("tailor"),
        fitPerDay: quotaCapFor("fit"),
        briefPerDay: quotaCapFor("brief"),
      },
      emailEnabled,
      inactivityPurge: {
        // Mirrors the fail-safe in lib/queue/inactivity-selection.ts: with no
        // working email transport, the pass never warns and never deletes.
        enabled: emailEnabled,
        warningAfterMonths: Math.round(INACTIVITY_WARNING_AFTER_DAYS / 30),
        deleteAfterMonths: Math.round(INACTIVITY_DELETE_AFTER_DAYS / 30),
        warningGraceDays: INACTIVITY_WARNING_GRACE_DAYS,
      },
    }),
  );
});

export default router;
