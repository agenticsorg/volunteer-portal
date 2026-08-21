/**
 * 1Password secret lookups — ADR-0016 "Secrets management" and
 * Implementation Notes: "1Password Terraform provider: infra/secrets.tf
 * declares data \"onepassword_item\" lookups feeding
 * vercel_project_environment_variable.value and cloudflare_... resource
 * secret fields, so terraform plan/apply in CI runs under
 * `op run --env-file=... -- terraform apply` with a 1Password Service
 * Account token supplied as the only long-lived credential CI itself
 * needs to hold."
 *
 * This file is identical for infra/environments/production and
 * infra/environments/staging (symlinked into both directories rather than
 * duplicated - run `ls -la` in either directory to confirm); each root
 * module's own main.tf sets `local.environment` ("production" |
 * "staging"), which every lookup below interpolates into the 1Password
 * item title so the same file resolves to that environment's own secret
 * values.
 *
 * The vault name ("Volunteer Portal") and the item title pattern below
 * ("<Secret> - <Environment>") are this repo's *assumed* convention, not
 * a confirmed fact about the org's real 1Password vault — whoever has
 * access to the Agentics Foundation's 1Password account must confirm (and
 * correct, if different) the actual vault name and item titles/field
 * names before this file can be applied for real. This repo has no
 * 1Password access configured in any environment it has run in, so these
 * `data "onepassword_item"` lookups have never been resolved against a
 * real vault — `terraform validate` only confirms this file is
 * schema-valid HCL against the onepassword provider's resource schema, it
 * proves nothing about whether the referenced vault or items exist.
 */

data "onepassword_item" "database_url" {
  vault = "Volunteer Portal"
  title = "Neon Database URL - ${local.environment}"
}

data "onepassword_item" "supabase_auth_jwt_secret" {
  vault = "Volunteer Portal"
  title = "Supabase Auth JWT Secret - ${local.environment}"
}

data "onepassword_item" "resend_api_key" {
  vault = "Volunteer Portal"
  title = "Resend API Key - ${local.environment}"
}

data "onepassword_item" "cloudflare_stream_token" {
  vault = "Volunteer Portal"
  title = "Cloudflare Stream Token - ${local.environment}"
}

data "onepassword_item" "sentry_dsn" {
  vault = "Volunteer Portal"
  title = "Sentry DSN - ${local.environment}"
}

data "onepassword_item" "r2_s3_credentials" {
  vault = "Volunteer Portal"
  title = "R2 S3-Compatible Credentials - ${local.environment}"
}

locals {
  # Fed into module "vercel"'s environment_variables input
  # (vercel_project_environment_variable resources). `vercel_env_target`
  # is set per-environment in that environment's own main.tf (production
  # targets Vercel's "production" environment; staging targets "preview",
  # scoped to the staging git branch).
  vercel_env_vars = [
    {
      key    = "DATABASE_URL"
      value  = data.onepassword_item.database_url.password
      target = local.vercel_env_target
    },
    {
      key    = "SUPABASE_AUTH_JWT_SECRET"
      value  = data.onepassword_item.supabase_auth_jwt_secret.credential
      target = local.vercel_env_target
    },
    {
      key    = "RESEND_API_KEY"
      value  = data.onepassword_item.resend_api_key.credential
      target = local.vercel_env_target
    },
    {
      key    = "CLOUDFLARE_STREAM_TOKEN"
      value  = data.onepassword_item.cloudflare_stream_token.credential
      target = local.vercel_env_target
    },
    {
      key    = "SENTRY_DSN"
      value  = data.onepassword_item.sentry_dsn.credential
      target = local.vercel_env_target
    },
  ]

  # Fed into module "fly_worker"'s `secrets` input (`flyctl secrets set`).
  fly_secrets = {
    DATABASE_URL           = data.onepassword_item.database_url.password
    GRAPHILE_WORKER_SCHEMA = "graphile_worker"
    SENTRY_DSN             = data.onepassword_item.sentry_dsn.credential
    R2_ACCESS_KEY_ID       = data.onepassword_item.r2_s3_credentials.username
    R2_SECRET_ACCESS_KEY   = data.onepassword_item.r2_s3_credentials.credential
  }
}
