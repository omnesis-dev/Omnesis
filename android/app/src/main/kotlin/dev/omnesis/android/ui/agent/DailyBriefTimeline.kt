// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentTrailRecord
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.ConversationOrigin

/**
 * Which loaded messages feed the citation timeline of the Morning brief conversation.
 *
 * That conversation is one thread with a new brief appended every morning, but its working
 * state is one day: the timeline covers the latest brief and everything after it, while earlier
 * days stay readable in the transcript. Persisted messages carry no ids, so the boundary is
 * positional — the brief's index among the conversation's visible messages, which the gateway
 * reports on the origin — and each loaded page is placed by counting back from the end.
 *
 * The transcript keeps every citation (inline markers in earlier days still resolve); the scope
 * only records what came from before the boundary, so the drawer can leave it out. Live turns
 * always follow the latest brief, so anything they add is in scope.
 */
data class TimelineScope(
    /** Visible index of the latest brief: the first message the timeline covers. */
    val floor: Int,
    /** Visible index of the first message loaded on screen. */
    val firstLoaded: Int,
    /** Annotate call ids (`<toolCallId>` or `<toolCallId>#<n>`) cited before [floor]. */
    val earlierCitationCalls: Set<String> = emptySet(),
    /** Documents given a document-level note before [floor] / from [floor] on. */
    val earlierDocNotes: Set<String> = emptySet(),
    val laterDocNotes: Set<String> = emptySet(),
    /** Record keys cited before [floor] / from [floor] on. */
    val earlierRecords: Set<String> = emptySet(),
    val laterRecords: Set<String> = emptySet(),
) {
    /** Account for an older page placed directly before the loaded messages. */
    fun withOlder(messages: List<ChatMessage>): TimelineScope {
        val first = (firstLoaded - messages.size).coerceAtLeast(0)
        return copy(firstLoaded = first).including(messages, first)
    }

    /** Fold [messages], the first of which sits at visible index [startIndex], into the sets. */
    private fun including(messages: List<ChatMessage>, startIndex: Int): TimelineScope {
        val split = (floor - startIndex).coerceIn(0, messages.size)
        val earlier = messages.subList(0, split)
        val later = messages.subList(split, messages.size)
        val earlierCitations = AgentTurnBuilder.citations(earlier)
        val laterCitations = AgentTurnBuilder.citations(later)
        return copy(
            earlierCitationCalls = earlierCitationCalls +
                earlierCitations.flatMap { citation -> citation.entries.map { it.toolCallId } },
            earlierDocNotes = earlierDocNotes + earlierCitations.filter { it.docNote != null }.map { it.documentId },
            laterDocNotes = laterDocNotes + laterCitations.filter { it.docNote != null }.map { it.documentId },
            earlierRecords = earlierRecords + AgentTurnBuilder.records(earlier).map { it.recordKey },
            laterRecords = laterRecords + AgentTurnBuilder.records(later).map { it.recordKey },
        )
    }

    /** The citations the timeline shows: only entries and notes from the latest brief on. */
    fun citations(citations: List<AgentCitation>): List<AgentCitation> = citations.mapNotNull { citation ->
        val entries = citation.entries.filterNot { it.toolCallId in earlierCitationCalls }
        val noteIsEarlierOnly = citation.documentId in earlierDocNotes && citation.documentId !in laterDocNotes
        val docNote = citation.docNote.takeUnless { noteIsEarlierOnly && entries.isEmpty() }
        if (entries.isEmpty() && docNote == null) null else citation.copy(entries = entries, docNote = docNote)
    }

    /** The records the timeline shows: those not cited only before the latest brief. */
    fun records(records: List<AgentTrailRecord>): List<AgentTrailRecord> = records.filterNot {
        it.recordKey in earlierRecords && it.recordKey !in laterRecords
    }

    companion object {
        /**
         * The scope for a freshly loaded transcript: [messages] are the newest visible messages
         * of a conversation that has [messageCount] of them. Null unless [origin] is the
         * Morning brief conversation with a brief to scope to — every other thread's timeline
         * covers the whole conversation.
         */
        fun forLoaded(
            origin: ConversationOrigin?,
            messages: List<ChatMessage>,
            messageCount: Int,
        ): TimelineScope? {
            val latest = origin?.latestDailyBrief ?: return null
            val first = (messageCount - messages.size).coerceAtLeast(0)
            return TimelineScope(floor = latest.messageIndex, firstLoaded = first).including(messages, first)
        }
    }
}
