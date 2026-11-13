#!/usr/bin/env bash
# macOS: double-click this file in Finder to start Meeting Bot.
# (If macOS says it "can't be opened", run once in Terminal:  chmod +x "Start Meeting Bot.command" start-meeting-bot.sh)
exec "$(cd "$(dirname "$0")" && pwd)/start-meeting-bot.sh" "$@"
