import { newId } from "@volunteer-portal/ulid";
import type { PolicySubject } from "@volunteer-portal/authz";
import { cloudflareR2Adapter, type PostAttachmentStorageAdapter } from "../infra/cloudflareR2Client";

export interface InitiatePostAttachmentUploadInput {
  caller: PolicySubject;
  /** e.g. `"image/jpeg"` — used only to build the object key extension; not itself part of the R2 signature. */
  fileExtension: string;
}

export interface InitiatedPostAttachmentUpload {
  r2ObjectKey: string;
  uploadUrl: string;
}

/**
 * The upload half of `CreatePost`'s Attachment value object (ADR-0011;
 * docs/ddd/community-social.md's Attachment: "a pointer to an object in
 * Cloudflare R2 ... never binary data stored in Postgres"). Not a
 * separately numbered Key Use Case in docs/ddd/community-social.md (its
 * API Contract Sketch's `createPost` takes `attachments` as already-known
 * `{r2ObjectKey, ...}` values, implying a prior upload step it doesn't
 * spell out — the same "upload triggers processing" shape
 * `training.initiateVideoUpload` fills for Video), but required for this
 * stage's build item 6 ("attachments via the R2 adapter boundary") to be
 * anything more than an unused interface: a client needs a real, signed
 * URL to upload attachment bytes to *before* it can call `createPost`
 * with the resulting `r2ObjectKey`.
 *
 * Key naming: `attachments/posts/{authorId}/{ulid}.{fileExtension}`
 * (ADR-0011's `attachments/{asset-class}/{owning-entity}/...` convention).
 * No DB row is created here — unlike `training.video`'s 1:1
 * upload-registration row, `community.post.attachments` is a plain JSONB
 * array with no independent "pending upload" table to track (see this
 * module's Prisma schema comment); the caller simply includes the
 * returned `r2ObjectKey` in `CreatePost`'s own `attachments` input once
 * the client-side upload succeeds.
 */
export async function initiatePostAttachmentUpload(
  input: InitiatePostAttachmentUploadInput,
  adapter: PostAttachmentStorageAdapter = cloudflareR2Adapter,
): Promise<InitiatedPostAttachmentUpload> {
  const r2ObjectKey = `attachments/posts/${input.caller.id}/${newId()}.${input.fileExtension}`;
  const { url } = await adapter.createUploadUrl(r2ObjectKey);
  return { r2ObjectKey, uploadUrl: url };
}
