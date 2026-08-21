variable "project_name" {
  description = "Neon project name. Production and staging are fully separate Neon *projects*, not branches of one project (ADR-0016 Environment Topology) — never reuse a name across environments."
  type        = string
}

variable "environment" {
  description = "Logical environment this project belongs to (production | staging | dr-drill). Informational only (used for tagging/naming in outputs); Neon has no native project-tag resource in this provider version."
  type        = string
}

variable "region_id" {
  description = "Neon region ID. Defaults to Neon's AWS us-east-1 region, matching the rest of the canonical stack's US hosting (Vercel/Fly primary regions)."
  type        = string
  default     = "aws-us-east-1"
}

variable "pg_version" {
  description = "Postgres major version."
  type        = number
  default     = 16
}

variable "history_retention_seconds" {
  description = "Neon point-in-time-recovery retention window, in seconds. ADR-0016: 604800 (7 days) for production, 86400 (1 day) for staging."
  type        = number
}

variable "autoscaling_min_cu" {
  description = "Minimum autoscaling compute units for the project's default branch endpoint. ADR-0016: 0.5 for production, 0.25 (fixed, equal to max) for staging."
  type        = number
}

variable "autoscaling_max_cu" {
  description = "Maximum autoscaling compute units for the project's default branch endpoint. ADR-0016: 4 for production, 0.25 (fixed, equal to min) for staging."
  type        = number
}

variable "suspend_timeout_seconds" {
  description = "How long the default branch's compute endpoint can sit idle before Neon suspends it. 0 disables scale-to-zero (kept on for production so cold-start latency never hits a real request); left at Neon's default (300s) for cost-sensitive staging/dr-drill unless overridden."
  type        = number
  default     = null
}
