variable "project_name" {
  description = "Vercel project name. Production and staging get separate Vercel projects (ADR-0016 Phase 10 build item 4: 'no shared resources between environments')."
  type        = string
}

variable "git_repo" {
  description = "GitHub repository in \"owner/repo\" form, connected for auto-deploy on push."
  type        = string
}

variable "production_branch" {
  description = "The branch that triggers a Production Deployment for this Vercel project. ADR-0016: \"main\" for the production project, \"staging\" for the staging project."
  type        = string
}

variable "root_directory" {
  description = "Monorepo subdirectory Vercel builds from."
  type        = string
  default     = "apps/web"
}

variable "framework" {
  type    = string
  default = "nextjs"
}

variable "custom_domain" {
  description = "Custom domain to attach to this project (e.g. volunteer.agentics.org or staging.volunteer.agentics.org). Null skips domain attachment."
  type        = string
  default     = null
}

variable "custom_domain_git_branch" {
  description = "If set, scopes the custom domain to deployments of this git branch rather than the project's production deployment (used for the staging domain, which should always reflect the staging branch)."
  type        = string
  default     = null
}

variable "environment_variables" {
  description = <<-EOT
    Environment variables to create via vercel_project_environment_variable
    (ADR-0016: "Terraform (vercel_project_environment_variable resource) so
    secret keys and their environment scoping are version-controlled even
    though values are not"). `value` is expected to come from a 1Password
    lookup (see infra/secrets.tf), never a literal in an environment's
    main.tf.
  EOT
  type = list(object({
    key        = string
    value      = string
    target     = set(string)
    git_branch = optional(string)
    sensitive  = optional(bool, true)
  }))
  default   = []
  sensitive = true
}
