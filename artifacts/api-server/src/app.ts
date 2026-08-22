import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
