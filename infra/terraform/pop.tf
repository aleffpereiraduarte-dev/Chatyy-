# infra/terraform/pop.tf
#
# `module.pops` — one entry per PoP. Each PoP runs the full stack
# (livekit-sfu + coturn + nginx-ws + pg-replica + node-exporter) because
# CPX21 has plenty of headroom (see §7 in 05-multi-pop-infra.md). The `roles`
# list is informational and surfaces into the Ansible inventory so role-level
# scale-out (e.g. dedicating a beefy node to LiveKit only) is one-line later.
#
# Adding a PoP:
#   1. Append a new key under `locals.pops` below (e.g. `tyo = {...}`).
#   2. Run scripts/pop-add.sh <name>.
#
# Removing a PoP:
#   1. Comment out the entry. terraform apply destroys infra. ALWAYS run
#      scripts/pop-drain.sh first (≥10 min before destroy) so live sessions
#      migrate.

# ---------------------------------------------------------------------------
# PoP catalogue
# ---------------------------------------------------------------------------
#
# Hetzner regions:
#   fsn1 = Falkenstein, DE
#   nbg1 = Nuremberg, DE
#   hel1 = Helsinki, FI
#   ash  = Ashburn, VA (US east)
#   hil  = Hillsboro, OR (US west)
#   sin  = Singapore
#
# Cost: every entry below is Hetzner CPX21 at €5.83/mo ≈ $6.30/mo, so 3 PoPs
# cost ~$19/mo of compute. Egress is 20 TB/mo included per CPX21 (Hetzner
# pools across all servers in the same project), well above our projected
# 2.5 TB at 5k MAU.

locals {
  pops = {
    # Enable a PoP by uncommenting + running scripts/pop-add.sh <name>.

    # frankfurt = {
    #   provider = "hcloud"
    #   region   = "fsn1"
    #   size     = "cpx21"
    #   roles    = ["livekit-sfu", "coturn", "nginx-ws", "pg-replica"]
    #   wg_ip    = "10.88.0.10"
    #   dns_host = "fra"   # turn-fra.chatyy.com.br, ws-fra.chatyy.com.br
    # }
    # ashburn = {
    #   provider = "hcloud"
    #   region   = "ash"
    #   size     = "cpx21"
    #   roles    = ["livekit-sfu", "coturn", "nginx-ws", "pg-replica"]
    #   wg_ip    = "10.88.0.20"
    #   dns_host = "iad"
    # }
    # saopaulo = {
    #   provider = "vultr"          # No Hetzner SP — see §1 of design doc.
    #   region   = "sao"
    #   size     = "vc2-2c-4gb"
    #   roles    = ["livekit-sfu", "coturn", "nginx-ws", "pg-replica"]
    #   wg_ip    = "10.88.0.30"
    #   dns_host = "sao"
    # }
  }
}

# ---------------------------------------------------------------------------
# Module instantiation
# ---------------------------------------------------------------------------

module "pops" {
  source   = "./modules/pop"
  for_each = local.pops

  name                 = each.key
  region               = each.value.region
  size                 = each.value.size
  roles                = each.value.roles
  wg_ip                = each.value.wg_ip
  dns_host             = each.value.dns_host
  cloud_provider       = each.value.provider
  image                = var.default_image
  ssh_key_id           = length(hcloud_ssh_key.ops) > 0 ? hcloud_ssh_key.ops[0].id : null
  cloudflare_zone_id   = var.cloudflare_zone_id
  origin_ip            = var.origin_ip
  origin_wg_pubkey     = var.origin_wg_pubkey
  wg_subnet            = var.wg_subnet
}

