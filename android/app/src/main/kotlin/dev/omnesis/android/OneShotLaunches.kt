// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import android.content.Intent
import android.os.Bundle

/** How an intent reached the activity. */
internal enum class LaunchDelivery {
    /** `onNewIntent`: somebody started the activity just now. */
    NEW_INTENT,

    /** `onCreate` with no saved state: the activity is new. */
    CREATED,

    /** `onCreate` with saved state: the system rebuilt an activity that existed before. */
    RECREATED,
}

/**
 * Decides whether a launch intent is a request to act on, so each request is acted on once.
 *
 * The system keeps the intent an activity was first started with for as long as its task
 * lives, and hands it over again every time it rebuilds the activity: after a rotation,
 * after it killed the process, and when the task is reopened from the recent apps list.
 * None of those is somebody asking again. Intents that arrive later go to `onNewIntent`
 * and never replace the kept one, so the kept intent can be older than requests already
 * handled.
 *
 * A stamped intent carries a number that grows with every request of its [kind] within one
 * boot. It is acted on when it reaches `onNewIntent`, or when it is newer than every
 * request of that kind handled so far; the newest handled stamp survives in the saved
 * state. An unstamped intent is acted on only when it reaches `onNewIntent` or a new
 * activity. An intent replayed from the recent apps list is never acted on.
 */
internal class OneShotLaunches(saved: Bundle?) {
    private val newestHandled = HashMap<String, Long>()

    init {
        saved?.getBundle(STATE_KEY)?.let { state ->
            for (kind in state.keySet()) newestHandled[kind] = state.getLong(kind)
        }
    }

    /**
     * Whether [intent], of the given [kind] and [stamp] (0 when it carries none), is a
     * request to act on. Accepting it records it as handled.
     */
    fun accept(kind: String, intent: Intent, stamp: Long, delivery: LaunchDelivery): Boolean {
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (delivery != LaunchDelivery.NEW_INTENT && fromHistory) return false
        val newest = newestHandled[kind] ?: 0L
        val accepted = when {
            delivery == LaunchDelivery.NEW_INTENT -> true
            stamp == 0L -> delivery == LaunchDelivery.CREATED
            else -> stamp > newest
        }
        if (accepted && stamp > newest) newestHandled[kind] = stamp
        return accepted
    }

    fun save(outState: Bundle) {
        outState.putBundle(STATE_KEY, Bundle().apply { newestHandled.forEach { (kind, stamp) -> putLong(kind, stamp) } })
    }

    private companion object {
        const val STATE_KEY = "one_shot_launches"
    }
}
