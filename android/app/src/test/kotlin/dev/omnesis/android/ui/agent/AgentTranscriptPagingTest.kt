// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.AgentTrailRecord
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.BriefOriginSnapshot
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.UserPart
import org.junit.Assert.assertSame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptPagingTest {

    @Test
    fun older_complete_turns_prepend_without_rebuilding_the_live_suffix() {
        val currentMessages = listOf(
            ChatMessage.User(listOf(UserPart.Text("Current question"))),
            ChatMessage.Assistant(listOf(AssistantPart.Text("Current answer"))),
        )
        val current = AgentTurnBuilder.stateFrom(currentMessages)
        val currentSuffix = current.turns
        val olderMessages = listOf(
            ChatMessage.User(listOf(UserPart.Text("Earlier question"))),
            ChatMessage.Assistant(listOf(AssistantPart.Text("Earlier answer"))),
        )

        val merged = prependOlderTranscript(current, olderMessages, "older-page-")

        assertEquals(4, merged.turns.size)
        assertEquals(currentSuffix, merged.turns.takeLast(currentSuffix.size))
        assertSame(currentSuffix[0], merged.turns[merged.turns.size - currentSuffix.size])
        assertSame(currentSuffix[1], merged.turns.last())
        assertEquals("Earlier question", (merged.turns[0] as AgentTurn.User).text)
        assertTrue(merged.turns.take(2).all { it.id.startsWith("older-page-") })
        assertTrue(merged.turns.takeLast(2).none { it.id.startsWith("older-page-") })
    }

    @Test
    fun current_record_metadata_wins_when_older_page_contains_the_same_record() {
        val currentRecord = AgentTrailRecord(
            recordKey = "fictional_table:id=42",
            title = "Current title",
            semanticTime = "2026-01-02T00:00:00Z",
        )
        val current = AgentChatState(records = listOf(currentRecord))
        val older = AgentChatState(
            records = listOf(
                currentRecord.copy(title = "Stale title"),
                AgentTrailRecord(
                    recordKey = "fictional_table:id=7",
                    title = "Earlier record",
                    semanticTime = "2026-01-01T00:00:00Z",
                ),
            ),
        )

        val merged = mergeOlderRecords(older.records, current.records)

        assertEquals(listOf("Current title", "Earlier record"), merged.map { it.title })
        assertSame(currentRecord, merged.first())
    }

    @Test
    fun legacy_anchored_transcript_hides_seed_only_when_replacement_snapshot_exists() {
        val messages = listOf(
            ChatMessage.User(listOf(UserPart.Text("Folded seed"))),
            ChatMessage.Assistant(listOf(AssistantPart.Text("Seed answer"))),
            ChatMessage.User(listOf(UserPart.Text("Visible follow-up"))),
        )
        val origin = ConversationOrigin(
            kind = "brief",
            brief = BriefOriginSnapshot(title = "Invented brief", description = "Why it matters."),
            seedMessageCount = 2,
        )

        assertEquals(
            listOf(messages.last()),
            visibleConversationMessages(messages, origin),
        )
        assertEquals(
            messages,
            visibleConversationMessages(messages, origin.copy(brief = null)),
        )
        assertEquals(
            messages,
            visibleConversationMessages(messages, origin.copy(seedMessageCount = 99)),
        )
    }

    @Test
    fun current_gateway_visibility_marker_bypasses_legacy_projection_contract() {
        val messages = listOf(
            ChatMessage.User(listOf(UserPart.Text("Already visible"))),
        )
        val origin = ConversationOrigin(
            kind = "brief",
            brief = BriefOriginSnapshot(title = "Invented brief", description = "Why it matters."),
            seedMessageCount = 1,
        )

        val selected = selectVisibleConversationMessages(
            messages = messages,
            messagesAreVisible = true,
            origin = origin,
        )
        assertSame(messages, selected)
    }

    @Test
    fun temporal_origin_does_not_hide_messages() {
        val messages = listOf(
            ChatMessage.User(listOf(UserPart.Text("Folded seed"))),
            ChatMessage.Assistant(listOf(AssistantPart.Text("Seed answer"))),
            ChatMessage.User(listOf(UserPart.Text("Visible follow-up"))),
        )

        assertEquals(
            messages,
            visibleConversationMessages(
                messages,
                ConversationOrigin(
                    kind = "temporal_annotation",
                    seedMessageCount = 2,
                ),
            ),
        )
    }
}
