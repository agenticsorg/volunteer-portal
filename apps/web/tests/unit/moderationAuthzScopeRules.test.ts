import { describe, expect, it } from "vitest";
import { can, type RoleAssignmentFact } from "@volunteer-portal/authz";

// Exercises `packages/authz`'s `can()` (ADR-0007) directly, for the four
// moderation actions (docs/ddd/moderation-trust-safety.md: `report.claim`,
// `report.resolve`, `report.release_claim`, `moderation_action.take`,
// `moderation_action.revoke`) against plain `RoleAssignmentFact[]`
// fixtures — no database, same "policy rules are unit-tested directly"
// shape `authz.test.ts` establishes for the rest of the rule table. This
// is the scope-rule enforcement this phase's own completion bar names:
// "a chapter-scoped moderator is blocked from issuing an org-scoped
// action."
describe("moderation scope-rule enforcement (can())", () => {
  const chapterA = "chapter_a";
  const chapterB = "chapter_b";

  const chapterModeratorA: RoleAssignmentFact[] = [
    { role: "moderator", scopeType: "chapter", scopeId: chapterA, revokedAt: null },
  ];
  const globalModerator: RoleAssignmentFact[] = [
    { role: "moderator", scopeType: "global", scopeId: null, revokedAt: null },
  ];
  const orgAdmin: RoleAssignmentFact[] = [{ role: "org_admin", scopeType: "global", scopeId: null, revokedAt: null }];
  const plainVolunteer: RoleAssignmentFact[] = [
    { role: "volunteer", scopeType: "global", scopeId: null, revokedAt: null },
  ];

  describe("moderation_action.take — a chapter-scoped moderator may only act within their own chapter", () => {
    it("allows a chapter moderator to take a chapter-scoped action within their own chapter", () => {
      expect(
        can(
          { id: "mod_1", status: "active" },
          "moderation_action.take",
          { type: "moderation_action", scopeType: "chapter", scopeId: chapterA },
          chapterModeratorA,
        ),
      ).toBe(true);
    });

    it("denies a chapter moderator taking a chapter-scoped action in a DIFFERENT chapter", () => {
      expect(
        can(
          { id: "mod_1", status: "active" },
          "moderation_action.take",
          { type: "moderation_action", scopeType: "chapter", scopeId: chapterB },
          chapterModeratorA,
        ),
      ).toBe(false);
    });

    it("denies a chapter-scoped moderator issuing an org-scoped action — this phase's own negative test", () => {
      expect(
        can(
          { id: "mod_1", status: "active" },
          "moderation_action.take",
          { type: "moderation_action", scopeType: "global", scopeId: null },
          chapterModeratorA,
        ),
      ).toBe(false);
    });

    it("allows a global-scoped moderator to issue an org-scoped action", () => {
      expect(
        can(
          { id: "mod_1", status: "active" },
          "moderation_action.take",
          { type: "moderation_action", scopeType: "global", scopeId: null },
          globalModerator,
        ),
      ).toBe(true);
    });

    it("allows org_admin to issue any action at any scope", () => {
      expect(
        can(
          { id: "admin_1", status: "active" },
          "moderation_action.take",
          { type: "moderation_action", scopeType: "global", scopeId: null },
          orgAdmin,
        ),
      ).toBe(true);
      expect(
        can(
          { id: "admin_1", status: "active" },
          "moderation_action.take",
          { type: "moderation_action", scopeType: "chapter", scopeId: chapterA },
          orgAdmin,
        ),
      ).toBe(true);
    });

    it("denies a plain volunteer with no moderator/org_admin role", () => {
      expect(
        can(
          { id: "vol_1", status: "active" },
          "moderation_action.take",
          { type: "moderation_action", scopeType: "chapter", scopeId: chapterA },
          plainVolunteer,
        ),
      ).toBe(false);
    });
  });

  describe("report.claim — same scope-authority shape", () => {
    it("allows a chapter moderator to claim a report scoped to their own chapter", () => {
      expect(
        can(
          { id: "mod_1", status: "active" },
          "report.claim",
          { type: "report", scopeType: "chapter", scopeId: chapterA },
          chapterModeratorA,
        ),
      ).toBe(true);
    });

    it("denies a chapter moderator claiming a report scoped to a different chapter", () => {
      expect(
        can(
          { id: "mod_1", status: "active" },
          "report.claim",
          { type: "report", scopeType: "chapter", scopeId: chapterB },
          chapterModeratorA,
        ),
      ).toBe(false);
    });
  });

  describe("report.resolve / report.release_claim / moderation_action.revoke — ownership shape", () => {
    it("allows the claim holder / issuing moderator to act on their own resource", () => {
      expect(
        can(
          { id: "mod_1", status: "active" },
          "report.resolve",
          { type: "report", scopeType: "global", scopeId: null, ownerId: "mod_1" },
          chapterModeratorA,
        ),
      ).toBe(true);
    });

    it("denies a different moderator acting on someone else's claim", () => {
      expect(
        can(
          { id: "mod_2", status: "active" },
          "report.resolve",
          { type: "report", scopeType: "global", scopeId: null, ownerId: "mod_1" },
          chapterModeratorA,
        ),
      ).toBe(false);
    });

    it("allows org_admin to act on any moderator's claim, even one they don't own", () => {
      expect(
        can(
          { id: "admin_1", status: "active" },
          "report.resolve",
          { type: "report", scopeType: "global", scopeId: null, ownerId: "mod_1" },
          orgAdmin,
        ),
      ).toBe(true);
    });

    it("moderation_action.revoke: only the issuing moderator or org_admin", () => {
      expect(
        can(
          { id: "mod_1", status: "active" },
          "moderation_action.revoke",
          { type: "moderation_action", scopeType: "global", scopeId: null, ownerId: "mod_1" },
          chapterModeratorA,
        ),
      ).toBe(true);
      expect(
        can(
          { id: "mod_2", status: "active" },
          "moderation_action.revoke",
          { type: "moderation_action", scopeType: "global", scopeId: null, ownerId: "mod_1" },
          chapterModeratorA,
        ),
      ).toBe(false);
    });
  });

  describe("fail-closed on non-active caller status", () => {
    it("denies moderation_action.take for a deactivated caller even with a covering role assignment", () => {
      expect(
        can(
          { id: "mod_1", status: "deactivated" },
          "moderation_action.take",
          { type: "moderation_action", scopeType: "chapter", scopeId: chapterA },
          chapterModeratorA,
        ),
      ).toBe(false);
    });
  });
});
