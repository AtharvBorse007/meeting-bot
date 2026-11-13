#!/bin/sh
# Starts the container. The same image serves three roles:
#   dashboard, recorders inside it    (RECORDER_MODE=inprocess, the default)  needs the virtual screen
#   dashboard only                    (RECORDER_MODE=ecs)                      no browsers here
#   one recorder for one lecture      (APP_ROLE=recorder, an AWS Fargate task) needs the virtual screen
# Extra arguments replace the program that is started (used by tests).
set -e

needs_display=yes
if [ "${RECORDER_MODE:-inprocess}" = "ecs" ] && [ "${APP_ROLE:-dashboard}" != "recorder" ]; then
  needs_display=no
fi

if [ "$needs_display" = "yes" ]; then
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR"
  # Left behind when the container was killed rather than stopped
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

  # Virtual screen. The bot windows are 1280x800 and cascade a little, so leave room.
  Xvfb :99 -screen 0 1920x1200x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -e /tmp/.X11-unix/X99 ] && break
    sleep 0.3
  done

  # Virtual sound card: the meeting audio plays into it, so the tab capture has audio to record
  pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pactl info >/dev/null 2>&1 && break
    sleep 0.3
  done
  pactl load-module module-null-sink sink_name=virtual_output >/dev/null 2>&1 || true
  pactl set-default-sink virtual_output >/dev/null 2>&1 || true
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
if [ "${APP_ROLE:-dashboard}" = "recorder" ]; then
  exec node --disable-warning=ExperimentalWarning dist/worker/index.js
fi
exec node --disable-warning=ExperimentalWarning dist/index.js
