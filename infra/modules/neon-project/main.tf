/**
 * Neon (managed Postgres) project — ADR-0016 "Decision" (Neon is the
 * managed Postgres provider for all environments) and Implementation
 * Notes ("infra/modules/neon-project/main.tf uses the kislerdm/neon
 * provider's neon_project resource with history_retention_seconds ...
 * and a neon_branch resource for each project's default branch with
 * autoscaling min_cu/max_cu set per environment").
 *
 * Deviation from the ADR's literal Implementation Notes worth flagging:
 * the real kislerdm/neon provider (checked against v0.15.0's schema via
 * `terraform providers schema -json` in this environment) does not model
 * the default branch's compute autoscaling as a separate `neon_branch`
 * resource — `neon_branch` only has name/parent/protected attributes, no
 * compute settings. Autoscaling limits for a project's default branch
 * live on `neon_project` itself, via the nested `default_endpoint_settings`
 * block. This module uses that real shape instead of the ADR sketch's
 * `neon_branch` resource, which would not have anywhere to put
 * `autoscaling_limit_min_cu`/`max_cu` in the actual provider schema.
 *
 * This environment has no NEON_API_KEY configured, so the "neon" provider
 * (configured in each infra/environments/{production,staging}/main.tf root
 * module) has never authenticated against a real Neon account here - see
 * this module's use in infra/environments/production and
 * infra/environments/staging for that provider block and its own
 * "never applied here" note.
 */

terraform {
  required_providers {
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.15"
    }
  }
}

resource "neon_project" "this" {
  name       = var.project_name
  region_id  = var.region_id
  pg_version = var.pg_version

  history_retention_seconds = var.history_retention_seconds

  # store_password/block_public_connections/etc. are modeled as tri-state
  # strings by this provider version rather than native bool, per its
  # schema (store_password accepts only "yes"/"no"/"" - confirmed via
  # `terraform validate`, which rejects "true"/"false" here) - not a typo.
  store_password = "yes"

  default_endpoint_settings {
    autoscaling_limit_min_cu = var.autoscaling_min_cu
    autoscaling_limit_max_cu = var.autoscaling_max_cu

    suspend_timeout_seconds = var.suspend_timeout_seconds
  }
}
