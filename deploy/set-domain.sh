#!/usr/bin/env bash
# Switch the dashboard to a new address (e.g. from the temporary <ip>.sslip.io to your own domain):
#   sudo bash set-domain.sh recorder.yourdomain.com
# Do it between lectures: recorders that are already running keep reporting to the old address.
set -euo pipefail
cd "$(dirname "$0")"
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

new="${1:-}"
new="${new#https://}"; new="${new#http://}"; new="${new%%/*}"
if ! [[ "$new" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
  echo "Usage: sudo bash set-domain.sh recorder.yourdomain.com"
  exit 1
fi

ip="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null || true)"
resolved="$(getent hosts "$new" | awk '{print $1}' | head -1 || true)"
if [ -n "$ip" ] && [ "$resolved" != "$ip" ]; then
  echo "Warning: $new points to '${resolved:-nothing}', but this server is $ip."
  echo "Create the DNS A record first (name -> $ip), wait a few minutes, then run this again."
  read -r -p "Continue anyway? [y/N] " answer
  [ "$answer" = "y" ] || exit 1
fi

old="$(grep '^DOMAIN=' .env | cut -d= -f2-)"
sed -i "s|^DOMAIN=.*|DOMAIN=${new}|" .env
$SUDO docker compose up -d
echo
echo "The dashboard is now at https://${new} (it was https://${old})."
echo "In Google Cloud -> Clients -> your OAuth client, add this authorised redirect URI:"
echo "  https://${new}/api/youtube/callback"
echo "The YouTube connection itself keeps working; the new URI is needed only to reconnect."