# ---------------------------------------------------------------------------
# Module definition (inline so scaffolding ships as ONE PR — split into
# modules/pop/{main.tf,variables.tf,outputs.tf} as it grows).
# ---------------------------------------------------------------------------
#
# When you split this out, the directory layout should be:
#   infra/terraform/modules/pop/
#     main.tf         (resources)
#     variables.tf    (inputs)
#     outputs.tf      (ipv4, wg_ip)
#     cloud-init.tpl  (bootstrap user-data: docker, wireguard preconfig)
#
# Until then, the module skeleton below is meant to be COPIED into
# modules/pop/main.tf verbatim (terraform won't read it from this file).
#
# ┌─────────────────────────── COPY BELOW ───────────────────────────┐
# variable "name"               { type = string }
# variable "region"             { type = string }
# variable "size"               { type = string }
# variable "roles"              { type = list(string) }
# variable "wg_ip"              { type = string }
# variable "dns_host"           { type = string }
# variable "cloud_provider"     { type = string }   # "hcloud" or "vultr"
# variable "image"              { type = string }
# variable "ssh_key_id"         { type = string }
# variable "cloudflare_zone_id" { type = string }
# variable "origin_ip"          { type = string }
# variable "origin_wg_pubkey"   { type = string }
# variable "wg_subnet"          { type = string }
#
# resource "hcloud_server" "pop" {
#   count       = var.cloud_provider == "hcloud" ? 1 : 0
#   name        = "pop-${var.name}"
#   server_type = var.size
#   image       = var.image
#   location    = var.region
#   ssh_keys    = var.ssh_key_id != null ? [var.ssh_key_id] : []
#   labels = {
#     "chatyy.role"   = "pop"
#     "chatyy.region" = var.region
#     "chatyy.wg_ip"  = var.wg_ip
#   }
#   user_data = templatefile("${path.module}/cloud-init.tpl", {
#     hostname    = "pop-${var.name}"
#     wg_ip       = var.wg_ip
#     origin_ip   = var.origin_ip
#     origin_pub  = var.origin_wg_pubkey
#     wg_subnet   = var.wg_subnet
#   })
# }
#
# resource "vultr_instance" "pop" {
#   count             = var.cloud_provider == "vultr" ? 1 : 0
#   label             = "pop-${var.name}"
#   plan              = var.size
#   region            = var.region
#   os_id             = 2284              # Ubuntu 24.04
#   enable_ipv6       = true
#   activation_email  = false
#   user_data         = base64encode(templatefile("${path.module}/cloud-init.tpl", {
#     hostname   = "pop-${var.name}"
#     wg_ip      = var.wg_ip
#     origin_ip  = var.origin_ip
#     origin_pub = var.origin_wg_pubkey
#     wg_subnet  = var.wg_subnet
#   }))
# }
#
# locals {
#   ipv4 = var.cloud_provider == "hcloud" ?
#     try(hcloud_server.pop[0].ipv4_address, "") :
#     try(vultr_instance.pop[0].main_ip, "")
# }
#
# # ----- DNS records (grey-cloud = no CF proxy, UDP passes through) -----
# resource "cloudflare_record" "turn" {
#   count   = var.cloudflare_zone_id == "" ? 0 : 1
#   zone_id = var.cloudflare_zone_id
#   name    = "turn-${var.dns_host}"
#   type    = "A"
#   value   = local.ipv4
#   proxied = false
#   ttl     = 60
# }
# resource "cloudflare_record" "sfu" {
#   count   = var.cloudflare_zone_id == "" ? 0 : 1
#   zone_id = var.cloudflare_zone_id
#   name    = "sfu-${var.dns_host}"
#   type    = "A"
#   value   = local.ipv4
#   proxied = false
#   ttl     = 60
# }
# resource "cloudflare_record" "ws" {
#   count   = var.cloudflare_zone_id == "" ? 0 : 1
#   zone_id = var.cloudflare_zone_id
#   name    = "ws-${var.dns_host}"
#   type    = "A"
#   value   = local.ipv4
#   proxied = true   # WS terminates TLS at CF, fine for control plane
#   ttl     = 1
# }
#
# output "ipv4" { value = local.ipv4 }
# output "wg_ip" { value = var.wg_ip }
# output "roles" { value = var.roles }
# └─────────────────────────── COPY ABOVE ───────────────────────────┘
