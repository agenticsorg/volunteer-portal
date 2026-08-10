import { describe, expect, it } from "vitest";
import { ACTIONS, can, hasRoleInScope, rules, type RoleAssignmentFact } from "@volunteer-portal/authz";

// Exercises `packages/authz`'s `can()` (ADR-0007) directly against plain
// `RoleAssignmentFact[]` fixtures — no database, no HTTP, per ADR-0007's
// Testing note: "policy rules are unit-tested directly (given a subject
// with assignments X, resource Y, action Z, expect allow/deny) independent
// of any HTTP/tRPC layer."
describe("authz: can()", () => {
  it("CI exhaustiveness check — every Action has exactly one matching rule (ADR-0007 fail-closed guarantee)", () => {
    const ruleActions = rules.map((r) => r.action).sort();
    expect(ruleActions).toEqual([...ACTIONS].sort());
    expect(new Set(ruleActions).size).toBe(ruleActions.length);
  });

  it("throws (fails closed) for an action with no matching rule", () => {
    expect(() =>
      can(
        { id: "person_1" },
        // Intentionally not a valid Action, to prove the fail-closed path.
        "not.a.real.action" as never,
        { type: "widget", scopeType: "global", scopeId: null },
        [],
      ),
    ).toThrow(/no policy rule defined/i);
  });

  describe("role.grant / role.revoke", () => {
    const orgAdmin: RoleAssignmentFact[] = [
      { role: "org_admin", scopeType: "global", scopeId: null, revokedAt: null },
    ];
    const chapterLeadOfLondon: RoleAssignmentFact[] = [
      { role: "chapter_lead", scopeType: "chapter", scopeId: "chapter_london", revokedAt: null },
    ];
    const revokedOrgAdmin: RoleAssignmentFact[] = [
      { role: "org_admin", scopeType: "global", scopeId: null, revokedAt: new Date("2026-01-01") },
    ];

    it("an org_admin (global) may grant/revoke any role at any scope", () => {
      for (const action of ["role.grant", "role.revoke"] as const) {
        expect(
          can(
            { id: "admin_1" },
            action,
            { type: "role_assignment", scopeType: "global", scopeId: null, role: "org_admin" },
            orgAdmin,
          ),
        ).toBe(true);
      }
    });

    it("a chapter_lead may grant/revoke mentor/volunteer scoped to their own chapter", () => {
      for (const role of ["mentor", "volunteer"] as const) {
        expect(
          can(
            { id: "lead_1" },
            "role.grant",
            { type: "role_assignment", scopeType: "chapter", scopeId: "chapter_london", role },
            chapterLeadOfLondon,
          ),
        ).toBe(true);
      }
    });

    it("a chapter_lead cannot grant a role scoped to a different chapter", () => {
      expect(
        can(
          { id: "lead_1" },
          "role.grant",
          { type: "role_assignment", scopeType: "chapter", scopeId: "chapter_sv", role: "volunteer" },
          chapterLeadOfLondon,
        ),
      ).toBe(false);
    });

    it("a chapter_lead cannot grant org_admin/content_admin/moderator (invariant 4)", () => {
      for (const role of ["org_admin", "content_admin", "moderator"] as const) {
        expect(
          can(
            { id: "lead_1" },
            "role.grant",
            { type: "role_assignment", scopeType: "chapter", scopeId: "chapter_london", role },
            chapterLeadOfLondon,
          ),
        ).toBe(false);
      }
    });

    it("a revoked org_admin assignment no longer grants authority", () => {
      expect(
        can(
          { id: "admin_1" },
          "role.grant",
          { type: "role_assignment", scopeType: "global", scopeId: null, role: "volunteer" },
          revokedOrgAdmin,
        ),
      ).toBe(false);
    });

    it("a subject with no assignments at all is denied", () => {
      expect(
        can(
          { id: "nobody" },
          "role.grant",
          { type: "role_assignment", scopeType: "global", scopeId: null, role: "volunteer" },
          [],
        ),
      ).toBe(false);
    });
  });

  describe("chapter.create / chapter.assign_lead", () => {
    it("requires org_admin (global)", () => {
      const orgAdmin: RoleAssignmentFact[] = [
        { role: "org_admin", scopeType: "global", scopeId: null, revokedAt: null },
      ];
      const chapterLead: RoleAssignmentFact[] = [
        { role: "chapter_lead", scopeType: "chapter", scopeId: "chapter_london", revokedAt: null },
      ];

      for (const action of ["chapter.create", "chapter.assign_lead"] as const) {
        expect(
          can({ id: "admin_1" }, action, { type: "chapter", scopeType: "global", scopeId: null }, orgAdmin),
        ).toBe(true);
        expect(
          can(
            { id: "lead_1" },
            action,
            { type: "chapter", scopeType: "chapter", scopeId: "chapter_london" },
            chapterLead,
          ),
        ).toBe(false);
      }
    });
  });

  describe.each(["dsar.export.request", "dsar.erasure.request"] as const)("%s", (action) => {
    it("allows a subject to request their own data", () => {
      expect(
        can(
          { id: "person_1" },
          action,
          { type: "dsar_request", scopeType: "global", scopeId: null, ownerId: "person_1" },
          [],
        ),
      ).toBe(true);
    });

    it("denies one person requesting another's data without org_admin", () => {
      expect(
        can(
          { id: "person_1" },
          action,
          { type: "dsar_request", scopeType: "global", scopeId: null, ownerId: "person_2" },
          [],
        ),
      ).toBe(false);
    });

    it("allows an org_admin to request on another person's behalf", () => {
      const orgAdmin: RoleAssignmentFact[] = [
        { role: "org_admin", scopeType: "global", scopeId: null, revokedAt: null },
      ];
      expect(
        can(
          { id: "admin_1" },
          action,
          { type: "dsar_request", scopeType: "global", scopeId: null, ownerId: "person_2" },
          orgAdmin,
        ),
      ).toBe(true);
    });
  });
});

describe("hasRoleInScope", () => {
  it("ignores scopeId for global-scoped checks", () => {
    const assignments: RoleAssignmentFact[] = [
      { role: "org_admin", scopeType: "global", scopeId: null, revokedAt: null },
    ];
    expect(hasRoleInScope(assignments, "org_admin", "global", null)).toBe(true);
  });

  it("requires an exact scopeId match for chapter-scoped checks", () => {
    const assignments: RoleAssignmentFact[] = [
      { role: "chapter_lead", scopeType: "chapter", scopeId: "chapter_a", revokedAt: null },
    ];
    expect(hasRoleInScope(assignments, "chapter_lead", "chapter", "chapter_a")).toBe(true);
    expect(hasRoleInScope(assignments, "chapter_lead", "chapter", "chapter_b")).toBe(false);
  });
});
