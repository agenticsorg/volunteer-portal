import type { PrismaClient } from "@prisma/client";
import { getPostSnapshot } from "@/modules/community";
import { getPersonSummary } from "@/modules/identity";
import { ReportedEntityNotFoundError, UnsupportedReportedEntityTypeError } from "../domain/errors";
import type { ReportedEntityType } from "../domain/reportedEntityTypes";

/**
 * `FileReport`'s content-snapshot + scope resolution
 * (docs/ddd/moderation-trust-safety.md, Key Use Case 1: "captures
 * `reportedContentSnapshot` and `scopeType`/`scopeId` from the reported
 * entity, via the owning context's own Open Host Service read"). The
 * anti-corruption boundary this whole aggregate exists for — this
 * function never joins into another schema's tables, only ever calls a
 * cross-context read exported through that module's own `index.ts`
 * barrel, and the result is captured once, here, at file-time (never
 * re-read afterward — see `fileReport.ts`).
 *
 * Only `"community.post"` (via `community.getPostSnapshot`, built exactly
 * for this in Phase 6) and `"identity.person"` (via
 * `identity.getPersonSummary`) have a real Open Host Service snapshot read
 * to call today. `"community.kudos"`, `"community.team"`, and
 * `"community.mentorship"` remain valid members of the closed
 * `reportedEntityType` set (docs/ddd/moderation-trust-safety.md's API
 * Contract Sketch lists all five), but `community`'s own Phase 6 index.ts
 * exports no snapshot read for any of them yet — filing a report against
 * one of those today throws `UnsupportedReportedEntityTypeError` rather
 * than fabricating a snapshot via a live join, which is exactly the thing
 * this aggregate's anti-corruption boundary forbids. Wiring those three up
 * is a matter of `community` exposing the matching read later, not a
 * change to this function's shape.
 */
export interface ReportedEntitySnapshotResult {
  snapshot: Record<string, unknown>;
  scopeType: "org" | "chapter";
  scopeId: string | null;
}

export async function resolveReportedEntitySnapshot(
  prisma: PrismaClient,
  reportedEntityType: ReportedEntityType,
  reportedEntityId: string,
): Promise<ReportedEntitySnapshotResult> {
  switch (reportedEntityType) {
    case "community.post": {
      const post = await getPostSnapshot(prisma, reportedEntityId);
      if (!post) {
        throw new ReportedEntityNotFoundError(reportedEntityType, reportedEntityId);
      }
      return {
        snapshot: {
          body: post.body,
          authorId: post.authorId,
          authorDisplayName: post.authorDisplayName,
          createdAt: post.createdAt,
        },
        scopeType: post.scopeType,
        scopeId: post.scopeId,
      };
    }
    case "identity.person": {
      const person = await getPersonSummary(prisma, reportedEntityId);
      if (!person) {
        throw new ReportedEntityNotFoundError(reportedEntityType, reportedEntityId);
      }
      // `getPersonSummary`'s contract deliberately excludes chapter
      // membership (identity-access-schema-api.md), so a reported Person
      // carries no scope of their own to copy — defaulted to `org`, the
      // same "no chapter dimension of its own" default `community`'s
      // `giveKudos.ts` already establishes for Kudos.
      return {
        snapshot: {
          displayName: person.displayName,
          publicSlug: person.publicSlug,
          avatarUrl: person.avatarUrl,
        },
        scopeType: "org",
        scopeId: null,
      };
    }
    case "community.kudos":
    case "community.team":
    case "community.mentorship":
      throw new UnsupportedReportedEntityTypeError(reportedEntityType);
    default: {
      const exhaustive: never = reportedEntityType;
      throw new UnsupportedReportedEntityTypeError(exhaustive as string);
    }
  }
}
