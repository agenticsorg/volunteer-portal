/**
 * @volunteer-portal/authz — `can(subject, action, resource, assignments)`
 * (ADR-0007).
 *
 * Deliberately pure and synchronous: unlike the ADR's own illustrative
 * sketch (which fetches `getActiveRoleAssignments(subject.id)` *inside*
 * `can()`), this package has zero database dependency of its own, so the
 * caller's already-fetched `RoleAssignmentFact[]` is passed in directly.
 * This is what ADR-0007's own Testing note asks for — "policy rules are
 * unit-tested directly (given a subject with assignments X, resource Y,
 * action Z, expect allow/deny) independent of any HTTP/tRPC layer" — a
 * function that itself opened a database connection could not be tested
 * that way. Callers fetch the subject's active assignments once per
 * request (e.g. `modules/identity`'s `listActiveRoleAssignments`) and
 * reuse them across every `can()` call in that request, which is exactly
 * the caching behavior the ADR asks for, just performed by the caller
 * instead of hidden inside this function.
 */
import { rules } from "./rules";
import type { Action, PolicySubject, Resource, RoleAssignmentFact } from "./types";

/**
 * Fail-closed by construction (ADR-0007 Consequences: "`can()` throws if
 * an `Action` has no matching rule, so a newly added mutation that a
 * developer forgot to write a policy rule for fails safe ... instead of
 * silently allowing"). `tests/unit/authz.test.ts` additionally enforces
 * this at CI time via an exhaustiveness check against every `Action`.
 */
export function can(
  subject: PolicySubject,
  action: Action,
  resource: Resource,
  assignments: readonly RoleAssignmentFact[],
): boolean {
  const rule = rules.find((r) => r.action === action);
  if (!rule) {
    throw new Error(`@volunteer-portal/authz: no policy rule defined for action "${action}".`);
  }
  return rule.allow(subject, resource, assignments);
}
