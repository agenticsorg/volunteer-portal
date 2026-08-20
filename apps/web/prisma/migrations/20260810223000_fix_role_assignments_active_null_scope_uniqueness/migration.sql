-- Fixes a real, verified gap in `uq_role_assignments_active`
-- (docs/ddd/identity-access-schema-api.md's Schema Sketch, reproduced
-- verbatim in the previous migration): Postgres unique indexes treat NULL
-- as distinct from NULL, so the original
--   CREATE UNIQUE INDEX uq_role_assignments_active
--     ON identity.role_assignments (subject_id, role, scope_type, scope_id)
--     WHERE revoked_at IS NULL;
-- does NOT actually prevent two simultaneously-active `global`-scoped
-- assignments for the same (subject_id, role) — `scope_id` is always NULL
-- for `scope_type = 'global'` (chk_role_assignments_scope), and two NULLs
-- never conflict in a unique index. Confirmed directly:
--   INSERT INTO identity.role_assignments (..., scope_type, scope_id, ...)
--     VALUES (..., 'global', NULL, ...);  -- x2, same subject/role
--   -- both succeed; RoleAssignment invariant 2 ("exactly one active
--   -- assignment per (subject, role, scope) tuple") is silently violated
--   -- for every global-scoped role (org_admin, content_admin, moderator,
--   -- mentor/volunteer-at-global-scope) under concurrent grants.
--
-- `grantRole.ts`'s applicaton-layer pre-check (`findActiveAssignment`)
-- already prevents this in the sequential case, but its own comment
-- incorrectly relied on this index as "the real backstop" for a
-- concurrent race — it wasn't. Fixed here by normalizing NULL to an empty
-- string inside the index expression, so two global-scoped rows for the
-- same (subject_id, role) now collide exactly like two chapter/team-scoped
-- rows for the same (subject_id, role, scope_id) already did.
DROP INDEX "identity"."uq_role_assignments_active";

CREATE UNIQUE INDEX "uq_role_assignments_active"
  ON "identity"."role_assignments" ("subject_id", "role", "scope_type", COALESCE("scope_id", ''))
  WHERE "revoked_at" IS NULL;
