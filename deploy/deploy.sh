#!/bin/bash
# Deploy TimeKeeper to the Raspberry Pi, then RESTART the service so cached
# templates and new routes actually take effect (the app caches templates in
# memory, so an rsync alone does not update the running site).
#
# Usage:  deploy/deploy.sh [user@host]
#   defaults to ayi102@192.168.6.94
#
# Data and secrets on the Pi are preserved (timekeeper.db, deploy/*.env are
# never synced or deleted).
set -euo pipefail

HOST="${1:-ayi102@192.168.6.94}"
DEST="TimeKeeper"                                   # relative to the remote home
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Syncing code to $HOST:$DEST/"
rsync -az --delete \
  --exclude '.git/' \
  --exclude '.venv/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude 'timekeeper.db' \
  --exclude 'cookies.txt' \
  --exclude 'deploy/mail.env' \
  --exclude 'deploy/timekeeper.env' \
  -e "ssh -o StrictHostKeyChecking=accept-new" \
  "$HERE/" "$HOST:$DEST/"

echo "→ Restarting service"
ssh "$HOST" 'sudo systemctl restart timekeeper && sleep 4 && systemctl is-active timekeeper'

echo "→ Health check"
code=$(ssh "$HOST" 'curl -s -o /dev/null -w "%{http_code}" http://localhost/')
echo "  HTTP $code"
[ "$code" = "200" ] || { echo "✗ App did not return 200 — check: ssh $HOST 'journalctl -u timekeeper -n 50'"; exit 1; }
echo "✓ Deployed."
