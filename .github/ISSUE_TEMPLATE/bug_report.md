---
name: Bug report
about: Something isn't working
title: ""
labels: bug
assignees: ""
---

**What happened**

A clear description of the bug.

**What you expected**

What you expected to happen instead.

**Steps to reproduce**

1.
2.
3.

**Logs**

Relevant lines from `deploy/logs/jobblast.log` (local prod) or your terminal
(dev), with any secrets/API keys removed.

**Environment**

- OS:
- Node version (`node -v`):
- pnpm version (`pnpm -v`):
- Running via: dev (`pnpm dev:api` / `pnpm dev:web`) / local production (`deploy/start-jobblast.*`)
- Relevant config: which job sources are enabled, whether the `claude` CLI is installed/logged in (if the bug involves AI tailoring, AI Scout, or Notion Inbox)
