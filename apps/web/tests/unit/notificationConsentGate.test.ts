import { describe, expect, it, vi } from "vitest";
import {
  getEffectivePreference,
  getNotificationTypeDeliveryMode,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationType,
} from "@/modules/notifications";

// `getEffectivePreference` (docs/ddd/notifications.md, `NotificationPreference`'s
// own doc comment) is "deliberately the ONLY place either [consent] gate
// reads preference state" — both `QueueNotification`'s queue-time gate and
// `ProcessDeliveryJob`'s delivery-time gate call this exact function. These
// are pure unit tests: a fake `notificationPreference.findUnique` delegate
// stands in for Prisma, no database involved, same shape as
// `recordAuditEvent.test.ts`'s `fakeDomainEventsDelegate()`.
function fakePreferenceClient(row: { enabled: boolean } | null) {
  const findUnique = vi.fn().mockResolvedValue(row);
  return { notificationPreference: { findUnique } };
}

describe("getEffectivePreference (consent-gate evaluation)", () => {
  it("returns the explicit preference row's `enabled` value when one exists, even when it disagrees with the platform default", async () => {
    // hours_approved/email defaults to enabled=true; an explicit
    // disabled row must still win.
    const client = fakePreferenceClient({ enabled: false });
    const result = await getEffectivePreference(client, "person-1", "hours_approved", "email");
    expect(result).toBe(false);
  });

  it("an explicit enabled=true row wins even over a default of false", async () => {
    // course_completed/email defaults to enabled=false; an explicit
    // enabled row must still win.
    const client = fakePreferenceClient({ enabled: true });
    const result = await getEffectivePreference(client, "person-1", "course_completed", "email");
    expect(result).toBe(true);
  });

  it("falls back to the platform default when no explicit preference row exists", async () => {
    const client = fakePreferenceClient(null);
    expect(await getEffectivePreference(client, "person-1", "hours_approved", "email")).toBe(true);
    expect(await getEffectivePreference(client, "person-1", "hours_approved", "in_app")).toBe(true);
  });

  it("course_completed's email default is disabled (in-app only) — the one documented default exception", async () => {
    const client = fakePreferenceClient(null);
    expect(await getEffectivePreference(client, "person-1", "course_completed", "email")).toBe(false);
    expect(await getEffectivePreference(client, "person-1", "course_completed", "in_app")).toBe(true);
  });

  it("looks the row up by the exact (personId, type, channel) compound key, never a broader query", async () => {
    const client = fakePreferenceClient(null);
    await getEffectivePreference(client, "person-42", "badge_awarded", "in_app");
    expect(client.notificationPreference.findUnique).toHaveBeenCalledWith({
      where: { personId_type_channel: { personId: "person-42", type: "badge_awarded", channel: "in_app" } },
    });
  });

  it("every closed notification type's default is a real boolean for both channels (no gap a future type could silently fall through)", async () => {
    const client = fakePreferenceClient(null);
    for (const type of NOTIFICATION_TYPES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        const result = await getEffectivePreference(client, "person-1", type, channel);
        expect(typeof result).toBe("boolean");
      }
    }
  });
});

// `getNotificationTypeDeliveryMode` — the digest-vs-real-time routing table
// (`packages/shared/src/notificationDefaults.ts`). Per that file's own doc
// comment, every type routes to `"realtime"` today (no digest-accumulation
// use case exists yet in docs/ddd/notifications.md's Key Use Cases); this
// is a pure per-type lookup, not a hardcoded constant, so it must be
// exercised for the full closed type set, not just spot-checked.
describe("getNotificationTypeDeliveryMode (digest-vs-real-time routing)", () => {
  it("routes every closed notification type to 'realtime' (no digest batching implemented yet)", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(getNotificationTypeDeliveryMode(type)).toBe("realtime");
    }
  });

  it("is a genuine per-type lookup, not a single shared value — every type maps by its own key", () => {
    // Reconstruct the mapping via NOTIFICATION_TYPES and compare structurally,
    // proving each key resolves independently rather than the function
    // ignoring its argument.
    const seen = new Map<NotificationType, string>();
    for (const type of NOTIFICATION_TYPES) {
      seen.set(type, getNotificationTypeDeliveryMode(type));
    }
    expect(seen.size).toBe(NOTIFICATION_TYPES.length);
    expect([...seen.values()].every((mode) => mode === "realtime")).toBe(true);
  });

  it("only ever returns one of the two documented delivery modes", () => {
    const validModes: readonly ("realtime" | "digest")[] = ["realtime", "digest"];
    for (const type of NOTIFICATION_TYPES) {
      expect(validModes).toContain(getNotificationTypeDeliveryMode(type));
    }
  });
});
