import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { PolicySubject } from "@volunteer-portal/authz";
import { ModuleNotFoundError, VideoAlreadyInitiatedError } from "../domain/errors";
import { cloudflareStreamAdapter, type CloudflareStreamAdapter } from "../infra/cloudflareStreamClient";
import { assertTrainingAuthority } from "./assertTrainingAuthority";

/**
 * InitiateVideoUpload — the Ingestion half of ADR-0010's "Upload triggers
 * processing" build item (not separately numbered among the DDD doc's 9
 * Key Use Cases, but required by the Video entity's own shape: a
 * `training.video` row's `cloudflare_stream_id` is `NOT NULL UNIQUE`, so
 * it can only ever be created alongside a real Cloudflare Stream direct
 * creator upload registration).
 *
 * *Pre:* caller holds `content_admin` (global) or `org_admin`; the target
 * Module has no Video yet (1:1, `training.video.module_id` unique).
 *
 * *Post:* a new `Video(encodeStatus = 'uploading', captionStatus =
 * 'pending')` row exists, pointing at a real Cloudflare Stream upload
 * registration; `VideoUploaded` emitted. The caller (a content-authoring
 * UI) uses the returned `uploadUrl` to upload the source video bytes
 * directly to Cloudflare — this server never proxies the video bytes
 * themselves.
 */
export interface InitiateVideoUploadInput {
  caller: PolicySubject;
  moduleId: string;
  maxDurationSeconds?: number;
}

export interface InitiatedVideoUpload {
  videoId: string;
  uploadUrl: string;
}

export async function initiateVideoUpload(
  prisma: PrismaClient,
  input: InitiateVideoUploadInput,
  adapter: CloudflareStreamAdapter = cloudflareStreamAdapter,
): Promise<InitiatedVideoUpload> {
  await assertTrainingAuthority(prisma, input.caller, "course.manage");

  const targetModule = await prisma.module.findUnique({
    where: { id: input.moduleId },
    select: { id: true, video: { select: { id: true } } },
  });
  if (!targetModule) {
    throw new ModuleNotFoundError(input.moduleId);
  }
  if (targetModule.video) {
    throw new VideoAlreadyInitiatedError(input.moduleId);
  }

  const { streamUid, uploadUrl } = await adapter.createDirectUploadUrl(input.maxDurationSeconds);

  const videoId = newId();
  await prisma.$transaction(async (tx) => {
    await tx.video.create({
      data: {
        id: videoId,
        moduleId: targetModule.id,
        cloudflareStreamId: streamUid,
        encodeStatus: "uploading",
        captionStatus: "pending",
      },
    });

    await tx.trainingDomainEvent.create({
      data: {
        id: newId(),
        aggregateType: "Video",
        aggregateId: videoId,
        eventType: "VideoUploaded",
        payload: {
          videoId,
          moduleId: targetModule.id,
          cloudflareStreamId: streamUid,
        } satisfies Prisma.InputJsonValue,
      },
    });

    await recordAuditEvent(tx.trainingDomainEvent, {
      actorId: input.caller.id,
      actorType: "user",
      action: "video.upload_initiate",
      resourceType: "video",
      resourceId: videoId,
      scopeType: "global",
      metadata: { moduleId: targetModule.id },
    });
  });

  return { videoId, uploadUrl };
}
