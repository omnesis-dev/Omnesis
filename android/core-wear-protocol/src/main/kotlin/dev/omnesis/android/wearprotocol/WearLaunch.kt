// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import java.net.URI
import java.net.URISyntaxException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/**
 * The watch app's deep links, as complications and tiles open them. Both
 * routes open the unified recorder; the route records which entry point was
 * used. The iOS counterpart is `WatchComplication` in `WatchComplication.swift`.
 */
enum class WearRoute(val host: String) {
    /** Ask Omnesis a question. */
    ASK("ask"),

    /** Tell Omnesis something to remember. */
    NOTE("note"),
    ;

    /** `omnesis-watch://ask` or `omnesis-watch://note`. */
    val uri: String get() = "$SCHEME://$host"

    companion object {
        const val SCHEME = "omnesis-watch"

        /**
         * The route a received link names, or null for anything else.
         * Strict: a link with anything beyond the scheme and host is not one
         * this app produces, and acting on it would start a recording nobody
         * asked for.
         */
        fun parse(link: String): WearRoute? {
            val uri = try {
                URI(link)
            } catch (_: URISyntaxException) {
                return null
            }
            if (!uri.scheme.equals(SCHEME, ignoreCase = true)) return null
            val bare = uri.rawPath.isNullOrEmpty() && uri.rawQuery == null && uri.rawFragment == null &&
                uri.rawUserInfo == null && uri.port == -1
            if (!bare) return null
            val host = uri.host?.lowercase() ?: return null
            return entries.firstOrNull { it.host == host }
        }
    }
}

/**
 * A request to open the recorder that can arrive before the screen that
 * serves it exists. The request is kept until the screen consumes it,
 * repeated presses merge into one launch, and a request the screen reaches
 * too late is not acted on. Not thread-safe.
 */
class CaptureLaunchRequests {
    private var requestCount = 0
    private var consumedCount = 0
    private var requestedAt: EpochMillis? = null

    fun request(now: EpochMillis) {
        requestedAt = now
        requestCount += 1
    }

    /** Whether to open the recorder now. True at most once per burst of requests. */
    fun consume(now: EpochMillis): Boolean {
        if (requestCount <= consumedCount) return false
        consumedCount = requestCount
        val at = requestedAt ?: return false
        return (now - at).milliseconds < FRESHNESS_WINDOW
    }

    companion object {
        /** How long a request stays worth acting on. */
        val FRESHNESS_WINDOW: Duration = 30.seconds
    }
}
