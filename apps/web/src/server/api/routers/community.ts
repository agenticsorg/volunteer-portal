/**
 * community bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `community`, per
 * ADR-0003. Empty in Phase 0 — no procedures exist because no domain logic
 * (application-layer use cases) exists yet for the `community` module. Real
 * procedures land as thin adapters that call into
 * `modules/community/index.ts` use cases (ADR-0001, ADR-0003), never into the
 * module's internals directly.
 */
import { router } from "../trpc";

export const communityRouter = router({});
