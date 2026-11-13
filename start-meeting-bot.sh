#!/usr/bin/env bash
# Meeting Bot launcher for macOS / Linux / Windows (Git Bash).
# Double-click it (or run ./start-meeting-bot.sh) and the dashboard opens at http://localhost:3000
cd "$(dirname "$0")" || exit 1

pause_on_error() {
  # Keep the window open so a double-clicked script doesn't vanish before the message can be read
  echo
  read -r -p "Press Enter to close this window..." _
}

open_url() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
  elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$1"
  fi
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed (it is needed to run Meeting Bot)."
  echo "Install Node.js 22 LTS or newer from https://nodejs.org , then double-click this file again."
  open_url "https://nodejs.org/en/download"
  pause_on_error
  exit 1
fi

node scripts/launch.js "$@"
code=$?

if [ "$code" -ne 0 ]; then
  pause_on_error
fi
exit "$code"
