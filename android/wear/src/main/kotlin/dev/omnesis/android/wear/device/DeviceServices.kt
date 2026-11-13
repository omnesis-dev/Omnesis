// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.device

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.content.ContextCompat
import dev.omnesis.android.wear.core.Haptics
import dev.omnesis.android.wear.core.MicPermission
import dev.omnesis.android.wear.core.ScreenPresence
import dev.omnesis.android.wear.core.WatchEnvironment
import dev.omnesis.android.wear.core.WatchHaptic
import kotlinx.coroutines.suspendCancellableCoroutine
import java.time.ZoneId
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume

object SystemEnvironment : WatchEnvironment {
    override fun now(): Long = System.currentTimeMillis()

    override fun zone(): ZoneId = ZoneId.systemDefault()

    override fun localeTag(): String = Locale.getDefault().toLanguageTag()

    override fun newRef(): String = UUID.randomUUID().toString()
}

/** Plays each [WatchHaptic] as its own vibration pattern, so the four are told apart on the wrist. */
class VibratorHaptics(context: Context) : Haptics {
    private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
        context.getSystemService(Vibrator::class.java)
    }

    override fun play(haptic: WatchHaptic) {
        val device = vibrator?.takeIf { it.hasVibrator() } ?: return
        device.vibrate(VibrationEffect.createWaveform(pattern(haptic), NO_REPEAT))
    }

    companion object {
        private const val NO_REPEAT = -1

        /** Alternating pause and buzz lengths in milliseconds, starting with a pause. */
        fun pattern(haptic: WatchHaptic): LongArray = when (haptic) {
            // One short tick: the microphone is open.
            WatchHaptic.START -> longArrayOf(0, 35)
            // Two quick ticks.
            WatchHaptic.SUCCESS -> longArrayOf(0, 40, 70, 40)
            // Three heavy buzzes.
            WatchHaptic.FAILURE -> longArrayOf(0, 90, 70, 90, 70, 130)
            // One long buzz.
            WatchHaptic.NOTIFICATION -> longArrayOf(0, 180)
        }
    }
}

/**
 * Asks for microphone access through whichever screen is attached. With no
 * screen attached there is nobody to ask, and the answer is no.
 */
class MicPermissionGate(private val context: Context) : MicPermission {
    /** A screen that can show the system's permission prompt. */
    fun interface Host {
        fun requestMicrophone(onResult: (Boolean) -> Unit)
    }

    private var host: Host? = null

    /** Answers the request that is waiting on the prompt, once. */
    private var pending: ((Boolean) -> Unit)? = null

    /** Whether the permission prompt is up, which stops the app's screen without the person leaving it. */
    val promptShowing: Boolean get() = pending != null

    fun attach(host: Host) {
        this.host = host
    }

    /**
     * The screen is going away. A prompt it was showing can no longer report
     * back, so the request waiting on it is answered as refused instead of
     * left waiting for good.
     */
    fun detach(host: Host) {
        if (this.host !== host) return
        this.host = null
        settle(false)
    }

    override suspend fun request(): Boolean {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
        if (granted == PackageManager.PERMISSION_GRANTED) return true
        val screen = host ?: return false
        settle(false)
        return suspendCancellableCoroutine { continuation ->
            pending = { allowed -> if (continuation.isActive) continuation.resume(allowed) }
            continuation.invokeOnCancellation { pending = null }
            screen.requestMicrophone(::settle)
        }
    }

    private fun settle(allowed: Boolean) {
        val waiting = pending ?: return
        pending = null
        waiting(allowed)
    }
}

/** Whether the app's screen is in front of an awake display. */
class ActivityPresence(context: Context) : ScreenPresence {
    private val power = context.getSystemService(PowerManager::class.java)

    /** Set by the screen as it is resumed and paused. */
    var resumed = false

    override fun isVisibleAndAwake(): Boolean = resumed && power?.isInteractive == true
}
