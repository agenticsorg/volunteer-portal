# ADR-0011: Object Storage on Cloudflare R2 for Certificates, Attachments, and Data Exports

## Status
Accepted — 2026-08-10

## Context
Several bounded contexts need durable, non-database file storage that is distinct from video (ADR-0010, which owns the Cloudflare Stream pipeline):

- **`training`**: generated completion certificates (PDFs), created on module completion, need to be durable, individually retrievable, and downloadable by the volunteer indefinitely (or until retention expiry).
- **`volunteering` / `moderation`**: user-uploaded attachments — event photo proof for hour logging (per `05-domain-and-compliance.md` §1, "photo proof, or GPS check-in" is a recognized hour-verification pattern), and moderation evidence attached to reports (`05-domain-and-compliance.md` §4, "in-product report flow with evidence attachment").
- **`admin` / cross-cutting compliance**: bulk export files — GDPR Data Subject Access Request (DSAR) exports ("export-all-my-data" per the domain-compliance day-one checklist item 5) and grant/impact reports (CSV/PDF hour rollups per item 3 of that checklist).

These are heterogeneous in access pattern (a certificate is fetched by one user repeatedly for years; a DSAR export is fetched once and should expire quickly; moderation evidence must be tightly restricted to moderator/admin roles) but share the same underlying need: **S3-compatible object storage with per-object access control, that composes with the same-vendor CDN/edge already chosen for video**, rather than a database BLOB column or a separate storage vendor.

The domain-compliance research is explicit that retention is per data class with automated expiry (checklist item 6) and that DSAR/export machinery must exist (item 5) — object storage lifecycle rules are the natural enforcement point for both.

## Decision
**Cloudflare R2 is the object store for all non-video file assets**: generated certificates, user-uploaded attachments, and data-export files. No file of these kinds is ever stored as a database BLOB or on ephemeral compute filesystem.

- **Buckets**: one bucket per environment, with a key-prefix convention per asset class (not one-bucket-per-context, to keep lifecycle/IAM policy management simple at this scale):
  - `vp-{env}-files` — single bucket, e.g. `vp-prod-files`, `vp-staging-files`.
- **Key naming convention** (prefix encodes bounded context + asset class + owning entity, enabling prefix-scoped lifecycle rules and IAM conditions):
  ```
  certificates/{chapterId}/{userId}/{enrollmentId}.pdf
  attachments/hour-entries/{hourEntryId}/{ulid}-{sanitizedFilename}
  attachments/moderation/{reportId}/{ulid}-{sanitizedFilename}
  exports/dsar/{userId}/{exportId}.zip
  exports/grant-reports/{chapterId}/{exportId}.csv
  ```
- **Access pattern**: R2 buckets are **private by default, no public bucket access**. All reads and writes go through the application:
  - **Uploads**: client requests a presigned PUT URL from a tRPC/REST endpoint that first runs the relevant `can()` check (e.g., `can(subject, "hour-entry:attach-evidence", hourEntry)`), then mints a presigned R2 PUT URL scoped to the exact key, short TTL (15 min), and a `Content-Length` / MIME-type constraint.
  - **Downloads**: never a raw bucket URL. A signed GET download URL is minted per-request after the same `can()` check, short TTL (default 15 min for exports/attachments, 1 hour for certificates since those are re-requested often by the same authorized user).
  - Certificates, uniquely, may also be served through a stable authenticated app route (`GET /api/certificates/:id`) that streams from R2 server-side after auth check, avoiding TTL-expiry UX friction for a document a volunteer might revisit a year later.
