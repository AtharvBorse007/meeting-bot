#!/usr/bin/env bash
# Pull the latest code (if this is a git checkout) and rebuild/restart.
# With recorders inside this server (RECORDER_MODE=inprocess), recordings in progress are stopped and
# saved during the restart, so run it between lectures. With AWS recorder tasks (RECORDER_MODE=ecs),
# recordings carry on during the update; new lectures use the new recorder image.
set -euo pipefail
cd "$(dirname "$0")"
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

if git -C .. rev-parse --git-dir >/dev/null 2>&1; then
  git -C .. pull --ff-only
fi

mode="$(grep '^RECORDER_MODE=' .env 2>/dev/null | cut -d= -f2- || true)"
if [ "$mode" != "ecs" ]; then
  active="$($SUDO docker compose exec -T app node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/app/data/meetingbot.db', { readOnly: true });
    console.log(db.prepare(\"SELECT COUNT(*) AS n FROM lectures WHERE status NOT IN ('saved','failed','cancelled')\").get().n);
  " 2>/dev/null || echo 0)"
  if [ "${active:-0}" != "0" ] && [ "${1:-}" != "--force" ]; then
    echo "$active lecture(s) are being recorded right now. Run again when they are done, or use: bash update.sh --force"
    exit 1
  fi
fi

$SUDO docker compose up -d --build
if grep -q '^ECR_REPOSITORY_URI=.' .env 2>/dev/null; then
  bash aws/push-recorder-image.sh
fi
$SUDO docker image prune -f >/dev/null
echo "Updated."
