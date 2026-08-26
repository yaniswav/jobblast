import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { IS_SAAS } from "./lib/mode";

const app: Express = express();

/**
 * Express only reads `X-Forwarded-For` when this is set - otherwise `req.ip`
 * is the socket address, which is correct for a direct connection and wrong
 * (and spoofable by any client) behind a reverse proxy.
 *
 * `saas` runs behind Caddy (docs/SAAS-ARCHITECTURE.md section 7), which sets
 * that header, so it defaults on there - `1` trusts exactly one hop, Caddy
 * itself. `selfhosted` has no reverse proxy in front of it by default, so it
 * defaults off; a self-hoster who puts one there can opt in with TRUST_PROXY
 * (a hop count, or any value express's `trust proxy` setting accepts).
 * Wrong in either direction is a real problem: off behind a real proxy means
 * every rate limit and the session's ip_hash key on the proxy's own address;
 * on with no proxy means a client can forge its own IP with a header.
 */
function resolveTrustProxy(): boolean | number | string {
  const override = process.env["TRUST_PROXY"]?.trim();
  if (override) {
    if (override.toLowerCase() === "true") return true;
    if (override.toLowerCase() === "false") return false;
    const asNumber = Number(override);
    return Number.isFinite(asNumber) ? asNumber : override;
  }
  return IS_SAAS ? 1 : false;
}

app.set("trust proxy", resolveTrustProxy());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// In production we run a single process: this Express app also serves the
// already-built frontend (artifacts/jobblast -> dist/public), so nothing
// else needs to run permanently besides this server + Postgres.
if (process.env["SERVE_STATIC"] === "1") {
  // Resolved relative to the bundled output (dist/index.mjs), not this
  // source file, since esbuild bundles everything into artifacts/api-server/dist/index.mjs.
  // artifacts/api-server/dist -> ../.. -> artifacts -> jobblast/dist/public
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = path.resolve(currentDir, "../../jobblast/dist/public");

  logger.info({ staticDir }, "SERVE_STATIC enabled, serving built frontend");

  app.use(express.static(staticDir));

  // SPA fallback: any non-API GET that didn't match a static file falls
  // back to index.html so client-side routing (e.g. /review) works.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

export default app;
