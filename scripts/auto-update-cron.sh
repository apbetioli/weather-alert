#!/usr/bin/env bash
# Periodic auto-update script suitable for cron or systemd timer
set -e

cd "$(dirname "$0")/.."

# Fetch latest status from origin without merging
git fetch origin main > /dev/null 2>&1

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] New commit detected on origin/main ($LOCAL -> $REMOTE). Updating..."
  ./scripts/deploy.sh
fi
