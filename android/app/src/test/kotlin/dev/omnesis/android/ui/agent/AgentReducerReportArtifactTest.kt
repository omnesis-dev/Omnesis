// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentUsage
import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.DeepResearchPlanItem
import dev.omnesis.android.transport.dto.DeepResearchVerification
import dev.omnesis.android.transport.dto.UserPart
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Spec for the verified-report artifact reduction + badge, the Android twin of the
 * iOS `attachReportArtifact` / `ReportVerificationBadge` tests + the portal report-artifact
 * reducer tests. The additive `agent.deep_research.summary` event folds onto its named
 * assistant turn as a `reportArtifact` field; an absent event yields no artifact (the bubble
 * degrades to plain prose); the badge is driven by the REAL quote tally, never hardcoded.
 */
class AgentReducerReportArtifactTest {

    private val S = "s"
    private val M = "a1"

    private fun reduce(state: AgentChatState, vararg events: AgentEvent): AgentChatState {
        var s = state
        for (e in events) s = AgentReducer.reduce(s, e)
        return s
    }

    private fun seeded() = reduce(
        AgentChatState(),
        AgentEvent.MessageStart(S, M),
        AgentEvent.TextDelta(S, M, "## Findings\nThe budget was approved."),
    )

    private fun summary(
        reason: String = "answer_complete",
        checked: Int = 3,
        verified: Int = 3,
        tree: AgentUsage? = AgentUsage(inputTokens = 7000, outputTokens = 2000),
    ) = AgentEvent.DeepResearchSummary(
        sessionId = S,
        messageId = M,
        stoppedReason = reason,
        plan = listOf(DeepResearchPlanItem("history-sweep", "Find prior decisions")),
        treeUsage = tree,
        verification = DeepResearchVerification(checked, verified),
    )

    private fun assistant(state: AgentChatState) =
        state.turns.last() as AgentTurn.Assistant

    @Test
    fun summary_event_folds_onto_named_turn_as_report_artifact() {
        val state = reduce(seeded(), summary())
        val artifact = assistant(state).reportArtifact
        assertEquals("answer_complete", artifact?.stoppedReason)
        assertEquals(1, artifact?.plan?.size)
        assertEquals(9000, artifact?.treeUsage?.total)
        assertEquals(3, artifact?.verification?.quotesVerified)
    }

    @Test
    fun absent_summary_leaves_no_artifact_so_bubble_degrades_to_prose() {
        // An ordinary turn / an older or resumed Deep Research run never carries the event.
        val state = reduce(seeded(), AgentEvent.MessageEnd(S, M, "end_turn"))
        assertNull(assistant(state).reportArtifact)
    }

    @Test
    fun summary_for_unknown_message_id_is_a_noop_graceful_degrade() {
        val state = reduce(seeded(), summary().copy(messageId = "no-such-turn"))
        assertNull(assistant(state).reportArtifact)
    }

    @Test
    fun summary_folds_even_mid_run_before_message_end() {
        // Not turn-extending: it bypasses the ephemeral causality gate, so it lands while
        // the turn is still open (no stopReason yet).
        val state = reduce(seeded(), summary())
        assertNull(assistant(state).stopReason)
        assertEquals("answer_complete", assistant(state).reportArtifact?.stoppedReason)
    }

    @Test
    fun later_message_end_keeps_the_already_attached_artifact() {
        val state = reduce(seeded(), summary(), AgentEvent.MessageEnd(S, M, "end_turn"))
        assertEquals("end_turn", assistant(state).stopReason)
        assertEquals("answer_complete", assistant(state).reportArtifact?.stoppedReason)
    }

    // --- resume: rebuild artifact + seed citations from the persisted part ---

