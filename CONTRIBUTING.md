# Contributing to JobBlast

JobBlast is a small, self-hosted, single-user tool. Contributions are welcome,
but keep the project's shape in mind: no telemetry, no hosted backend, no
account system, everything config-driven so a fork can be re-pointed at a
different profile without touching source.

## Getting set up

Follow `docs/TUTORIEL.md` (or the Quick start in `README.md`) to get a local
dev environment running, then read `docs/CONFIG.md` before touching anything
job-source- or scoring-related.

## Before opening a PR

- `pnpm run typecheck` must pass.
- `pnpm run build` must pass.
- `pnpm test` must pass. If you change logic in `artifacts/api-server/src/lib`
  (scoring, config, sanitization, Gmail-sync matching, ...), add or update a
  colocated `*.test.ts` covering it - pure-logic unit tests only (no DB,
  network, or CLI mocking), see the existing tests for the pattern.
- If you touch the API contract (routes, request/response shapes), regenerate
  the client from `lib/api-spec/openapi.yaml` rather than hand-editing the
  generated files under `lib/api-client-react/src/generated` and
  `lib/api-zod/src/generated`.
- Keep personal data out of the source tree. If a value is specific to one
  user (name, credentials, scoring keywords, target companies, Notion IDs...),
  it belongs in `.env` or `jobblast.config.json`, not hardcoded - see
  `docs/CONFIG.md`.

## Adding a job source

New sources live in `artifacts/api-server/src/lib/sources/`. Look at an
existing simple one (e.g. `arbeitnow.ts` or `remoteok.ts`) for the shape:
a `fetch*Jobs(): Promise<RawJob[]>` function that never throws (log and
return `[]` on failure), registered in `refresh.ts`, with its `enabled` flag
and parameters added to the config schema (`lib/config.ts`),
`jobblast.config.example.json`, and documented in `docs/CONFIG.md`.

## Reporting bugs / requesting features

Open an issue using the bug report template, or just describe what you
expected vs. what happened. Since this runs entirely on your own machine and
data, include your OS and Node version - most issues turn out to be
environment-specific (PATH, Docker, the `claude` CLI not being on PATH, etc).

## License

By contributing, you agree your contributions are licensed under the
project's MIT license (see `LICENSE`).
