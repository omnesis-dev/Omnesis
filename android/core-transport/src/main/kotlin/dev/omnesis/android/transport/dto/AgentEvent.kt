// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * One agent SSE event, wire-framed as `{ "type": ..., "payload": {...} }`. Mirrors the
 * iOS `AgentEvent`. Inbound only (never re-encoded). Unknown types decode to [Unknown].
 */
@Serializable(with = AgentEventSerializer::class)
sealed interface AgentEvent {
    val sessionId: String

    @Serializable
    data class UserMessage(override val sessionId: String = "", val userMessageId: String = "", val text: String = "") : AgentEvent

    @Serializable
    data class MessageStart(override val sessionId: String = "", val messageId: String = "") : AgentEvent

    @Serializable
    data class TextDelta(override val sessionId: String = "", val messageId: String = "", val delta: String = "") : AgentEvent

    @Serializable
    data class ThinkingDelta(override val sessionId: String = "", val messageId: String = "", val delta: String = "") : AgentEvent

    /** Cumulative usage reported while this model request is still running. */
    @Serializable
    data class UsageUpdate(
        override val sessionId: String = "",
        val messageId: String = "",
        val usage: AgentUsage = AgentUsage(),
    ) : AgentEvent

    @Serializable
    data class ToolInputStart(override val sessionId: String = "", val messageId: String = "", val toolCallId: String = "", val tool: String = "") : AgentEvent

    @Serializable
    data class ToolStart(
        override val sessionId: String = "",
        val messageId: String = "",
        val toolCallId: String = "",
        val tool: String = "",
        val args: JsonElement = JsonNull,
        val argsSummary: String? = null,
    ) : AgentEvent

    @Serializable
    data class ToolResult(
        override val sessionId: String = "",
        val messageId: String = "",
        val toolCallId: String = "",
        val result: AgentToolResult,
        val durationMs: Double = 0.0,
    ) : AgentEvent

    @Serializable
    data class Citation(
        override val sessionId: String = "",
        val messageId: String = "",
        val toolCallId: String = "",
        val ref: AgentDocRef,
        val quote: String? = null,
        val note: String? = null,
        val quoteAuthor: String? = null,
        val quoteIsSelf: Boolean = false,
    ) : AgentEvent

    /**
     * Live per-child progress for a batch tool call (`search_many` / `fetch_many` /
     * `annotate_many`). [toolCallId] is the PARENT batch call; `(toolCallId, childIndex)` keys one
     * live ephemeral card per child so the client animates N cards concurrently. [tool] is the
     * SINGULAR tool name (`search_documents` / `fetch_document` / `annotate`) so renderers reuse
     * the existing per-tool card. These are live-only signals — the durable record is the single
     * [ToolResult] (a `*.batch` result) the cards re-project from on reload, so a client that
     * ignores them still reconstructs the same UI. Mirrors `agentToolChildStartEvent` /
     * `agentToolChildResultEvent` in `@omnesis/core/agent-protocol.ts`.
     */
    @Serializable
    data class ToolChildStart(
        override val sessionId: String = "",
        val messageId: String = "",
        val toolCallId: String = "",
        val childIndex: Int = 0,
        val tool: String = "",
        val argsSummary: String? = null,
    ) : AgentEvent

    @Serializable
    data class ToolChildResult(
        override val sessionId: String = "",
        val messageId: String = "",
        val toolCallId: String = "",
        val childIndex: Int = 0,
        val result: AgentToolResult,
    ) : AgentEvent

    @Serializable
    data class CitationsUpdate(
        override val sessionId: String = "",
        val added: List<AgentDocRef> = emptyList(),
        val removed: List<String> = emptyList(),
    ) : AgentEvent

    /**
     * Additive end-of-run summary for an explicit Deep Research run (#748), emitted
     * ONCE just before the parent turn's [MessageEnd]. Carries the structured facts
     * the verified-report artifact renders — the honest terminal [stoppedReason], the
     * planner's decomposition ([plan]), the whole-tree token total ([treeUsage]), and
     * the REAL quote-[verification] tally — so the client never parses the rendered
     * report prose. Strictly ADDITIVE: a run (or a resumed/older transcript) that never
     * carries this event degrades to the plain report bubble, mirroring portal + iOS.
     *
     * [stoppedReason] is an open string on the wire (the gateway enumerates four real
     * terminal states, but an unrecognised value still decodes — the badge falls back
     * to the raw label rather than hiding it).
     */
    @Serializable
    data class DeepResearchSummary(
        override val sessionId: String = "",
        val messageId: String = "",
        val stoppedReason: String = "",
        val plan: List<DeepResearchPlanItem> = emptyList(),
        val treeUsage: AgentUsage? = null,
        val verification: DeepResearchVerification = DeepResearchVerification(),
    ) : AgentEvent

