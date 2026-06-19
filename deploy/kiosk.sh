#!/bin/bash
# Launches Chromium in kiosk mode pointing at the local TimeKeeper app.
# Started once from the LXDE autostart (no @ respawn — this script handles its
# own respawn). It relaunches Chromium if it crashes, but exits cleanly to the
# desktop when the app requests it (the /tmp/kiosk-exit flag).

EXIT_FLAG=/tmp/kiosk-exit
rm -f "$EXIT_FLAG"

# Keep the screen awake.
xset s off
xset -dpms
xset s noblank

# Hide the mouse cursor when idle.
pgrep -x unclutter >/dev/null || unclutter -idle 0.5 -root &

# Wait until the web server is accepting connections so Chromium never loads
# before the app is ready.
for i in $(seq 1 60); do
    curl -s -o /dev/null http://localhost/ && break
    sleep 1
done

while true; do
    # Clear Chromium's "was it shut down cleanly?" flags to avoid the
    # "Restore pages?" bubble after a power-off.
    PREF="$HOME/.config/chromium/Default/Preferences"
    if [ -f "$PREF" ]; then
        sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "$PREF"
        sed -i 's/"exit_type":"[^"]\+"/"exit_type":"Normal"/' "$PREF"
    fi

    chromium-browser \
        --kiosk \
        --noerrdialogs \
        --disable-infobars \
        --disable-session-crashed-bubble \
        --disable-features=TranslateUI \
        --disable-pinch \
        --overscroll-history-navigation=0 \
        --check-for-update-interval=31536000 \
        --no-first-run \
        --fast --fast-start \
        http://localhost/

    # Chromium has exited. If the app asked us to quit, leave to the desktop;
    # otherwise it crashed, so relaunch it.
    if [ -f "$EXIT_FLAG" ]; then
        rm -f "$EXIT_FLAG"
        break
    fi
    sleep 2
done
