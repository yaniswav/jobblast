// Builds the GDPR portability export for one account (RGPD - v0.4 pre-beta
// lot, docs/SAAS-ARCHITECTURE.md section 8 "Data export"). Composes existing
// scoped repo reads; touches no table directly, so it lives outside
// lib/repo/ - same reason routes do (see lib/scoping.test.ts).
//
// Documents are exported as metadata only, with a link to the existing
// per-document endpoint, exactly as the architecture doc specifies: "no new
// dependency, no zip library" - base64-inlining a multi-MB PDF into a JSON
// body helps nobody, and the file is already reachable at
// GET /documents/:type/file for an authenticated request.

import { getUserById } from "./auth/store";
import { readAiSettings, readAutomations, readSearchCriteria } from "./config-store";
import { listApplications } from "./repo/applications";
import { listDocuments } from "./repo/documents";
import { listBriefs } from "./repo/interview-briefs";
import { listUserPostings } from "./repo/postings";
import { getProfile } from "./repo/profile";

export type AccountExport = {
  exportedAt: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    locale: string | null;
    createdAt: string;
    lastLoginAt: string | null;
  };
  settings: {
    ai: { provider: string; model: string };
    gmailSync: { enabled: boolean; dryRun: boolean };
    aiScout: { enabled: boolean };
    notionInbox: { enabled: boolean; pageUrl: string; dataSourceUrl: string };
    searchCriteria: { keywords: string[]; targetLocationKeywords: string[]; letterLanguages: string[] };
  };
  profile: Awaited<ReturnType<typeof getProfile>>;
  applications: Awaited<ReturnType<typeof listApplications>>;
  postings: Awaited<ReturnType<typeof listUserPostings>>;
  interviewBriefs: Awaited<ReturnType<typeof listBriefs>>;
  documents: Array<{
    type: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    uploadedAt: string;
    downloadUrl: string;
  }>;
};

/**
 * Everything the app knows about `userId`, minus the password hash (never
 * exported in any form) and minus BYOK key material (a separate encrypted
 * table this function never reads - only the credential status/hint
 * endpoints ever touch it, and even those never return the key itself).
 */
export async function buildAccountExport(userId: string): Promise<AccountExport> {
  const [user, profile, applications, postings, interviewBriefs, documents] = await Promise.all([
    getUserById(userId),
    getProfile(userId),
    listApplications(userId),
    listUserPostings(userId),
    listBriefs(userId),
    listDocuments(userId),
  ]);

  if (!user) throw new Error(`No account found for user ${userId}`);

  return {
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    },
    settings: { ai: readAiSettings(), ...readAutomations(), searchCriteria: readSearchCriteria() },
    profile,
    applications,
    postings,
    interviewBriefs,
    documents: documents.map((doc) => ({
      type: doc.type,
      filename: doc.filename,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      uploadedAt: doc.uploadedAt.toISOString(),
      downloadUrl: `/api/documents/${doc.type}/file`,
    })),
  };
}
