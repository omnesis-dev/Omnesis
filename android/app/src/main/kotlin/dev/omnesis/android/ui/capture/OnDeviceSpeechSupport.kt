// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.RequiresApi
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Which locales the on-device speech recognizer has confirmed it can recognize — the
 * only recognizer that is ever handed vocabulary hints. One instance serves every
 * [SpeechTranscriber], so a confirmation earned on one screen holds for the next, and a
 * check started before a recognition session outlives that session's start and end.
 * Main thread only, like the platform recognizer it asks.
 */
@Singleton
class OnDeviceSpeechSupport @Inject constructor() {

    private class Check(val locale: String, val waiters: MutableList<() -> Unit>)

    private val confirmedAt = mutableMapOf<String, Long>()
    private val checkedAt = mutableMapOf<String, Long>()
    private val checks = mutableMapOf<RecognizerBackend, Check>()
    private val handler = Handler(Looper.getMainLooper())

    /** True while [locale]'s confirmation is recent enough to act on. */
    fun confirmed(locale: String): Boolean =
        confirmedAt[locale]?.let { SystemClock.elapsedRealtime() - it < VALIDITY_MS } == true

    /** The recognizer turned out not to have [locale] after all, e.g. its language pack was removed. */
    fun revoke(locale: String) {
        confirmedAt.remove(locale)
    }

    /**
     * Asks an on-device recognizer from [factory] whether [locale] is installed, unless it
     * was asked recently, and calls [onSettled] once the answer is in: at once when there
     * is nothing to ask, otherwise when the recognizer replies or [CHECK_TIMEOUT_MS]
     * passes. [intent] describes the recognition and carries no vocabulary.
     */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    internal fun check(factory: RecognizerFactory, locale: String, intent: Intent, onSettled: () -> Unit = {}) {
        checks.values.firstOrNull { it.locale == locale }?.let {
            it.waiters += onSettled
            return
        }
        val now = SystemClock.elapsedRealtime()
        if (checkedAt[locale]?.let { now - it < VALIDITY_MS } == true) {
            onSettled()
            return
        }
        checkedAt.clear()
        checkedAt[locale] = now
        confirmedAt.keys.retainAll(setOf(locale))
        val probe = runCatching { factory.onDevice() }.getOrNull() ?: run {
            onSettled()
            return
        }
        val check = Check(locale, mutableListOf(onSettled))
        checks[probe] = check
        val settle = Runnable {
            if (checks.remove(probe) != null) {
                probe.destroy()
                check.waiters.forEach { it() }
            }
        }
        handler.postDelayed(settle, CHECK_TIMEOUT_MS)
        try {
            probe.support(intent) { installed ->
                if (probe in checks && installed?.any { it.equals(locale, ignoreCase = true) } == true) {
                    confirmedAt[locale] = SystemClock.elapsedRealtime()
                }
                handler.removeCallbacks(settle)
                settle.run()
            }
        } catch (_: Exception) {
            handler.removeCallbacks(settle)
            settle.run()
        }
    }

    private companion object {
        /** How long a confirmation, or a check that confirmed nothing, stands before asking again. */
        const val VALIDITY_MS = 300_000L
        const val CHECK_TIMEOUT_MS = 10_000L
    }
}
