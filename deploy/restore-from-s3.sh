#!/usr/bin/env bash
# Restore the database from the S3 backup bucket (e.g. onto a new server):
#   sudo bash restore-from-s3.sh            the newest backup
#   sudo bash restore-from-s3.sh <key>      a specific one (the list is printed)
# Replaces the current accounts, subjects, lecture history and YouTube connection. Run it between lectures.
set -euo pipefail
cd "$(dirname "$0")"
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

$SUDO docker compose exec -T app node --disable-warning=ExperimentalWarning dist/cli/fetch-db-backup.js "${1:-}"
$SUDO docker compose stop app
# Runs as the app's own user so the file keeps the right owner; the old write-ahead log must go too
$SUDO docker compose run --rm --no-deps --entrypoint sh app -c \
  "mv /app/data/restore-from-s3.db /app/data/meetingbot.db && rm -f /app/data/meetingbot.db-wal /app/data/meetingbot.db-shm"
$SUDO docker compose start app
echo "Restored the database from S3."
