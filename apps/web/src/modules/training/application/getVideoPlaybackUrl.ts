import type { PrismaClient } from "@prisma/client";
import { can, type PolicySubject } from "@volunteer-portal/authz";
import { listActiveRoleAssignments } from "@/modules/identity";
import { ForbiddenActionError, NotEnrolledError, VideoNotFoundError, VideoNotReadyError } from "../domain/errors";
import { cloudflareStreamAdapter, type CloudflareStreamAdapter } from "../infra/cloudflareStreamClient";

const PLAYBACK_TTL_SECONDS = 4 * 60 * 60; // 4 hours, ADR-0010's documented default TTL.

/**
 * GetPlaybackUrl (ADR-0010: "Playback never uses Cloudflare's public/
 * default UIDs directly ... every playback request goes through a
 * tRPC/REST endpoint that runs the `can(subject, 'video:play', video)`
 * policy check ... and, only on success, mints a signed Stream URL").
 * **Gated by both enrollment and an `identity.can()` check**, as two
 * independent guards, per this phase's own build item:
 *
 * 1. Enrollment: unless the caller holds `content_admin`/`org_admin`
 *    (staff caption-review/QA preview, which must work on an unpublished
 *    course's videos too), the caller must hold an `active` or
 *    `completed` Enrollment in the Course the Video's Module belongs to.
 * 2. `can()`: `video.play` (`@volunteer-portal/authz`) — allows the
 *    learner acting on their own enrollment (`resource.ownerId ===
 *    subject.id`) or `content_admin`/`org_admin`; fails closed on the
 *    caller's own `status` (ADR-0006) regardless of enrollment.
 *
 * *Post:* a Cloudflare Stream signed, short-lived (4h) playback URL,
 * viewer-bound to `caller.id`. Never a raw/public Stream URL.
 */
export interface GetVideoPlaybackUrlInput {
  caller: PolicySubject;
  videoId: string;
}

export interface VideoPlaybackUrl {
  url: string;
  expiresAt: string;
}

export async function getVideoPlaybackUrl(
  prisma: PrismaClient,
  input: GetVideoPlaybackUrlInput,
  adapter: CloudflareStreamAdapter = cloudflareStreamAdapter,
): Promise<VideoPlaybackUrl> {
  const video = await prisma.video.findUnique({
    where: { id: input.videoId },
    select: {
      id: true,
      cloudflareStreamId: true,
      encodeStatus: true,
      module: { select: { courseId: true } },
    },
  });
  if (!video) {
    throw new VideoNotFoundError(input.videoId);
  }
  if (video.encodeStatus !== "ready") {
    throw new VideoNotReadyError(video.id, video.encodeStatus);
  }

  const assignments = await listActiveRoleAssignments(prisma, input.caller.id);

  // Staff preview: content_admin/org_admin may play any video regardless
  // of enrollment (an `ownerId` guaranteed not to equal the caller's own
  // id isolates the `hasContentAuthority` branch of the `video.play` rule).
  const isStaffPreview = can(
    input.caller,
    "video.play",
    { type: "video", scopeType: "global", scopeId: null, ownerId: `not-${input.caller.id}` },
    assignments,
  );

  if (!isStaffPreview) {
    const enrollment = await prisma.enrollment.findFirst({
      where: { personId: input.caller.id, courseId: video.module.courseId, status: { in: ["active", "completed"] } },
      select: { id: true },
    });
    if (!enrollment) {
      throw new NotEnrolledError(input.caller.id, video.module.courseId);
    }
  }

  const allowed = can(
    input.caller,
    "video.play",
    { type: "video", scopeType: "global", scopeId: null, ownerId: input.caller.id },
    assignments,
  );
  if (!allowed) {
    throw new ForbiddenActionError("video.play");
  }

  const url = await adapter.mintSignedPlaybackUrl(video.cloudflareStreamId, input.caller.id, PLAYBACK_TTL_SECONDS);
  const expiresAt = new Date(Date.now() + PLAYBACK_TTL_SECONDS * 1000).toISOString();

  return { url, expiresAt };
}
