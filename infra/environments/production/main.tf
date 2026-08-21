/**
 * Production infrastructure root module — ADR-0016 Implementation Notes:
 * "Terraform root modules: infra/environments/{production,staging}/main.tf,
 * each composing shared modules from
 * infra/modules/{vercel-project,neon-project,cloudflare-stack,fly-worker}."
 *
 * This environment has none of the credentials (VERCEL_API_TOKEN,
 * CLOUDFLARE_API_TOKEN, NEON_API_KEY, FLY_API_TOKEN,
 * OP_SERVICE_ACCOUNT_TOKEN) this root module's providers need — only
 * `terraform validate` (HCL/schema correctness, no credentials required)
 * has been run against it here, never `terraform plan`/`apply`. See the
 * per-module comments in each of
 * infra/modules/{vercel-project,neon-project,cloudflare-stack,fly-worker}
 * for the same note scoped to each provider.
 */

terraform {
  required_version = ">= 1.9"

  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 1.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.15"
    }
    onepassword = {
      source  = "1Password/onepassword"
      version = "~> 2.0"
    }
  }

  # Terraform Cloud remote backend — ADR-0016's secrets-management section
  # names a "Terraform Cloud token" among the CI-only GitHub Actions
  # secrets. No real Terraform Cloud organization/workspace has ever been
  # created for this project; this block is written for structural
  # correctness only. `terraform init -backend=false` (used to run
  # `terraform validate` in this environment) skips backend
  # initialization entirely, so this block has never actually been
  # exercised here.
  cloud {
    organization = "agentics-foundation"
    workspaces {
      name = "volunteer-portal-production"
    }
  }
}

# Each provider below reads its credential from the environment variable
# it supports natively (VERCEL_API_TOKEN, CLOUDFLARE_API_TOKEN,
# NEON_API_KEY, OP_SERVICE_ACCOUNT_TOKEN) rather than a Terraform variable,
# per ADR-0016: those are CI-only credentials held as encrypted GitHub
# Actions repository secrets (provider auth), distinct from the
# *application* secret values looked up from 1Password in secrets.tf.
provider "vercel" {}
provider "cloudflare" {}
provider "neon" {}
provider "onepassword" {}

locals {
  environment = "production"

  # vercel_project_environment_variable.target: "production" deployments
  # only, per ADR-0016's topology table (production = main branch).
  vercel_env_target = ["production"]
}

module "neon" {
  source = "../../modules/neon-project"

  project_name = "agentics-volunteer-portal-production"
  environment  = local.environment

  # ADR-0016 Implementation Notes.
  history_retention_seconds = 604800 # 7 days
  autoscaling_min_cu        = 0.5
  autoscaling_max_cu        = 4
  suspend_timeout_seconds   = 0 # never scale to zero in production
}

module "cloudflare" {
  source = "../../modules/cloudflare-stack"

  account_id  = var.cloudflare_account_id
  environment = local.environment
  subdomain   = "volunteer"

  bucket_suffix        = ""
  create_backup_bucket = true
}

module "vercel" {
  source = "../../modules/vercel-project"

  project_name      = "agentics-volunteer-portal-production"
  git_repo          = var.git_repo
  production_branch = "main"
  custom_domain     = "volunteer.agentics.org"

  environment_variables = local.vercel_env_vars
}

module "fly_worker" {
  source = "../../modules/fly-worker"

  app_name             = "agentics-worker-prod"
  environment          = local.environment
  fly_org              = var.fly_org
  min_machines_running = 2 # HA, per ADR-0016

  enable_backup_machine = true
  r2_backup_bucket_name = module.cloudflare.backup_bucket_name

  secrets = local.fly_secrets
}
