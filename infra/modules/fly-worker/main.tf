/**
 * Fly.io worker app (graphile-worker's long-lived process) — ADR-0016
 * "Decision" ("the background worker (graphile-worker) running as a
 * separate long-lived Node process on Fly.io") and "Consequences /
 * Negative" ("some of the worker's infra is provisioned via
 * local-exec/flyctl shell-outs rather than pure declarative Terraform
 * resources ... accepted because no viable alternative keeps a persistent
 * polling worker process on Vercel's serverless model").
 *
 * This module deliberately uses `null_resource` + `local-exec` shelling
 * out to `flyctl` (the ADR's explicitly-accepted fallback), not the
 * `fly-apps/terraform-provider-fly` community provider - that provider's
 * resource coverage was not verified as mature/stable enough in this
 * environment to depend on for `terraform validate`, and the ADR itself
 * names the local-exec approach as the accepted trade-off rather than a
 * last resort.
 *
 * IMPORTANT: this environment has no `flyctl` authentication (no
 * FLY_API_TOKEN) and no real Fly.io organization. Every local-exec
 * command below would fail immediately on `terraform apply` here with an
 * auth error - which is correct, expected behavior. Only
 * `terraform validate` (HCL/schema correctness) has been run against this
 * module in this environment; `terraform apply` has never been attempted.
 */

terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

resource "local_file" "fly_toml" {
  filename = "${path.module}/generated/${var.app_name}.fly.toml"
  content = templatefile("${path.module}/templates/fly.toml.tftpl", {
    app_name       = var.app_name
    primary_region = var.primary_region
    vm_size        = var.vm_size
    environment    = var.environment
  })
}

resource "null_resource" "fly_app" {
  triggers = {
    fly_toml_sha256      = local_file.fly_toml.content_md5
    min_machines_running = tostring(var.min_machines_running)
  }

  # `flyctl apps create` is idempotent (no-ops if the app already exists);
  # `flyctl deploy` re-deploys on every apply, so this resource's plan
  # always shows as "will run" regardless of `triggers` - deliberate,
  # matching ADR-0016's accepted trade-off that this part of the topology
  # isn't purely declarative.
  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      flyctl apps create "${var.app_name}" --org "${var.fly_org}" || true
      flyctl deploy --config "${local_file.fly_toml.filename}" --app "${var.app_name}" --remote-only
      flyctl scale count "${var.min_machines_running}" --app "${var.app_name}" --yes
    EOT
  }
}

resource "null_resource" "fly_secrets" {
  triggers = {
    secrets_hash = md5(jsonencode(var.secrets))
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      flyctl secrets set ${join(" ", [for k, v in var.secrets : "${k}=${v}"])} --app "${var.app_name}"
    EOT
  }

  depends_on = [null_resource.fly_app]
}

resource "local_file" "backup_machine_toml" {
  count = var.enable_backup_machine ? 1 : 0

  filename = "${path.module}/generated/${var.app_name}-backup.fly.toml"
  content = templatefile("${path.module}/templates/backup-machine.toml.tftpl", {
    app_name       = var.app_name
    r2_bucket_name = var.r2_backup_bucket_name
  })
}

resource "null_resource" "backup_machine" {
  count = var.enable_backup_machine ? 1 : 0

  triggers = {
    backup_toml_sha256 = local_file.backup_machine_toml[0].content_md5
    schedule           = var.backup_schedule
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      flyctl machine run "${local_file.backup_machine_toml[0].filename}" \
        --app "${var.app_name}" \
        --schedule "${var.backup_schedule}" \
        --name "${var.app_name}-nightly-backup"
    EOT
  }

  depends_on = [null_resource.fly_app]
}
