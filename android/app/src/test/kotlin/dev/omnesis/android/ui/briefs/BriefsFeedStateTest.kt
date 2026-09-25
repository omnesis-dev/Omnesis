// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import dev.omnesis.android.transport.dto.BriefKindDto
import dev.omnesis.android.transport.dto.BriefReadStateDto
import dev.omnesis.android.transport.dto.BriefRecordDto
import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The feed's bookkeeping, without a gateway or a render. */
class BriefsFeedStateTest {
    private fun brief(id: String, unread: Boolean = true, kind: BriefKindDto = BriefKindDto.INFO) =
        BriefRecordDto(
            id = id,
            kind = kind,
            state = if (unread) BriefReadStateDto.UNREAD else BriefReadStateDto.READ,
            title = "Brief $id",
            description = "Something worth a glance",
            createdAt = "2026-05-15T13:00:00Z",
        )

    private val feed = BriefsFeedState().replacing(
        listOf(brief("a"), brief("b", unread = false), brief("c")),
    )

    @Test
    fun `unread counts only briefs the server called unread`() {
        assertEquals(2, feed.unreadCount)
        assertTrue(feed.isUnread("a"))
        assertFalse(feed.isUnread("b"))
    }

    /**
     * Opening a brief must silence its row at once — not on the next fetch — so viewing is
     * tracked here rather than read back off the record.
     */
    @Test
    fun `marking viewed silences the row immediately`() {
        val next = feed.markingViewed("a")!!
        assertFalse(next.isUnread("a"))
        assertEquals(1, next.unreadCount)
    }

    /** Null means "nothing to do", so the caller can skip a redundant mark-read POST. */
    @Test
    fun `marking an already-read brief reports nothing to do`() {
        assertNull(feed.markingViewed("b"))
        val once = feed.markingViewed("a")!!
        assertNull(once.markingViewed("a"))
    }

    @Test
    fun `removing lifts the brief out and remembers where it was`() {
        val (next, removed) = feed.removing("b")!!
        assertEquals(listOf("a", "c"), next.briefs.map { it.id })
        assertEquals(1, removed.index)
        assertEquals("b", removed.record.id)
    }

    @Test
    fun `removing an unknown id reports nothing removed`() {
        assertNull(feed.removing("nope"))
    }

    /** A failed dismiss must not silently reorder the feed under the user. */
    @Test
    fun `restoring puts the brief back where it was`() {
        val (next, removed) = feed.removing("b")!!
        assertEquals(listOf("a", "b", "c"), next.restoring(removed).briefs.map { it.id })
    }

    /** A restore that raced a refresh which already re-listed the brief is a no-op. */
    @Test
    fun `restoring a brief the feed already holds changes nothing`() {
        val (next, removed) = feed.removing("b")!!
        val refreshed = next.replacing(listOf(brief("a"), brief("b"), brief("c")))
        assertEquals(listOf("a", "b", "c"), refreshed.restoring(removed).briefs.map { it.id })
    }

    /** A re-fetched page must not duplicate rows the feed already holds. */
    @Test
    fun `appending drops ids already held`() {
        val grown = feed.appending(listOf(brief("c"), brief("d")))
        assertEquals(listOf("a", "b", "c", "d"), grown.briefs.map { it.id })
    }

    /** A refresh that drops a brief must also drop the memory of having viewed it. */
    @Test
    fun `replacing forgets viewed ids no longer in the feed`() {
        val viewed = feed.markingViewed("a")!!
        val replaced = viewed.replacing(listOf(brief("c")))
        assertEquals(1, replaced.unreadCount)
    }

    @Test
    fun `clear action pairs the reason with the kind`() {
        assertEquals("Done", BriefKindDto.LOOP.clearActionLabel)
        assertEquals("Got it", BriefKindDto.INFO.clearActionLabel)
        assertEquals("already_handled", BriefKindDto.LOOP.clearActionReason.wire)
        assertEquals("acknowledged", BriefKindDto.INFO.clearActionReason.wire)
    }

    @Test
    fun `row description removes emphasis markers without changing its words`() {
        assertEquals(
            "Review the updated budget before Friday",
            briefRowPlainDescription("Review the **updated** budget before __Friday__"),
        )
    }

    @Test
    fun `snooze presets match the shared Briefs contract`() {
        val now = Instant.parse("2026-08-20T10:15:00Z")
        val zone = ZoneId.of("Europe/London")
        assertEquals(
            Instant.parse("2026-08-20T13:15:00Z"),
            resolveBriefSnooze(BriefSnoozeChoice.LATER_TODAY, now, zone),
        )
        // August is BST, so 09:00 local is 08:00Z.
        assertEquals(
            Instant.parse("2026-08-21T08:00:00Z"),
            resolveBriefSnooze(BriefSnoozeChoice.TOMORROW, now, zone),
        )
        assertNull(resolveBriefSnooze(BriefSnoozeChoice.AGENT_DECIDES, now, zone))
    }

    @Test
    fun `picked snooze time passes through exactly`() {
        val picked = Instant.parse("2026-08-22T14:30:00Z")
        assertEquals(
            picked,
            resolveBriefSnooze(
                BriefSnoozeChoice.PICK_A_TIME,
                Instant.parse("2026-08-20T10:15:00Z"),
                ZoneId.of("UTC"),
                picked,
            ),
        )
    }

    @Test
    fun `picked snooze must still be future when the form is confirmed`() {
        val now = Instant.parse("2026-08-20T10:15:00Z")
        assertTrue(
            isBriefSnoozeValid(
                BriefSnoozeChoice.PICK_A_TIME,
                now,
                Instant.parse("2026-08-20T10:16:00Z"),
            ),
        )
        assertFalse(isBriefSnoozeValid(BriefSnoozeChoice.PICK_A_TIME, now, now))
        assertFalse(
            isBriefSnoozeValid(
                BriefSnoozeChoice.PICK_A_TIME,
                now,
                Instant.parse("2026-08-20T10:14:00Z"),
            ),
        )
        assertTrue(isBriefSnoozeValid(BriefSnoozeChoice.AGENT_DECIDES, now, null))
    }

    @Test
    fun `refresh discards dictation when the microphone owning brief disappears`() {
        val current = BriefsFeedState().replacing(listOf(brief("recording"), brief("remaining")))

        val transition = replaceBriefFeed(
            current = current,
            incoming = listOf(brief("remaining")),
            dictatingBriefId = "recording",
        )

        assertEquals(listOf("remaining"), transition.feed.briefs.map { it.id })
        assertTrue(transition.discardedDictation)
        assertNull(transition.retainedDictatingBriefId)
    }

    @Test
    fun `refresh keeps dictation when its brief remains in the feed`() {
        val current = BriefsFeedState().replacing(listOf(brief("recording")))

        val transition = replaceBriefFeed(
            current = current,
            incoming = listOf(brief("recording"), brief("new")),
            dictatingBriefId = "recording",
        )

        assertFalse(transition.discardedDictation)
        assertEquals("recording", transition.retainedDictatingBriefId)
    }

    @Test
    fun `refresh without active dictation does not report a discard`() {
        val transition = replaceBriefFeed(
            current = BriefsFeedState().replacing(listOf(brief("old"))),
            incoming = listOf(brief("new")),
            dictatingBriefId = null,
        )

        assertFalse(transition.discardedDictation)
        assertNull(transition.retainedDictatingBriefId)
    }
}
