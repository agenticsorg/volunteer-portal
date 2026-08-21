/**
 * Domain errors for the `notifications` bounded context (docs/ddd/
 * notifications.md). Thrown by the use cases under `application/`; caught
 * at the (future) tRPC procedure boundary
 * (`server/api/routers/notifications.ts`) and translated to the
 * appropriate `TRPCError` code there — this module itself has no knowledge
 * of tRPC, same split as every other module's `domain/errors.ts`.
 */

/** A `can()` (ADR-0007) check denied the caller's requested action. */
export class ForbiddenActionError extends Error {
  constructor(action: string) {
    super(`Not authorized to perform "${action}".`);
    this.name = "ForbiddenActionError";
  }
}

/** An event handler's precondition: the recipient Person must exist (per `identity.getPersonSummary`/`getPersonContactInfo`). */
export class PersonNotFoundError extends Error {
  constructor(personId: string) {
    super(`No person found for id "${personId}".`);
    this.name = "PersonNotFoundError";
  }
}

/**
 * A consumed external event referenced a source-context row (an
 * Opportunity, a Course, a BadgeAward) that this handler could not resolve
 * via the owning context's own Open Host Service read — a cross-context
 * data-consistency problem, not a normal domain rejection. Thrown rather
 * than silently skipping the notification so the failure is visible and
 * the event is retried (ADR-0009's at-least-once delivery guarantee)
 * rather than a person silently never being told. Named/shaped to match
 * `community`'s own `SourceRecordNotFoundError` precedent exactly.
 */
export class SourceRecordNotFoundError extends Error {
  constructor(sourceType: string, sourceId: string) {
    super(`Could not resolve "${sourceType}" record "${sourceId}" via its owning context's Open Host Service read.`);
    this.name = "SourceRecordNotFoundError";
  }
}

/** `MarkAsRead` precondition: no `notification` row exists for this id owned by the caller. */
export class NotificationNotFoundError extends Error {
  constructor(notificationId: string) {
    super(`No notification found for id "${notificationId}" owned by the caller.`);
    this.name = "NotificationNotFoundError";
  }
}

/** `ProcessDeliveryJob` precondition: no `delivery_attempt` row exists for this id. */
export class DeliveryAttemptNotFoundError extends Error {
  constructor(deliveryAttemptId: string) {
    super(`No delivery attempt found for id "${deliveryAttemptId}".`);
    this.name = "DeliveryAttemptNotFoundError";
  }
}

/**
 * `ProcessDeliveryJob` only ever drives `email` delivery attempts —
 * `in_app` "delivery" is a same-transaction side effect of `QueueNotification`
 * itself (docs/ddd/notifications.md, `DeliveryAttempt` invariant), so
 * calling this job against an `in_app` attempt is a caller bug, not a
 * runtime data problem.
 */
export class DeliveryAttemptNotEmailChannelError extends Error {
  constructor(deliveryAttemptId: string, channel: string) {
    super(`Delivery attempt "${deliveryAttemptId}" is channel "${channel}", not "email" — ProcessDeliveryJob only drives email delivery.`);
    this.name = "DeliveryAttemptNotEmailChannelError";
  }
}

/**
 * A Resend-backed adapter call (ADR-0012) requires an environment variable
 * that is not set in this environment. Thrown instead of faking a
 * successful send — see `infra/resendClient.ts`'s own header comment, same
 * precedent as `training`'s `cloudflareStreamClient.ts` and `moderation`'s/
 * `community`'s `cloudflareR2Client.ts`.
 */
export class ExternalServiceNotConfiguredError extends Error {
  constructor(missingEnvVar: string, purpose: string) {
    super(`${purpose} requires the "${missingEnvVar}" environment variable, which is not set.`);
    this.name = "ExternalServiceNotConfiguredError";
  }
}
