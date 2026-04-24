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

# Fast-forward working tree to origin/master if upstream moved ahead (i.e.
# a push from another machine). Local commits already match origin if the
# author pushed from this box, so we fall through to the deploy check.
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "[$(date -Is)] Pulling origin/master: $LOCAL → $REMOTE"
  git reset --hard origin/master
  LOCAL=$REMOTE
fi

# Compare against the commit actually deployed to /var/www/mail. This is the
# real source of truth — if it's behind HEAD (whether HEAD came from pull or
# local commit), we need to redeploy. Keeping this state OUTSIDE the repo
# (rather than at git notes or tags) because the deploy is a prod fact, not
# a code fact.
DEPLOYED_FILE=/var/www/mail/.deployed_sha
DEPLOYED=$(cat "$DEPLOYED_FILE" 2>/dev/null || echo "none")

if [ "$LOCAL" = "$DEPLOYED" ]; then
  # Already deployed this commit — skip.
  exit 0
fi

echo "[$(date -Is)] Deploying $LOCAL (previously deployed: $DEPLOYED)"

echo "[$(date -Is)] Installing dependencies if package.json changed"
if git diff --name-only "$LOCAL" "$REMOTE" | grep -qE '^package(-lock)?\.json$'; then
  npm ci --prefer-offline --no-audit --no-fund 2>&1 | tail -5
fi

echo "[$(date -Is)] Running deploy.sh"
# deploy.sh may exit 0 without deploying if the lockfile is held by another
# concurrent run (GitHub Actions SSH). Only mark the SHA as deployed when
# we actually ran a full deploy, not when we short-circuited on the lock.
if bash scripts/deploy.sh | tee /tmp/chatyy-deploy-last.log; then
  if grep -q "Another deploy is running" /tmp/chatyy-deploy-last.log; then
    echo "[$(date -Is)] Skipped — concurrent deploy took this commit. Will re-check next tick."
  else
    echo "$LOCAL" > "$DEPLOYED_FILE"
    echo "[$(date -Is)] Deploy finished — now at $LOCAL"
  fi
else
  echo "[$(date -Is)] Deploy FAILED — not recording .deployed_sha so we retry next tick"
  exit 1
fi
