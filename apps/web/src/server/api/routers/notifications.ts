/**
 * notifications bounded-context tRPC sub-router.
 *
 * Mounted on the root `appRouter` (../root.ts) under `notifications`, per
 * ADR-0003. Procedures are thin adapters over `modules/notifications/index.ts`
 * use cases (ADR-0001) — no domain logic lives here; this file's own job is:
 * validate input, resolve the caller's `PolicySubject`/`personId` from the
 * *verified* session (never from client input — same anti-corruption
 * discipline as every other module's own router), and translate domain
 * errors to `TRPCError` codes. Same shape as `moderationRouter`/
 * `gamificationRouter`.
 *
 * Shaped per the API Contract Sketch in docs/ddd/notifications.md, with two
 * deliberate additions beyond that sketch's own TypeScript block:
 *
 * - `listAll`/`listPreferences` — named in the sketch but with no matching
 *   application-layer use case built in the prior (domain/application)
 *   stage; both are thin, read-only queries (`listNotifications`,
 *   `listPreferences` under `modules/notifications/application/`) added in
 *   this API stage to actually satisfy the sketch's `listAll`/
 *   `listPreferences` procedures — see each function's own doc comment for
 *   why this is a query, not new domain logic (`listPreferences` in
 *   particular reuses the exact same `getNotificationTypeDefault` table
 *   `getEffectivePreference` already reads for both consent gates, never a
 *   second definition of "the default").
 *
 * This context has no public `/api/v1` surface of its own beyond the Resend
 * webhook receiver (`app/api/webhooks/resend/route.ts`, out of scope for
 * this router — see docs/ddd/notifications.md's own API Contract Sketch,
 * second code block) — every procedure below is a person managing their own
 * notifications, so there is no `moderatorProcedure`/`adminProcedure`
 * equivalent here: everything is `protectedProcedure`, scoped to
 * `ctx.person.personId` as both the recipient and the caller, exactly as
 * the sketch's own `ctx.subject.personId` shape implies.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { isValidUlid } from "@volunteer-portal/ulid";
import type { PolicySubject } from "@volunteer-portal/authz";
import { NOTIFICATION_TYPES, NOTIFICATION_CHANNELS } from "@volunteer-portal/shared";
import {
  listUnread,
  listNotifications,
  markAsRead,
  markAllAsRead,
  listPreferences,
  setNotificationPreference,
  ForbiddenActionError,
  NotificationNotFoundError,
} from "@/modules/notifications";
import { router, protectedProcedure } from "../trpc";
import type { PersonSummary } from "@/modules/identity";

const ulidSchema = z.string().refine(isValidUlid, { message: "Expected a ULID." });
const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

/** Builds the `PolicySubject` `setNotificationPreference`'s own `caller` argument needs, from the already-resolved session `Person` — same helper as every other router's own `callerSubject`. */
function callerSubject(person: PersonSummary): PolicySubject {
  return { id: person.personId, status: person.status as PolicySubject["status"] };
}

/**
 * Translates this module's domain errors (thrown by the use cases under
 * `modules/notifications/application/`) to the appropriate `TRPCError`
 * code. Centralized here, same shape as every other router's own
 * `map*Error`.
 */
function mapNotificationError(error: unknown): never {
  if (error instanceof NotificationNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (error instanceof ForbiddenActionError) {
    throw new TRPCError({ code: "FORBIDDEN", message: error.message });
  }
  throw error;
}

export const notificationsRouter = router({
  listUnread: protectedProcedure
    .input(
      z.object({
        cursor: ulidSchema.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listUnread(ctx.prisma, { personId: ctx.person.personId, ...input });
      } catch (error) {
        mapNotificationError(error);
      }
    }),

  listAll: protectedProcedure
    .input(
      z.object({
        cursor: ulidSchema.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listNotifications(ctx.prisma, { personId: ctx.person.personId, ...input });
      } catch (error) {
        mapNotificationError(error);
      }
    }),

  markAsRead: protectedProcedure
    .input(z.object({ notificationId: ulidSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await markAsRead(ctx.prisma, { personId: ctx.person.personId, notificationId: input.notificationId });
      } catch (error) {
        mapNotificationError(error);
      }
    }),

  markAllAsRead: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      return await markAllAsRead(ctx.prisma, { personId: ctx.person.personId });
    } catch (error) {
      mapNotificationError(error);
    }
  }),

  listPreferences: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await listPreferences(ctx.prisma, { personId: ctx.person.personId });
    } catch (error) {
      mapNotificationError(error);
    }
  }),

  setPreference: protectedProcedure
    .input(
      z.object({
        type: notificationTypeSchema,
        channel: notificationChannelSchema,
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await setNotificationPreference(ctx.prisma, {
          caller: callerSubject(ctx.person),
          personId: ctx.person.personId,
          ...input,
        });
      } catch (error) {
        mapNotificationError(error);
      }
    }),
});
