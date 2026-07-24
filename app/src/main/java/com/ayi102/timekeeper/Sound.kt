package com.ayi102.timekeeper

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper

/**
 * Plays short voice clips from res/raw. Each call spins up a MediaPlayer that
 * releases itself once the clip finishes (or fails), so callers don't manage
 * lifecycle. Safe to call from any thread (server threads, the prayer scheduler):
 * playback is set up on the main looper so the completion callback fires and the
 * player is always released.
 */
object Sound {
    private val main = Handler(Looper.getMainLooper())

    fun play(context: Context, resId: Int) {
        val app = context.applicationContext
        main.post {
            val mp = MediaPlayer.create(app, resId) ?: return@post
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            mp.setOnCompletionListener { it.release() }
            mp.setOnErrorListener { player, _, _ -> player.release(); true }
            mp.start()
        }
    }
}
