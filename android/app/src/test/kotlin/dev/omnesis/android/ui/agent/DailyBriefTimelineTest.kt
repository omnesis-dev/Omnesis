// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AgentTrailRecord
import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.DailyBriefMessageRef
import dev.omnesis.android.transport.dto.UserPart
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Morning brief conversation's timeline covers only the latest brief and what followed it,
 * while every other thread keeps its whole timeline. All fixture data is invented.
 */
class DailyBriefTimelineTest {

    private fun brief(text: String) = ChatMessage.Assistant(listOf(AssistantPart.Text(text)))

    private fun user(text: String) = ChatMessage.User(listOf(UserPart.Text(text)))

    /** A turn that cites [docId] through `annotate`, answering with a tool call and its result. */
    private fun citingTurn(callId: String, docId: String, quote: String): List<ChatMessage> = listOf(
        ChatMessage.Assistant(listOf(AssistantPart.ToolUse(callId, "annotate", JsonObject(emptyMap())))),
        ChatMessage.User(
            listOf(
                UserPart.ToolResultPart(
                    callId,
                    AgentToolResult.AnnotateRecorded(
                        documentId = docId,
                        ref = AgentDocRef(documentId = docId, sourceId = "notes:local", title = "Doc $docId"),
                        quote = quote,
                    ),
                ),
            ),
        ),
        ChatMessage.Assistant(listOf(AssistantPart.Text("Answer citing $docId."))),
    )

    private fun origin(vararg indices: Int) = ConversationOrigin(
        kind = ConversationOrigin.DAILY_BRIEF_KIND,
        runId = "run_example",
        briefs = indices.mapIndexed { n, i -> DailyBriefMessageRef("2026-10-${10 + n}", i, "mb_$n") },
    )

    /**
     * Day one: brief, a question citing doc-old. Day two: brief, a question citing doc-new and
     * doc-shared, the latter cited on day one as well.
     */
    private val transcript: List<ChatMessage> =
        listOf(brief("Monday's brief"), user("What about the lease?")) +
            citingTurn("call_old", "doc-old", "Old quote") +
            citingTurn("call_shared_1", "doc-shared", "First mention") +
            listOf(brief("Tuesday's brief"), user("And the invoice?")) +
            citingTurn("call_new", "doc-new", "New quote") +
            citingTurn("call_shared_2", "doc-shared", "Second mention")

    private val tuesdayIndex = 8

    private fun drawer(scope: TimelineScope?, messages: List<ChatMessage>): List<AgentCitation> {
        val all = AgentReducer.drawerCitations(AgentTurnBuilder.stateFrom(messages))
        return scope?.citations(all) ?: all
    }

    @Test
    fun the_timeline_starts_at_the_latest_brief() {
        val scope = TimelineScope.forLoaded(origin(0, tuesdayIndex), transcript, transcript.size)!!

        val shown = drawer(scope, transcript)

        assertEquals(setOf("doc-new", "doc-shared"), shown.map { it.documentId }.toSet())
        val shared = shown.single { it.documentId == "doc-shared" }
        assertEquals(listOf("Second mention"), shared.entries.map { it.quote })
    }

    @Test
    fun other_conversations_keep_their_whole_timeline() {
        assertNull(TimelineScope.forLoaded(null, transcript, transcript.size))
        assertNull(
            TimelineScope.forLoaded(
                ConversationOrigin(kind = "watch_firing", watchId = "w"),
                transcript,
                transcript.size,
            ),
        )
        // A Morning brief thread whose index is empty has no boundary to scope to.
        assertNull(TimelineScope.forLoaded(origin(), transcript, transcript.size))
    }

    /**
     * Only the newest page is loaded at first, placed by counting back from the end. Pages
     * start where a turn does, so Tuesday's brief closes the older page; when older pages join,
     * what they cite lands on the earlier side of the boundary.
     */
    @Test
    fun older_pages_join_the_earlier_side_of_the_boundary() {
        val newest = transcript.subList(9, transcript.size)
        val scope = TimelineScope.forLoaded(origin(0, tuesdayIndex), newest, transcript.size)!!
        assertEquals(9, scope.firstLoaded)
        assertEquals(setOf("doc-new", "doc-shared"), drawer(scope, newest).map { it.documentId }.toSet())

        val older = transcript.subList(1, 9)
        val widened = scope.withOlder(older)
        assertEquals(1, widened.firstLoaded)
        val loaded = transcript.subList(1, transcript.size)
        val shown = drawer(widened, loaded)
        assertEquals(setOf("doc-new", "doc-shared"), shown.map { it.documentId }.toSet())
        assertEquals(
            listOf("Second mention"),
            shown.single { it.documentId == "doc-shared" }.entries.map { it.quote },
        )

        // The unscoped drawer would have shown day one's citations too.
        assertEquals(setOf("doc-old", "doc-new", "doc-shared"), drawer(null, loaded).map { it.documentId }.toSet())
    }

    @Test
    fun records_cited_only_before_the_latest_brief_leave_the_timeline() {
        val scope = TimelineScope(
            floor = 4,
            firstLoaded = 0,
            earlierRecords = setOf("row:old", "row:both"),
            laterRecords = setOf("row:both", "row:new"),
        )
        val records = listOf("row:old", "row:both", "row:new", "row:live").map {
            AgentTrailRecord(recordKey = it)
        }
        assertEquals(listOf("row:both", "row:new", "row:live"), scope.records(records).map { it.recordKey })
    }
}