    @Serializable
    data class MessageEnd(
        override val sessionId: String = "",
        val messageId: String = "",
        val stopReason: String = "end_turn",
        val failure: AgentTerminalFailure? = null,
        val context: AgentContextAssessment? = null,
        val usage: AgentUsage? = null,
    ) : AgentEvent

    /**
     * A run that ended on an error the model provider reported. [message] is the humanized
     * sentence the gateway wrote for the operator; [code] is the failure's own taxonomy entry;
     * [provider] is the provider's disposition when the gateway had one to forward (absent from
     * an older gateway, and from failures that never reached a provider).
     */
    @Serializable
    data class ErrorEvent(
        override val sessionId: String = "",
        val messageId: String? = null,
        val code: String = "",
        val message: String = "",
        val provider: AgentProviderFailureDetail? = null,
    ) : AgentEvent

    /**
     * A sub-agent (#748) the parent spawned via `spawn_subagent` just started.
     * Opens a collapsible card on the parent's current assistant turn; the
     * child's nested transcript grows from the [SubagentEvent] stream that
     * follows and the run finalises with [SubagentResult]. Mirrors the iOS
     * `.subagentSpawned` case + the portal `agent.subagent.spawned` reduction.
     */
    @Serializable
    data class SubagentSpawned(
        override val sessionId: String = "",
        val subagentId: String = "",
        val specialist: String = "",
        val title: String = "",
        val task: String = "",
        val parentToolCallId: String? = null,
    ) : AgentEvent

    /**
     * One of a sub-agent's own [AgentEvent]s, wrapped one level of recursion.
     * The reducer re-invokes the same part-fold the top-level turn uses. A
     * wrapped child event whose `type` this build doesn't recognise decodes to
     * [Unknown] (graceful degrade) and the card simply doesn't grow for it —
     * the Android twin of iOS's `.unknown` fallthrough.
     */
    @Serializable
    data class SubagentEvent(
        override val sessionId: String = "",
        val subagentId: String = "",
        val specialist: String = "",
        val event: AgentEvent = Unknown(""),
    ) : AgentEvent

    /**
     * A sub-agent finished: terminal [status], a distilled [summary], the merged
     * [citations] (folded into the parent's single citation set via the separate
     * `agent.citations.update` event — never surfaced as per-sub-agent
     * attribution), the per-child token [usage], and the whole-tree [treeUsage]
     * total at the moment this child finished. Mirrors the iOS `.subagentResult`.
     */
    @Serializable
    data class SubagentResult(
        override val sessionId: String = "",
        val subagentId: String = "",
        val specialist: String = "",
        val status: String = "complete",
        val summary: String = "",
        val citations: List<AgentDocRef> = emptyList(),
        val usage: AgentUsage? = null,
        val treeUsage: AgentUsage? = null,
        val failure: AgentTerminalFailure? = null,
    ) : AgentEvent

    /**
     * Out-of-band control signal (`agent.resync`, payload `{}`, no sessionId): the
     * gateway couldn't replay what we missed since our `Last-Event-ID` — the gap
     * predates its buffer, or the client cursor is ahead of a post-restart reset
     * sequence. The client reloads the persisted transcript instead of routing
     * this through the reducer. Mirrors the iOS `AgentEvent.resync` case.
     */
    @Serializable
    data class Resync(override val sessionId: String = "") : AgentEvent

    data class Unknown(val type: String, override val sessionId: String = "") : AgentEvent
}

/**
 * LLM-token spend for a sub-agent run (or, summed, a whole sub-agent tree) —
 * the shape behind `agentUsageSchema` on the wire (#748). Every field is
 * optional; [total] sums input, output, and cache fields for the card counter.
 */
@Serializable
data class AgentUsage(
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val cacheReadTokens: Int? = null,
    val cacheCreationTokens: Int? = null,
) {
    val total: Int get() =
        (inputTokens ?: 0) + (outputTokens ?: 0) +
            (cacheReadTokens ?: 0) + (cacheCreationTokens ?: 0)
    val hasAnyToken: Boolean get() =
        (inputTokens ?: 0) > 0 || (outputTokens ?: 0) > 0 ||
            (cacheReadTokens ?: 0) > 0 || (cacheCreationTokens ?: 0) > 0
}

