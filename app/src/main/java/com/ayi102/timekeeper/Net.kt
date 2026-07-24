package com.ayi102.timekeeper

import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections

/** Best-effort LAN IPv4 of this device (the address you'd type in a browser). */
object Net {
    fun lanIp(): String {
        try {
            // (interfaceName, ipv4) for every up, non-loopback, site-local address.
            val candidates = ArrayList<Pair<String, String>>()
            for (ni in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp || ni.isLoopback) continue
                val name = ni.name?.lowercase() ?: ""
                for (addr in Collections.list(ni.inetAddresses)) {
                    if (addr is Inet4Address && addr.isSiteLocalAddress) {
                        candidates.add(name to (addr.hostAddress ?: continue))
                    }
                }
            }
            // Prefer real WiFi (wlan*), then wired (eth*); avoid WiFi-Direct/hotspot
            // (p2p*, which uses the 192.168.49.x subnet a phone/PC can't route to).
            return candidates.firstOrNull { it.first.startsWith("wlan") }?.second
                ?: candidates.firstOrNull { it.first.startsWith("eth") }?.second
                ?: candidates.firstOrNull {
                    !it.first.startsWith("p2p") && !it.second.startsWith("192.168.49.")
                }?.second
                ?: candidates.firstOrNull()?.second
                ?: "127.0.0.1"
        } catch (_: Exception) {
        }
        return "127.0.0.1"
    }
}