    @Test
    fun resume_rebuilds_report_artifact_and_seeds_citations_from_persisted_part() {
        // On reload the live `agent.deep_research.summary` event is gone — the gateway persists the
        // artifact (facts + merged citations) as a `report_artifact` assistant part instead. The
        // resume builder must rebuild the same card AND seed the same Citations set the live run
        // showed (a deep-research run cites via the merged set, never `annotate` pairs, so the
        // plain citation walk reconstructs none). Mirrors the iOS
        // testTurnsRebuildReportArtifactFromPersistedPart + the portal load-conversation reducer.
        val messages = listOf<ChatMessage>(
            ChatMessage.User(listOf(UserPart.Text("what was that bank charge?"))),
            ChatMessage.Assistant(
                listOf(
                    AssistantPart.Text("It was a hotel booking."),
                    AssistantPart.ReportArtifact(
                        stoppedReason = "answer_complete",
                        plan = listOf(DeepResearchPlanItem("history-sweep", "Find the charge")),
                        treeUsage = AgentUsage(inputTokens = 7000, outputTokens = 2000),
                        verification = DeepResearchVerification(2, 2),
                        citations = listOf(
                            AgentDocRef(documentId = "d1", sourceType = "enable-banking-accounts", sourceId = "enable-banking-accounts:self", title = "Tokyo Riverside Hotel"),
                            AgentDocRef(documentId = "d2", sourceType = "gmail", sourceId = "gmail:me", title = "Confirmation"),
                            // Duplicate documentId — must collapse.
                            AgentDocRef(documentId = "d1", sourceType = "enable-banking-accounts", sourceId = "enable-banking-accounts:self", title = "Tokyo Riverside Hotel"),
                        ),
                    ),
                ),
            ),
        )

        val state = AgentTurnBuilder.stateFrom(messages)

        // The card rebuilt onto the assistant turn; the part is not a render slot.
        val turn = state.turns.last() as AgentTurn.Assistant
        assertEquals("answer_complete", turn.reportArtifact?.stoppedReason)
        assertEquals(9000, turn.reportArtifact?.treeUsage?.total)
        assertEquals(2, turn.reportArtifact?.verification?.quotesVerified)
        assertTrue(turn.parts.all { it is AgentPart.Text })

        // Citations seeded from the artifact (no `annotate` pairs here), deduped by documentId.
        assertEquals(listOf("d1", "d2"), state.citations.map { it.documentId })
        assertEquals(0, state.citationsByDocId["d1"])
        assertEquals(1, state.citationsByDocId["d2"])
    }

    // --- badge: driven by the REAL tally, never hardcoded ---

    @Test
    fun badge_all_verified_is_ok() {
        val b = ReportVerificationBadge.of(DeepResearchVerification(4, 4))
        assertEquals(ReportVerificationBadge.Kind.OK, b.kind)
        assertEquals("4/4 quotes verified", b.text)
    }

    @Test
    fun badge_partial_verification_is_partial() {
        val b = ReportVerificationBadge.of(DeepResearchVerification(4, 2))
        assertEquals(ReportVerificationBadge.Kind.PARTIAL, b.kind)
        assertEquals("2/4 quotes verified", b.text)
    }

    @Test
    fun badge_no_quotes_is_neutral_not_a_misleading_green_tick() {
        val b = ReportVerificationBadge.of(DeepResearchVerification(0, 0))
        assertEquals(ReportVerificationBadge.Kind.NEUTRAL, b.kind)
        assertEquals("No quotes to verify", b.text)
    }

    // --- stoppedReason labels: honest per terminal state, raw fallback for unknown ---

    @Test
    fun stopped_reason_labels_render_each_terminal_state() {
        assertEquals("Answer complete", deepResearchStoppedReasonLabel("answer_complete"))
        assertEquals("No verifiable findings", deepResearchStoppedReasonLabel("no_results"))
        assertEquals("Sub-agent token budget exhausted", deepResearchStoppedReasonLabel("budget_exhausted"))
        assertEquals("Fan-out hit a structural cap", deepResearchStoppedReasonLabel("depth_or_concurrency_capped"))
        // Forward-compat: an unknown reason surfaces its raw value, never hides it.
        assertEquals("some_future_reason", deepResearchStoppedReasonLabel("some_future_reason"))
    }

    // --- inline marker deep-link target: in-app doc page, never an external URL ---

    @Test
    fun citation_marker_opens_by_documentId_in_app_never_an_external_url() {
        // The merged set is a single ordered list (no per-sub-agent attribution); each
        // marker opens by the citation's own documentId through onOpenDocument → the
        // in-app doc page. A Roborazzi snapshot can't drive the tap, so the target is
        // asserted directly. Mirrors the iOS testCitationMarkerCarriesInAppDocLinkTarget.
        val citations = listOf(
            AgentCitation("doc-deck", AgentDocRef(documentId = "doc-deck", sourceId = "gmail:demo", title = "Q4 deck")),
            AgentCitation("doc-thread", AgentDocRef(documentId = "doc-thread", sourceId = "whatsapp:demo", title = "Sign-off thread")),
        )
        assertEquals(listOf("doc-deck", "doc-thread"), citations.map { reportCitationTarget(it) })
        for (c in citations) {
            assertEquals(c.documentId, reportCitationTarget(c))
            assertNull("in-app link target — not an external URL", c.ref.url)
        }
        assertTrue(citations.isNotEmpty())
    }
}
