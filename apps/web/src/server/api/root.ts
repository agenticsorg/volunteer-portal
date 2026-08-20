/**
 * Root tRPC router — the single internal API surface for the Next.js
 * frontend (ADR-0003). Composed from exactly one sub-router per bounded
 * context (docs/ddd/00-context-map.md), matching the eight module folders
 * under `src/modules/`.
 *
 * All Phase 0 sub-routers are empty (`router({})`); this file only proves
 * the composition and mount point, not any domain behavior.
 */
import { router } from "./trpc";
import { identityRouter } from "./routers/identity";
import { volunteeringRouter } from "./routers/volunteering";
import { trainingRouter } from "./routers/training";
import { gamificationRouter } from "./routers/gamification";
import { communityRouter } from "./routers/community";
import { moderationRouter } from "./routers/moderation";
import { notificationsRouter } from "./routers/notifications";
import { adminRouter } from "./routers/admin";

export const appRouter = router({
  identity: identityRouter,
  volunteering: volunteeringRouter,
  training: trainingRouter,
  gamification: gamificationRouter,
  community: communityRouter,
  moderation: moderationRouter,
  notifications: notificationsRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
