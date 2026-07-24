#!/bin/bash
# WiFi control helper for the kiosk Settings page. Invoked by the app via sudo.
#   wifi_ctl.sh scan                  -> list visible SSIDs, one per line
#   wifi_ctl.sh status                -> "ssid=..." and "ip=..."
#   wifi_ctl.sh connect "SSID" "PASS" -> add/replace network (priority 10) and reconnect
# An empty PASS means an open network. Existing networks (for failover) are kept.
IFACE=wlan0
CONF=/etc/wpa_supplicant/wpa_supplicant.conf

case "$1" in
  scan)
    wpa_cli -i "$IFACE" scan >/dev/null 2>&1
    sleep 3
    wpa_cli -i "$IFACE" scan_results 2>/dev/null | tail -n +2 \
      | awk -F'\t' '$5!=""{print $5}' | sort -u
    ;;

  status)
    echo "ssid=$(wpa_cli -i "$IFACE" status 2>/dev/null | sed -n 's/^ssid=//p')"
    echo "ip=$(hostname -I 2>/dev/null | awk '{print $1}')"
    ;;

  connect)
    SSID="$2"; PASS="$3"
    [ -z "$SSID" ] && { echo "ERR:no ssid"; exit 1; }
    cp "$CONF" "$CONF.bak.$(date +%s)" 2>/dev/null
    # Drop any existing saved network with the same name (avoid duplicates).
    wpa_cli -i "$IFACE" list_networks 2>/dev/null | tail -n +2 \
      | awk -F'\t' -v s="$SSID" '$2==s{print $1}' | sort -rn \
      | while read -r nid; do wpa_cli -i "$IFACE" remove_network "$nid" >/dev/null 2>&1; done
    ID=$(wpa_cli -i "$IFACE" add_network 2>/dev/null | tail -1)
    case "$ID" in ""|*[!0-9]*) echo "ERR:add_network"; exit 1;; esac
    [ "$(wpa_cli -i "$IFACE" set_network "$ID" ssid "\"$SSID\"")" = "OK" ] || { echo "ERR:ssid"; exit 1; }
    if [ -z "$PASS" ]; then
      wpa_cli -i "$IFACE" set_network "$ID" key_mgmt NONE >/dev/null
    else
      [ "$(wpa_cli -i "$IFACE" set_network "$ID" psk "\"$PASS\"")" = "OK" ] || { echo "ERR:password"; exit 1; }
    fi
    wpa_cli -i "$IFACE" set_network "$ID" priority 10 >/dev/null
    wpa_cli -i "$IFACE" enable_network "$ID" >/dev/null
    wpa_cli -i "$IFACE" save_config >/dev/null
    wpa_cli -i "$IFACE" reconfigure >/dev/null
    echo "OK:$SSID"
    ;;

  *) echo "ERR:usage"; exit 1;;
esac
