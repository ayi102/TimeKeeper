# 3.5" touchscreen (LCD) setup

The kiosk runs on a 3.5" SPI touchscreen wired to the Pi's GPIO header. Unlike
HDMI, an SPI screen needs a **model-specific driver** before it shows anything.
`deploy/setup.sh` does everything *except* this (it can't guess the panel), so
run this once after a rebuild.

> ⚠️ The wrong driver can leave the screen blank or stop the Pi booting. Identify
> the panel first, and know the recovery path (below) before you start. SSH keeps
> working regardless, so a bad display config is always fixable remotely.

## 1. Identify the panel
Check the board's silkscreen / the seller's listing. The common families:

| Panel | Driver repo | Install command |
|---|---|---|
| Generic red "MHS-3.5" / XPT2046" (goodtft) | `github.com/goodtft/LCD-show` | `sudo ./MHS35-show` (or `sudo ./LCD35-show`) |
| Waveshare 3.5" (A/B/C) | `github.com/waveshare/LCD-show` | `sudo ./LCD35-show` |
| Adafruit PiTFT 3.5" | Adafruit installer | see Adafruit's PiTFT guide |

The stock overlays already on this Pi (`ls /boot/overlays | grep -Ei 'tft|piscreen'`)
include `piscreen`, `pitft35-resistive` — some panels work with just a
`dtoverlay=` line instead of a vendor script.

## 2. Install the driver
Example for a goodtft-style board (adjust repo/script to your panel). The `90`
rotates to landscape:
```bash
cd ~
git clone https://github.com/goodtft/LCD-show.git
chmod -R 755 LCD-show
cd LCD-show
sudo ./MHS35-show 90       # or ./LCD35-show 90 — matches your panel
```
The script rewrites `/boot/config.txt` and **reboots**.

## 3. Known gotcha on Bullseye — the KMS driver
This Pi's `config.txt` uses `dtoverlay=vc4-kms-v3d`. Most SPI LCD drivers need the
**older FKMS** driver instead, or they conflict (HDMI works, LCD stays black).
If the LCD is black after the driver install, edit `/boot/config.txt`:
```
# change:
dtoverlay=vc4-kms-v3d
# to:
dtoverlay=vc4-fkms-v3d
```
(The vendor scripts usually do this for you; verify it if the screen is blank.)

## 4. Rotation & touch calibration
- Rotation: re-run the vendor script with a different angle (`0/90/180/270`).
- If touch is offset or mirrored, install `xinput-calibrator` and follow the
  vendor repo's calibration notes (they ship a matching `99-calibration.conf`).

## 5. The kiosk itself
Already wired up by `deploy/setup.sh`: desktop **autologin** is on and
`~/.config/lxsession/LXDE-pi/autostart` launches `deploy/kiosk.sh` (Chromium
full-screen at `http://localhost/`). Once the panel displays, the kiosk appears
on it automatically at the next boot — no extra step.

## 6. If it breaks the boot / screen
- SSH still works — you're never locked out.
- The vendor scripts back up config to `/boot/config.txt.bak`. Restore with the
  repo's `sudo ./LCD-hdmi` (reverts to HDMI), or restore `config.txt` by popping
  the SD into another computer (the boot partition is FAT, readable anywhere).
