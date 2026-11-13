#!/usr/bin/env bash
# Give an account (e.g. the admin) a new temporary password:  bash reset-password.sh admin@example.com
set -euo pipefail
cd "$(dirname "$0")"
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
$SUDO docker compose exec -T app node --disable-warning=ExperimentalWarning dist/cli/reset-password.js "${1:-}"
