package com.ayi102.timekeeper

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Relaunches the kiosk automatically after the tablet boots. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            action.endsWith("QUICKBOOT_POWERON")
        ) {
            context.startActivity(
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
    }
}
