output "app_name" {
  value = var.app_name
}

output "fly_toml_path" {
  value = local_file.fly_toml.filename
}
