# 3.5" touchscreen (LCD) setup — confirmed procedure

The kiosk runs on a **goodtft-style 3.5" SPI touchscreen** (ILI9486 display via
the `tft35a` overlay, XPT2046 resistive touch). An SPI screen needs a driver
before it shows anything, and `deploy/setup.sh` can't do it (it reboots and
can't guess the panel), so run this once after a rebuild.

> ⚠️ SSH keeps working throughout, so a bad display config is always fixable
> remotely. Recovery notes at the bottom.

## The exact steps that work on this Pi

```bash
# 1. Install the goodtft driver (this is the one that works here)
cd ~
git clone --depth 1 https://github.com/goodtft/LCD-show.git
chmod -R 755 LCD-show
cd LCD-show
sudo ./LCD35-show 180        # 180 = landscape, oriented for how OUR screen is mounted
# ^ this rewrites /boot/config.txt, flips the touch axes to match, and REBOOTS
```

**Rotation reference** (the base overlay is `rotate=90`; the arg rotates from there):

| `LCD35-show` arg | Result | config it writes |
|---|---|---|
| `0`   | landscape | `tft35a:rotate=90`, `hdmi_cvt 480 320` |
| `90`  | portrait | `tft35a:rotate=180`, `hdmi_cvt 320 480` |
| **`180`** | **landscape, flipped — use this** | `tft35a:rotate=270`, `hdmi_cvt 480 320` |
| `270` | portrait, flipped | `tft35a:rotate=0`, `hdmi_cvt 320 480` |

```bash
# 2. IMPORTANT: the goodtft script RESETS boot to console (multi-user.target)
#    every time it runs. Re-enable the graphical kiosk afterward:
sudo systemctl set-default graphical.target
sudo mkdir -p /etc/lightdm/lightdm.conf.d
printf '[Seat:*]\nautologin-user=ayi102\nautologin-user-timeout=0\n' \
  | sudo tee /etc/lightdm/lightdm.conf.d/01-timekeeper-autologin.conf
sudo reboot
```

After the reboot it boots straight into the full-screen Chromium kiosk, landscape,
mirrored to the LCD by `fbcp` (which the goodtft script installs and autostarts).

## Gotchas we hit (so you don't rediscover them)
- **goodtft resets boot to console.** Step 2 is mandatory *after* the driver, or
  the Pi boots to a terminal on the LCD instead of the kiosk.
- **Don't use `raspi-config` for autologin here** — `do_boot_behaviour` throws
  `Illegal number: W1` on this image and silently doesn't apply. Set the target +
  lightdm autologin directly (step 2).
- **Rotation is `180`, not `90`** — `90` gives portrait on this panel.
- **`vc4-kms-v3d`:** the goodtft/fbcp path works alongside it here. If a future
  driver leaves the LCD black, switch `dtoverlay=vc4-kms-v3d` → `vc4-fkms-v3d` in
  `/boot/config.txt`.

## If it breaks the boot or the screen
- SSH still works — you're never locked out.
- goodtft backs up config to `/boot/config.txt.bak`; we also saved
  `/boot/config.txt.pre-lcd.bak`. Revert to HDMI with `sudo ~/LCD-show/LCD-hdmi`,
  or restore `config.txt` by popping the SD into any computer (boot partition is
  FAT, readable anywhere).
