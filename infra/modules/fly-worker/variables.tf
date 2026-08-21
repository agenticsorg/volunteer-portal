variable "app_name" {
  description = "Fly.io app name. ADR-0016: \"agentics-worker-prod\" / \"agentics-worker-staging\"."
  type        = string
}

variable "environment" {
  description = "production | staging."
  type        = string
}

variable "fly_org" {
  description = "Fly.io organization slug the app is created under."
  type        = string
}

variable "primary_region" {
  description = "Fly.io region code."
  type        = string
  default     = "ewr"
}

variable "min_machines_running" {
  description = "graphile-worker process count. ADR-0016: 2 for production (HA - graphile-worker's job-locking design supports multiple concurrent workers safely), 1 for staging."
  type        = number
}

variable "vm_size" {
  type    = string
  default = "shared-cpu-1x"
}

variable "secrets" {
  description = "Fly secrets applied via `flyctl secrets set` (DATABASE_URL, GRAPHILE_WORKER_SCHEMA, ...). ADR-0016: \"Fly.io secrets ... are set via flyctl secrets set, sourced from the same 1Password vault\" (see infra/secrets.tf). Never populated with literal values in an environment's main.tf."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "enable_backup_machine" {
  description = "Whether to provision the nightly pg_dump backup Fly Machine (ADR-0016: production only)."
  type        = bool
  default     = false
}

variable "backup_schedule" {
  description = "flyctl machine run --schedule value for the backup machine."
  type        = string
  default     = "daily"
}

variable "r2_backup_bucket_name" {
  description = "R2 bucket the backup machine's pg_dump target. Required when enable_backup_machine is true."
  type        = string
  default     = null
}
