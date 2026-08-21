import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments, getPersonSummary } from "@/modules/identity";
import { PersonNotFoundError, ScopeInvariantViolationError } from "../domain/errors";
import { publishCommunityEvent } from "./publishCommunityEvent";

export interface PostAttachmentInput {
  r2ObjectKey: string;
  contentType: string;
  sizeBytes: number;
  altText?: string;
}

export interface CreatePostInput {
  caller: PolicySubject;
  /**
   * The chapter the author currently belongs to, per `identity.persons.
   * primary_chapter_id` — resolved and passed in by the caller (the tRPC
   * procedure, from the authenticated session/profile) rather than fetched
   * here. `identity.getPersonSummary`'s contract deliberately excludes
   * chapter membership (identity-access-schema-api.md: `-> { personId,
   * publicSlug, displayName, avatarUrl }`), and Post's own doc comment
   * frames `authorChapterId` as snapshotted "without a live cross-schema
   * read on every write" — so this use case takes it as given input rather
   * than resolving it itself.
   */
  authorChapterId: string | null;
  body: string;
  scopeType: "org" | "chapter";
  scopeId: string | null;
  attachments?: PostAttachmentInput[];
}

export interface CreatedPost {
  postId: string;
}

/**
 * CreatePost (docs/ddd/community-social.md, Key Use Case 1). Validates the
 * scope invariant (Post invariant 1), snapshots `authorDisplayName`/
 * `authorChapterId`, persists the Post, creates the matching native
 * `FeedEntry` (`kind = 'post'`, a thin pointer per FeedEntry invariant 2 —
 * `summary`/`payload` deliberately do NOT duplicate `body`, so a later
 * edit/hide of the Post is reflected by feed reads joining `community.post`
 * live rather than by re-projecting this row), and emits `PostCreated`.
 *
 * *Pre:* `scopeType = 'org'` requires `can(caller, 'post.create_org_scope',
 * {})` (only `org_admin`); `scopeType = 'chapter'` requires `scopeId ===
 * authorChapterId` — a member cannot post *into* a chapter they don't
 * belong to, even one they can see.
 *
 * *Post:* a new `Post(status = 'published')` row and its native `FeedEntry`
 * both exist; `PostCreated` emitted.
 */
export async function createPost(prisma: PrismaClient, input: CreatePostInput): Promise<CreatedPost> {
  const author = await getPersonSummary(prisma, input.caller.id);
  if (!author) {
    throw new PersonNotFoundError(input.caller.id);
  }

  if (input.scopeType === "org") {
    if (input.scopeId !== null) {
      throw new ScopeInvariantViolationError("An org-scoped post must not carry a scopeId.");
    }
    const assignments = await listActiveRoleAssignments(prisma, input.caller.id);
    const allowed = can(input.caller, "post.create_org_scope", { type: "post", scopeType: "global", scopeId: null }, assignments);
    if (!allowed) {
      throw new ScopeInvariantViolationError(
        "Only an org_admin may create an org-scoped post.",
      );
    }
  } else {
    if (input.scopeId === null || input.scopeId !== input.authorChapterId) {
      throw new ScopeInvariantViolationError(
        "A chapter-scoped post's scopeId must equal the author's own chapter membership.",
      );
    }
  }

  const attachments = input.attachments ?? [];
  const postId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.post.create({
      data: {
        id: postId,
        authorId: input.caller.id,
        authorDisplayName: author.displayName,
        authorChapterId: input.authorChapterId,
        body: input.body,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        attachments: attachments as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.feedEntry.create({
      data: {
        id: newId(),
        kind: "post",
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        subjectPersonId: input.caller.id,
        subjectDisplayName: author.displayName,
        sourceType: "community.post",
        sourceId: postId,
        sourceEventId: null,
        // Deliberately NOT the post body (FeedEntry invariant 2) — feed
        // reads resolve live content by joining `community.post` at read
        // time, so this stays a static, non-stale placeholder.
        summary: `${author.displayName} posted an update`,
        payload: {},
      },
    });

    await publishCommunityEvent(tx, {
      eventType: "PostCreated",
      aggregateType: "Post",
      aggregateId: postId,
      payload: {
        postId,
        authorId: input.caller.id,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
      },
    });

    await recordAuditEvent(tx.communityDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "post.create",
      resourceType: "post",
      resourceId: postId,
      scopeType: input.scopeType === "org" ? "global" : "chapter",
      scopeId: input.scopeId ?? undefined,
      metadata: { scopeType: input.scopeType, attachmentCount: attachments.length },
    });
  });

  return { postId };
}
