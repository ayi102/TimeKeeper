#!/bin/bash
# Launches Chromium in kiosk mode pointing at the local TimeKeeper app.
# Runs from the LXDE autostart on desktop login.

# Disable screen blanking / power management so the screen stays on.
xset s off
xset -dpms
xset s noblank

# Hide the mouse cursor when idle (installed via apt: unclutter).
unclutter -idle 0.5 -root &

# Wait until the TimeKeeper web server is actually accepting connections,
# so Chromium never loads before the app is ready.
for i in $(seq 1 60); do
    if curl -s -o /dev/null http://localhost/; then
        break
    fi
    sleep 1
done

# Chromium stores a "was it shut down cleanly?" flag; clearing it prevents the
# "Restore pages?" bubble after an unclean power-off.
PREF="$HOME/.config/chromium/Default/Preferences"
if [ -f "$PREF" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "$PREF"
    sed -i 's/"exit_type":"[^"]\+"/"exit_type":"Normal"/' "$PREF"
fi

exec chromium-browser \
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
