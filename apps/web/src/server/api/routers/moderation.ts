/**
 * moderation bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `moderation`, per
 * ADR-0003. Empty in Phase 0 — no procedures exist because no domain logic
 * (application-layer use cases) exists yet for the `moderation` module. Real
 * procedures land as thin adapters that call into
 * `modules/moderation/index.ts` use cases (ADR-0001, ADR-0003), never into the
 * module's internals directly.
 */
import { router } from "../trpc";

export const moderationRouter = router({});
