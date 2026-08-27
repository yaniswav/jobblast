// Explore (lot J2): search the entire shared pool of postings directly,
// beyond whatever this account's own criteria have already scored and
// queued (that stays GET /jobs). saas pools every account's
// signatures/watches together; selfhosted's pool is just its own fetches -
// same route, same UI, no mode-conditional code, since the search itself
// never cares how the pool got populated.

import { Router, type IRouter } from "express";
import {
  AddExplorePostingParams,
  AddExplorePostingResponse,
  SearchExploreQueryParams,
  SearchExploreResponse,
} from "@workspace/api-zod";
import { actingUserId } from "../lib/auth/middleware";
import { parseExploreSearch, toExplorePostingCard } from "../lib/explore-search";
import { getPostingById, searchPostings } from "../lib/repo/postings";
import { scoreAndAttachPosting } from "../lib/sources/refresh";

const router: IRouter = Router();

router.get("/explore", async (req, res): Promise<void> => {
  const userId = actingUserId(req);

  // Checked ahead of the zod parse below on purpose: the generated schema's
  // `q` is `zod.coerce.string().min(2)` (query-string params are coerced -
  // see lib/api-spec/orval.config.ts), and `String(undefined)` is the
  // *string* "undefined" - ten characters, which trivially clears
  // `.min(2)`. Without this guard, a request with no `q` at all would parse
  // as a valid search for the literal text "undefined" instead of failing.
  if (typeof req.query.q !== "string") {
    res.status(400).json({ error: "q is required" });
    return;
  }

  const query = SearchExploreQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const params = parseExploreSearch(query.data);
  if (!params) {
    res.status(400).json({ error: "q must be at least 2 characters" });
    return;
  }

  const rows = await searchPostings(params, userId);
  res.json(SearchExploreResponse.parse(rows.map(toExplorePostingCard)));
});

router.post("/explore/:postingId/add", async (req, res): Promise<void> => {
  const userId = actingUserId(req);
  const params = AddExplorePostingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const posting = await getPostingById(params.data.postingId);
  if (!posting) {
    res.status(404).json({ error: "Posting not found" });
    return;
  }

  const added = await scoreAndAttachPosting(userId, posting);
  if (!added) {
    res.status(409).json({ error: "Already in your queue" });
    return;
  }
  res.status(201).json(AddExplorePostingResponse.parse({ added: true }));
});

export default router;
