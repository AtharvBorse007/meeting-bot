#!/usr/bin/env bash
# Sets up Lecture Recorder on a fresh Linux VM on any cloud (AWS, Google Cloud, Azure, Oracle) or on
# your own machine. Supported: Ubuntu 22.04 / 24.04 and Debian 12, on x86-64 or ARM64.
#
#   cd meeting-bot/deploy && bash install.sh
#
# Installs Docker, opens ports 80/443 in the VM's own firewall when it has a restrictive one, adds
# swap, asks for the domain and admin email (or takes them from DOMAIN / ADMIN_EMAIL), then builds
# and starts everything. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n==> %s\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi
export DEBIAN_FRONTEND=noninteractive

# ------------------------------------------------------------------ Docker
. /etc/os-release
if ! command -v docker >/dev/null 2>&1 || ! $SUDO docker compose version >/dev/null 2>&1; then
  say "Installing Docker"
  case "${ID:-}" in
    ubuntu)
      $SUDO apt-get update -y
      $SUDO apt-get install -y docker.io docker-compose-v2
      ;;
    debian)
      # Debian's own packages don't include Compose v2: use Docker's official repository
      $SUDO apt-get update -y
      $SUDO apt-get install -y ca-certificates curl gnupg
      $SUDO install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/debian/gpg | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
        | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
      $SUDO apt-get update -y
      $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    *)
      echo "This script supports Ubuntu and Debian. On this system (${PRETTY_NAME:-unknown}), install Docker"
      echo "with the Compose plugin yourself, then run it again. (Every cloud offers an Ubuntu 24.04 image.)"
      exit 1
      ;;
  esac
  $SUDO systemctl enable --now docker
  if [ -n "$SUDO" ]; then $SUDO usermod -aG docker "$USER" || true; fi
fi

# ---------------------------------------------------------------- firewall
# Most clouds filter traffic outside the VM (security groups / firewall rules / NSGs, see
# docs/CLOUD.md) and leave the VM's own firewall open. Oracle's Ubuntu images are the exception:
# they REJECT everything except SSH in iptables. Only touch iptables when it is set up that way.
if command -v iptables >/dev/null 2>&1 && $SUDO iptables -S INPUT 2>/dev/null | grep -qE -- '-j (REJECT|DROP)|-P INPUT DROP'; then
  say "Opening ports 80 and 443 in the VM firewall"
  for port in 80 443; do
    $SUDO iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null \
      || $SUDO iptables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
  done
  $SUDO iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || $SUDO iptables -I INPUT 1 -p udp --dport 443 -j ACCEPT
  if command -v netfilter-persistent >/dev/null 2>&1; then
    $SUDO netfilter-persistent save >/dev/null
  fi
fi
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow 80/tcp && $SUDO ufw allow 443
fi

# -------------------------------------------------------------------- swap
# A safety net for memory spikes when several browsers run at once
if ! swapon --show | grep -q .; then
  say "Adding 4 GB of swap"
  $SUDO fallocate -l 4G /swapfile
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi

# --------------------------------------------------------------- settings
# Values come from the environment (DOMAIN, ADMIN_EMAIL, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET),
# for unattended installs, or are asked for.
if [ ! -f .env ]; then
  say "Settings"
  domain="${DOMAIN:-}"
  admin="${ADMIN_EMAIL:-}"
  if [ -z "$domain" ]; then read -r -p "Dashboard address (e.g. recorder.yourdomain.com): " domain; fi
  if [ -z "$admin" ]; then read -r -p "Admin email (used to sign in): " admin; fi
  domain="${domain#https://}"; domain="${domain#http://}"; domain="${domain%%/*}"
  {
    echo "DOMAIN=${domain}"
    echo "ADMIN_EMAIL=${admin}"
    echo "YOUTUBE_CLIENT_ID=${YOUTUBE_CLIENT_ID:-}"
    echo "YOUTUBE_CLIENT_SECRET=${YOUTUBE_CLIENT_SECRET:-}"
    grep -vE '^(DOMAIN|ADMIN_EMAIL|YOUTUBE_CLIENT_ID|YOUTUBE_CLIENT_SECRET)=' .env.example
  } > .env
  chmod 600 .env
  echo "Saved in deploy/.env (change settings there, then run: bash update.sh)."
fi

# ------------------------------------------------------------------ start
say "Building and starting (the first build takes several minutes)"
$SUDO docker compose up -d --build

say "Waiting for the app to start"
for _ in $(seq 1 90); do
  if $SUDO docker compose logs app 2>/dev/null | grep -q "Server is running"; then break; fi
  sleep 2
done
$SUDO docker compose logs app 2>/dev/null | sed -n '/Admin account created/,/=====$/p' || true

domain="$(grep '^DOMAIN=' .env | cut -d= -f2)"
say "Done. Open https://${domain}"
echo "If the page does not load yet: the domain's DNS A record must point at this VM's public IP,"
echo "and ports 80 and 443 must be allowed in the cloud firewall (docs/CLOUD.md). After fixing DNS,"
echo "run: docker compose restart caddy   (in this folder; prefix with sudo if needed)"
