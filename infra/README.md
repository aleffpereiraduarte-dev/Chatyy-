# Chatyy Multi-PoP Infrastructure

Phase-1 scaffolding for the multi-PoP buildout described in
[`docs/whatsapp-migration/05-multi-pop-infra.md`](../docs/whatsapp-migration/05-multi-pop-infra.md).

Origin (Contabo NY, `217.216.67.99`) stays the system of record. Each PoP is
a stateless edge running LiveKit SFU + coturn + nginx WS + a read-only PG
replica, joined to origin via a WireGuard mesh (`10.88.0.0/24`).

```
infra/
  terraform/
    main.tf            providers, vars, outputs
    pop.tf             catalogue of PoPs (one HCL block per PoP)
    modules/pop/       per-PoP resources (VM + DNS)
    envs/prod.tfvars.example
  ansible/
    ansible.cfg
    inventory/hosts.yml.example
    playbooks/bootstrap-pop.yml
    roles/
      pop-base/        ufw, fail2ban, node_exporter, unattended-upgrades
      wireguard/       mesh tunnel back to origin
      pg-replica/      streaming replica via pg_basebackup
      livekit-sfu/     SFU node tagged with region, redis=origin
      coturn/          STUN/TURN with LE cert via Cloudflare DNS-01
scripts/
  pop-add.sh           wraps terraform apply + ansible-playbook
  pop-list.sh          health overview (ping, LK, PG lag) for every PoP
```

## Quick start (adding the first PoP — Frankfurt)

This entire section is a runbook. Nothing executes until you run the
commands. Total wall time: ~12 minutes from the moment you say "go".

### 0. Prereqs

