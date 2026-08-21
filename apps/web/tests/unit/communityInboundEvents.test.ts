import { describe, expect, it } from "vitest";
import {
  INBOUND_EVENT_TYPES,
  isInboundEventType,
  sourceContextForEventType,
  type InboundEventType,
} from "@/modules/community";

// Pure-function coverage for the anti-corruption vocabulary
// (`domain/inboundEvents.ts`) that `consumeInboundEvent`'s dispatcher relies
// on to recognize/route the exact four consumed external event types this
// stage's Build item 2 names — no database, per ADR-0015's unit/integration
// split.
describe("isInboundEventType", () => {
  it("recognizes exactly the four documented consumed event types", () => {
    expect(INBOUND_EVENT_TYPES).toEqual(["BadgeAwarded", "HoursApproved", "CourseCompleted", "StreakExtended"]);
    for (const eventType of INBOUND_EVENT_TYPES) {
      expect(isInboundEventType(eventType)).toBe(true);
    }
  });

  it("rejects an event type this consumer does not subscribe to, including a same-named-but-wrong-context event", () => {
    expect(isInboundEventType("SomethingThisConsumerDoesNotSubscribeTo")).toBe(false);
    expect(isInboundEventType("PostCreated")).toBe(false); // this module's OWN outbound event, never an inbound one
    expect(isInboundEventType("ModerationActionTaken")).toBe(false); // documented but deliberately out of this stage's Build list
    expect(isInboundEventType("PersonAnonymized")).toBe(false); // ditto
    expect(isInboundEventType("")).toBe(false);
  });
});

describe("sourceContextForEventType", () => {
  it("maps each event type to the exact owning context named in the Consumed External Events table", () => {
    const expected: Record<InboundEventType, "gamification" | "volunteering" | "training"> = {
      BadgeAwarded: "gamification",
      StreakExtended: "gamification",
      HoursApproved: "volunteering",
      CourseCompleted: "training",
    };
    for (const [eventType, sourceContext] of Object.entries(expected) as [InboundEventType, string][]) {
      expect(sourceContextForEventType(eventType)).toBe(sourceContext);
    }
  });
});
