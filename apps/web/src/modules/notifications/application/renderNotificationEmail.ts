import type { NotificationType } from "@volunteer-portal/shared";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Every field this module's own handlers actually put on `notification.payload` — a loose, defensive read, never assumed present. */
type NotificationPayload = Record<string, unknown>;

function str(payload: NotificationPayload, key: string, fallback = ""): string {
  const value = payload[key];
  return typeof value === "string" ? value : fallback;
}

function num(payload: NotificationPayload, key: string, fallback = 0): number {
  const value = payload[key];
  return typeof value === "number" ? value : fallback;
}

/**
 * Renders the subject/body for `notification.type`, using only
 * `notification.payload` — the immutable, already-resolved snapshot every
 * handler builds (Notification invariant 3), never a live cross-context
 * lookup at send time (docs/ddd/notifications.md's Integration &
 * Anti-Corruption Notes: "the notification payload must contain
 * everything needed to render"). Real, deterministic template logic (not
 * React Email components — this codebase has no `resend`/`react-email`
 * dependency installed, and this stage doesn't add one; plain
 * subject/text/html strings are the real, working equivalent), not a
 * stub — independently unit-testable given a fixed `type`/`payload`.
 *
 * A type this function has no specific case for (e.g. a future consumed
 * event type wired up before its own template is written) still renders a
 * safe, generic fallback rather than throwing — `ProcessDeliveryJob` must
 * never crash on an unrecognized-but-legitimate `notification.type`.
 */
export function renderNotificationEmail(type: NotificationType, payload: unknown): RenderedEmail {
  const p: NotificationPayload = payload && typeof payload === "object" ? (payload as NotificationPayload) : {};

  switch (type) {
    case "hours_approved": {
      const hours = num(p, "hours");
      const opportunityTitle = str(p, "opportunityTitle", "your volunteer shift");
      const subject = `Your ${hours} hour${hours === 1 ? "" : "s"} for "${opportunityTitle}" was approved`;
      const text = `Great news — your logged hours for "${opportunityTitle}" (${hours} hour${hours === 1 ? "" : "s"}) have been approved.`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    case "badge_awarded": {
      const badgeName = str(p, "badgeName", "a new badge");
      const subject = `You earned the "${badgeName}" badge`;
      const text = `Congratulations — you just earned the "${badgeName}" badge.`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    case "streak_broken": {
      const activityType = str(p, "activityType", "your");
      const previousLength = num(p, "previousLength");
      const subject = `Your ${activityType} streak ended`;
      const text = `Your ${activityType} streak of ${previousLength} ended. Log a new activity to start a fresh one.`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    case "training_reminder": {
      const courseTitle = str(p, "courseTitle", "your course");
      const subject = `Reminder: complete "${courseTitle}"`;
      const text = `This is a reminder to complete "${courseTitle}" before its deadline.`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    case "course_completed": {
      const courseTitle = str(p, "courseTitle", "your course");
      const subject = `You completed "${courseTitle}"`;
      const text = `Nice work — you completed "${courseTitle}".`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    case "certificate_issued": {
      const courseTitle = str(p, "courseTitle", "your course");
      const certificateNumber = str(p, "certificateNumber");
      const subject = `Your certificate for "${courseTitle}" is ready`;
      const text = `Your certificate${certificateNumber ? ` (${certificateNumber})` : ""} for "${courseTitle}" has been issued.`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    case "moderation_action": {
      const actionType = str(p, "actionType", "action");
      const reason = str(p, "reason");
      const subject = `A moderation action was taken on your account`;
      const text = `A "${actionType}" action was taken on your account.${reason ? ` Reason: ${reason}` : ""}`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    case "mention": {
      const mentionedByDisplayName = str(p, "mentionedByDisplayName", "Someone");
      const subject = `${mentionedByDisplayName} mentioned you`;
      const text = `${mentionedByDisplayName} mentioned you.`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    case "kudos_given": {
      const fromDisplayName = str(p, "fromDisplayName", "Someone");
      const subject = `${fromDisplayName} gave you kudos`;
      const note = str(p, "note");
      const text = `${fromDisplayName} gave you kudos.${note ? ` "${note}"` : ""}`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    case "mentorship_started": {
      const counterpartDisplayName = str(p, "counterpartDisplayName", "your mentorship counterpart");
      const subject = `Your mentorship with ${counterpartDisplayName} has started`;
      const text = `Your mentorship with ${counterpartDisplayName} has started.`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    case "export_ready": {
      const subject = `Your data export is ready`;
      const text = `Your requested data export is ready to download.`;
      return { subject, text, html: `<p>${text}</p>` };
    }
    default: {
      const subject = `You have a new notification`;
      const text = `You have a new "${type}" notification.`;
      return { subject, text, html: `<p>${text}</p>` };
    }
  }
}
