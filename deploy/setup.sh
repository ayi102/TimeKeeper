#!/bin/bash
# One-shot (re)provision of TimeKeeper on a fresh Raspberry Pi.
#
# After flashing Raspberry Pi OS (SSH enabled, user 'ayi102'):
#   git clone https://github.com/ayi102/TimeKeeper.git ~/TimeKeeper
#   bash ~/TimeKeeper/deploy/setup.sh [path/to/timekeeper-backup.db(.gz)]
#
# Pass a backup file to restore the data (a .db or the .db.gz from a weekly
# email). Idempotent and safe to re-run; it will NOT overwrite an existing
# timekeeper.db. You must still fill in the two secret files it creates from
# templates — they are git-ignored and therefore not in any backup.
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP="${1:-}"
cd "$APP"
echo "== TimeKeeper setup in $APP =="

echo "→ System packages"
sudo apt-get update -qq
sudo apt-get install -y python3-venv git curl unclutter
# Kiosk browser: package name varies by OS version — try both, don't hard-fail.
sudo apt-get install -y chromium-browser \
  || sudo apt-get install -y chromium \
  || echo "  (couldn't auto-install chromium — install it manually for kiosk mode)"

echo "→ Python venv + dependencies"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt

echo "→ Secret files (EDIT THESE after setup)"
[ -f deploy/mail.env ] \
  || { cp deploy/mail.env.example deploy/mail.env; echo "  created deploy/mail.env — set MAIL_* incl. the App Password"; }
[ -f deploy/timekeeper.env ] \
  || { cp deploy/timekeeper.env.example deploy/timekeeper.env; echo "  created deploy/timekeeper.env — set the PIN and SECRET"; }

echo "→ Database"
if [ -f timekeeper.db ]; then
  echo "  timekeeper.db already present — leaving it untouched"
elif [ -n "$BACKUP" ]; then
  case "$BACKUP" in
    *.gz) gunzip -c "$BACKUP" > timekeeper.db ;;
    *)    cp "$BACKUP" timekeeper.db ;;
  esac
  echo "  restored database from $BACKUP"
else
  echo "  no backup passed — the app will create a fresh empty DB on first start"
fi

echo "→ systemd services + timers"
sudo cp deploy/timekeeper.service \
        deploy/timekeeper-daily.service deploy/timekeeper-daily.timer \
        deploy/missed-clockin.service deploy/missed-clockin.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now timekeeper.service
sudo systemctl enable --now timekeeper-daily.timer
sudo systemctl enable --now missed-clockin.timer

echo "→ WiFi control sudoers (lets the Settings page change WiFi)"
SUDOERS=/etc/sudoers.d/timekeeper-wifi
if [ ! -f "$SUDOERS" ]; then
  echo "$USER ALL=(root) NOPASSWD: /bin/bash $APP/deploy/wifi_ctl.sh" | sudo tee "$SUDOERS" >/dev/null
  sudo chmod 440 "$SUDOERS"
  echo "  installed $SUDOERS"
fi

echo "→ Kiosk on boot (desktop autologin + Chromium autostart)"
sudo raspi-config nonint do_boot_behaviour B4 \
  && echo "  desktop autologin enabled" \
  || echo "  (couldn't set autologin — enable 'Desktop Autologin' in raspi-config)"
AUTOSTART="$HOME/.config/lxsession/LXDE-pi/autostart"
mkdir -p "$(dirname "$AUTOSTART")"
cp deploy/lxde-autostart "$AUTOSTART"
echo "  autostart installed at $AUTOSTART"
echo "  NOTE: the 3.5\" SPI touchscreen needs its own driver — see deploy/lcd-setup.md"

echo
echo "✓ Setup complete. Final steps:"
echo "   1. Edit deploy/mail.env and deploy/timekeeper.env with your secrets."
echo "   2. sudo systemctl restart timekeeper"
echo "   3. Open http://<pi-ip>/ (kiosk) and http://<pi-ip>/admin"
echo "   Health: systemctl status timekeeper --no-pager"
