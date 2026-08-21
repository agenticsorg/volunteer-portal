import { newId } from "@volunteer-portal/ulid";
import type { PolicySubject } from "@volunteer-portal/authz";
import { cloudflareR2Adapter, type EvidenceAttachmentStorageAdapter } from "../infra/cloudflareR2Client";

export interface InitiateEvidenceUploadInput {
  caller: PolicySubject;
  /** e.g. `"image/png"` — used only to build the object key extension; not itself part of the R2 signature. */
  fileExtension: string;
}

export interface InitiatedEvidenceUpload {
  r2ObjectKey: string;
  uploadUrl: string;
}

/**
 * The upload half of `FileReport`'s EvidenceAttachment value object
 * (ADR-0011; docs/ddd/moderation-trust-safety.md's "Evidence Attachment":
 * "a pointer to an object in Cloudflare R2 ... screenshots, additional
 * context files"). `FileReport`'s API Contract Sketch takes
 * `evidenceAttachments` as already-known `{r2ObjectKey, ...}` values, same
 * "a client needs a real, signed URL to upload attachment bytes to
 * *before* it can call the create mutation with the resulting
 * `r2ObjectKey`" shape `community.initiatePostAttachmentUpload` fills for
 * Post attachments.
 *
 * Key naming: `attachments/moderation/{reporterId}/{ulid}.{fileExtension}`
 * — see `infra/cloudflareR2Client.ts`'s own `createUploadUrl` doc comment
 * for why this uses the reporter's id rather than the not-yet-created
 * Report's id. No DB row is created here — `moderation.report.
 * evidence_attachments` is a plain JSONB array with no independent
 * "pending upload" table to track, same shape as `community.post.
 * attachments`; the caller includes the returned `r2ObjectKey` in
 * `FileReport`'s own `evidenceAttachments` input once the client-side
 * upload succeeds.
 */
export async function initiateEvidenceUpload(
  input: InitiateEvidenceUploadInput,
  adapter: EvidenceAttachmentStorageAdapter = cloudflareR2Adapter,
): Promise<InitiatedEvidenceUpload> {
  const r2ObjectKey = `attachments/moderation/${input.caller.id}/${newId()}.${input.fileExtension}`;
  const { url } = await adapter.createUploadUrl(r2ObjectKey);
  return { r2ObjectKey, uploadUrl: url };
}
