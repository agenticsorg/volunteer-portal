/**
 * Throwaway Neon project for the quarterly DR restore drill — ADR-0016
 * "Backup testing cadence" and Implementation Notes: "DR drill workflow
 * (.github/workflows/dr-drill.yml): creates a throwaway Neon project via
 * Terraform in a temporary workspace, restores the latest R2 backup
 * object into it, runs `pnpm test:integration` ... pointed at the
 * restored database's connection string as DATABASE_URL, tears down the
 * throwaway project."
 *
 * This root module exists only for that one workflow, which applies and
 * destroys it within a single CI job run — deliberately no `cloud`/remote
 * backend block, unlike infra/environments/{production,staging}: local
 * backend state (the default when no backend block is present) is enough
 * because this state never needs to survive past that one job, and using
 * a real Terraform Cloud workspace for a throwaway resource created and
 * destroyed dozens of times a year would just be state-management
 * overhead with no benefit.
 *
 * This environment has no NEON_API_KEY configured, so this module has
 * only ever been checked with `terraform validate`
 * (`terraform init -backend=false` first) — never `apply`/`destroy`.
 */

terraform {
  required_version = ">= 1.9"

  required_providers {
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.15"
    }
  }
}

provider "neon" {
  # NEON_API_KEY env var — the `NEON_API_KEY` GitHub Actions repository
  # secret named in .github/workflows/dr-drill.yml's top comment. Not
  # configured anywhere this module has actually been run.
}

variable "drill_id" {
  description = "Unique suffix for this drill run (the workflow passes the GitHub Actions run ID) so overlapping/concurrent drill runs never collide on Neon project name."
  type        = string
}

module "throwaway_db" {
  source = "../../modules/neon-project"

  project_name = "agentics-dr-drill-${var.drill_id}"
  environment  = "dr-drill"

  # This project lives for the duration of one CI job (minutes), so PITR
  # retention and autoscaling headroom are irrelevant beyond satisfying
  # the module's required variables — smallest practical values.
  history_retention_seconds = 86400
  autoscaling_min_cu        = 0.25
  autoscaling_max_cu        = 0.25
}

output "connection_uri" {
  description = "Connection string the workflow restores the latest backup into and then points `pnpm test:integration`'s DATABASE_URL at."
  value       = module.throwaway_db.connection_uri
  sensitive   = true
}
