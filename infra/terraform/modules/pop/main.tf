# infra/terraform/modules/pop/main.tf
#
# Per-PoP resources. Instantiated once per entry in `local.pops` (see
# ../../pop.tf). Each PoP becomes:
#   - one VM (Hetzner or Vultr)
#   - three DNS A records (turn-<host>, sfu-<host>, ws-<host>)
#
# The VM boots from cloud-init.tpl, which installs Docker, WireGuard, and
# enough scaffolding for Ansible to take over via SSH within ~90 s.

terraform {
  required_providers {
    hcloud     = { source = "hetznercloud/hcloud" }
    vultr      = { source = "vultr/vultr" }
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

variable "name"               { type = string }
variable "region"             { type = string }
variable "size"               { type = string }
variable "roles"              { type = list(string) }
variable "wg_ip"              { type = string }
variable "dns_host"           { type = string }
variable "cloud_provider"     { type = string }
variable "image"              { type = string }
variable "ssh_key_id"         { type = string
                                default = null }
variable "cloudflare_zone_id" { type = string }
variable "origin_ip"          { type = string }
variable "origin_wg_pubkey"   { type = string }
variable "wg_subnet"          { type = string }

# ---------------------------------------------------------------------------
# VM
# ---------------------------------------------------------------------------

resource "hcloud_server" "pop" {
  count       = var.cloud_provider == "hcloud" ? 1 : 0
  name        = "pop-${var.name}"
  server_type = var.size
  image       = var.image
  location    = var.region
  ssh_keys    = var.ssh_key_id != null ? [var.ssh_key_id] : []
  labels = {
    "chatyy.role"   = "pop"
    "chatyy.region" = var.region
    "chatyy.wg_ip"  = var.wg_ip
  }
  user_data = templatefile("${path.module}/cloud-init.tpl", {
    hostname   = "pop-${var.name}"
    wg_ip      = var.wg_ip
    origin_ip  = var.origin_ip
    origin_pub = var.origin_wg_pubkey
    wg_subnet  = var.wg_subnet
  })
}

resource "vultr_instance" "pop" {
  count            = var.cloud_provider == "vultr" ? 1 : 0
  label            = "pop-${var.name}"
  plan             = var.size
  region           = var.region
  os_id            = 2284 # Ubuntu 24.04 LTS
  enable_ipv6      = true
  activation_email = false
  user_data = base64encode(templatefile("${path.module}/cloud-init.tpl", {
    hostname   = "pop-${var.name}"
    wg_ip      = var.wg_ip
    origin_ip  = var.origin_ip
    origin_pub = var.origin_wg_pubkey
    wg_subnet  = var.wg_subnet
  }))
}

locals {
  ipv4 = var.cloud_provider == "hcloud" ? try(hcloud_server.pop[0].ipv4_address, "") : try(vultr_instance.pop[0].main_ip, "")
}

# ---------------------------------------------------------------------------
# DNS (grey-cloud for turn/sfu — UDP must bypass Cloudflare proxy)
# ---------------------------------------------------------------------------

resource "cloudflare_record" "turn" {
  count   = var.cloudflare_zone_id == "" ? 0 : 1
  zone_id = var.cloudflare_zone_id
  name    = "turn-${var.dns_host}"
  type    = "A"
  value   = local.ipv4
  proxied = false
  ttl     = 60
}

resource "cloudflare_record" "sfu" {
  count   = var.cloudflare_zone_id == "" ? 0 : 1
  zone_id = var.cloudflare_zone_id
  name    = "sfu-${var.dns_host}"
  type    = "A"
  value   = local.ipv4
  proxied = false
  ttl     = 60
}

resource "cloudflare_record" "ws" {
  count   = var.cloudflare_zone_id == "" ? 0 : 1
  zone_id = var.cloudflare_zone_id
  name    = "ws-${var.dns_host}"
  type    = "A"
  value   = local.ipv4
  proxied = true # WS over CF is fine for control plane
  ttl     = 1
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "ipv4"  { value = local.ipv4 }
output "wg_ip" { value = var.wg_ip }
output "roles" { value = var.roles }
output "name"  { value = var.name }
