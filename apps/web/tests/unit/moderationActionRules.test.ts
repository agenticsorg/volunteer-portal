import { describe, expect, it } from "vitest";
import {
  assertBanIsAlwaysOrgScoped,
  assertValidModerationActionDuration,
  assertValidModerationActionScope,
} from "@/modules/moderation";

// Pure-function coverage for ModerationAction's scope/duration invariants
// (docs/ddd/moderation-trust-safety.md, ModerationAction invariants 1-3) —
// no database, per ADR-0015's unit/integration split. `takeModerationAction.ts`
// (application layer) calls these before ever touching Prisma or `can()`;
// this file isolates the decision logic itself, same split
// `moduleCompletionRule.test.ts` establishes for `training`.
describe("assertValidModerationActionScope", () => {
  it("accepts org scope with a null scopeId", () => {
    expect(() => assertValidModerationActionScope("org", null)).not.toThrow();
  });

  it("accepts chapter scope with a non-null scopeId", () => {
    expect(() => assertValidModerationActionScope("chapter", "chapter_1")).not.toThrow();
  });

  it("rejects org scope carrying a scopeId", () => {
    expect(() => assertValidModerationActionScope("org", "chapter_1")).toThrow(/must not carry a scopeId/i);
  });

  it("rejects chapter scope with a null scopeId", () => {
    expect(() => assertValidModerationActionScope("chapter", null)).toThrow(/must carry a scopeId/i);
  });
});

describe("assertBanIsAlwaysOrgScoped", () => {
  it("allows an org-scoped ban", () => {
    expect(() => assertBanIsAlwaysOrgScoped("ban", "org")).not.toThrow();
  });

  it("rejects a chapter-scoped ban outright — a ban is always org-scoped regardless of report origin", () => {
    expect(() => assertBanIsAlwaysOrgScoped("ban", "chapter")).toThrow(/always org-scoped/i);
  });

  it("does not constrain non-ban action types either way", () => {
    expect(() => assertBanIsAlwaysOrgScoped("warn", "chapter")).not.toThrow();
    expect(() => assertBanIsAlwaysOrgScoped("mute", "org")).not.toThrow();
    expect(() => assertBanIsAlwaysOrgScoped("suspend", "chapter")).not.toThrow();
  });
});

describe("assertValidModerationActionDuration", () => {
  it("warn accepts endsAt omitted or explicitly null (both mean 'never time-boxed'), rejects a real timestamp", () => {
    expect(() => assertValidModerationActionDuration("warn", undefined)).not.toThrow();
    expect(() => assertValidModerationActionDuration("warn", null)).not.toThrow();
    expect(() => assertValidModerationActionDuration("warn", "2999-01-01T00:00:00.000Z")).toThrow(
      /never time-boxed/i,
    );
  });

  it("ban accepts endsAt omitted or explicitly null, rejects a real timestamp — permanent by definition", () => {
    expect(() => assertValidModerationActionDuration("ban", undefined)).not.toThrow();
    expect(() => assertValidModerationActionDuration("ban", null)).not.toThrow();
    expect(() => assertValidModerationActionDuration("ban", "2999-01-01T00:00:00.000Z")).toThrow(
      /never time-boxed/i,
    );
  });

  it("mute/suspend require endsAt to be explicitly present (undefined is rejected)", () => {
    expect(() => assertValidModerationActionDuration("mute", undefined)).toThrow(/cannot be omitted/i);
    expect(() => assertValidModerationActionDuration("suspend", undefined)).toThrow(/cannot be omitted/i);
  });

  it("mute/suspend accept an explicit null — an indefinite sanction", () => {
    expect(() => assertValidModerationActionDuration("mute", null)).not.toThrow();
    expect(() => assertValidModerationActionDuration("suspend", null)).not.toThrow();
  });

  it("mute/suspend accept a future timestamp", () => {
    expect(() => assertValidModerationActionDuration("suspend", "2999-01-01T00:00:00.000Z")).not.toThrow();
  });

  it("mute/suspend reject a past or present timestamp", () => {
    expect(() => assertValidModerationActionDuration("suspend", "2000-01-01T00:00:00.000Z")).toThrow(
      /future timestamp/i,
    );
  });

  it("mute/suspend reject an unparseable timestamp", () => {
    expect(() => assertValidModerationActionDuration("mute", "not-a-date")).toThrow(/future timestamp/i);
  });
});
