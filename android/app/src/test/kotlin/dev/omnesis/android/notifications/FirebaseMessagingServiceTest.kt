// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.messaging.RemoteMessage
import dev.omnesis.android.transport.dto.ClaimedNotificationDelivery
import dev.omnesis.android.transport.GatewayException
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32])
class FirebaseMessagingServiceTest {
    @Test fun wake_timeout_diagnoses_only_a_started_unfinished_claim() = runTest {
        var notices = 0
        val drainMutex = Mutex(locked = true)
        runClaimWakeWithDeadline(
            timeoutMillis = 100,
            work = { claimStarted, _ -> drainMutex.withLock { claimStarted() } },
            onClaimTimeout = { notices += 1 },
        )
        assertEquals(0, notices) // Waiting behind another drain is not a gateway failure.
        drainMutex.unlock()

        runClaimWakeWithDeadline(
            timeoutMillis = 100,
            work = { claimStarted, _ -> claimStarted(); delay(200) },
            onClaimTimeout = { notices += 1 },
        )
        assertEquals(1, notices)

        runClaimWakeWithDeadline(
            timeoutMillis = 100,
            work = { claimStarted, claimCompleted -> claimStarted(); claimCompleted(); delay(200) },
            onClaimTimeout = { notices += 1 },
        )
        assertEquals(1, notices)
    }

    @Test fun failed_private_claim_reports_only_for_the_current_session() {
        val current = Any()
        var active: Any = current
        val failures = mutableListOf<Throwable>()
        val network = GatewayException.Network(java.net.ConnectException("refused"))

        kotlinx.coroutines.runBlocking {
            drainClaimedNotifications(
                session = current,
                maxItems = 1,
                isCurrent = { it === active },
                claim = { throw network },
                render = { _, _ -> error("claim failed") },
                onClaimFailure = { failures.add(it) },
                confirm = { _, _ -> error("claim failed") },
            )
        }
        assertEquals(listOf(network), failures)

        failures.clear()
        kotlinx.coroutines.runBlocking {
            drainClaimedNotifications(
                session = current,
                maxItems = 1,
                isCurrent = { it === active },
                claim = { active = Any(); throw network },
                render = { _, _ -> error("claim failed") },
                onClaimFailure = { failures.add(it) },
                confirm = { _, _ -> error("claim failed") },
            )
        }
        assertTrue(failures.isEmpty())
    }

    @Test fun synthetic_remote_messages_claim_render_and_confirm_all_six_kinds() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pushManager = FcmPushManager(context)
        val deliveries = mutableListOf(
            delivery("agent-answer", "conversation_answer", 1),
            delivery("conversation", "conversation_update", 2),
            delivery("brief", "brief_example", 3),
            delivery("watch", "watch_example", 4),
            delivery("needs-auth", "fictional:source", 5),
            delivery("privacy-approval", "approval_example", 6),
        )
        val session = Any()
        val confirmed = mutableListOf<String>()
        val processor = ClaimedWakeProcessor(
            currentSession = { session },
            claim = { deliveries.removeAt(0) },
            isCurrent = { it === session },
            render = { captured, delivery ->
                assertTrue(captured === session)
                assertTrue(pushManager.showClaimed(delivery))
                NotificationRenderOutcome.Rendered
            },
            reportDisabled = {},
            confirm = { _, id -> confirmed += id },
        )
        val service = OmnesisFirebaseMessagingService().apply {
            testClaimedWakeWork = processor::run
        }

        repeat(6) {
            service.onMessageReceived(
                RemoteMessage.Builder("fixture@example.test")
                    .setData(mapOf("wake" to "1"))
                    .build(),
            )
        }

