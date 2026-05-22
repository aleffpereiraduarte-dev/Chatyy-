#!/usr/bin/env bash
# scripts/pop-add.sh — bootstrap a new Point of Presence end-to-end.
#
# Usage:
#   scripts/pop-add.sh <region>
#
# Examples:
#   scripts/pop-add.sh frankfurt
#   scripts/pop-add.sh ashburn
#
# What it does:
#   1. Sanity-checks env (HCLOUD_TOKEN, SSH key, etc.)
#   2. Ensures the region is enabled in infra/terraform/pop.tf
#   3. terraform plan + apply (creates VM + DNS records)
#   4. Writes infra/ansible/inventory/hosts.yml from terraform output
#   5. Runs infra/ansible/playbooks/bootstrap-pop.yml --limit pop-<region>
#   6. Prints the WireGuard pubkey to register on origin (217.216.67.99)
#
# Idempotent: re-running on an existing PoP is a no-op until cloud config
# drifts; ansible just verifies state.
#
# Code only — set CHATYY_POP_APPLY=1 to actually run terraform/ansible.

set -euo pipefail

REGION="${1:-}"
if [[ -z "$REGION" ]]; then
  echo "usage: $0 <region>"
  echo "available regions:"
  echo "  frankfurt  (Hetzner CPX21, fsn1)   ~\$7/mo"
  echo "  ashburn    (Hetzner CPX21, ash)    ~\$7/mo"
  echo "  saopaulo   (Vultr 2c/4g, sao)      ~\$24/mo (only SP option)"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$ROOT/infra/terraform"
ANS_DIR="$ROOT/infra/ansible"

echo "==> pop-add: region=$REGION"

# ---------------------------------------------------------------------------
# 1. Env sanity
# ---------------------------------------------------------------------------

require_env() {
  if [[ -z "${!1:-}" ]]; then
    echo "ERROR: env $1 not set." >&2
    return 1
  fi
}

MISSING=0
require_env HCLOUD_TOKEN          || MISSING=1
require_env CLOUDFLARE_API_TOKEN  || MISSING=1
require_env CLOUDFLARE_ZONE_ID    || MISSING=1
require_env ORIGIN_WG_PUBKEY      || MISSING=1
require_env PG_REPLICA_PASSWORD   || MISSING=1
require_env LIVEKIT_API_KEY       || MISSING=1
require_env LIVEKIT_API_SECRET    || MISSING=1
require_env TURN_SECRET           || MISSING=1
if [[ "$REGION" == "saopaulo" ]]; then
  require_env VULTR_API_KEY || MISSING=1
fi
if [[ "$MISSING" == "1" ]]; then
  echo
  echo "Fill missing envs and re-run. Suggested source: 1Password 'chatyy-infra' item." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 2. Check region is enabled in terraform
# ---------------------------------------------------------------------------

if ! grep -q "^    $REGION = {" "$TF_DIR/pop.tf"; then
  echo "ERROR: region '$REGION' not enabled in $TF_DIR/pop.tf." >&2
  echo "       Uncomment the relevant block in locals.pops, then re-run." >&2
  exit 3
fi

# ---------------------------------------------------------------------------
# 3. Terraform
# ---------------------------------------------------------------------------

cd "$TF_DIR"

if [[ ! -d .terraform ]]; then
  echo "==> terraform init"
  terraform init -input=false
fi

echo "==> terraform plan (region=$REGION)"
terraform plan \
  -var-file=envs/prod.tfvars \
  -var="hcloud_token=$HCLOUD_TOKEN" \
  -var="vultr_api_key=${VULTR_API_KEY:-}" \
  -var="cloudflare_api_token=$CLOUDFLARE_API_TOKEN" \
  -var="cloudflare_zone_id=$CLOUDFLARE_ZONE_ID" \
  -var="origin_wg_pubkey=$ORIGIN_WG_PUBKEY" \
  -target="module.pops[\"$REGION\"]" \
  -out=/tmp/tfplan-$REGION

if [[ "${CHATYY_POP_APPLY:-0}" != "1" ]]; then
  echo
  echo "==> Dry-run complete. Review the plan above."
  echo "    Re-run with CHATYY_POP_APPLY=1 to apply."
  echo "    e.g.  CHATYY_POP_APPLY=1 $0 $REGION"
  exit 0
fi

echo "==> terraform apply"
terraform apply -input=false /tmp/tfplan-$REGION

# ---------------------------------------------------------------------------
# 4. Build Ansible inventory from terraform output
# ---------------------------------------------------------------------------

POP_IP="$(terraform output -json pop_inventory | jq -r ".\"$REGION\"")"
if [[ -z "$POP_IP" || "$POP_IP" == "null" ]]; then
  echo "ERROR: terraform did not surface IP for $REGION." >&2
  exit 4
fi

INV="$ANS_DIR/inventory/hosts.yml"
mkdir -p "$(dirname "$INV")"
if [[ ! -f "$INV" ]]; then
  cp "$ANS_DIR/inventory/hosts.yml.example" "$INV"
fi

python3 - "$INV" "$REGION" "$POP_IP" <<'PY'
import sys, yaml, pathlib
inv_path, region, ip = sys.argv[1], sys.argv[2], sys.argv[3]
inv = yaml.safe_load(pathlib.Path(inv_path).read_text()) or {}
pops_node = inv.setdefault("all", {}).setdefault("children", {}).setdefault("pops", {})
hosts = pops_node.setdefault("hosts", {}) or {}
# wg_ip allocation: pop-X uses 10.88.0.<10+index*10> matching pop.tf defaults
default_map = {"frankfurt": 10, "ashburn": 20, "saopaulo": 30}
wg_last = default_map.get(region, 40 + 10*len(hosts))
hosts[f"pop-{region}"] = {
    "ansible_host": ip,
    "wg_ip":  f"10.88.0.{wg_last}",
    "dns_host": {"frankfurt": "fra", "ashburn": "iad", "saopaulo": "sao"}.get(region, region[:3]),
    "roles":  ["livekit-sfu", "coturn", "nginx-ws", "pg-replica"],
}
pops_node["hosts"] = hosts
pathlib.Path(inv_path).write_text(yaml.safe_dump(inv, sort_keys=False))
print(f"wrote inventory entry pop-{region} -> {ip}")
PY

# ---------------------------------------------------------------------------
# 5. Ansible
# ---------------------------------------------------------------------------

echo "==> Waiting 30s for cloud-init / SSHd to come up..."
sleep 30

cd "$ANS_DIR"
echo "==> ansible-playbook bootstrap-pop.yml --limit pop-$REGION"
ansible-playbook \
  -i inventory/hosts.yml \
  playbooks/bootstrap-pop.yml \
  --limit "pop-$REGION" \
  --extra-vars "pg_replica_password=$PG_REPLICA_PASSWORD \
                livekit_api_key=$LIVEKIT_API_KEY \
                livekit_api_secret=$LIVEKIT_API_SECRET \
                turn_static_secret=$TURN_SECRET \
                cloudflare_api_token=$CLOUDFLARE_API_TOKEN"

echo
echo "============================================================"
echo "pop-$REGION provisioned."
echo "Remaining manual steps:"
echo "  1. Copy the WG pubkey printed above and register it on origin:"
echo "       ssh root@217.216.67.99"
echo "       wg set wg0 peer <POP_PUBKEY> allowed-ips <WG_IP>/32 persistent-keepalive 25"
echo "       wg-quick save wg0"
echo "  2. Add Cloudflare Worker route for region -> pop-$REGION at edge.chatyy.com.br/pop"
echo "  3. Verify health: scripts/pop-list.sh"
echo "============================================================"
