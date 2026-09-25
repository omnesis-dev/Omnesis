// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dagger.hilt.android.AndroidEntryPoint
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.ClaimedNotificationDelivery
import java.net.SocketTimeoutException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import android.util.Log
import javax.inject.Inject

@AndroidEntryPoint
class OmnesisFirebaseMessagingService : FirebaseMessagingService() {
    @Inject lateinit var pushManager: FcmPushManager
    @Inject lateinit var sessionManager: SessionManager

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    internal var testClaimedWakeWork: (suspend () -> Unit)? = null
    internal var testRelayChallengeWork: ((String) -> Unit)? = null

    override fun onNewToken(token: String) {
        pushManager.rememberRegistrationToken(token)
        serviceScope.launch { sessionManager.registerCurrentFcmToken(token) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        FirebasePushOrchestrator(
            relayChallenge = { nonce ->
                testRelayChallengeWork?.invoke(nonce)
                    ?: finishMessageWork { sessionManager.completeRelayEnrollment(nonce) }
            },
            contentFreeWake = {
                runBlocking(Dispatchers.IO) {
                    runClaimWakeWithDeadline(
                        timeoutMillis = MESSAGE_WORK_TIMEOUT_MS,
                        work = { claimStarted, claimCompleted ->
                            testClaimedWakeWork?.invoke() ?: claimAndShowOne(claimStarted, claimCompleted)
                        },
                        onClaimTimeout = {
                            pushManager.showClaimFailureDiagnostic(
                                GatewayException.Network(SocketTimeoutException("private claim timed out")),
                            )
                        },
                    )
                }
            },
        ).handle(message.data)
    }

    /** Keep Firebase's service callback alive while private content crosses the paired channel. */
    private fun finishMessageWork(block: suspend () -> Unit) {
        runBlocking(Dispatchers.IO) {
            withTimeoutOrNull(MESSAGE_WORK_TIMEOUT_MS) { block() }
        }
    }

    private suspend fun claimAndShowOne(onClaimStarted: () -> Unit, onClaimCompleted: () -> Unit) {
        sessionManager.drainPendingNotifications(
            maxItems = 1,
            onClaimStarted = onClaimStarted,
            onClaimCompleted = onClaimCompleted,
            onClaimFailure = pushManager::showClaimFailureDiagnostic,
        )
    }

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    private companion object {
        const val MESSAGE_WORK_TIMEOUT_MS = 18_000L
    }
}

/** A wake deadline diagnoses a stalled private claim, excluding mutex wait, rendering, and confirmation. */
internal suspend fun runClaimWakeWithDeadline(
    timeoutMillis: Long,
    work: suspend (onClaimStarted: () -> Unit, onClaimCompleted: () -> Unit) -> Unit,
    onClaimTimeout: () -> Unit,
) {
    var claimStarted = false
    var claimCompleted = false
    val finished = withTimeoutOrNull(timeoutMillis) {
        work({ claimStarted = true }, { claimCompleted = true })
        true
    } == true
    if (!finished && claimStarted && !claimCompleted) runCatching { onClaimTimeout() }
}

/** Claim/render/confirm transaction shared by production and the synthetic service proof. */
internal class ClaimedWakeProcessor<Session : Any>(
    private val currentSession: () -> Session?,
    private val claim: suspend (Session) -> ClaimedNotificationDelivery?,
    private val isCurrent: (Session) -> Boolean,
    private val render: (Session, ClaimedNotificationDelivery) -> NotificationRenderOutcome,
    private val reportDisabled: suspend (Session) -> Unit = {},
    private val confirm: suspend (Session, String) -> Unit,
) {
    suspend fun run() {
        val current = currentSession() ?: return
        drainClaimedNotifications(
            session = current,
            maxItems = 1,
            isCurrent = isCurrent,
            claim = claim,
            render = render,
            reportDisabled = reportDisabled,
            confirm = confirm,
        )
    }
}

/** Bounded, serialized by the caller, and stale-pairing safe at every side effect. */
internal suspend fun <Session : Any> drainClaimedNotifications(
    session: Session,
    maxItems: Int,
    isCurrent: (Session) -> Boolean,
    claim: suspend (Session) -> ClaimedNotificationDelivery?,
    render: (Session, ClaimedNotificationDelivery) -> NotificationRenderOutcome,
    reportDisabled: suspend (Session) -> Unit = {},
    onClaimFailure: (Throwable) -> Unit = {},
    onClaimStarted: () -> Unit = {},
    onClaimCompleted: () -> Unit = {},
    confirm: suspend (Session, String) -> Unit,
): Int {
    if (maxItems <= 0) return 0
    var delivered = 0
    repeat(maxItems) {
        if (!isCurrent(session)) return delivered
        val item = try {
            onClaimStarted()
            claim(session).also { onClaimCompleted() }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            if (isCurrent(session)) runCatching { onClaimFailure(error) }
            null
        } ?: return delivered
        if (!isCurrent(session)) return delivered
        val outcome = render(session, item)
        if (outcome == NotificationRenderOutcome.DeferredNotificationsDisabled) {
            try {
                reportDisabled(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // The delivery stays leased and the next wake can retry the report.
            }
        }
        if (!outcome.shouldConfirm) return delivered
        if (outcome == NotificationRenderOutcome.RejectedInvalid) {
            Log.w("Omnesis:notifications", "Discarding malformed notification delivery")
        }
        if (!isCurrent(session)) return delivered
        try {
            confirm(session, item.id)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return delivered
        }
        delivered += 1
    }
    return delivered
}

/** Testable orchestration boundary fed by the real Firebase service callback. */
internal class FirebasePushOrchestrator(
    private val relayChallenge: (String) -> Unit,
    private val contentFreeWake: () -> Unit,
) {
    fun handle(data: Map<String, String>) {
        relayChallengeNonce(data)?.let {
            relayChallenge(it)
            return
        }
        if (isContentFreeWake(data)) {
            contentFreeWake()
        }
    }
}
