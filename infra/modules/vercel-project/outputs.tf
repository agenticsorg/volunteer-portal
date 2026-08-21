output "project_id" {
  description = "Vercel project ID."
  value       = vercel_project.this.id
}

output "project_name" {
  value = vercel_project.this.name
}