- **Retention/lifecycle** (R2 lifecycle rules + application-level expiry jobs, tied to the org's documented data-retention policy):
  - `exports/dsar/**`: R2 lifecycle rule auto-deletes objects after **7 days** — a DSAR export is a point-in-time snapshot handed to the user, not a permanent artifact; the user is instructed to download promptly.
  - `exports/grant-reports/**`: retained **2 years** (typical grant-reporting audit window), then a graphile-worker scheduled job deletes the object and its DB row.
  - `attachments/moderation/**`: retained per the moderation-log retention policy (aligned with moderation audit log retention, not shorter — evidence must outlive the enforcement action it supports), deletion is a manual/audited action only, never automatic.
  - `attachments/hour-entries/**`: retained for the life of the associated hour entry; if an hour entry is anonymized under a DSAR erasure request, the attachment is deleted (not just the DB reference) as part of that anonymization job.
  - `certificates/**`: retained indefinitely by default (a certificate is proof of achievement a volunteer may need years later), removed only on account deletion/anonymization.
- **Malware/content safety**: uploaded attachments (photos, evidence) are scanned before being marked "available" — upload lands in a `pending` key state (or a quarantine prefix) and a graphile-worker job runs a content-scan step before the attachment record is marked visible to other users; this guards the moderation-evidence and hour-proof upload paths specifically since those accept arbitrary user files.

## Consequences

### Positive
- Single S3-compatible API and IAM model across every non-video file asset type, using the standard `@aws-sdk/client-s3` presigned-URL flow — no bespoke storage code per bounded context.
- Zero egress fees (R2's defining cost advantage vs. S3) matter directly here: certificate downloads and grant-report exports are recurring, unpredictable-volume operations that would otherwise carry a variable bandwidth bill.
- Same-vendor consolidation with Cloudflare Stream (ADR-0010) and CDN — one billing relationship, one sub-processor entry in the GDPR processor inventory for "file storage," simpler data-residency documentation.
- Lifecycle rules give retention-policy enforcement for free at the storage layer (DSAR export auto-deletion) rather than relying solely on application cron correctness.
- Presigned URL pattern keeps large file transfer off the Next.js/Vercel compute path entirely (client uploads/downloads directly to/from R2), avoiding serverless function payload-size and duration limits.

### Negative / Trade-offs
- Presigned-URL-per-request adds a network round-trip (mint URL, then fetch) compared to a naive public-URL/CDN-cache setup — acceptable given the access-control requirement, but a deliberate latency trade-off for private content.
- Single shared bucket with prefix-based conventions means IAM/lifecycle policy correctness depends on disciplined key naming rather than bucket-level isolation; a key-naming bug could leak cross-context (mitigated by centralizing key construction in one server-side module, never client-constructed).
- Malware/content-scan step adds latency between "upload accepted" and "attachment visible," and is additional infrastructure (scanning job, quarantine state) beyond a naive direct-write.
- R2 is a newer product than S3 with a smaller tooling/ecosystem footprint; some third-party admin/backup tools assume AWS S3 specifically and need an S3-compatible-endpoint config step.

## Alternatives Considered
- **AWS S3** — the incumbent, most mature option with the largest tooling ecosystem. Rejected in favor of R2 primarily on egress cost (S3 charges per-GB egress; R2 does not) given that certificate/export/attachment downloads are a recurring, volume-unpredictable workload for a nonprofit operating under real budget constraints, and on vendor consolidation with the already-chosen Cloudflare Stream/CDN stack. S3 remains fully API-compatible as an escape hatch if a future requirement (e.g., a specific AWS-only integration) demands it.
- **Database BLOB storage (Postgres `bytea`/large objects)** — rejected: certificates and exports are exactly the kind of large, infrequently-queried binary payload that bloats database size, slows backups/replication, and offers no CDN-edge delivery benefit. Object storage is the standard-practice separation of concerns here.
- **Supabase Storage** — plausible since Supabase already hosts Auth and (per the canonical stack) may host Postgres; rejected because it would fragment file storage across two vendors depending on which Postgres host is chosen, and its egress/pricing model is less favorable at scale than R2's zero-egress model. Cloudflare R2 keeps storage vendor-independent of the Postgres hosting choice (Neon or Supabase).

## Implementation Notes

**Schema (illustrative, per owning context — e.g. `training.certificates`, `volunteering.attachments`, `admin.exports`)**
```sql
CREATE TABLE training.certificates (
  id             TEXT PRIMARY KEY,          -- ULID
  user_id        TEXT NOT NULL,
  chapter_id     TEXT NOT NULL,
  enrollment_id  TEXT NOT NULL,
  r2_key         TEXT NOT NULL UNIQUE,      -- 'certificates/{chapterId}/{userId}/{enrollmentId}.pdf'
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ                -- null = does not expire
);

CREATE TABLE volunteering.attachments (
  id             TEXT PRIMARY KEY,          -- ULID
  hour_entry_id  TEXT NOT NULL,
  r2_key         TEXT NOT NULL UNIQUE,
  content_type   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  scan_status    TEXT NOT NULL DEFAULT 'pending'
                   CHECK (scan_status IN ('pending','clean','rejected')),
  uploaded_by    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin.exports (
  id           TEXT PRIMARY KEY,           -- ULID, also used as {exportId} in the key
  export_type  TEXT NOT NULL CHECK (export_type IN ('dsar','grant_report')),
  requested_by TEXT NOT NULL,
  r2_key       TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','ready','failed','expired')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL        -- now() + 7 days for dsar, + 2 years for grant_report
);
```

**Presigned upload (attachment example)**
```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});

async function createAttachmentUploadUrl(subject: Subject, hourEntryId: string, filename: string, contentType: string) {
  const hourEntry = await requireHourEntry(hourEntryId);
  await assertCan(subject, "hour-entry:attach-evidence", hourEntry);

  const key = `attachments/hour-entries/${hourEntryId}/${ulid()}-${sanitizeFilename(filename)}`;
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLengthRange: undefined, // enforce max size via presign policy / server-side check post-upload
  });
  const url = await getSignedUrl(r2, cmd, { expiresIn: 900 }); // 15 min

  await db.volunteering.attachments.create({
    data: { id: ulid(), hourEntryId, r2Key: key, contentType, byteSize: 0, scanStatus: "pending", uploadedBy: subject.userId },
  });

  return { uploadUrl: url, key };
}
```

**Lifecycle rule (R2 bucket config, Terraform)**
```hcl
resource "cloudflare_r2_bucket_lifecycle" "dsar_expiry" {
  bucket = cloudflare_r2_bucket.files.name
  rule {
    id     = "dsar-export-expiry"
    status = "Enabled"
    filter = { prefix = "exports/dsar/" }
    expiration = { days = 7 }
  }
  rule {
    id     = "grant-report-expiry"
    status = "Enabled"
    filter = { prefix = "exports/grant-reports/" }
    expiration = { days = 730 }
  }
}
```

**Scan-then-publish flow**: graphile-worker job `scanAttachment(attachmentId)` runs after upload-complete (client calls a `confirmUpload` mutation, or an R2 event notification triggers the job); on clean result sets `scan_status = 'clean'` and the attachment becomes visible to viewers with permission; on `rejected`, the R2 object is deleted and the uploader notified via the notification center (ADR-0012).

**Secrets/config**: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (scoped R2 API token, least-privilege per bucket), `R2_BUCKET`, `CF_ACCOUNT_ID` — stored in the platform secrets manager, distinct token from the Cloudflare Stream API token (ADR-0010) for blast-radius isolation.
