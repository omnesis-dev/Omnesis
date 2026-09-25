// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppForegroundPolicyTest {
    private val now = 2_000_000_000L

    @Test
    fun `3599 seconds reopens the exact conversation`() {
        assertEquals(
            AppForegroundDestination.Conversation("conversation-example"),
            destination(ageSeconds = 3_599, conversationId = "conversation-example"),
        )
    }

    @Test
    fun `3600 seconds starts fresh inclusively`() {
        assertEquals(
            AppForegroundDestination.FreshConversation,
            destination(ageSeconds = 3_600, conversationId = "conversation-example"),
        )
    }

    @Test
    fun `3601 seconds starts fresh`() {
        assertEquals(
            AppForegroundDestination.FreshConversation,
            destination(ageSeconds = 3_601, conversationId = "conversation-example"),
        )
    }

    @Test
    fun `missing snapshot starts fresh`() {
        assertEquals(
            AppForegroundDestination.FreshConversation,
            AppForegroundPolicy.destination(null, now),
        )
    }

    @Test
    fun `future snapshot starts fresh instead of trusting a moved clock`() {
        assertEquals(
            AppForegroundDestination.FreshConversation,
            AppForegroundPolicy.destination(
                AppForegroundSnapshot(
                    now + 1,
                    AppForegroundSurface.Conversation("conversation-example"),
                ),
                now,
            ),
        )
    }

    @Test
    fun `recent fresh snapshot preserves the empty conversation state`() {
        assertEquals(
            AppForegroundDestination.FreshConversation,
            destination(ageSeconds = 30, conversationId = null),
        )
    }

    @Test
    fun `recent non-agent surface preserves current navigation`() {
        assertEquals(
            AppForegroundDestination.PreserveCurrent,
            AppForegroundPolicy.destination(
                AppForegroundSnapshot(now - 30_000, AppForegroundSurface.OutsideAgent),
                now,
            ),
        )
    }

    private fun destination(ageSeconds: Long, conversationId: String?): AppForegroundDestination =
        AppForegroundPolicy.destination(
            AppForegroundSnapshot(
                backgroundedAtMillis = now - ageSeconds * 1_000,
                surface = conversationId
                    ?.let(AppForegroundSurface::Conversation)
                    ?: AppForegroundSurface.FreshConversation,
            ),
            now,
        )

    @Test
    fun `only a recent explicit fresh snapshot qualifies for same-process mint preservation`() {
        assertTrue(
            AppForegroundPolicy.isRecentFresh(
                AppForegroundSnapshot(now - 1, AppForegroundSurface.FreshConversation),
                now,
            ),
        )
        val disqualified = listOf(
            null,
            AppForegroundSnapshot(now, AppForegroundSurface.Conversation("conv-bootstrap")),
            AppForegroundSnapshot(now + 1, AppForegroundSurface.FreshConversation),
            AppForegroundSnapshot(
                now - AppForegroundPolicy.RECENT_WINDOW_MILLIS,
                AppForegroundSurface.FreshConversation,
            ),
        )
        disqualified.forEach { assertFalse(AppForegroundPolicy.isRecentFresh(it, now)) }
    }

}
