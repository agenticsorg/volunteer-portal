import type { PrismaClient } from "@prisma/client";
import type { PolicySubject, PersonStatus } from "@volunteer-portal/authz";
import { ForbiddenActionError } from "../domain/errors";

/**
 * Resolves the CALLER's own `identity.persons.status` into the
 * `PolicySubject` shape `can()` needs to fail closed on it (ADR-0006's
 * Negative Consequences note; `packages/authz/src/can.ts`).
 *
 * Every privileged use case that calls `can()` must build its `subject`
 * argument through this helper rather than a bare `{ id: callerId }` —
 * that literal shape no longer type-checks against `PolicySubject` at all
 * (its `status` field is required), which is what makes "a use case forgot
 * to check the caller's own status" a compile error going forward instead
 * of a silent authorization gap.
 *
 * If no `Person` row exists for `callerId` at all, the caller is treated
 * as unauthorized — fail closed, the same outcome as a non-`active`
 * status — rather than throwing a generic "not found": every privileged
 * mutation's caller is expected to already be a registered, resolved
 * Person (tRPC's `protectedProcedure` / the REST DSAR endpoint's API-key
 * path both only ever produce a real `callerId`), so a missing row here
 * means something is wrong upstream, not that "unauthenticated" should be
 * distinguished from "forbidden."
 */
export async function getCallerPolicySubject(
  prisma: PrismaClient,
  callerId: string,
  action: string,
): Promise<PolicySubject> {
  const caller = await prisma.person.findUnique({
    where: { id: callerId },
    select: { status: true },
  });
  if (!caller) {
    throw new ForbiddenActionError(action);
  }
  return { id: callerId, status: caller.status as PersonStatus };
}
