#!/usr/bin/env bash
# Restore a database backup made by backup.sh (e.g. when moving to a new server):
#   bash restore.sh backups/meetingbot-2026-11-13-0300.db
# Replaces the current accounts, subjects, lecture history and YouTube connection. Run it between lectures.
set -euo pipefail
cd "$(dirname "$0")"
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

backup="${1:-}"
if [ -z "$backup" ] || [ ! -f "$backup" ]; then
  echo "Usage: bash restore.sh <path to meetingbot-*.db>"
  exit 1
fi
dir="$(cd "$(dirname "$backup")" && pwd)"
file="$(basename "$backup")"

$SUDO docker compose stop app
# Runs as the app's own user, so the restored file has the right owner. The old write-ahead log
# files must go too, or SQLite would replay them onto the restored database.
$SUDO docker compose run --rm --no-deps -v "$dir:/restore:ro" --entrypoint sh app -c \
  "cp /restore/$file /app/data/meetingbot.db && rm -f /app/data/meetingbot.db-wal /app/data/meetingbot.db-shm"
$SUDO docker compose start app
echo "Restored $file."
