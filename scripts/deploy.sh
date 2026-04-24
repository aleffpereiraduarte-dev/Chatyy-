#!/bin/bash
# Local deploy script — runs on prod server (69.62.103.131).
#
# Safer than bare rsync: excludes the backend directories that must never be
# touched by a frontend web deploy. See memory/rsync_deploy_critical.md for
# the incident that caused this script to exist.
#
# Usage:
#   cd /root/webmail-app && bash scripts/deploy.sh [--skip-ota] [--skip-web]
#
# Defaults: builds web, deploys to /var/www/mail/, publishes OTA.

set -euo pipefail

# Mutex — prevents two concurrent deploys from racing on dist/. Without
# this, the systemd timer and GitHub Actions would both run expo export
# at the same time; each one's `rm -rf dist` wipes the other's output
# mid-build (observed 2026-04-24: enhance-web.sh errored with "dist/
# index.html: No such file or directory" on parallel runs).
LOCK=/var/run/chatyy-deploy.lock
exec 9>"$LOCK" || { echo "cannot open $LOCK"; exit 3; }
if ! flock -n 9; then
  echo "==> Another deploy is running (locked on $LOCK). Exiting without redeploy."
  exit 0
fi

SKIP_OTA=0
SKIP_WEB=0
for arg in "$@"; do
  case "$arg" in
    --skip-ota) SKIP_OTA=1 ;;
    --skip-web) SKIP_WEB=1 ;;
  esac
done

cd "$(dirname "$0")/.."
echo "==> Working dir: $(pwd)"

# Fail-fast: make sure backend is actually where we expect — never run a
# deploy against an already-broken state (would mask the root cause).
for required in /var/www/mail/api/email.php /var/www/mail/data; do
  if [ ! -e "$required" ]; then
    echo "ERROR: $required missing — refusing to deploy. Restore from replica first:"
    echo "  rsync -avz -e 'ssh -o StrictHostKeyChecking=no' root@144.126.151.134:/var/www/mail/api/ /var/www/mail/api/"
    exit 1
  fi
done

if [ "$SKIP_WEB" = 0 ]; then
  echo "==> Building web bundle"
  rm -rf dist
  NODE_ENV=production npx expo export --platform web --clear 2>&1 | tail -5

  if [ -f scripts/enhance-web.sh ]; then
    echo "==> Enhancing web bundle (manifest, PWA meta, OG)"
    bash scripts/enhance-web.sh 2>&1 | tail -3
  fi

  echo "==> Rsync dist/ → /var/www/mail/ (with backend excludes)"
  rsync -avz --delete \
    --exclude='api/' \
    --exclude='meet/' \
    --exclude='data/' \
    --exclude='docs/' \
    --exclude='suporte/' \
    dist/ /var/www/mail/ 2>&1 | tail -3

  # Guardrail: if excludes were somehow missing, api/ would be gone. Bail.
  if [ ! -f /var/www/mail/api/email.php ]; then
    echo "ERROR: /var/www/mail/api/email.php disappeared after rsync — critical bug in deploy script"
    exit 2
  fi
  echo "==> Web deployed. Bundle: $(grep -oE 'entry-[a-f0-9]+\.js' /var/www/mail/index.html | head -1)"
fi

if [ "$SKIP_OTA" = 0 ]; then
  echo "==> Publishing OTA update"
  MSG=$(git log -1 --pretty=%s 2>/dev/null | tr -d '"' | head -c 200)
  [ -z "$MSG" ] && MSG="deploy.sh auto-publish"
  npx eas-cli update \
    --branch production \
    --environment production \
    --message "$MSG" \
    --non-interactive 2>&1 | tail -6
fi

echo "==> Deploy complete ✓"
