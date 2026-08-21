variable "cloudflare_account_id" {
  description = "Cloudflare account ID (one account for the whole org, per ADR-0016)."
  type        = string
}

variable "fly_org" {
  description = "Fly.io organization slug."
  type        = string
  default     = "agentics-foundation"
}

variable "git_repo" {
  description = "GitHub repo the Vercel project auto-deploys from."
  type        = string
  default     = "agenticsorg/volunteer-portal"
}
