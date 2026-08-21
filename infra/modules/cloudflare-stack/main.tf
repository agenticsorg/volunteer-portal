/**
 * Cloudflare stack (R2 buckets + DNS) — ADR-0016 "Decision" ("Cloudflare
 * provides Stream (video), R2 (object storage) ... one Cloudflare account
 * with per-environment resource separation") and Implementation Notes
 * ("Domain/DNS: Cloudflare is also the DNS provider ... managed via
 * cloudflare_record Terraform resources pointing at Vercel's provided
 * CNAME targets").
 *
 * Deliberately NOT covered here: Cloudflare Stream. There is no
 * Terraform-manageable "create a Stream project" resource in the
 * cloudflare/cloudflare provider (checked against v4.52.8's schema in
 * this environment) - Stream is account-level and configured via its API
 * directly by the training module's adapter
 * (apps/web/src/modules/training/infra/cloudflareStreamClient.ts), not
 * provisioned as infrastructure. What IS Terraform-managed here is the R2
 * buckets and the DNS records pointing this environment's subdomain at
 * Vercel.
 *
 * Also not covered: the 90-day-to-infrequent-access / 1-year-deletion R2
 * object lifecycle policy ADR-0016 describes for the backup bucket. The
 * cloudflare_r2_bucket resource in this provider version has no lifecycle
 * sub-block/resource - R2 lifecycle rules are configured via Cloudflare's
 * dashboard or a direct API call today; a comment is left on the backup
 * bucket resource below instead of silently omitting the requirement.
 *
 * This environment has no Cloudflare API token configured, so the
 * "cloudflare" provider (configured in each
 * infra/environments/{production,staging} root module) has never
 * authenticated against a real Cloudflare account here.
 */

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

data "cloudflare_zone" "root" {
  name = var.zone_name
}

locals {
  bucket_names = {
    dsar_exports        = "agentics-dsar-exports${var.bucket_suffix}"
    profile_photos      = "agentics-profile-photos${var.bucket_suffix}"
    moderation_evidence = "agentics-moderation-evidence${var.bucket_suffix}"
  }
}

resource "cloudflare_r2_bucket" "dsar_exports" {
  account_id = var.account_id
  name       = local.bucket_names.dsar_exports
  location   = var.bucket_location
}

resource "cloudflare_r2_bucket" "profile_photos" {
  account_id = var.account_id
  name       = local.bucket_names.profile_photos
  location   = var.bucket_location
}

resource "cloudflare_r2_bucket" "moderation_evidence" {
  account_id = var.account_id
  name       = local.bucket_names.moderation_evidence
  location   = var.bucket_location
}

# ADR-0016 "Disaster recovery / backup policy": nightly pg_dump target,
# production only. NOTE: the 90-day -> infrequent-access -> 1-year-deletion
# lifecycle this bucket is supposed to have is not configurable through
# this provider version's cloudflare_r2_bucket resource - it must be set
# via the Cloudflare dashboard or R2 API directly until a lifecycle
# resource exists in a future provider version. Flagging here rather than
# silently dropping the requirement.
resource "cloudflare_r2_bucket" "db_backups" {
  count = var.create_backup_bucket ? 1 : 0

  account_id = var.account_id
  name       = "agentics-db-backups-prod"
  location   = var.bucket_location
}

resource "cloudflare_record" "app_cname" {
  zone_id = data.cloudflare_zone.root.id
  name    = var.subdomain
  type    = "CNAME"
  content = var.vercel_cname_target

  # Vercel's own SSL/domain-verification flow expects the CNAME to resolve
  # directly to Vercel's edge, not through Cloudflare's proxy - proxied
  # traffic would let Cloudflare terminate TLS in front of Vercel's own
  # certificate issuance, breaking Vercel's automatic domain verification.
  proxied = false
  ttl     = 300
}

resource "cloudflare_record" "vercel_verification" {
  count = var.vercel_txt_verification_value != null ? 1 : 0

  zone_id = data.cloudflare_zone.root.id
  name    = "_vercel.${var.subdomain}"
  type    = "TXT"
  content = var.vercel_txt_verification_value
  ttl     = 300
}
