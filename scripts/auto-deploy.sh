#!/bin/bash
# Poll-based auto-deploy — runs on prod server as a systemd timer.
# Checks GitHub master for new commits every 60s; if there are any, pulls +
# runs deploy.sh. This is the "GitHub secrets not configured" fallback.
#
# Install:
#   sudo cp scripts/chatyy-auto-deploy.{service,timer} /etc/systemd/system/
#   sudo systemctl enable --now chatyy-auto-deploy.timer
#
# Log:
#   journalctl -u chatyy-auto-deploy.service -f

set -euo pipefail
cd /root/webmail-app

export GIT_SSH_COMMAND='ssh -i /root/.ssh/github_chatyy -o StrictHostKeyChecking=no'

# Pick up any upstream changes without touching working tree state
git fetch origin master --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)

if [ "$LOCAL" = "$REMOTE" ]; then
  # Up to date — nothing to do. Exit quietly so the timer log stays clean.
  exit 0
fi

echo "[$(date -Is)] New commits detected: $LOCAL → $REMOTE"
echo "[$(date -Is)] Pulling origin/master"
git reset --hard origin/master

echo "[$(date -Is)] Installing dependencies if package.json changed"
if git diff --name-only "$LOCAL" "$REMOTE" | grep -qE '^package(-lock)?\.json$'; then
  npm ci --prefer-offline --no-audit --no-fund 2>&1 | tail -5
fi

echo "[$(date -Is)] Running deploy.sh"
bash scripts/deploy.sh

echo "[$(date -Is)] Deploy finished — now at $REMOTE"
