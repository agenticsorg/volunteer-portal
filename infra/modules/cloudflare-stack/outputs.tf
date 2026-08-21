output "zone_id" {
  value = data.cloudflare_zone.root.id
}

output "bucket_names" {
  value = local.bucket_names
}

output "backup_bucket_name" {
  description = "Name of the nightly-backup R2 bucket, or null when this environment doesn't have one (create_backup_bucket = false)."
  value       = var.create_backup_bucket ? cloudflare_r2_bucket.db_backups[0].name : null
}

output "app_hostname" {
  value = "${var.subdomain}.${var.zone_name}"
}
