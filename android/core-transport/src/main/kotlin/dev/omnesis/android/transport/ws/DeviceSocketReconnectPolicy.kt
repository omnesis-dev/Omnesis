// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.ws

import java.security.cert.CertificateException
import javax.net.ssl.SSLPeerUnverifiedException
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/** Why a device-socket attempt ended, reduced to what decides the next retry and the copy. */
internal sealed interface DeviceSocketAttemptFailure {
    /** The gateway could not be reached, or an open socket dropped. */
    data class Network(val detail: String) : DeviceSocketAttemptFailure

    /** The upgrade reached something that answered with this HTTP status. */
    data class Server(val status: Int) : DeviceSocketAttemptFailure

    data object RateLimited : DeviceSocketAttemptFailure

    /** The connection was refused because the gateway failed TLS verification. */
    data class Trust(val detail: String) : DeviceSocketAttemptFailure

    /** The gateway refused this device's credentials. */
    data class Authentication(val detail: String) : DeviceSocketAttemptFailure

    /** The gateway refused the hello for a reason a retry cannot change. */
    data class Incompatible(val detail: String) : DeviceSocketAttemptFailure

    companion object {
        fun fromTransport(error: Throwable, responseCode: Int?, helloCompleted: Boolean): DeviceSocketAttemptFailure {
            val detail = error.message ?: "The connection to the gateway failed."
            if (helloCompleted) return Network(detail)
            if (responseCode != null && responseCode != 101) {
                return when (responseCode) {
                    401, 403 -> Authentication("The gateway answered with status $responseCode.")
                    429 -> RateLimited
                    else -> Server(responseCode)
                }
            }
            val causes = generateSequence(error) { current -> current.cause?.takeIf { it !== current } }.take(12)
            return if (causes.any { it is CertificateException || it is SSLPeerUnverifiedException }) {
                Trust(detail)
            } else {
                Network(detail)
            }
        }

        fun fromHello(code: String?, message: String): DeviceSocketAttemptFailure = when (code) {
            "invalid_token", "device_not_found" -> Authentication(message)
            "rate_limited" -> RateLimited
            else -> Incompatible(message)
        }
    }
}

/** Timing limits for [DeviceSocketReconnectPolicy], in milliseconds. */
data class DeviceSocketReconnectLimits(
    val baseDelayMs: Long = 1_000,
    val maxDelayMs: Long = 30_000,
    val jitterFraction: Double = 0.25,
    /** Long enough for the gateway's one-minute limiter window to pass. */
    val rateLimitedDelayMs: Long = 60_000,
    /** A credential or protocol refusal can only change on the gateway's side, so it is checked rarely. */
    val refusedDelayMs: Long = 300_000,
    val attemptBurst: Int = 5,
    val attemptRefillIntervalMs: Long = 20_000,
    /** An attempt in flight this long started on a network state that may be gone. */
    val supersedeInFlightAfterMs: Long = 2_000,
)

/**
 * Decides when the device socket may try to connect again. Pure state and arithmetic: the socket
 * supplies the time and the randomness, so every schedule here is deterministic under test.
 *
 * Two independent limits apply. **Backoff** is the delay a failed attempt earns: 1s, 2s, 4s, 8s,
 * 16s, then 30s, plus up to 25% jitter. Restored connectivity restarts the ladder, because the
 * failures so far say nothing about the new network, and a gateway that stays unreachable climbs
 * it again. **The attempt budget** caps every attempt, however it was triggered, so network
 * flapping or repeated foregrounding cannot become a retry storm: a burst of 5 refilling every 20s
 * allows at most 8 attempts in any minute and 185 in any hour, below the gateway's upgrade limit
 * of 10 per minute and 200 per hour for one client address.
 */
internal class DeviceSocketReconnectPolicy(val limits: DeviceSocketReconnectLimits = DeviceSocketReconnectLimits()) {
    /** What is asking for an early attempt. */
    enum class WakeSignal { CONNECTIVITY_RESTORED, FOREGROUND }

    var lastFailure: DeviceSocketAttemptFailure? = null
        private set
    private var consecutiveFailures = 0

    /** Theoretical arrival time of the next attempt, all the generic cell rate algorithm needs. */
    private var nextAttemptArrivalMs = 0L

    /**
     * Whether a signal should shorten the current wait. A network change cannot fix a refused
     * credential, and a retry inside the limiter's window is only refused again, so those signals
     * leave the schedule alone. Returning to the app does re-check a refusal, because the user may have
     * fixed it on the gateway.
     */
    fun accepts(signal: WakeSignal): Boolean = when (lastFailure) {
        DeviceSocketAttemptFailure.RateLimited -> false
        is DeviceSocketAttemptFailure.Authentication, is DeviceSocketAttemptFailure.Incompatible ->
            signal == WakeSignal.FOREGROUND
        else -> true
    }

    fun connectivityRestored() {
        consecutiveFailures = 0
    }

    fun recordConnected() {
        consecutiveFailures = 0
        lastFailure = null
    }

    fun recordFailure(failure: DeviceSocketAttemptFailure) {
        lastFailure = failure
        consecutiveFailures += 1
    }

    /** The wait the most recent failure earned. [jitter] is in `0..1`. */
    fun retryDelayMs(jitter: Double): Long {
        val backoff = jitteredBackoffMs(jitter)
        return when (lastFailure) {
            is DeviceSocketAttemptFailure.Authentication, is DeviceSocketAttemptFailure.Incompatible ->
                limits.refusedDelayMs
            DeviceSocketAttemptFailure.RateLimited -> max(backoff, limits.rateLimitedDelayMs)
            else -> backoff
        }
    }

    /** How long until the budget allows another attempt. */
    fun budgetDelayMs(nowMs: Long): Long {
        val allowance = limits.attemptRefillIntervalMs * (limits.attemptBurst - 1)
        return max(0, nextAttemptArrivalMs - allowance - nowMs)
    }

    fun recordAttemptStarted(nowMs: Long) {
        nextAttemptArrivalMs = max(nowMs, nextAttemptArrivalMs) + limits.attemptRefillIntervalMs
    }

    private fun jitteredBackoffMs(jitter: Double): Long {
        val exponent = max(consecutiveFailures - 1, 0).coerceAtMost(5)
        val base = min(limits.baseDelayMs shl exponent, limits.maxDelayMs)
        return base + (base * limits.jitterFraction * jitter).roundToLong()
    }
}
