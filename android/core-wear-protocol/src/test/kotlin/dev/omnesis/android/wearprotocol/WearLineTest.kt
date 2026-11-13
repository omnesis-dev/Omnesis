// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearLineTest {
    @Test
    fun an_answer_is_shown_as_it_is() {
        assertEquals("The ferry leaves at 09:40.", WearLine.forOutcome(AskOutcome.Answered("The ferry leaves at 09:40.")))
    }

    @Test
    fun every_fixed_outcome_has_its_line() {
        val lines = mapOf(
            AskOutcome.EmptyAnswer to "The agent finished without a spoken answer. Check the conversation in Omnesis.",
            AskOutcome.StillWorking to "Still working on it — I'll send you the answer as a notification.",
            AskOutcome.PreviousTurnRunning to
                "Still working on your last question — that answer is on the way. Ask me again in a moment.",
            AskOutcome.NotPaired to "Omnesis isn't paired with a gateway yet. Open the app to pair first.",
            AskOutcome.ExperimentalOff to "This gateway version doesn't support asking by voice. Update your gateway.",
            AskOutcome.Unauthorized to "Omnesis couldn't authenticate. Re-pair with your gateway from the app.",
            AskOutcome.Unreachable to "Sorry, I couldn't reach your Omnesis gateway.",
            AskOutcome.SendFailed to "Sorry, I couldn't send that question to your gateway.",
            AskOutcome.PhoneUnreachable to
                "I couldn't reach your phone. Make sure it's nearby and unlocked, then try again.",
            AskOutcome.WatchLinkInactive to "The watch couldn't open its link to your phone. Try again in a moment.",
            AskOutcome.RelayFailed to "Sorry, something went wrong reaching your phone.",
            AskOutcome.AnswerOnPhone to
                "I got your answer but couldn't bring it to your watch. It's waiting in Omnesis on your phone.",
            AskOutcome.QueuedForPhone to
                "Your phone didn't respond in time, so I've queued your question. " +
                "The answer will arrive as a notification once your phone picks it up.",
        )
        for ((outcome, line) in lines) assertEquals(line, WearLine.forOutcome(outcome))
    }

    @Test
    fun no_line_names_another_platforms_devices() {
        for (line in WearLine.entries) {
            assertFalse(line.name, line.text.contains("iPhone"))
            assertFalse(line.name, line.text.contains("Apple"))
            assertFalse(line.name, line.text.contains("Siri"))
            assertTrue(line.name, line.text.isNotBlank())
        }
    }

    @Test
    fun a_failure_speaks_the_gateways_reason_as_one_sentence() {
        assertEquals(
            "Sorry — The model provider does not have the assigned model.",
            WearLine.forOutcome(AskOutcome.Failed("The model provider does not have the assigned model.")),
        )
        assertEquals("Sorry — Rate limit reached.", WearLine.failure("  Rate limit reached \nRetry after 30 s"))
        assertEquals("Sorry — Is the gateway awake?", WearLine.failure("Is the gateway awake?"))
        assertEquals("Sorry — Out of credit!", WearLine.failure("Out of credit!"))
    }

    @Test
    fun an_unusable_reason_falls_back_to_the_generic_apology() {
        val generic = "Sorry, something went wrong while answering. Check the conversation in Omnesis."
        assertEquals(generic, WearLine.forOutcome(AskOutcome.Failed(null)))
        assertEquals(generic, WearLine.failure(""))
        assertEquals(generic, WearLine.failure("   \nSecond line only"))
        assertEquals(generic, WearLine.failure("x".repeat(161)))
        assertEquals("Sorry — ${"x".repeat(160)}.", WearLine.failure("x".repeat(160)))
    }

    @Test
    fun a_status_is_titled_by_where_the_question_is() {
        assertEquals("Queued for phone", WearLine.statusTitle(AskOutcome.QueuedForPhone))
        assertEquals("Still working", WearLine.statusTitle(AskOutcome.StillWorking))
        assertEquals("Still working", WearLine.statusTitle(AskOutcome.AnswerOnPhone))
    }

    @Test
    fun dropped_notes_are_counted() {
        assertEquals("A note wasn't sent", WearLine.notesNotSent(1))
        assertEquals("3 notes weren't sent", WearLine.notesNotSent(3))
    }

    // Activity.

    @Test
    fun tools_map_to_coarse_labels() {
        val labels = mapOf(
            "search_documents" to "Searching…",
            "search_many" to "Searching…",
            "list_loops" to "Searching…",
            "fetch_document" to "Reading…",
            "fetch_many" to "Reading…",
            "lookup_document_by_url" to "Reading…",
            "lookup_people" to "Looking up people…",
            "run_sql" to "Checking records…",
            "trace_connections" to "Tracing links…",
            "temporal_query" to "Checking dates…",
            "time_index_query" to "Checking dates…",
            "entity_context" to "Gathering context…",
            "cite_record" to "Noting sources…",
            "annotate_many" to "Noting sources…",
            "spawn_subagent" to "Looking deeper…",
            "join_subagents" to "Looking deeper…",
            "plan" to "Planning…",
            "watch_create" to "Setting up a watch…",
            "a_tool_from_a_newer_gateway" to "Working…",
        )
        for ((tool, label) in labels) assertEquals(tool, label, AskActivity.labelForTool(tool))
    }

    @Test
    fun every_label_fits_the_status_line() {
        assertEquals(22, AskActivity.MAX_RENDERABLE_LABEL_LENGTH)
        assertEquals("Working…", AskActivity.fallbackLabel)
        assertEquals("Waking your phone…", AskActivity.wakingPhoneLabel)
        for (label in AskActivity.allLabels) {
            assertTrue(label, label.length <= AskActivity.MAX_RENDERABLE_LABEL_LENGTH)
            assertEquals(AskActivitySnapshot(label), AskProgress.of(AskActivitySnapshot(label), null).snapshot)
        }
    }

    @Test
    fun the_status_line_joins_step_and_detail() {
        assertEquals("Searching… · 12 found", AskActivitySnapshot("Searching…", "12 found").line)
        assertEquals("Thinking…", AskActivitySnapshot("Thinking…").line)
        assertEquals("Thinking…", AskActivitySnapshot("Thinking…", "").line)
    }

    @Test
    fun the_timeline_follows_a_turn() {
        val timeline = AskActivityTimeline()
        assertEquals("Working…", timeline.snapshot.line)
        assertEquals("Received", timeline.apply(AskActivityEvent.RelayReceived).line)
        assertEquals("Asking…", timeline.apply(AskActivityEvent.Connecting).line)
        assertEquals("Asking…", timeline.apply(AskActivityEvent.RequestSent).line)
        assertEquals("Thinking…", timeline.apply(AskActivityEvent.AgentStarted).line)
        assertEquals("Searching…", timeline.apply(AskActivityEvent.ToolStarted("t1", "search_documents")).line)
        assertEquals(
            "Searching… · 12 found",
            timeline.apply(AskActivityEvent.ToolFinished("t1", AskToolOutcome.Search(12))).line,
        )
        assertEquals("Reading… · 12 found", timeline.apply(AskActivityEvent.ToolStarted("t2", "fetch_document")).line)
        assertEquals(
            "Reading… · 1 read",
            timeline.apply(AskActivityEvent.ToolFinished("t2", AskToolOutcome.DocumentOpened)).line,
        )
        assertEquals(
            "Reading… · 15 found",
            timeline.apply(AskActivityEvent.ToolFinished("t3", AskToolOutcome.Search(3))).line,
        )
    }

    @Test
    fun replayed_events_change_nothing() {
        val timeline = AskActivityTimeline()
        timeline.apply(AskActivityEvent.AgentStarted)
        timeline.apply(AskActivityEvent.ToolStarted("t1", "search_documents"))
        timeline.apply(AskActivityEvent.ToolFinished("t1", AskToolOutcome.Search(4)))
        timeline.apply(AskActivityEvent.ToolStarted("t2", "run_sql"))
        val before = timeline.snapshot
        assertEquals(before, timeline.apply(AskActivityEvent.AgentStarted))
        assertEquals(before, timeline.apply(AskActivityEvent.ToolStarted("t1", "search_documents")))
        assertEquals(before, timeline.apply(AskActivityEvent.ToolFinished("t1", AskToolOutcome.Search(4))))
        assertEquals("Checking records… · 4 found", before.line)
    }

    @Test
    fun a_batch_counts_once_whether_or_not_its_children_reported() {
        val withChildren = AskActivityTimeline()
        withChildren.apply(AskActivityEvent.ToolFinished("b1#0", AskToolOutcome.Search(5)))
        withChildren.apply(AskActivityEvent.ToolFinished("b1#1", AskToolOutcome.Search(2)))
        assertEquals("7 found", withChildren.apply(AskActivityEvent.ToolFinished("b1", AskToolOutcome.Batch(7, 0))).detail)

        val alone = AskActivityTimeline()
        assertEquals("7 found", alone.apply(AskActivityEvent.ToolFinished("b1", AskToolOutcome.Batch(7, 0))).detail)
        assertEquals("2 read", alone.apply(AskActivityEvent.ToolFinished("b2", AskToolOutcome.Batch(1, 2))).detail)
    }

    @Test
    fun nothing_found_shows_no_detail_and_negative_counts_are_ignored() {
        val timeline = AskActivityTimeline()
        assertEquals(null, timeline.apply(AskActivityEvent.ToolFinished("t1", AskToolOutcome.Search(0))).detail)
        assertEquals(null, timeline.apply(AskActivityEvent.ToolFinished("t2", AskToolOutcome.Search(-4))).detail)
        assertEquals(null, timeline.apply(AskActivityEvent.ToolFinished("t3", AskToolOutcome.None)).detail)
    }
}
