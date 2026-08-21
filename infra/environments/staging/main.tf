/**
 * Staging infrastructure root module — ADR-0016 Implementation Notes:
 * "Terraform root modules: infra/environments/{production,staging}/main.tf,
 * each composing shared modules from
 * infra/modules/{vercel-project,neon-project,cloudflare-stack,fly-worker}."
 *
 * Staging is a fully separate Neon *project* and a fully separate Vercel
 * project/Fly app/Cloudflare bucket set from production (ADR-0016
 * Environment Topology: "so that production's backup policy, compute
 * autoscaling limits, and IP allowlisting are independently configured
 * and staging activity can never contend for production compute").
 *
 * This environment has none of the credentials (VERCEL_API_TOKEN,
 * CLOUDFLARE_API_TOKEN, NEON_API_KEY, FLY_API_TOKEN,
 * OP_SERVICE_ACCOUNT_TOKEN) this root module's providers need — only
 * `terraform validate` (HCL/schema correctness, no credentials required)
 * has been run against it here, never `terraform plan`/`apply`.
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

  # See infra/environments/production/main.tf's identical note: no real
  # Terraform Cloud workspace exists for this project, this block has
  # never been exercised (terraform init -backend=false skips it).
  cloud {
    organization = "agentics-foundation"
    workspaces {
      name = "volunteer-portal-staging"
    }
  }
}

provider "vercel" {}
provider "cloudflare" {}
provider "neon" {}
provider "onepassword" {}

locals {
  environment = "staging"

  # vercel_project_environment_variable.target: staging deploys as a
  # Vercel "preview" environment scoped to the `staging` git branch (per
  # ADR-0016's topology table: "staging branch, staging.volunteer.agentics.org"),
  # not Vercel's "production" target — that's reserved for the separate
  # production Vercel project.
  vercel_env_target = ["preview"]
}

module "neon" {
  source = "../../modules/neon-project"

  project_name = "agentics-volunteer-portal-staging"
  environment  = local.environment

  # ADR-0016 Implementation Notes: 1-day PITR retention, fixed 0.25 CU
  # (min == max, no autoscaling) to control cost — staging data is
  # synthetic and reproducible from seed scripts.
  history_retention_seconds = 86400
  autoscaling_min_cu        = 0.25
  autoscaling_max_cu        = 0.25
}

module "cloudflare" {
  source = "../../modules/cloudflare-stack"

  account_id  = var.cloudflare_account_id
  environment = local.environment
  subdomain   = "staging.volunteer"

  bucket_suffix        = "-staging"
  create_backup_bucket = false # production only, per ADR-0016
}

module "vercel" {
  source = "../../modules/vercel-project"

  project_name             = "agentics-volunteer-portal-staging"
  git_repo                 = var.git_repo
  production_branch        = "staging"
  custom_domain            = "staging.volunteer.agentics.org"
  custom_domain_git_branch = "staging"

  environment_variables = local.vercel_env_vars
}

module "fly_worker" {
  source = "../../modules/fly-worker"

  app_name             = "agentics-worker-staging"
  environment          = local.environment
  fly_org              = var.fly_org
  min_machines_running = 1 # no HA needed for staging, per ADR-0016

  enable_backup_machine = false # production only, per ADR-0016

  secrets = local.fly_secrets
}
