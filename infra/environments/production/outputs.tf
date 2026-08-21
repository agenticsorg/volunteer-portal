output "vercel_project_id" {
  value = module.vercel.project_id
}

output "neon_project_id" {
  value = module.neon.project_id
}

output "fly_app_name" {
  value = module.fly_worker.app_name
}

output "app_hostname" {
  value = module.cloudflare.app_hostname
}
