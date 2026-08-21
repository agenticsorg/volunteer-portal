import type { PrismaClient } from "@prisma/client";
import type { PostAttachmentInput } from "./createPost";

/**
 * The stable, well-defined shape `getPostSnapshot` returns — every field a
 * later consumer needs to capture an immutable content snapshot from,
 * without that consumer ever joining into `community.post` directly
 * (ADR-0001). Every field here is a plain value, never a live reference —
 * a caller that stores this object (e.g. Moderation's `reportedContentSnapshot`,
 * docs/ddd/moderation-trust-safety.md) captures it once and never re-reads
 * it, per that phase's own "never a live join, never re-synced after
 * filing" framing.
 */
export interface PostSnapshot {
  postId: string;
  authorId: string;
  authorDisplayName: string;
  authorChapterId: string | null;
  body: string;
  scopeType: "org" | "chapter";
  scopeId: string | null;
  attachments: PostAttachmentInput[];
  status: "published" | "hidden" | "deleted";
  hiddenByModerationActionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * GetPostSnapshot (docs/ddd/community-social.md, Key Use Case 3) — the
 * Open Host Service query a later Moderation phase depends on existing
 * before `Report.reportedContentSnapshot` can be built
 * (docs/plans/implementation-plan.md, Phase 7 build item 2: "a
 * `reportedContentSnapshot` captured once, at file-time, via the owning
 * context's own snapshot query (e.g. `community.getPostSnapshot` from
 * Phase 6)"). Nothing calls this yet — it exists now purely so that
 * contract is stable and testable ahead of time, per Phase 6's own
 * completion bar ("`getPostSnapshot` has its own contract test asserting a
 * stable return shape, since nothing will exercise it end-to-end until the
 * next phase exists").
 *
 * A plain, un-gated read (same "public projection" shape as `identity`'s
 * `getPersonSummary`) — Moderation's own `can()` check on who may *file* a
 * report happens at that phase's own boundary, not here.
 */
export async function getPostSnapshot(prisma: PrismaClient, postId: string): Promise<PostSnapshot | null> {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) return null;

  return {
    postId: post.id,
    authorId: post.authorId,
    authorDisplayName: post.authorDisplayName,
    authorChapterId: post.authorChapterId,
    body: post.body,
    scopeType: post.scopeType,
    scopeId: post.scopeId,
    attachments: (post.attachments as unknown as PostAttachmentInput[]) ?? [],
    status: post.status,
    hiddenByModerationActionId: post.hiddenByModerationActionId,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}
