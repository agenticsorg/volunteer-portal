/**
 * Vercel project — ADR-0016 "Decision" ("Vercel hosts the Next.js
 * application (App Router) across all environments") and Implementation
 * Notes ("Terraform root modules ... each composing shared modules from
 * infra/modules/{vercel-project,...}").
 *
 * This environment has no Vercel API token configured, so the "vercel"
 * provider (configured in each infra/environments/{production,staging}
 * root module) has never authenticated against a real Vercel account or
 * team here.
 */

terraform {
  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 1.0"
    }
  }
}

resource "vercel_project" "this" {
  name           = var.project_name
  framework      = var.framework
  root_directory = var.root_directory

  git_repository = {
    type              = "github"
    repo              = var.git_repo
    production_branch = var.production_branch
  }
}

resource "vercel_project_domain" "custom" {
  count = var.custom_domain != null ? 1 : 0

  project_id = vercel_project.this.id
  domain     = var.custom_domain
  git_branch = var.custom_domain_git_branch
}

resource "vercel_project_environment_variable" "this" {
  for_each = { for ev in var.environment_variables : ev.key => ev }

  project_id = vercel_project.this.id
  key        = each.value.key
  value      = each.value.value
  target     = each.value.target
  git_branch = each.value.git_branch
  sensitive  = each.value.sensitive
}
