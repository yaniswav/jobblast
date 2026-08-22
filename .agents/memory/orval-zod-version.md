---
name: Orval and Zod compatibility
description: Orval 8 can emit Zod 4-style validators in a workspace that still resolves Zod 3.
---

Pin the generated Zod target explicitly when the workspace catalog uses Zod 3; otherwise new schemas may generate helpers such as `z.int()` and `z.email()` that fail the shared library typecheck.

**Why:** The generator's automatic detection can fall back to modern output when package metadata is incomplete, even though the runtime dependency is still Zod 3.

**How to apply:** Keep the target version explicit in the Orval configuration and rerun codegen after OpenAPI changes.