// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentPlanItem
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AgentTrailRecord
import dev.omnesis.android.transport.dto.AgentUsage
import dev.omnesis.android.transport.dto.DeepResearchPlanItem
import dev.omnesis.android.transport.dto.DeepResearchVerification
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/** A rendered conversation turn. Mirrors the iOS `AgentTurn`. */
sealed interface AgentTurn {
    val id: String

    data class User(override val id: String, val text: String) : AgentTurn

    data class Assistant(
        override val id: String,
        val parts: List<AgentPart> = emptyList(),
        val stopReason: String? = null,
        /** How this turn ended badly, kept structured so the code survives to the renderer. */
        val failure: AgentTurnFailure? = null,
        /**
         * The sentence a reopened conversation shows under a reply that was stopped — the
         * marker the session leaves in history says whether the user stopped it. A stop is an
         * outcome, not a failure, so it never reaches [failure]; a live stop ends the turn
         * with no note at all.
         */
        val stopped: String? = null,
        val citationCount: Int = 0,
        /**
         * The end-of-run verified-report artifact, folded on by the reducer from
         * the additive `agent.deep_research.summary` event (located by this turn's id =
         * the event's `messageId`). `null` until that event arrives — and it never
         * arrives for an ordinary turn or an older/resumed Deep Research run, so the
         * bubble degrades to plain report prose. Not persisted (the resume path rebuilds
         * turns without it, mirroring the not-persisted `deepResearch` run marker).
         * Mirrors the iOS `AgentTurn.reportArtifact`.
         */
        val reportArtifact: AgentReportArtifact? = null,
    ) : AgentTurn
}

/**
 * Why one assistant turn ended badly, in the three pieces the transcript shows: the humanized
 * [message] the gateway wrote, the failure's [code], and the provider's [providerDetail] line
 * when the provider reported a disposition. Kept as separate fields — never one flattened
 * sentence — so the renderer can hold the explanation and the diagnostic apart, and so a
 * gateway that carries no provider detail simply leaves that half empty.
 */
data class AgentTurnFailure(
    val message: String,
    val code: String? = null,
    val providerDetail: String? = null,
)

/**
 * The verified-report artifact for one completed Deep Research turn — the
 * structured facts that hang below the streamed report prose: the honest terminal
 * [stoppedReason], the planner's [plan], the whole-tree token total ([treeUsage]),
 * and the REAL quote-[verification] tally driving the badge. Built from the additive
 * `agent.deep_research.summary` event; the merged citations it renders as inline
 * markers come from [AgentChatState.citations] (a single set, no per-sub-agent
 * attribution — a frozen constraint), NOT carried here. Mirrors the iOS
 * `AgentReportArtifact`.
 */
data class AgentReportArtifact(
    val stoppedReason: String,
    val plan: List<DeepResearchPlanItem> = emptyList(),
    val treeUsage: AgentUsage? = null,
    val verification: DeepResearchVerification,
)

/** One piece of an assistant turn. Mirrors the iOS `AgentPart`. */
sealed interface AgentPart {
    data class Text(val text: String) : AgentPart
    data class Thinking(val text: String) : AgentPart
    data class Tool(val call: AgentToolCall) : AgentPart
    /** A collapsible sub-agent card. Mirrors the iOS `AgentPart.subagent`. */
    data class Subagent(val card: AgentSubagentCard) : AgentPart
    data class Unknown(val label: String, val kind: String) : AgentPart
}

/**
 * The compact state for one sub-agent the parent spawned via
 * `spawn_subagent`, rendered as an [AgentPart.Subagent] on the parent's assistant
 * turn. Built from the three `agent.subagent.*` events: `spawned` seeds an empty
 * card, each wrapped `event` bumps [stepCount] / [tokens] and grows [docs],
 * `result` finalises [status] / [summary] / the authoritative [tokens]. Mirrors the
 * iOS `AgentSubagentCard`.
 */
data class AgentSubagentCard(
    val subagentId: String,
    val specialist: String,
    val task: String,
    val title: String = "",
    val parentToolCallId: String? = null,
    /**
     * Scratch state for the child request in flight, holding the tool parts that
     * pair a child's `tool.result` with the call that opened it. Replaced at each
     * child request boundary rather than accumulated, and never rendered — the card
     * and the research working-set surface read the fields below, not this.
     */
    val childTurns: List<AgentChildTurn> = emptyList(),
    /** Sub-agent tool calls so far, retained for the detailed working set. */
    val stepCount: Int = 0,
    /** Rendered total: completed requests plus current live usage snapshots. */
    val tokens: Int = 0,
    /** Cumulative provider usage for child requests whose terminal event arrived. */
    val completedUsageByMessage: Map<String, AgentUsage> = emptyMap(),
    /** Latest cumulative provider usage by in-flight child message id. */
    val liveUsageByMessage: Map<String, AgentUsage> = emptyMap(),
    /**
     * Documents this researcher has reached so far, accumulated LIVE from its child
     * tool results (search hits, opened docs, trail walks) and deduped by documentId.
     * Each is a minimal source-tintable ref — the research working-set surface paints
     * one source-tinted chip per entry as the run proceeds. This is what a child's
     * work leaves behind; the result payloads it came from are not kept. Mirrors the
     * iOS `docs[]`.
     */
    val docs: List<AgentResearchDoc> = emptyList(),
    /** `null` while running; `complete` / `failed` / `budget_exhausted` once finalised. */
    val status: String? = null,
    val summary: String? = null,
    /** Deliberate citations retained by a failed worker for a partial result. */
    val retainedCitationCount: Int = 0,
    /** Authoritative terminal code for deciding whether retained evidence is usable. */
    val failureCode: String? = null,
    /** The provider's disposition for that terminal code, when one was reported. */
    val failureProviderDetail: String? = null,
) {
    val hasPartialResult: Boolean
        get() = status == "failed" &&
            failureCode == "output_truncated" &&
            retainedCitationCount > 0 &&
            summary?.startsWith("Partial evidence collected before the worker reached its output limit:") == true
}

