// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The reference drawer must surface ONLY annotate-recorded citations — each carries a
 * quote entry or a doc note. The merged citation set a Deep Research run emits
 * (`agent.citations.update`: refs without entries) belongs to the report-artifact card
 * alone. This guards parity with iOS and the portal: the drawer stays untouched during a
 * Deep Research run instead of duplicating the report card's sources. All fixture data is
 * invented (privacy rule).
 */
class AgentReducerDrawerCitationsTest {

    private fun annotateCitation(id: String) = AgentCitation(
        documentId = id,
        ref = AgentDocRef(documentId = id, sourceId = "gmail:me", title = "Quoted $id"),
        entries = listOf(
            AgentCitationEntry(
                toolCallId = "tc-$id",
                messageId = "m",
                quote = "a quoted line",
                note = null,
                quoteAuthor = null,
            ),
        ),
    )

    private fun notedCitation(id: String) = AgentCitation(
        documentId = id,
        ref = AgentDocRef(documentId = id, sourceId = "notes:local", title = "Noted $id"),
        docNote = "a recorded note",
    )

    /** A merged Deep Research ref: just a document, no quote entry or note. */
    private fun mergedRef(id: String) = AgentCitation(
        documentId = id,
        ref = AgentDocRef(documentId = id, sourceId = "enable-banking-accounts:self", title = "Charge $id"),
    )

    @Test
    fun drawer_keeps_annotate_citations_drops_the_merged_deep_research_set() {
        val state = AgentChatState(
            citations = listOf(
                annotateCitation("d-quote"),
                mergedRef("d-bank-1"),
                notedCitation("d-note"),
                mergedRef("d-bank-2"),
            ),
        )
        assertEquals(
            listOf("d-quote", "d-note"),
            AgentReducer.drawerCitations(state).map { it.documentId },
        )
    }

    @Test
    fun drawer_is_empty_when_every_citation_is_a_merged_ref() {
        // A pure Deep Research turn: the only citations are the merged refs.
        val state = AgentChatState(citations = listOf(mergedRef("d-1"), mergedRef("d-2")))
        assertEquals(emptyList<String>(), AgentReducer.drawerCitations(state).map { it.documentId })
    }
}
