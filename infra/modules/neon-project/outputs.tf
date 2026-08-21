output "project_id" {
  description = "Neon project ID."
  value       = neon_project.this.id
}

output "default_branch_id" {
  description = "ID of the project's default branch."
  value       = neon_project.this.default_branch_id
}

output "connection_uri" {
  description = "Pooled connection URI for the default branch/database — this is the value that becomes DATABASE_URL for the Next.js app (Vercel) and the graphile-worker process (Fly.io)."
  value       = neon_project.this.connection_uri_pooler
  sensitive   = true
}

output "database_host" {
  description = "Direct (non-pooled) database host, for tooling that needs a direct connection (e.g. migrations)."
  value       = neon_project.this.database_host
  sensitive   = true
}
