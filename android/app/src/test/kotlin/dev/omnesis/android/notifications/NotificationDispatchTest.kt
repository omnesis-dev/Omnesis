// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import dev.omnesis.android.transport.dto.ClaimedNotificationDelivery
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationDispatchTest {
    @Test
    fun content_free_wake_is_exact_and_contains_no_routing_data() {
        assertTrue(isContentFreeWake(mapOf("wake" to "1")))
        assertFalse(isContentFreeWake(mapOf("wake" to "1", "kind" to "brief")))
        assertFalse(isContentFreeWake(mapOf("wake" to "0")))
    }

    @Test
    fun diagnostic_notification_opens_the_app_without_a_deep_link() {
        assertEquals(
            ClaimedPushAction("diagnostic", NotificationTarget.App),
            notificationAction(
                notification(
                    "diagnostic",
                    "app",
                    """{"kind":"diagnostic"}""",
                ),
            ),
        )
    }

    @Test
    fun all_typed_notification_routes_dispatch_locally() {
        val cases = listOf(
            notification(
                "agent-answer",
                "fallback",
                """{"kind":"agent-answer","conversationId":"conv_answer"}""",
            ) to
                ClaimedPushAction("agent-answer", NotificationTarget.AgentConversation("conv_answer")),
            notification(
                "conversation",
                "fallback",
                """{"kind":"conversation","conversationId":"conv_update"}""",
            ) to
                ClaimedPushAction("conversation", NotificationTarget.AgentConversation("conv_update")),
            notification(
                "brief",
                "brief_daily",
                """{"kind":"brief","briefId":"brief_daily"}""",
            ) to
                ClaimedPushAction("brief", NotificationTarget.App),
            notification(
                "watch",
                "fallback",
                """{"kind":"watch","watchId":"watch_example","firingKey":"watch_example:17"}""",
            ) to ClaimedPushAction(
                "watch",
                NotificationTarget.WatchFiring("watch_example", "watch_example:17"),
            ),
            notification(
                "needs-auth",
                "fictional:account",
                """{"kind":"needs-auth","sourceId":"fictional:account","providerId":"fictional"}""",
            ) to
                ClaimedPushAction("needs-auth", NotificationTarget.App),
            notification(
                "privacy-approval",
                "fallback",
                """{"kind":"privacy-approval","approvalId":"approval_example"}""",
            ) to
                ClaimedPushAction(
                    "privacy-approval",
                    NotificationTarget.PrivacyApproval("approval_example"),
                ),
            notification(
                "access-authorization",
                "access",
                """{"kind":"access-authorization"}""",
            ) to ClaimedPushAction(
                "access-authorization",
                NotificationTarget.AccessAuthorization,
            ),
        )

        cases.forEach { (notification, expected) ->
            assertEquals(expected, notificationAction(notification))
        }
    }

    @Test fun access_authorization_never_accepts_a_request_identifier_from_push() {
        assertNull(notificationAction(notification("access-authorization", "request_secret")))
        assertEquals(
            ClaimedPushAction("access-authorization", NotificationTarget.AccessAuthorization),
            notificationAction(notification("access-authorization", "access")),
        )
    }

    @Test
    fun typed_watch_route_preserves_the_exact_firing_destination() {
        val notification = notification("watch", "watch_fallback").copy(
            route = Json.parseToJsonElement(
                """{"kind":"watch","watchId":"watch_example","firingKey":"watch_example:17"}""",
            ).jsonObject,
        )

        assertEquals(
            ClaimedPushAction(
                "watch",
                NotificationTarget.WatchFiring("watch_example", "watch_example:17"),
            ),
            notificationAction(notification),
        )
    }

    @Test
    fun lease_retry_keeps_one_stable_local_notification_identity() {
        val firstLease = notification("brief", "brief_example")
        val retryLease = firstLease.copy(id = "00000000-0000-4000-8000-000000000099")

        assertFalse(firstLease.id == retryLease.id)
        assertEquals(
            claimedNotificationIdentity(firstLease),
            claimedNotificationIdentity(retryLease),
        )
    }

    @Test
    fun mismatched_typed_route_cannot_override_the_flat_fallback() {
        val notification = notification("agent-answer", "conversation_fallback").copy(
            route = Json.parseToJsonElement(
                """{"kind":"conversation","conversationId":"conversation_wrong"}""",
            ).jsonObject,
        )

        assertEquals(
            ClaimedPushAction(
                "agent-answer",
                NotificationTarget.AgentConversation("conversation_fallback"),
            ),
            notificationAction(notification),
        )
    }

    @Test
    fun future_kinds_and_malformed_flat_targets_are_not_drawn() {
        assertNull(notificationAction(notification("future-kind", "example")))
        assertNull(notificationAction(notification("agent-answer", "bad/path")))
        assertNull(
            notificationAction(
                notification("brief", "bad/path"),
            ),
        )
    }

    @Test
    fun a_watch_firing_the_agent_wrote_about_opens_that_conversation() {
        // The banner quotes the agent's opening sentence, so the thread holds
        // the account. It outranks the firing's ledger line, which this app has
        // no screen for anyway.
        assertEquals(
            ClaimedPushAction("watch", NotificationTarget.AgentConversation("conv_firing")),
            notificationAction(
                notification(
                    "watch",
                    "watch_example",
                    """{"kind":"watch","watchId":"watch_example","firingKey":"watch_example:41",
                       "conversationId":"conv_firing"}""",
                ),
            ),
        )
    }

    @Test
    fun a_watch_firing_with_no_usable_conversation_falls_back_to_the_firing() {
        // A gateway that sends none, and one that sends a value this app will
        // not put in a nav route. Both keep the landing they already had.
        val routes = listOf(
            """{"kind":"watch","watchId":"watch_example","firingKey":"watch_example:41"}""",
            """{"kind":"watch","watchId":"watch_example","firingKey":"watch_example:41",
               "conversationId":"bad/path"}""",
        )
        routes.forEach { route ->
            assertEquals(
                ClaimedPushAction(
                    "watch",
                    NotificationTarget.WatchFiring("watch_example", "watch_example:41"),
                ),
                notificationAction(notification("watch", "watch_example", route)),
            )
        }
    }

    @Test
    fun malformed_typed_route_uses_the_safe_flat_fallback() {
        assertEquals(
            ClaimedPushAction("brief", NotificationTarget.App),
            notification("brief", "brief_fallback", """{"kind":{"nested":true}}""")
                .let(::notificationAction),
        )
    }

    @Test
    fun relay_challenge_is_distinct_from_a_wake() {
        val challenge = mapOf("kind" to "relay-enrol-challenge", "nonce" to "nonce_fictional")
        assertEquals("nonce_fictional", relayChallengeNonce(challenge))
        assertFalse(isContentFreeWake(challenge))
        assertNull(relayChallengeNonce(mapOf("kind" to "relay-enrol-challenge", "nonce" to "")))
    }

    private fun notification(kind: String, targetId: String, route: String? = null) =
        ClaimedNotificationDelivery(
            id = "00000000-0000-4000-8000-000000000001",
            kind = kind,
            targetId = targetId,
            title = "Fictional notification",
            body = "Invented notification body.",
            collapseId = "$kind:$targetId",
            route = route?.let { Json.parseToJsonElement(it).jsonObject },
        )
}