- Terraform ≥ 1.5  (`apt install terraform` from HashiCorp repo)
- Ansible ≥ 2.16  (`apt install ansible-core` + `ansible-galaxy collection install community.general`)
- `jq`, `yq`, `python3-yaml`
- SSH key authorized on origin `root@217.216.67.99` (you'll need this to
  register the PoP's WG pubkey)

### 1. One-time origin prep (do this BEFORE the first PoP)

```bash
ssh root@217.216.67.99

# WireGuard hub
apt install -y wireguard
umask 077
wg genkey | tee /etc/wireguard/wg0.key | wg pubkey > /etc/wireguard/wg0.pub
cat /etc/wireguard/wg0.pub      # <- paste into envs/prod.tfvars as origin_wg_pubkey

cat > /etc/wireguard/wg0.conf <<'EOF'
[Interface]
PrivateKey = $(cat /etc/wireguard/wg0.key)
Address    = 10.88.0.1/24
ListenPort = 51820
# Peers added dynamically as PoPs come online (see pop-add output)
EOF

systemctl enable --now wg-quick@wg0
ufw allow 51820/udp

# PostgreSQL: enable replication
sudo -u postgres psql <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'PICK_A_LONG_RANDOM_PASSWORD';
SELECT pg_create_physical_replication_slot('pop_frankfurt');
SELECT pg_create_physical_replication_slot('pop_ashburn');
SELECT pg_create_physical_replication_slot('pop_saopaulo');
SQL

# Edit /etc/postgresql/16/main/postgresql.conf:
#   wal_level = replica
#   max_wal_senders = 10
#   max_replication_slots = 10
#   wal_keep_size = 1024
#   listen_addresses = 'localhost,10.88.0.1'
#
# Edit /etc/postgresql/16/main/pg_hba.conf, add at top:
#   host replication replicator 10.88.0.0/24 scram-sha-256
#   host all         all        10.88.0.0/24 scram-sha-256
systemctl restart postgresql

# Redis: bind to WG IP so PoP LK nodes can join
# /etc/redis/redis.conf:
#   bind 127.0.0.1 10.88.0.1
#   protected-mode yes
systemctl restart redis-server
ufw allow from 10.88.0.0/24 to any port 6379
ufw allow from 10.88.0.0/24 to any port 5432
```

### 2. Fill in Terraform vars

```bash
cd infra/terraform
cp envs/prod.tfvars.example envs/prod.tfvars
$EDITOR envs/prod.tfvars     # paste hcloud_token, cloudflare token+zone_id,
                             # origin_wg_pubkey, ssh_pub_key
```

### 3. Enable the PoP in `pop.tf`

Edit `infra/terraform/pop.tf` and uncomment the `frankfurt = {…}` entry inside
`locals.pops`. (`scripts/pop-add.sh` will fail loudly if you forget.)

### 4. Run `pop-add.sh frankfurt`

```bash
# Source secrets — recommended via 1Password CLI:
#   eval $(op signin)
#   export HCLOUD_TOKEN=$(op read 'op://chatyy-infra/hetzner/token')
#   ...etc
export HCLOUD_TOKEN=...
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ZONE_ID=...
export ORIGIN_WG_PUBKEY=$(ssh root@217.216.67.99 cat /etc/wireguard/wg0.pub)
export PG_REPLICA_PASSWORD=...        # same as you set on origin in step 1
export LIVEKIT_API_KEY=$(ssh root@217.216.67.99 grep LIVEKIT_API_KEY /etc/mail-api.env | cut -d= -f2)
export LIVEKIT_API_SECRET=$(ssh root@217.216.67.99 grep LIVEKIT_API_SECRET /etc/mail-api.env | cut -d= -f2)
export TURN_SECRET=$(ssh root@217.216.67.99 grep ^TURN_SECRET /etc/mail-api.env | cut -d= -f2)

# Dry-run first (default):
scripts/pop-add.sh frankfurt

# When happy with the plan:
CHATYY_POP_APPLY=1 scripts/pop-add.sh frankfurt
```

Ansible will print the PoP's WireGuard pubkey near the end. Add it on origin:

```bash
ssh root@217.216.67.99
wg set wg0 peer <POP_PUBKEY> allowed-ips 10.88.0.10/32 persistent-keepalive 25
wg-quick save wg0
```

If `pop-add.sh` finished before you registered the peer, the PG replica step
will hang waiting for origin to be reachable. Register the peer, then re-run
`scripts/pop-add.sh frankfurt` (idempotent).

### 5. Manual follow-ups (one-time per PoP)

These steps are NOT yet automated by `pop-add.sh`. They're cheap to do once
and easy to forget, so the script prints them at the end.

1. **DNS A records.** `pop.tf` creates `turn-fra`, `sfu-fra`, `ws-fra` via the
   `cloudflare_record` resource. Verify in Cloudflare:
   - `turn-fra.chatyy.com.br` → PoP IP, grey-cloud, TTL 60
   - `sfu-fra.chatyy.com.br`  → PoP IP, grey-cloud, TTL 60
   - `ws-fra.chatyy.com.br`   → PoP IP, orange-cloud (CF proxy ok for WS)

2. **Cloudflare GeoSteering Worker.** Free tier:
   - Cloudflare → Workers & Pages → Create → "edge-pop"
   - Paste the code from §4 of `05-multi-pop-infra.md` (returns nearest PoP
     based on `request.cf.country`)
   - Route: `edge.chatyy.com.br/pop*`
   - For week 1 (Frankfurt only): set Worker to always return `pop-fra` for
     EU + AF countries, `pop-iad` for everything else (default to origin
     for fall-through until both PoPs are live)

3. **Backend env update.** On origin `/etc/mail-api.env`:
   ```
   LIVEKIT_NODES=10.88.0.1,10.88.0.10           # add WG IP of each PoP
   TURN_HOSTS=turn-fra.chatyy.com.br,turn-iad.chatyy.com.br
   ```
   Then `docker restart chatyy-php-fpm && systemctl restart chatyy-ws-cpp`.

4. **Smoke test.**
   ```bash
   # From origin, with PG_REPLICA_PASSWORD exported:
   scripts/pop-list.sh

   # Expect:
   #   pop-frankfurt  5.75.X.X   10.88.0.10   12ms   1ms   OK   0s   livekit-sfu,coturn,nginx-ws,pg-replica
   ```

## Cost

| PoP        | Provider | Plan      | Cost/mo |
|------------|----------|-----------|---------|
| frankfurt  | Hetzner  | CPX21     | €5.83 ≈ $6.30 |
| ashburn    | Hetzner  | CPX21     | €5.83 ≈ $6.30 |
| saopaulo   | Vultr    | vc2-2c-4gb| $24 |
| **3 PoPs total** | | | **~$37** + ~$5 egress headroom → **<$50/mo** ✓ |

## State backend

The Terraform state lives in `infra/terraform/terraform.tfstate` (local).
Migrate to R2 once a second operator is added:

```hcl
backend "s3" {
  bucket   = "chatyy-tfstate"
  key      = "multi-pop/terraform.tfstate"
  region   = "auto"
  endpoint = "https://<account>.r2.cloudflarestorage.com"
  ...
}
```

## Subnet collision check

Tailscale uses `100.64.0.0/10`. WireGuard mesh uses `10.88.0.0/24`. They are
disjoint. Verify on origin before flipping anything:

```bash
ip route | grep -E '(10\.88|100\.64)'
# expected: only Tailscale's 100.64.0.0/10 dev tailscale0
#           (10.88.x is added by wg-quick on `systemctl start wg-quick@wg0`)
```

If you see anything else claiming `10.88/24` (Hetzner internal nets sometimes
hand out `10.0.0.0/16` but never `10.88` — Vultr same), bump to `10.89.0.0/24`
in BOTH `infra/terraform/envs/prod.tfvars` and the role defaults, then re-run.

## Adding a 2nd / 3rd PoP

Identical to the first, minus the origin prep (already done). Run:

```bash
scripts/pop-add.sh ashburn
scripts/pop-add.sh saopaulo
```

Each new PoP gets a unique slot from the `default_map` in `pop-add.sh`
(frankfurt=.10, ashburn=.20, saopaulo=.30). Don't hand-edit `wg_ip` unless
you regen the slots in the script too.

## Tearing down

```bash
# Drain first (10 min before destroy so live sessions migrate).
ansible-playbook playbooks/drain.yml --limit pop-frankfurt   # NOT YET WRITTEN

# Then in pop.tf comment out the entry, and:
cd infra/terraform
terraform plan  -var-file=envs/prod.tfvars
terraform apply -var-file=envs/prod.tfvars
```

## What's intentionally NOT in this PR

- `roles/nginx-ws/`  (will reuse origin's chatyy-ws-cpp + nginx; trivial copy)
- `roles/monitoring/` (blackbox-exporter probes — once PoPs are healthy)
- `playbooks/drain.yml`, `playbooks/rollout.yml`
- Vultr provider wiring beyond the schema stub (São Paulo is week-3)
- Automated origin WG peer registration (currently manual)

See `docs/whatsapp-migration/05-multi-pop-infra.md` §10 for the full plan.
