#!/usr/bin/env bash
# Copy the database (accounts, subjects, lecture history, YouTube connection) to deploy/backups/.
# The videos themselves are on YouTube; server copies of recordings are not included.
# Run it from cron for regular backups, e.g.  0 3 * * *  /home/ubuntu/meeting-bot/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")"
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

mkdir -p backups
# VACUUM INTO makes a consistent copy even while the app is writing
$SUDO docker compose exec -T app node --disable-warning=ExperimentalWarning -e "
  const fs = require('fs');
  const { DatabaseSync } = require('node:sqlite');
  fs.rmSync('/app/data/backup.db', { force: true });
  new DatabaseSync('/app/data/meetingbot.db').exec(\"VACUUM INTO '/app/data/backup.db'\");
"
target="backups/meetingbot-$(date +%Y-%m-%d-%H%M).db"
$SUDO docker compose cp app:/app/data/backup.db "$target"
$SUDO chown "$(id -u):$(id -g)" "$target" 2>/dev/null || true
chmod 600 "$target"
# keep the last 30
ls -1t backups/meetingbot-*.db 2>/dev/null | tail -n +31 | xargs -r rm -f
echo "Saved $target"
