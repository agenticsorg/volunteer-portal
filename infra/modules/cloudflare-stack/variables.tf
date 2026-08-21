variable "account_id" {
  description = "Cloudflare account ID (one account, per-environment resource separation per ADR-0016)."
  type        = string
}

variable "environment" {
  description = "production | staging. Drives the bucket name suffix and DNS subdomain."
  type        = string
}

variable "zone_name" {
  description = "Root DNS zone this platform's subdomains live under."
  type        = string
  default     = "agentics.org"
}

variable "subdomain" {
  description = "Full subdomain (relative to the zone) the app is served from - e.g. \"volunteer\" for production, \"staging.volunteer\" for staging."
  type        = string
}

variable "vercel_cname_target" {
  description = "CNAME target Vercel issues for this project's custom domain (e.g. cname.vercel-dns.com)."
  type        = string
  default     = "cname.vercel-dns.com"
}

variable "vercel_txt_verification_value" {
  description = "TXT record value Vercel requires for domain ownership verification. Null skips the record (added once Vercel actually issues one for a real domain - it does not exist until the vercel-project module's domain resource has been applied for real, which has not happened in this environment)."
  type        = string
  default     = null
}

variable "bucket_suffix" {
  description = "Suffix appended to R2 bucket names for non-production environments. ADR-0016 Environment Topology: \"Separate Stream/R2 buckets (-staging suffix)\"."
  type        = string
  default     = ""
}

variable "bucket_location" {
  description = "R2 bucket location hint."
  type        = string
  default     = "enam"
}

variable "create_backup_bucket" {
  description = "Whether to create the nightly-pg_dump backup bucket (agentics-db-backups-prod). ADR-0016's backup policy only covers production - staging has no equivalent backup bucket."
  type        = bool
  default     = false
}
