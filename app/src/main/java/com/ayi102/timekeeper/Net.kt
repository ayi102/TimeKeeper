package com.ayi102.timekeeper

import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections

/** Best-effort LAN IPv4 of this device (the address you'd type in a browser). */
object Net {
    fun lanIp(): String {
        try {
            for (ni in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp || ni.isLoopback) continue
                for (addr in Collections.list(ni.inetAddresses)) {
                    if (addr is Inet4Address && addr.isSiteLocalAddress) {
                        return addr.hostAddress ?: continue
                    }
                }
            }
        } catch (_: Exception) {
        }
        return "127.0.0.1"
    }
}