        val systemManager = context.getSystemService(NotificationManager::class.java)
        assertEquals(6, shadowOf(systemManager).allNotifications.size)
        assertEquals(
            (1..6).map { "00000000-0000-4000-8000-${it.toString().padStart(12, '0')}" },
            confirmed,
        )
    }

    @Test fun synthetic_relay_challenge_cannot_fall_through_as_a_wake() {
        val events = mutableListOf<String>()
        val service = OmnesisFirebaseMessagingService().apply {
            testRelayChallengeWork = { events += "challenge:$it" }
            testClaimedWakeWork = { events += "wake" }
        }
        val message = RemoteMessage.Builder("fixture@example.test")
            .setData(mapOf("kind" to "relay-enrol-challenge", "nonce" to "nonce-example"))
            .build()

        service.onMessageReceived(message)

        assertEquals(listOf("challenge:nonce-example"), events)
    }

    @Test fun legacy_rich_payload_is_ignored() {
        val events = mutableListOf<String>()
        val orchestrator = FirebasePushOrchestrator(
            relayChallenge = { events += "challenge:$it" },
            contentFreeWake = { events += "wake" },
        )

        orchestrator.handle(
            mapOf(
                "kind" to "agent-answer",
                "conversationId" to "conversation-example",
                "title" to "Private title",
                "body" to "Private body",
            ),
        )

        assertEquals(emptyList<String>(), events)
    }

    @Test fun repaired_session_cannot_render_or_confirm_an_inflight_claim() {
        val original = Any()
        var current: Any = original
        var rendered = false
        var confirmed = false
        val processor = ClaimedWakeProcessor(
            currentSession = { original },
            claim = {
                current = Any()
                delivery("brief", "brief_stale", 7)
            },
            isCurrent = { it === current },
            render = { _, _ -> rendered = true; NotificationRenderOutcome.Rendered },
            reportDisabled = {},
            confirm = { _, _ -> confirmed = true },
        )

        kotlinx.coroutines.runBlocking { processor.run() }

        assertEquals(false, rendered)
        assertEquals(false, confirmed)
    }

    @Test fun bounded_drain_stops_at_the_requested_limit() {
        val session = Any()
        val deliveries = ArrayDeque((1..4).map { delivery("brief", "brief_$it", it) })
        val rendered = mutableListOf<String>()
        val confirmed = mutableListOf<String>()

        val count = kotlinx.coroutines.runBlocking {
            drainClaimedNotifications(
                session = session,
                maxItems = 2,
                isCurrent = { true },
                claim = { if (deliveries.isEmpty()) null else deliveries.removeFirst() },
                render = { _, delivery ->
                    rendered += delivery.id
                    NotificationRenderOutcome.Rendered
                },
                confirm = { _, id -> confirmed += id },
            )
        }

        assertEquals(2, count)
        assertEquals(2, rendered.size)
        assertEquals(rendered, confirmed)
        assertEquals(2, deliveries.size)
    }

    @Test fun malformed_known_delivery_is_confirmed_so_it_cannot_starve_the_queue() {
        val session = Any()
        var confirmed = false

        val count = kotlinx.coroutines.runBlocking {
            drainClaimedNotifications(
                session = session,
                maxItems = 1,
                isCurrent = { true },
                claim = { delivery("brief", "brief_failed", 8) },
                render = { _, _ -> NotificationRenderOutcome.RejectedInvalid },
                confirm = { _, _ -> confirmed = true },
            )
        }

        assertEquals(1, count)
        assertEquals(true, confirmed)
    }

    @Test fun render_uses_the_claimed_session_even_if_global_session_changes_after_guard() {
        val original = Any()
        var current: Any = original
        var checks = 0
        var renderedWith: Any? = null
        val processor = ClaimedWakeProcessor(
            currentSession = { original },
            claim = { delivery("brief", "brief_example", 10) },
            isCurrent = {
                checks += 1
                val matched = it === current
                if (matched && checks == 2) current = Any()
                matched
            },
            render = { captured, _ ->
                renderedWith = captured
                NotificationRenderOutcome.Rendered
            },
            reportDisabled = {},
            confirm = { _, _ -> },
        )

        kotlinx.coroutines.runBlocking { processor.run() }

        assertTrue(renderedWith === original)
        assertTrue(current !== original)
    }

    @Test fun render_outcomes_have_explicit_confirmation_policy() {
        val delivery = delivery("brief", "brief_example", 8)
        NotificationRenderOutcome.entries.forEach { outcome ->
            var confirmed = false
            val processor = ClaimedWakeProcessor(
                currentSession = { Unit },
                claim = { delivery },
                isCurrent = { true },
                render = { _, _ -> outcome },
                reportDisabled = {},
                confirm = { _, _ -> confirmed = true },
            )
            kotlinx.coroutines.runBlocking { processor.run() }
            assertEquals(outcome.shouldConfirm, confirmed)
        }
    }

    @Test fun notifications_disabled_reports_health_without_confirming_delivery() {
        val delivery = delivery("brief", "brief_example", 9)
        var reports = 0
        var confirmed = false
        val processor = ClaimedWakeProcessor(
            currentSession = { Unit },
            claim = { delivery },
            isCurrent = { true },
            render = { _, _ -> NotificationRenderOutcome.DeferredNotificationsDisabled },
            reportDisabled = { reports += 1 },
            confirm = { _, _ -> confirmed = true },
        )

        kotlinx.coroutines.runBlocking { processor.run() }

        assertEquals(1, reports)
        assertEquals(false, confirmed)
    }

    private fun delivery(kind: String, targetId: String, suffix: Int) =
        ClaimedNotificationDelivery(
            id = "00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}",
            kind = kind,
            targetId = targetId,
            title = "Fictional notification $suffix",
            body = "Invented notification body $suffix.",
            collapseId = "$kind:$targetId",
        )
}