/**
 * One entry of a Deep Research planner's decomposition (#748) — a [specialist] reader
 * and the [task] it was fanned out on, in plan order. Carried on
 * [AgentEvent.DeepResearchSummary.plan]; mirrors the wire `deepResearchPlanItemSchema`.
 */
@Serializable
data class DeepResearchPlanItem(
    val specialist: String = "",
    val task: String = "",
)

/**
 * Quote-verification tally for a Deep Research run (#748). The citation-verify pass
 * re-fetches each cited document and string-matches the verbatim quotes a reader
 * embedded against the fetched body. [quotesChecked] is how many quotes were tested;
 * [quotesVerified] how many matched. The verified-report badge is driven by these REAL
 * counts — never hardcoded. A run that quoted nothing reports 0/0 (the badge then reads
 * "no quotes to verify" rather than a misleading green tick). Mirrors the wire
 * `deepResearchVerificationSchema`.
 */
@Serializable
data class DeepResearchVerification(
    val quotesChecked: Int = 0,
    val quotesVerified: Int = 0,
)

object AgentEventSerializer : KSerializer<AgentEvent> {
    override val descriptor: SerialDescriptor =
        buildClassSerialDescriptor("dev.omnesis.android.transport.dto.AgentEvent")

    override fun deserialize(decoder: Decoder): AgentEvent {
        val input = decoder as? JsonDecoder ?: error("AgentEvent requires a JSON decoder")
        val obj = input.decodeJsonElement().jsonObject
        val type = obj["type"]?.jsonPrimitive?.contentOrNull
        val payload = obj["payload"] ?: JsonObject(emptyMap())
        val json = input.json
        return when (type) {
            "agent.user.message" -> json.decodeFromJsonElement(AgentEvent.UserMessage.serializer(), payload)
            "agent.message.start" -> json.decodeFromJsonElement(AgentEvent.MessageStart.serializer(), payload)
            "agent.text.delta" -> json.decodeFromJsonElement(AgentEvent.TextDelta.serializer(), payload)
            "agent.thinking.delta" -> json.decodeFromJsonElement(AgentEvent.ThinkingDelta.serializer(), payload)
            "agent.usage.update" -> json.decodeFromJsonElement(AgentEvent.UsageUpdate.serializer(), payload)
            "agent.tool.input_start" -> json.decodeFromJsonElement(AgentEvent.ToolInputStart.serializer(), payload)
            "agent.tool.start" -> json.decodeFromJsonElement(AgentEvent.ToolStart.serializer(), payload)
            "agent.tool.result" -> json.decodeFromJsonElement(AgentEvent.ToolResult.serializer(), payload)
            "agent.tool.child.start" -> json.decodeFromJsonElement(AgentEvent.ToolChildStart.serializer(), payload)
            "agent.tool.child.result" -> json.decodeFromJsonElement(AgentEvent.ToolChildResult.serializer(), payload)
            "agent.citation" -> json.decodeFromJsonElement(AgentEvent.Citation.serializer(), payload)
            "agent.citations.update" -> json.decodeFromJsonElement(AgentEvent.CitationsUpdate.serializer(), payload)
            "agent.message.end" -> json.decodeFromJsonElement(AgentEvent.MessageEnd.serializer(), payload)
            "agent.error" -> json.decodeFromJsonElement(AgentEvent.ErrorEvent.serializer(), payload)
            "agent.subagent.spawned" -> json.decodeFromJsonElement(AgentEvent.SubagentSpawned.serializer(), payload)
            // The `event` field is itself an `{ type, payload }` envelope, so the
            // generated serializer recurses through this same `AgentEventSerializer`
            // (one level of recursion). An unknown inner `type` lands on `Unknown`.
            "agent.subagent.event" -> json.decodeFromJsonElement(AgentEvent.SubagentEvent.serializer(), payload)
            "agent.subagent.result" -> json.decodeFromJsonElement(AgentEvent.SubagentResult.serializer(), payload)
            "agent.deep_research.summary" -> json.decodeFromJsonElement(AgentEvent.DeepResearchSummary.serializer(), payload)
            "agent.resync" -> json.decodeFromJsonElement(AgentEvent.Resync.serializer(), payload)
            else -> AgentEvent.Unknown(type ?: "")
        }
    }

    override fun serialize(encoder: Encoder, value: AgentEvent) =
        error("AgentEvent is inbound only and is never serialized")
}