/**
 * A single document a researcher sub-agent has reached, in minimal source-tintable
 * form. Carries only what the research working-set surface needs to paint one
 * source-tinted chip — the title plus the [sourceId] the source registry ([SourceCatalog])
 * resolves to an icon/accent/label. Source identity rides this ref; the surface NEVER
 * branches on a source name. Mirrors the iOS `AgentResearchDoc`.
 */
data class AgentResearchDoc(
    val documentId: String,
    val title: String? = null,
    val sourceId: String = "",
)

/**
 * View-facing descriptor for one researcher panel on the research working-set surface
 * — the projection [AgentReducer.researchPanels] builds per sub-agent card in
 * spawn order. A pure value type so the selector stays unit-testable without Compose.
 * Mirrors the iOS `AgentResearchPanel`.
 */
data class AgentResearchPanel(
    val subagentId: String,
    val specialist: String,
    val title: String,
    val task: String,
    val docs: List<AgentResearchDoc>,
    val stepCount: Int,
    val tokens: Int,
    val status: String?,
    val summary: String?,
)

/** One assistant turn inside a sub-agent's nested transcript. */
data class AgentChildTurn(
    val id: String,
    val parts: List<AgentPart> = emptyList(),
)

/**
 * A tool call within an assistant turn, including the ephemeral-gate bookkeeping
 * (`pendingTail` / `tailDismissed`). Mirrors the iOS `AgentToolCall`.
 */
data class AgentToolCall(
    val toolCallId: String,
    val tool: String,
    val args: JsonElement = JsonNull,
    val argsSummary: String = "",
    val argsKnown: Boolean = false,
    val result: AgentToolResult? = null,
    val durationMs: Double? = null,
    val pendingTail: List<AgentEvent> = emptyList(),
    val tailDismissed: Boolean = false,
    /**
     * Per-child progress for a batch retrieval call (`search_many` / `fetch_many`), attached LIVE
     * from `agent.tool.child.*` events and kept sorted by [AgentToolChild.index]. The renderer
     * projects one ephemeral card per entry, reusing the singular card the child names. Empty for
     * a non-batch call and never rebuilt on reload (the batch cards are ephemeral, like the
     * singular ones they wrap).
     */
    val children: List<AgentToolChild> = emptyList(),
)

/**
 * One child of a batch retrieval call (`search_many` / `fetch_many`), built LIVE from the
 * `agent.tool.child.start` / `agent.tool.child.result` events keyed by [index]. [tool] is the
 * SINGULAR tool name the child card reuses (`search_documents` / `fetch_document`); [result] is
 * the singular result (or an [AgentToolResult.ErrorResult] for a failed child), `null` until the
 * child completes. Mirrors the portal reducer's `part.children` entries.
 */
data class AgentToolChild(
    val index: Int,
    val tool: String? = null,
    val argsSummary: String = "",
    val result: AgentToolResult? = null,
)

data class AgentCitation(
    val documentId: String,
    val ref: AgentDocRef,
    val docNote: String? = null,
    val entries: List<AgentCitationEntry> = emptyList(),
)

data class AgentCitationEntry(
    val toolCallId: String,
    val messageId: String,
    val quote: String?,
    val note: String?,
    val quoteAuthor: String?,
    val quoteIsSelf: Boolean = false,
)

/** The full immutable agent-chat state the reducer threads through. */
data class AgentChatState(
    val turns: List<AgentTurn> = emptyList(),
    val citations: List<AgentCitation> = emptyList(),
    val citationsByDocId: Map<String, Int> = emptyMap(),
    val planItems: List<AgentPlanItem> = emptyList(),
    /**
     * Directly-cited records from `cite_record` tool results, deduped by `recordKey`
     * (last wins). These feed the timeline drawer: a record the agent cited directly appears on
     * the timeline through here.
     */
    val records: List<AgentTrailRecord> = emptyList(),
    val busy: Boolean = false,
    /**
     * True while a user-invoked Deep Research run is in flight — the `/`-pill set
     * `deepResearch:true` on the send. Drives the bespoke multi-panel research working-set
     * surface: it appears only while this holds AND at least one sub-agent panel exists
     * ([AgentReducer.isResearchWorkspaceActive]), and collapses into the written-back report
     * when the run ends (the reducer clears it on `MessageEnd` / `ErrorEvent`). A run-active
     * marker, NOT persisted — a resumed/reset session never re-opens the surface (the resume
     * path rebuilds state without it). Mirrors the iOS `AgentCoordinator.deepResearch`.
     */
    val deepResearch: Boolean = false,
    val lastTurnError: String? = null,
)
