#!/usr/bin/env bash
# scripts/pop-list.sh — show all PoPs + their health.
#
# Reads the Ansible inventory (single source of truth for what's deployed),
# then for each PoP:
#   - ICMP ping (over public Internet from this box)
#   - Ping over WireGuard tunnel (to PoP's wg_ip — proves tunnel is up)
#   - LK SFU HTTP /healthz reachable over WG
#   - PG replica lag (SELECT EXTRACT(EPOCH FROM now()-pg_last_xact_replay_timestamp()))
#
# Output is one line per PoP, color-coded (green=ok, yellow=warn, red=fail).
#
# Requires: ssh access to origin (10.88.0.1) OR running from origin itself
# so that WG-internal probes work.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INV="$ROOT/infra/ansible/inventory/hosts.yml"

if [[ ! -f "$INV" ]]; then
  echo "ERROR: inventory not found at $INV" >&2
  echo "       Run scripts/pop-add.sh <region> first." >&2
  exit 1
fi

# Pull list of PoPs from the YAML inventory.
pops_json="$(python3 - "$INV" <<'PY'
import sys, yaml, json, pathlib
inv = yaml.safe_load(pathlib.Path(sys.argv[1]).read_text()) or {}
hosts = inv.get("all",{}).get("children",{}).get("pops",{}).get("hosts",{}) or {}
out = []
for name, meta in hosts.items():
    out.append({
        "name":   name,
        "ip":     meta.get("ansible_host"),
        "wg_ip":  meta.get("wg_ip"),
        "dns":    meta.get("dns_host"),
        "roles":  meta.get("roles", []),
    })
print(json.dumps(out))
PY
)"

if [[ "$pops_json" == "[]" ]]; then
  echo "(no PoPs deployed yet)"
  exit 0
fi

# ANSI colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { printf "${GREEN}%s${NC}" "$1"; }
warn() { printf "${YELLOW}%s${NC}" "$1"; }
bad()  { printf "${RED}%s${NC}" "$1"; }

printf "%-18s %-16s %-12s %-9s %-9s %-9s %-9s %s\n" \
  POP PUBLIC_IP WG_IP PING_PUB PING_WG LK_API PG_LAG ROLES
echo "------------------------------------------------------------------------------------------------"

# Probe one PoP. Echoes a single row.
probe_one() {
  local name="$1" ip="$2" wg="$3" dns="$4" roles="$5"

  # Public ICMP
  local ping_pub
  if ping -c1 -W2 -q "$ip" >/dev/null 2>&1; then
    ping_pub="$(ping -c2 -W2 -q "$ip" 2>/dev/null | awk -F'/' '/^rtt/ {printf "%dms",$5}')"
  else
    ping_pub="DOWN"
  fi

  # WG ICMP — works only if we're on origin or have WG locally
  local ping_wg
  if ping -c1 -W2 -q "$wg" >/dev/null 2>&1; then
    ping_wg="$(ping -c2 -W2 -q "$wg" 2>/dev/null | awk -F'/' '/^rtt/ {printf "%dms",$5}')"
  else
    ping_wg="DOWN"
  fi

  # LK API /healthz
  local lk
  if curl -fsS --max-time 3 "http://$wg:7880/" >/dev/null 2>&1; then
    lk="OK"
  else
    lk="DOWN"
  fi

  # PG replica lag (psql over WG; needs PGPASSWORD)
  local lag
  if command -v psql >/dev/null 2>&1 && [[ -n "${PG_REPLICA_PASSWORD:-}" ]]; then
    lag="$(PGPASSWORD="$PG_REPLICA_PASSWORD" psql -h "$wg" -U replicator -d chatyy_main -tAc \
            "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())),0)::int" \
            2>/dev/null || echo ERR)"
    if [[ "$lag" =~ ^[0-9]+$ ]]; then lag="${lag}s"; fi
  else
    lag="n/a"
  fi

  # Color flags
  local ping_pub_disp ping_wg_disp lk_disp lag_disp
  case "$ping_pub" in DOWN) ping_pub_disp="$(bad DOWN)";; *) ping_pub_disp="$(ok "$ping_pub")";; esac
  case "$ping_wg"  in DOWN) ping_wg_disp="$(bad DOWN)";;  *) ping_wg_disp="$(ok "$ping_wg")";; esac
  case "$lk"       in OK)   lk_disp="$(ok OK)";;          *) lk_disp="$(bad DOWN)";; esac
  case "$lag" in
    n/a|ERR) lag_disp="$(warn "$lag")";;
    *) n="${lag%s}"; if [[ "$n" -gt 5 ]]; then lag_disp="$(bad "$lag")"
       elif [[ "$n" -gt 1 ]]; then lag_disp="$(warn "$lag")"
       else lag_disp="$(ok "$lag")"; fi;;
  esac

  printf "%-18s %-16s %-12s %-18b %-18b %-18b %-18b %s\n" \
    "$name" "$ip" "$wg" "$ping_pub_disp" "$ping_wg_disp" "$lk_disp" "$lag_disp" "$roles"
}

echo "$pops_json" | python3 -c "
import json, sys
for p in json.load(sys.stdin):
    print(f\"{p['name']}|{p['ip']}|{p['wg_ip']}|{p['dns']}|{','.join(p['roles'])}\")
" | while IFS='|' read -r name ip wg dns roles; do
  probe_one "$name" "$ip" "$wg" "$dns" "$roles"
done

echo
echo "Legend: PING_PUB = public ICMP, PING_WG = via WireGuard mesh,"
echo "        LK_API = LiveKit /healthz on :7880 over WG,"
echo "        PG_LAG = replica lag in seconds (target <1s)."
