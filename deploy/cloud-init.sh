#!/bin/bash
# Unattended install for a new cloud VM. Paste this whole file (after filling in the settings below)
# into the VM's start-up script field when you create it:
#
#   AWS EC2          Advanced details -> User data           (or: aws ec2 run-instances --user-data file://...)
#   Google Cloud     Advanced -> Management -> Automation -> Startup script
#                                                            (or: gcloud ... --metadata-from-file=startup-script=...)
#   Azure            Advanced -> Custom data                 (or: az vm create --custom-data ...)
#   Oracle Cloud     Advanced options -> Management -> Cloud-init script
#
# Use an Ubuntu 24.04 image. The VM installs Docker, downloads the code, and starts the recorder
# by itself; it takes about 10 minutes. Progress: sudo tail -f /var/log/lecture-recorder-setup.log
# The first admin password is printed at the end of that log.

# ======================= fill in =======================
DOMAIN="recorder.example.com"          # without https://; its DNS A record must point at this VM
ADMIN_EMAIL="admin@example.com"
REPO_URL="https://github.com/omkar-kokane/meeting-bot.git"
REPO_BRANCH="lecture-recorder"   # the product branch (use main once it is merged there)
# Optional, can be added later in /opt/lecture-recorder/deploy/.env
YOUTUBE_CLIENT_ID=""
YOUTUBE_CLIENT_SECRET=""
# =======================================================

set -euo pipefail
APP_DIR=/opt/lecture-recorder
exec >>/var/log/lecture-recorder-setup.log 2>&1
echo "=== $(date -u) start-up script"

# Google Cloud runs start-up scripts on every boot: only install once (Docker restarts the app itself)
if [ -f "$APP_DIR/.installed" ]; then
  echo "already installed"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
# The cloud's own first-boot package updates can hold the apt lock for a while
for _ in $(seq 1 60); do
  if ! fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then break; fi
  sleep 5
done
apt-get update -y
apt-get install -y git

if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR/deploy"
DOMAIN="$DOMAIN" ADMIN_EMAIL="$ADMIN_EMAIL" \
YOUTUBE_CLIENT_ID="$YOUTUBE_CLIENT_ID" YOUTUBE_CLIENT_SECRET="$YOUTUBE_CLIENT_SECRET" \
  bash install.sh

touch "$APP_DIR/.installed"
echo "=== $(date -u) finished"
