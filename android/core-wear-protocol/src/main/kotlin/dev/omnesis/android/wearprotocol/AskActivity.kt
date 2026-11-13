// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

/**
 * Labels for what the agent is doing mid-turn, keyed by the tool it just
 * started. Deliberately coarse: the tool name only, never its arguments, so a
 * label carries none of the question's content. The iOS counterpart is
 * `SiriAskActivity` in `SiriAsk.swift`.
 */
object AskActivity {
    /**
     * The ceiling every label here is held under, so the watch's status line
     * fits without clipping a phrase.
     */
    const val MAX_RENDERABLE_LABEL_LENGTH = 22

    /** Shown before the first tool starts, and for a tool this build does not know. */
    val fallbackLabel: String get() = WearLine.WORKING.text

    /** Shown on the watch while it retries a phone app that has not taken the question yet. */
    val wakingPhoneLabel: String get() = WearLine.WAKING_PHONE.text

    fun labelForTool(tool: String): String = lineForTool(tool).text

    /** Every label [labelForTool] and [AskActivityTimeline] can produce. */
    val allLabels: List<String> = listOf(
        WearLine.WORKING, WearLine.WAKING_PHONE, WearLine.RECEIVED, WearLine.ASKING,
        WearLine.THINKING, WearLine.SEARCHING, WearLine.READING, WearLine.LOOKING_UP_PEOPLE,
        WearLine.CHECKING_RECORDS, WearLine.TRACING_LINKS, WearLine.CHECKING_DATES,
        WearLine.GATHERING_CONTEXT, WearLine.NOTING_SOURCES, WearLine.LOOKING_DEEPER,
        WearLine.PLANNING, WearLine.SETTING_UP_WATCH,
    ).map { it.text }

    private fun lineForTool(tool: String): WearLine = when {
        // The batch tools are what the agent calls at the top level; the
        // singular ones appear as their child steps.
        tool in SEARCH_TOOLS -> WearLine.SEARCHING
        tool in READ_TOOLS -> WearLine.READING
        tool == "lookup_people" -> WearLine.LOOKING_UP_PEOPLE
        tool == "run_sql" -> WearLine.CHECKING_RECORDS
        tool == "trace_connections" -> WearLine.TRACING_LINKS
        tool == "temporal_query" || tool == "time_index_query" -> WearLine.CHECKING_DATES
        tool == "entity_context" -> WearLine.GATHERING_CONTEXT
        tool in CITE_TOOLS -> WearLine.NOTING_SOURCES
        tool == "spawn_subagent" || tool == "join_subagents" -> WearLine.LOOKING_DEEPER
        tool == "plan" -> WearLine.PLANNING
        tool.startsWith("watch") -> WearLine.SETTING_UP_WATCH
        else -> WearLine.WORKING
    }

    private val SEARCH_TOOLS = setOf("search_documents", "search_loops", "list_loops", "search_many")
    private val READ_TOOLS = setOf("fetch_document", "fetch_loop", "lookup_document_by_url", "fetch_many")
    private val CITE_TOOLS = setOf("annotate", "cite_record", "annotate_many")
}

/**
 * One relayed question's live work, sized for the single line the watch gives
 * it. It carries no query text, document title, source identity or result
 * content.
 */
data class AskActivitySnapshot(
    /** The current step, one short phrase. */
    val label: String,
    /** What the last completed retrieval yielded, such as "12 found"; null until one completes. */
    val detail: String? = null,
) {
    /** The whole status line: the step, then what was retrieved. */
    val line: String
        get() = if (detail.isNullOrEmpty()) label else "$label · $detail"
}

/** What a finished tool call retrieved, as counts only. */
sealed interface AskToolOutcome {
    data object None : AskToolOutcome

    data class Search(val found: Int) : AskToolOutcome

    data object DocumentOpened : AskToolOutcome

    data class Batch(val found: Int, val opened: Int) : AskToolOutcome
}

/** The milestones of a turn the phone may expose to the watch. */
sealed interface AskActivityEvent {
    data object RelayReceived : AskActivityEvent

    data object Connecting : AskActivityEvent

    data object RequestSent : AskActivityEvent

    data object AgentStarted : AskActivityEvent

    data class ToolStarted(val id: String, val tool: String) : AskActivityEvent

    data class ToolFinished(val id: String, val outcome: AskToolOutcome) : AskActivityEvent
}

/**
 * Reduces a turn's milestones into the snapshot the watch shows. Tool ids make
 * a replayed event harmless: a start or result seen twice changes nothing.
 * Not thread-safe; confine one instance to the turn that feeds it.
 */
class AskActivityTimeline {
    var snapshot: AskActivitySnapshot = AskActivitySnapshot(AskActivity.fallbackLabel)
        private set
    private var agentStarted = false
    private val startedTools = mutableSetOf<String>()
    private val finishedTools = mutableSetOf<String>()

    // Running totals behind the detail clause. Only one is ever shown: the
    // clause names the last kind of retrieval that completed.
    private var found = 0
    private var opened = 0

    fun apply(event: AskActivityEvent): AskActivitySnapshot {
        when (event) {
            AskActivityEvent.RelayReceived -> relabel(WearLine.RECEIVED.text)
            // One phrase for reaching the gateway and handing it the question:
            // two labels a moment apart read as a flicker.
            AskActivityEvent.Connecting, AskActivityEvent.RequestSent -> relabel(WearLine.ASKING.text)
            AskActivityEvent.AgentStarted -> if (!agentStarted) {
                agentStarted = true
                relabel(WearLine.THINKING.text)
            }
            is AskActivityEvent.ToolStarted -> if (startedTools.add(event.id)) {
                relabel(AskActivity.labelForTool(event.tool))
            }
            is AskActivityEvent.ToolFinished -> if (finishedTools.add(event.id)) {
                finished(event.id, event.outcome)
            }
        }
        return snapshot
    }

    private fun finished(id: String, outcome: AskToolOutcome) {
        when (outcome) {
            AskToolOutcome.None -> Unit
            is AskToolOutcome.Search -> {
                found += outcome.found.coerceAtLeast(0)
                updateDetail(justOpened = 0)
            }
            AskToolOutcome.DocumentOpened -> {
                opened += 1
                updateDetail(justOpened = 1)
            }
            is AskToolOutcome.Batch -> {
                // A batch whose child steps (ids "<batch>#<n>") already
                // reported is not counted again; its own counts are the
                // fallback for a gateway that sends no child results.
                if (finishedTools.any { it.startsWith("$id#") }) return
                found += outcome.found.coerceAtLeast(0)
                opened += outcome.opened.coerceAtLeast(0)
                updateDetail(justOpened = outcome.opened)
            }
        }
    }

    private fun relabel(label: String) {
        snapshot = snapshot.copy(label = label)
    }

    /**
     * A call that opened a document reports what has been read; one that only
     * searched reports what has been found to read from.
     */
    private fun updateDetail(justOpened: Int) {
        if (justOpened > 0 && opened > 0) {
            snapshot = snapshot.copy(detail = "$opened read")
        } else if (found > 0) {
            snapshot = snapshot.copy(detail = "$found found")
        }
    }
}
