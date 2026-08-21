import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import {
  CaptionsNotApprovableError,
  TranscriptTextRequiredError,
  VideoNotFoundError,
  VideoNotReadyError,
} from "../domain/errors";
import { assertTrainingAuthority } from "./assertTrainingAuthority";

const APPROVABLE_FROM = new Set(["auto_generated", "human_review"]);

/**
 * ApproveCaptions (docs/ddd/training-learning.md, Key Use Case 4;
 * ADR-0010's mandatory human-review gate; ADR-0014's WCAG 2.1 AA
 * compliance requirement). This is the *only* code path in this module
 * that ever sets `Video.captionStatus = 'approved'` — `PublishCourse`
 * hard-fails on anything else, and no other function writes this column
 * to `'approved'`.
 *
 * *Pre:* caller holds `content_admin` (global) or `org_admin`; the Video
 * is `encodeStatus = 'ready'`; `captionStatus` is currently
 * `'auto_generated'` or `'human_review'` (never directly from `'pending'`
 * — no draft exists yet to review — and never re-approved once already
 * `'approved'`); `transcriptText` is non-empty.
 *
 * *Post:* `captionStatus = 'approved'`, `transcriptText` stored (also
 * feeding the ADR-0017 `video.search_vector` generated column);
 * `VideoCaptionsApproved` emitted.
 */
export interface ApproveCaptionsInput {
  caller: PolicySubject;
  videoId: string;
  transcriptText: string;
}

export async function approveCaptions(prisma: PrismaClient, input: ApproveCaptionsInput): Promise<void> {
  await assertTrainingAuthority(prisma, input.caller, "video.captions.approve");

  const video = await prisma.video.findUnique({
    where: { id: input.videoId },
    select: { id: true, moduleId: true, encodeStatus: true, captionStatus: true },
  });
  if (!video) {
    throw new VideoNotFoundError(input.videoId);
  }
  if (video.encodeStatus !== "ready") {
    throw new VideoNotReadyError(video.id, video.encodeStatus);
  }
  if (!APPROVABLE_FROM.has(video.captionStatus)) {
    throw new CaptionsNotApprovableError(video.id, video.captionStatus);
  }
  if (!input.transcriptText.trim()) {
    throw new TranscriptTextRequiredError();
  }

  await prisma.$transaction(async (tx) => {
    await tx.video.update({
      where: { id: video.id, captionStatus: video.captionStatus as "auto_generated" | "human_review" },
      data: { captionStatus: "approved", transcriptText: input.transcriptText },
    });

    await tx.trainingDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Video",
        aggregateId: video.id,
        eventType: "VideoCaptionsApproved",
        payload: {
          videoId: video.id,
          moduleId: video.moduleId,
          approvedByPersonId: input.caller.id,
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.trainingDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "video.captions.approve",
      resourceType: "video",
      resourceId: video.id,
      scopeType: "global",
    });
  });
}
