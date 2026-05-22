# infra/terraform/main.tf
#
# Root Terraform configuration for the Chatyy multi-PoP infrastructure.
#
# This file declares providers (Hetzner Cloud primary, Vultr planned for São
# Paulo) and the global state backend. It deliberately does NOT call any
# resources directly — provisioning lives in pop.tf via the `pop` module so a
# new PoP is one HCL block change away.
#
# Usage (manual, never run from automation without review):
#
#   export HCLOUD_TOKEN="..."        # https://console.hetzner.cloud/projects -> Security -> API Tokens
#   export TF_VAR_ssh_pub_key="$(cat ~/.ssh/id_ed25519.pub)"
#   cd infra/terraform
#   terraform init
#   terraform plan  -var-file=envs/prod.tfvars
#   terraform apply -var-file=envs/prod.tfvars
#
# Cost target: <$8/mo per PoP using Hetzner CPX21 (3 vCPU / 4 GB / 80 GB).
# Three PoPs (fra, iad, plus optional sao on Vultr) fit comfortably under
# $50/mo total, matching the budget set in 05-multi-pop-infra.md §1.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
    # Vultr provider is declared but not instantiated yet — São Paulo is the
    # only Vultr PoP and we'll wire that in week 3 of the rollout.
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.21"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.30"
    }
  }

  # Local state for the bootstrap. Migrate to S3-compatible (R2) backend once
  # we have >1 operator. See infra/README.md §"State backend" before flipping.
  backend "local" {
    path = "terraform.tfstate"
  }
}

# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------

provider "hcloud" {
  # TODO: set HCLOUD_TOKEN env (Hetzner Cloud API token, scope = Read+Write).
  # Never commit the token. CI reads from GH Actions secret HCLOUD_TOKEN.
  token = var.hcloud_token
}

provider "vultr" {
  # TODO: set VULTR_API_KEY env when we add pop-sao.
  api_key = var.vultr_api_key
}

provider "cloudflare" {
  # TODO: set CLOUDFLARE_API_TOKEN env. Token scope:
  #   Zone -> DNS -> Edit  (zone: chatyy.com.br)
  #   Zone -> Zone -> Read (zone: chatyy.com.br)
  api_token = var.cloudflare_api_token
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "hcloud_token" {
  description = "Hetzner Cloud API token. Pass via TF_VAR_hcloud_token or env HCLOUD_TOKEN."
  type        = string
  sensitive   = true
  default     = "" # filled by env HCLOUD_TOKEN if blank
}

variable "vultr_api_key" {
  description = "Vultr API key (only needed for pop-sao)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token for DNS record management."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for chatyy.com.br."
  type        = string
  default     = "" # TODO: set in envs/prod.tfvars
}

variable "ssh_pub_key" {
  description = "SSH public key installed on every PoP for root login (Ansible will lock down later)."
  type        = string
  default     = ""
}

variable "origin_ip" {
  description = "Public IP of the origin (Contabo NY, PG master, WireGuard hub)."
  type        = string
  default     = "217.216.67.99"
}

variable "origin_wg_pubkey" {
  description = "WireGuard public key of the origin. Generate once with `wg genkey | tee priv | wg pubkey`."
  type        = string
  default     = "" # TODO: paste origin WG pubkey here (or in envs/prod.tfvars)
}

variable "wg_subnet" {
  description = "WireGuard mesh subnet. MUST NOT overlap with Tailscale (100.64/10) or any LAN."
  type        = string
  default     = "10.88.0.0/24"
}

variable "default_image" {
  description = "Hetzner image slug for new PoPs."
  type        = string
  default     = "ubuntu-24.04"
}

variable "default_size" {
  description = "Hetzner server type. CPX21 = 3 vCPU / 4 GB / 80 GB, €5.83/mo."
  type        = string
  default     = "cpx21"
}

# ---------------------------------------------------------------------------
# Shared resources (SSH key registration, labels)
# ---------------------------------------------------------------------------

resource "hcloud_ssh_key" "ops" {
  count      = var.ssh_pub_key == "" ? 0 : 1
  name       = "chatyy-ops"
  public_key = var.ssh_pub_key
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "pop_inventory" {
  description = "Map of PoP name -> public IPv4. Consumed by scripts/pop-add.sh to build Ansible inventory."
  value       = { for k, v in module.pops : k => v.ipv4 }
}

output "wg_subnet" {
  value = var.wg_subnet
}

output "origin_ip" {
  value = var.origin_ip
}
