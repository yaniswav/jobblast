# syntax=docker/dockerfile:1
#
# JobBlast SaaS image - docs/SAAS-ARCHITECTURE.md section 7.
#
# Three stages:
#
#   build   Full pnpm workspace install, then `pnpm run build`: typecheck,
#           the esbuild api-server bundle (artifacts/api-server/dist), and
#           the Vite frontend build (artifacts/jobblast/dist/public).
#
#   prune   Same filesystem as `build`, with every node_modules directory
#           removed but every package.json (and both build outputs) kept.
#           This lets the runtime stage run its own, narrower `pnpm install`
#           against a workspace that still matches pnpm-lock.yaml exactly,
#           instead of carrying the frontend's build tooling (Vite,
#           Tailwind, the component library, vitest...) into the final
#           image.
#
#   runtime A fresh, minimal node:24-slim image. Installs only the
#           dependency closure the running server and the two admin
#           commands actually need: @workspace/api-server (which pulls in
#           pdfkit and @node-rs/argon2, the two packages esbuild leaves
#           external - see build.mjs), @workspace/db (drizzle-kit push) and
#           @workspace/scripts (pnpm run invite). Runs as a non-root user.
#
# The build output keeps the repo's artifacts/api-server + artifacts/jobblast
# sibling layout, so app.ts's existing relative static-file lookup
# (../../jobblast/dist/public, resolved from dist/index.mjs) keeps working
# unchanged - the "flatter container layout" concern section 7 flags is
# handled by this file's layout choice, not by a source change.

# COREPACK_HOME pins where corepack keeps its "which version did I activate"
# state to a fixed path instead of the default under $HOME. Without it,
# `corepack prepare --activate` (run below, as root, HOME=/root) is
# invisible to the runtime image's non-root `jobblast` user (HOME=/home/
# jobblast): corepack finds no activation for that HOME, silently fetches
# whatever it considers current instead of the pinned 10.28.1, and that
# unpinned pnpm's own "deps status check" then aborts every `pnpm run ...`
# with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY (no TTY to confirm a
# node_modules purge it thinks it needs). COREPACK_DEFAULT_TO_LATEST=0 is
# belt-and-suspenders against the same failure mode. Set identically in both
# node:24-slim stages below (ENV can't precede a Dockerfile's first FROM).

FROM node:24-slim AS build
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_DEFAULT_TO_LATEST=0
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM build AS prune
WORKDIR /repo
RUN find . -type d -name node_modules -prune -exec rm -rf {} +

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    JOBBLAST_MODE=saas \
    SERVE_STATIC=1 \
    PORT=5000 \
    COREPACK_HOME=/opt/corepack \
    COREPACK_DEFAULT_TO_LATEST=0
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
RUN useradd --system --uid 10001 --create-home --home-dir /home/jobblast jobblast
WORKDIR /app
COPY --from=prune /repo ./
RUN pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store \
      --filter @workspace/api-server... \
      --filter @workspace/scripts... \
      --filter @workspace/db... \
 && rm -rf /tmp/pnpm-store \
 && mkdir -p /app/data \
 # storage.ts resolves data/users/<uuid> from REPO_ROOT (three levels up
 # from dist/index.mjs, i.e. /app here) - create it now, owned by the
 # runtime user, so the first `docker compose up` copies that ownership
 # onto the named volume mounted at /app/data. Also chown COREPACK_HOME, so
 # `docker exec <container> pnpm run invite` (running as jobblast) can use
 # the pinned pnpm activated above.
 && chown -R jobblast:jobblast /app "$COREPACK_HOME"

USER jobblast
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:5000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# WORKDIR stays /app (the workspace root) so `docker exec <container> pnpm
# run invite` / `pnpm run db:push` resolve the root package.json's scripts
# without an extra -C/--dir flag.
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
