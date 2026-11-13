// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import androidx.annotation.VisibleForTesting
import java.util.concurrent.atomic.AtomicReference

/**
 * Debug builds only: a pairing for [MainActivity] to run on its next start, so the instrumented
 * journeys reach the paired app without driving the pairing screen. It runs the real
 * [dev.omnesis.android.session.SessionManager.pairManually] exchange against the gateway.
 *
 * It lives in this process's memory, so only code running inside the app (its instrumentation)
 * can offer one. It is deliberately not an intent extra: the main activity is exported, and
 * any other app on the phone can start it with extras of its choosing.
 */
object DebugPairingSeed {
    data class Seed(val url: String, val code: String, val fingerprint: String?)

    private val pending = AtomicReference<Seed?>(null)

    @VisibleForTesting
    fun offer(url: String, code: String, fingerprint: String?) {
        pending.set(Seed(url, code, fingerprint))
    }

    /** The offered pairing, at most once; always null in a release build. */
    fun take(): Seed? = if (BuildConfig.DEBUG) pending.getAndSet(null) else null
}
