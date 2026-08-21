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
        { id: "person_1", status: "active" },
        // Intentionally not a valid Action, to prove the fail-closed path.
        "not.a.real.action" as never,
        { type: "widget", scopeType: "global", scopeId: null },
        [],
      ),
    ).toThrow(/no policy rule defined/i);
  });

  describe("caller status (fail-closed)", () => {
    // Reviewer-verified gap this proves is fixed: a caller holding every
    // role assignment a rule would otherwise require must still be denied
    // outright once their OWN `Person.status` is not "active" — an
    // anonymized/deactivated account's still-cryptographically-valid
    // session must not be able to exercise privileged authority
    // (ADR-0006's Negative Consequences: "checking a persons.status flag
    // inside the can() policy module on every privileged action").
    const orgAdmin: RoleAssignmentFact[] = [
      { role: "org_admin", scopeType: "global", scopeId: null, revokedAt: null },
    ];

    it.each(["deactivated", "anonymized"] as const)(
      "denies role.grant for an org_admin whose own status is %s, even though their role_assignments alone would allow it",
      (status) => {
        expect(
          can(
            { id: "admin_1", status },
            "role.grant",
            { type: "role_assignment", scopeType: "global", scopeId: null, role: "volunteer" },
            orgAdmin,
          ),
        ).toBe(false);
      },
    );

    it("denies chapter.create for a non-active org_admin", () => {
      expect(
        can(
          { id: "admin_1", status: "anonymized" },
          "chapter.create",
          { type: "chapter", scopeType: "global", scopeId: null },
          orgAdmin,
        ),
      ).toBe(false);
    });

    it("denies dsar.erasure.request for a non-active caller acting on their own data", () => {
      expect(
        can(
          { id: "person_1", status: "deactivated" },
          "dsar.erasure.request",
          { type: "dsar_request", scopeType: "global", scopeId: null, ownerId: "person_1" },
          [],
        ),
      ).toBe(false);
    });

    it("still allows role.grant for the same org_admin once status is active", () => {
      expect(
        can(
          { id: "admin_1", status: "active" },
          "role.grant",
          { type: "role_assignment", scopeType: "global", scopeId: null, role: "volunteer" },
          orgAdmin,
        ),
      ).toBe(true);
    });
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
            { id: "admin_1", status: "active" },
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
            { id: "lead_1", status: "active" },
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
          { id: "lead_1", status: "active" },
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
            { id: "lead_1", status: "active" },
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
          { id: "admin_1", status: "active" },
          "role.grant",
          { type: "role_assignment", scopeType: "global", scopeId: null, role: "volunteer" },
          revokedOrgAdmin,
        ),
      ).toBe(false);
    });

    it("a subject with no assignments at all is denied", () => {
      expect(
        can(
          { id: "nobody", status: "active" },
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
          can(
            { id: "admin_1", status: "active" },
            action,
            { type: "chapter", scopeType: "global", scopeId: null },
            orgAdmin,
          ),
        ).toBe(true);
        expect(
          can(
            { id: "lead_1", status: "active" },
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
          { id: "person_1", status: "active" },
          action,
          { type: "dsar_request", scopeType: "global", scopeId: null, ownerId: "person_1" },
          [],
        ),
      ).toBe(true);
    });

    it("denies one person requesting another's data without org_admin", () => {
      expect(
        can(
          { id: "person_1", status: "active" },
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
          { id: "admin_1", status: "active" },
          action,
          { type: "dsar_request", scopeType: "global", scopeId: null, ownerId: "person_2" },
          orgAdmin,
        ),
      ).toBe(true);
    });
  });

  describe("volunteering: opportunity.create / opportunity.manage / shift.manage", () => {
    const chapterLeadOfLondon: RoleAssignmentFact[] = [
      { role: "chapter_lead", scopeType: "chapter", scopeId: "chapter_london", revokedAt: null },
    ];
    const orgAdmin: RoleAssignmentFact[] = [
      { role: "org_admin", scopeType: "global", scopeId: null, revokedAt: null },
    ];

    it.each(["opportunity.create", "opportunity.manage", "shift.manage"] as const)(
      "%s: a chapter_lead may act within their own chapter, not another",
      (action) => {
        expect(
          can(
            { id: "lead_1", status: "active" },
            action,
            { type: "opportunity", scopeType: "chapter", scopeId: "chapter_london" },
            chapterLeadOfLondon,
          ),
        ).toBe(true);
        expect(
          can(
            { id: "lead_1", status: "active" },
            action,
            { type: "opportunity", scopeType: "chapter", scopeId: "chapter_sv" },
            chapterLeadOfLondon,
          ),
        ).toBe(false);
      },
    );

    it.each(["opportunity.create", "opportunity.manage", "shift.manage"] as const)(
      "%s: an org-wide (chapterId null) resource requires org_admin — a chapter_lead cannot act on it",
      (action) => {
        expect(
          can(
            { id: "admin_1", status: "active" },
            action,
            { type: "opportunity", scopeType: "global", scopeId: null },
            orgAdmin,
          ),
        ).toBe(true);
        expect(
          can(
            { id: "lead_1", status: "active" },
            action,
            { type: "opportunity", scopeType: "global", scopeId: null },
            chapterLeadOfLondon,
          ),
        ).toBe(false);
      },
    );

    it("a mentor alone (no chapter_lead/org_admin) cannot manage an opportunity/shift", () => {
      const mentor: RoleAssignmentFact[] = [
        { role: "mentor", scopeType: "chapter", scopeId: "chapter_london", revokedAt: null },
      ];
      for (const action of ["opportunity.create", "opportunity.manage", "shift.manage"] as const) {
        expect(
          can(
            { id: "mentor_1", status: "active" },
            action,
            { type: "opportunity", scopeType: "chapter", scopeId: "chapter_london" },
            mentor,
          ),
        ).toBe(false);
      }
    });
  });

  describe("volunteering: application.decide / hour_entry.approve / hour_entry.reject", () => {
    const mentorOfLondon: RoleAssignmentFact[] = [
      { role: "mentor", scopeType: "chapter", scopeId: "chapter_london", revokedAt: null },
    ];
    const globalMentor: RoleAssignmentFact[] = [
      { role: "mentor", scopeType: "global", scopeId: null, revokedAt: null },
    ];
    const chapterLeadOfLondon: RoleAssignmentFact[] = [
      { role: "chapter_lead", scopeType: "chapter", scopeId: "chapter_london", revokedAt: null },
    ];
    const volunteerOnly: RoleAssignmentFact[] = [];

    it.each(["application.decide", "hour_entry.approve", "hour_entry.reject"] as const)(
      "%s: chapter_lead, mentor (chapter-scoped or global), and org_admin all qualify",
      (action) => {
        const resource = { type: "hour_entry", scopeType: "chapter", scopeId: "chapter_london" } as const;
        expect(can({ id: "lead_1", status: "active" }, action, resource, chapterLeadOfLondon)).toBe(true);
        expect(can({ id: "mentor_1", status: "active" }, action, resource, mentorOfLondon)).toBe(true);
        expect(can({ id: "mentor_2", status: "active" }, action, resource, globalMentor)).toBe(true);
        expect(can({ id: "v_1", status: "active" }, action, resource, volunteerOnly)).toBe(false);
      },
    );

    it("a mentor scoped to a different chapter does not qualify", () => {
      const resource = { type: "hour_entry", scopeType: "chapter", scopeId: "chapter_sv" } as const;
      expect(can({ id: "mentor_1", status: "active" }, "hour_entry.approve", resource, mentorOfLondon)).toBe(
        false,
      );
    });
  });

  describe("volunteering: hours.export", () => {
    const chapterLeadOfLondon: RoleAssignmentFact[] = [
      { role: "chapter_lead", scopeType: "chapter", scopeId: "chapter_london", revokedAt: null },
    ];
    const orgAdmin: RoleAssignmentFact[] = [
      { role: "org_admin", scopeType: "global", scopeId: null, revokedAt: null },
    ];
    const mentorOfLondon: RoleAssignmentFact[] = [
      { role: "mentor", scopeType: "chapter", scopeId: "chapter_london", revokedAt: null },
    ];

    it("a chapter_lead may export their own chapter's approved hours, not another's", () => {
      const resource = { type: "hour_entry", scopeType: "chapter", scopeId: "chapter_london" } as const;
      expect(can({ id: "lead_1", status: "active" }, "hours.export", resource, chapterLeadOfLondon)).toBe(true);
      expect(
        can(
          { id: "lead_1", status: "active" },
          "hours.export",
          { type: "hour_entry", scopeType: "chapter", scopeId: "chapter_sv" },
          chapterLeadOfLondon,
        ),
      ).toBe(false);
    });

    it("an unfiltered (global-scope) export requires org_admin — a chapter_lead cannot", () => {
      const resource = { type: "hour_entry", scopeType: "global", scopeId: null } as const;
      expect(can({ id: "admin_1", status: "active" }, "hours.export", resource, orgAdmin)).toBe(true);
      expect(can({ id: "lead_1", status: "active" }, "hours.export", resource, chapterLeadOfLondon)).toBe(false);
    });

    it("a plain mentor (no chapter_lead/org_admin) cannot export", () => {
      const resource = { type: "hour_entry", scopeType: "chapter", scopeId: "chapter_london" } as const;
      expect(can({ id: "mentor_1", status: "active" }, "hours.export", resource, mentorOfLondon)).toBe(false);
    });
  });

  describe("training: course.manage / video.captions.approve", () => {
    const contentAdmin: RoleAssignmentFact[] = [
      { role: "content_admin", scopeType: "global", scopeId: null, revokedAt: null },
    ];
    const orgAdmin: RoleAssignmentFact[] = [
      { role: "org_admin", scopeType: "global", scopeId: null, revokedAt: null },
    ];
    const chapterLead: RoleAssignmentFact[] = [
      { role: "chapter_lead", scopeType: "chapter", scopeId: "chapter_london", revokedAt: null },
    ];

    it.each(["course.manage", "video.captions.approve"] as const)(
      "%s: content_admin or org_admin qualify, a chapter_lead does not",
      (action) => {
        const resource = { type: "course", scopeType: "global", scopeId: null } as const;
        expect(can({ id: "admin_1", status: "active" }, action, resource, contentAdmin)).toBe(true);
        expect(can({ id: "admin_2", status: "active" }, action, resource, orgAdmin)).toBe(true);
        expect(can({ id: "lead_1", status: "active" }, action, resource, chapterLead)).toBe(false);
      },
    );
  });

  describe("training: video.play", () => {
    const contentAdmin: RoleAssignmentFact[] = [
      { role: "content_admin", scopeType: "global", scopeId: null, revokedAt: null },
    ];

    it("allows a caller acting on their own enrollment (resource.ownerId === subject.id)", () => {
      expect(
        can(
          { id: "learner_1", status: "active" },
          "video.play",
          { type: "video", scopeType: "global", scopeId: null, ownerId: "learner_1" },
          [],
        ),
      ).toBe(true);
    });

    it("denies a caller acting on someone else's enrollment without content authority", () => {
      expect(
        can(
          { id: "learner_1", status: "active" },
          "video.play",
          { type: "video", scopeType: "global", scopeId: null, ownerId: "learner_2" },
          [],
        ),
      ).toBe(false);
    });

    it("allows content_admin to preview any video regardless of ownerId", () => {
      expect(
        can(
          { id: "admin_1", status: "active" },
          "video.play",
          { type: "video", scopeType: "global", scopeId: null, ownerId: "learner_2" },
          contentAdmin,
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
