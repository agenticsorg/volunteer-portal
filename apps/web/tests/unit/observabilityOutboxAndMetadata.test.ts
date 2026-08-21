import { describe, expect, it } from "vitest";
import {
  attachRequestMetadata,
  evaluateOutboxLag,
  OUTBOX_LAG_ALERT_THRESHOLD_SECONDS,
} from "@volunteer-portal/observability";

describe("attachRequestMetadata", () => {
  it("merges _meta.requestId into a plain-object payload", () => {
    const payload = { hourEntryId: "he_1", personId: "p_1" };
    const result = attachRequestMetadata(payload, "req_abc");
    expect(result).toEqual({ hourEntryId: "he_1", personId: "p_1", _meta: { requestId: "req_abc" } });
  });

  it("never mutates the input payload", () => {
    const payload = { hourEntryId: "he_1" };
    attachRequestMetadata(payload, "req_abc");
    expect(payload).toEqual({ hourEntryId: "he_1" });
    expect((payload as Record<string, unknown>)._meta).toBeUndefined();
  });

  it("returns the payload unchanged when there is no current requestId", () => {
    const payload = { hourEntryId: "he_1" };
    const result = attachRequestMetadata(payload, undefined);
    expect(result).toBe(payload);
  });

  it("is a no-op for a non-plain-object payload (e.g. an array), never throwing", () => {
    const payload = ["a", "b"];
    const result = attachRequestMetadata(payload as unknown as Record<string, unknown>, "req_abc");
    expect(result).toBe(payload);
  });
});

describe("evaluateOutboxLag", () => {
  it("treats no unprocessed rows (maxLagSeconds: null) as zero lag, no alert", () => {
    const result = evaluateOutboxLag("community", { maxLagSeconds: null, unprocessedCount: 0 });
    expect(result).toEqual({ schema: "community", maxLagSeconds: 0, unprocessedCount: 0, needsAlert: false });
  });

  it("does not flag a needs-alert at or below the 10-minute threshold", () => {
    const atThreshold = evaluateOutboxLag("community", {
      maxLagSeconds: OUTBOX_LAG_ALERT_THRESHOLD_SECONDS,
      unprocessedCount: 3,
    });
    expect(atThreshold.needsAlert).toBe(false);

    const wellUnder = evaluateOutboxLag("community", { maxLagSeconds: 45, unprocessedCount: 3 });
    expect(wellUnder.needsAlert).toBe(false);
  });

  it("flags needs-alert once lag exceeds the 10-minute threshold", () => {
    const result = evaluateOutboxLag("volunteering", {
      maxLagSeconds: OUTBOX_LAG_ALERT_THRESHOLD_SECONDS + 1,
      unprocessedCount: 5,
    });
    expect(result).toEqual({
      schema: "volunteering",
      maxLagSeconds: 601,
      unprocessedCount: 5,
      needsAlert: true,
    });
  });
});
