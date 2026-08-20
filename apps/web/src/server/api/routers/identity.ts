/**
 * identity bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `identity`, per
 * ADR-0003. Empty in Phase 0 — no procedures exist because no domain logic
 * (application-layer use cases) exists yet for the `identity` module. Real
 * procedures land as thin adapters that call into
 * `modules/identity/index.ts` use cases (ADR-0001, ADR-0003), never into the
 * module's internals directly.
 */
import { router } from "../trpc";

export const identityRouter = router({});
