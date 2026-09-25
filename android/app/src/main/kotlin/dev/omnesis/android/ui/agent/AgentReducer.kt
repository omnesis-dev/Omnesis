// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AgentTrailRecord
import dev.omnesis.android.transport.dto.AgentUsage
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.formatLine
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Pure SSE-event reducer for the agent chat. Faithful port of the iOS
 * `AgentCoordinator.handle(event:)` and its ephemeral-causality gate. Kept as pure
 * `reduce(state, event)` functions so the gate state machine is unit-testable without
 * a live stream (mirrors the iOS `applyEventForTesting`). Session filtering is the
 * caller's job (it knows the live sessionId).
 */
object AgentReducer {

    /** Tools whose cards auto-dismiss; turn-extending events are gated behind their dismissal. */
    val EPHEMERAL_TOOLS = setOf(
        // Visible only until SubagentSpawned replaces it with the stable worker row.
        "spawn_subagent",
        "search_documents", "fetch_document", "run_sql",
        "trace_connections", "lookup_people", "lookup_document_by_url",
        "search_loops", "fetch_loop", "list_loops", "entity_context",
        "open_loop_search", "open_loop_fetch", "open_loop_create", "open_loop_update",
        "open_loop_delete", "open_loop_ledger_append",
        "brief_list", "brief_fetch", "brief_create", "brief_update", "brief_delete",
        "notes_append", "notes_rewrite", "annotate_durable", "schedule_agent_run",
        "conversation_memory_evidence", "annotation_search",
        "annotation_revise", "annotation_retract", "annotation_supersede",
        "annotate_person", "person_annotation_revise", "person_annotation_retract",
        "person_annotation_supersede",
        "temporal_query",
        "temporal_annotation_add", "temporal_annotation_update", "temporal_annotation_delete",
        // Stored transcripts and rolling upgrades can still carry the old names.
        "time_index_query", "time_index_add", "time_index_update", "time_index_delete",
        // Batch retrieval: each renders live as N per-child ephemeral cards (the renderer
        // projects `AgentToolCall.children`) and — like the singular cards they wrap — is dropped
        // from resumed history. But a batch parent does NOT act as a causality gate (it is in
        // [BATCH_EPHEMERAL_TOOLS], excluded via [actsAsGate]): its children each animate on their
        // own lifecycle, so there is no single card to drive a parent flush, and the answer text
        // streams as soon as the batch result lands. `annotate_many` is NOT here: it is silent,
        // like `annotate`.
        "search_many", "fetch_many",
    )

    /**
     * The batch retrieval tools — a subset of [EPHEMERAL_TOOLS]. They are dropped from resumed
     * history like the singular ephemeral tools they wrap, but they render as N independent
     * per-child cards (each with its own dismiss lifecycle) rather than one card, so a batch parent
     * never acts as a causality gate — there is no single card to drive its flush, and its answer
     * text must stream immediately after the batch result rather than park. Mirrors the portal's
     * `BATCH_EPHEMERAL_TOOLS` and the iOS `agentBatchTools`.
     */
    val BATCH_EPHEMERAL_TOOLS = setOf("search_many", "fetch_many")

    /** Orchestration calls that must not survive in the final transcript. */
    val ORCHESTRATION_TOOLS = setOf("spawn_subagent", "join_subagents")

    /** Panel-only or fully invisible tools skipped at input/start time. */
    val HIDDEN_TRANSCRIPT_TOOLS = setOf("plan", "join_subagents")

    /** Whether an ephemeral tool's card gates the text that follows it — batch tools do not. */
    private fun actsAsGate(tool: String): Boolean =
        tool in EPHEMERAL_TOOLS && tool !in BATCH_EPHEMERAL_TOOLS

    fun reduce(state: AgentChatState, event: AgentEvent): AgentChatState {
        if (event is AgentEvent.Unknown) return state

        // Causality gate: park turn-extending events behind an active ephemeral tool.
        if (eventAppendsToTurn(event)) {
            val gateIdx = activeEphemeralGateIndex(state)
            if (gateIdx != null) return enqueueOnGate(state, gateIdx, event)
        }

        return when (event) {
            is AgentEvent.UserMessage -> {
                val have = state.turns.any { it is AgentTurn.User && it.id == event.userMessageId }
                if (have) state
                else state.copy(turns = state.turns + AgentTurn.User(event.userMessageId, event.text))
            }

            is AgentEvent.MessageStart ->
                state.copy(
                    turns = state.turns + AgentTurn.Assistant(id = event.messageId),
                    busy = true,
                    lastTurnError = null,
                )

            is AgentEvent.TextDelta -> state.updateLastAssistant { a ->
                val last = a.parts.lastOrNull()
                if (last is AgentPart.Text) a.replaceLast(AgentPart.Text(last.text + event.delta))
                else a.copy(parts = a.parts + AgentPart.Text(event.delta))
            }

            is AgentEvent.ThinkingDelta -> state.updateLastAssistant { a ->
                val last = a.parts.lastOrNull()
                if (last is AgentPart.Thinking) a.replaceLast(AgentPart.Thinking(last.text + event.delta))
                else a.copy(parts = a.parts + AgentPart.Thinking(event.delta))
            }

            is AgentEvent.UsageUpdate -> state

            is AgentEvent.ToolInputStart -> {
                if (event.tool in HIDDEN_TRANSCRIPT_TOOLS) state
                else state.updateLastAssistant { a ->
                    a.copy(parts = a.parts + AgentPart.Tool(AgentToolCall(event.toolCallId, event.tool, argsKnown = false)))
                }
            }

            is AgentEvent.ToolStart -> {
                if (event.tool in HIDDEN_TRANSCRIPT_TOOLS) state
                else state.updateLastAssistant { a ->
                    val summary = event.argsSummary ?: summarizeArgs(event.tool, event.args)
                    val idx = a.parts.indexOfLast { it is AgentPart.Tool && it.call.toolCallId == event.toolCallId }
                    if (idx >= 0) {
                        val call = (a.parts[idx] as AgentPart.Tool).call
                        a.replaceAt(idx, AgentPart.Tool(call.copy(args = event.args, argsSummary = summary, argsKnown = true)))
                    } else {
                        a.copy(
                            parts = a.parts + AgentPart.Tool(
                                AgentToolCall(event.toolCallId, event.tool, args = event.args, argsSummary = summary, argsKnown = true),
                            ),
                        )
                    }
                }
            }

            is AgentEvent.ToolResult -> {
                val result = event.result
                if (result is AgentToolResult.PlanUpdated) {
                    state.copy(planItems = result.items)
                } else {
                    var next = state.updateLastAssistant { a ->
                        val idx = a.parts.indexOfLast { it is AgentPart.Tool && it.call.toolCallId == event.toolCallId }
                        if (idx < 0) {
                            a
                        } else {
                            val call = (a.parts[idx] as AgentPart.Tool).call
                            a.replaceAt(idx, AgentPart.Tool(call.copy(result = result, durationMs = event.durationMs)))
                        }
                    }
                    if (result is AgentToolResult.CiteRecord) {
                        // A directly-cited record: fold it into the timeline feed deduped by
                        // recordKey (last wins) and bump the citing turn's reference count — there is
                        // no SSE Citation event for a record, so the count is bumped here, mirroring
                        // how `applyCitation` bumps it for an annotate document citation.
                        val record = result.toTrailRecord()
                        next = next.copy(records = mergeRecord(next.records, record))
                            .updateAssistantById(event.messageId) { it.copy(citationCount = it.citationCount + 1) }
                    }
                    next
                }
            }

            // Live per-child progress for a batch retrieval call (`search_many` / `fetch_many`):
            // attach the child onto its parent tool part's `children`, keyed by index; the renderer
            // projects one ephemeral card per child. Not a turn-extending event (it decorates a part
            // that already exists), so it bypasses the causality gate. Order is by index, not
            // arrival, so out-of-order completion still renders correctly. Mirrors the portal's
            // `agent.tool.child.start` reduction.
            is AgentEvent.ToolChildStart -> applyToolChild(state, event.toolCallId, event.childIndex) { existing ->
                existing?.copy(tool = event.tool, argsSummary = event.argsSummary ?: existing.argsSummary)
                    ?: AgentToolChild(index = event.childIndex, tool = event.tool, argsSummary = event.argsSummary ?: "")
            }

            is AgentEvent.ToolChildResult -> applyToolChild(state, event.toolCallId, event.childIndex) { existing ->
                existing?.copy(result = event.result)
                    ?: AgentToolChild(index = event.childIndex, result = event.result)
            }

            is AgentEvent.Citation -> applyCitation(state, event)

            is AgentEvent.CitationsUpdate -> applyCitationsUpdate(state, event)

            is AgentEvent.SubagentSpawned -> {
                // Open a collapsible card on the parent's current assistant turn,
                // at the spawn position — mirrors how tool parts attach. Idempotent:
                // a re-delivered spawn for a card we already have is a no-op.
                val alreadyHave = state.turns.any { turn ->
                    turn is AgentTurn.Assistant && turn.parts.any {
                        it is AgentPart.Subagent && it.card.subagentId == event.subagentId
                    }
                }
                val withoutLaunch = event.parentToolCallId?.let { removeToolPart(state, it) } ?: state
                val withCard = if (alreadyHave) {
                    withoutLaunch
                } else {
                    withoutLaunch.updateLastAssistant { a ->
                        a.copy(
                            parts = a.parts + AgentPart.Subagent(
                                AgentSubagentCard(
                                    subagentId = event.subagentId,
                                    specialist = event.specialist,
                                    title = event.title,
                                    task = event.task,
                                    parentToolCallId = event.parentToolCallId,
                                ),
                            ),
                        )
                    }
                }
                // Generic workers stay in the ordinary transcript. Named
                // private readers still arm the Deep Research workspace for
                // replay/demo streams that were not explicitly armed.
                if (event.specialist == "generic" || withCard.deepResearch) {
                    withCard
                } else {
                    withCard.copy(deepResearch = true)
                }
            }

            is AgentEvent.SubagentEvent ->
                // Fold the wrapped child event into the card's nested transcript.
                // An unrecognised inner event (decoded to AgentEvent.Unknown) leaves
                // the card unchanged (graceful degrade — the AgentPart.Unknown twin).
                mutateSubagentCard(state, event.subagentId) { card -> reduceChildEvent(card, event.event) }

            is AgentEvent.SubagentResult -> {
                // Finalise: terminal status + distilled summary, and adopt the
                // authoritative per-child token total over the running tally when it
                // actually carries numbers. Citations merge into the parent's single
                // set via the separate agent.citations.update event (no per-sub-agent
                // attribution surfaced — frozen constraint).
                val parentToolCallId = findSubagentCard(state, event.subagentId)?.parentToolCallId
                val withResult = mutateSubagentCard(state, event.subagentId) { card ->
                    val usage = event.usage
                    card.copy(
                        status = event.status,
                        summary = event.summary,
                        retainedCitationCount = event.citations.size,
                        failureCode = event.failure?.code,
                        failureProviderDetail = event.failure?.provider?.formatLine(),
                        docs = mergeCardDocs(card, event.citations.mapNotNull { ref ->
                            ref.sourceId.takeIf { it.isNotBlank() }?.let { sourceId ->
                                AgentResearchDoc(ref.documentId, ref.title, sourceId)
                            }
                        }).docs,
                        tokens = if (usage != null && usage.hasAnyToken) usage.total else card.tokens,
                        completedUsageByMessage = if (usage != null && usage.hasAnyToken) emptyMap() else card.completedUsageByMessage,
                        liveUsageByMessage = if (usage != null && usage.hasAnyToken) emptyMap() else card.liveUsageByMessage,
                    )
                }
                parentToolCallId?.let { removeToolPart(withResult, it) } ?: withResult
            }

            is AgentEvent.DeepResearchSummary ->
                // Fold the additive end-of-run summary onto its named assistant turn as a
                // reportArtifact field, located by messageId (not turn-extending, so it
                // bypasses the ephemeral causality gate above and folds even mid-run; a
                // turn we never opened is a no-op — graceful degrade). The cross-session
                // guard already happened in AgentCoordinator.handle (it drops events for
                // other sessions before the reduce). Mirrors the iOS attachReportArtifact.
                attachReportArtifact(state, event)

            is AgentEvent.MessageEnd -> {
                val failure = event.failure
                val withReason =
                    state.updateLastAssistant {
                        it.copy(
                            stopReason = event.stopReason,
                            failure =
                                if (failure?.code == "output_truncated") {
                                    AgentTurnFailure(
                                        message = failure.message,
                                        code = failure.code,
                                        providerDetail = failure.provider?.formatLine(),
                                    )
                                } else {
                                    it.failure
                                },
                        )
                    }
                // The run is over — collapse the research working-set surface into the
                // written-back report (the now-finished assistant turn). The finished
                // cards stay on the transcript; only the live band disappears.
                // Drain first: a queued subagent.spawned event may own the
                // stable worker row that replaces its launch tool card.
                removeOrchestrationTools(
                    forceFlushActiveGates(
                        withReason.copy(
                            busy = false,
                            deepResearch = false,
                            // A failed Stop is actionable only while the turn is still live.
                            lastTurnError = null,
                        ),
                    ),
                )
            }

            is AgentEvent.ErrorEvent -> {
                if (
                    event.code == "context_window_exceeded" ||
                    event.code == "output_truncated"
                ) {
                    // Live signal only. The following MessageEnd.failure is
                    // authoritative and owns the freeze or truncation marker.
                    return state
                }
                // The code stays a separate field rather than a prefix on the sentence: the
                // renderer prints the humanized message and the machine-readable code (plus any
                // provider disposition) on their own lines.
                val withError = state.updateLastAssistant {
                    it.copy(
                        failure = AgentTurnFailure(
                            message = event.message.ifBlank { event.code },
                            code = event.code.takeIf { code -> code.isNotBlank() },
                            providerDetail = event.provider?.formatLine(),
                        ),
                    )
                }
                forceFlushActiveGates(
                    withError.copy(busy = false, deepResearch = false, lastTurnError = null),
                )
            }

            // A connection-control signal, not a transcript event — the
            // coordinator reloads the persisted transcript on it (see
            // [AgentCoordinator.handle]). Nothing for the pure reducer to do.
            is AgentEvent.Resync -> state

            is AgentEvent.Unknown -> state
        }
    }

    /** UI-driven: an ephemeral card's dismiss animation finished — drain its parked events. */
    fun flushEphemeralTail(state: AgentChatState, toolCallId: String): AgentChatState {
        val turnIdx = state.turns.indexOfLast { it is AgentTurn.Assistant }
        if (turnIdx < 0) return state
        val assistant = state.turns[turnIdx] as AgentTurn.Assistant
        val partIdx = assistant.parts.indexOfLast { it is AgentPart.Tool && it.call.toolCallId == toolCallId }
        if (partIdx < 0) return state
        val call = (assistant.parts[partIdx] as AgentPart.Tool).call
        if (call.tailDismissed) return state // double-flush guard

        val queued = call.pendingTail
        val drained = assistant.replaceAt(partIdx, AgentPart.Tool(call.copy(pendingTail = emptyList(), tailDismissed = true)))
        var next = state.copy(turns = state.turns.toMutableList().also { it[turnIdx] = drained })
        for (event in queued) next = reduce(next, event)
        return next
    }

    /** Safety net on turn end: drain every still-active gate (their dismiss never fired). */
    fun forceFlushActiveGates(state: AgentChatState): AgentChatState {
        var next = state
        while (true) {
            val gateIdx = activeEphemeralGateIndex(next) ?: break
            val turnIdx = next.turns.indexOfLast { it is AgentTurn.Assistant }
            if (turnIdx < 0) break
            val assistant = next.turns[turnIdx] as AgentTurn.Assistant
            if (gateIdx >= assistant.parts.size) break
            val part = assistant.parts[gateIdx] as? AgentPart.Tool ?: break
            val queued = part.call.pendingTail
            val drained = assistant.replaceAt(gateIdx, AgentPart.Tool(part.call.copy(pendingTail = emptyList(), tailDismissed = true)))
            next = next.copy(turns = next.turns.toMutableList().also { it[turnIdx] = drained })
            for (event in queued) next = reduce(next, event)
        }
        return next
    }

    // --- sub-agent card ---

    /**
     * Locate the [AgentPart.Subagent] card with [subagentId] across every assistant
     * turn (a `subagent.event`/`result` can arrive after later parts attached to the
     * parent), apply [mutation] in place. No-op when the card isn't found (a stray
     * event for a card we never opened — graceful degrade). Mirrors the iOS
     * `mutateSubagentCard`.
     */
    private fun mutateSubagentCard(
        state: AgentChatState,
        subagentId: String,
        mutation: (AgentSubagentCard) -> AgentSubagentCard,
    ): AgentChatState {
        val turns = state.turns
        for (i in turns.indices.reversed()) {
            val assistant = turns[i] as? AgentTurn.Assistant ?: continue
            val partIdx = assistant.parts.indexOfLast {
                it is AgentPart.Subagent && it.card.subagentId == subagentId
            }
            if (partIdx < 0) continue
            val card = (assistant.parts[partIdx] as AgentPart.Subagent).card
            val updated = assistant.replaceAt(partIdx, AgentPart.Subagent(mutation(card)))
            return state.copy(turns = turns.toMutableList().also { it[i] = updated })
        }
        return state
    }

    private fun findSubagentCard(state: AgentChatState, subagentId: String): AgentSubagentCard? {
        for (turn in state.turns.asReversed()) {
            val assistant = turn as? AgentTurn.Assistant ?: continue
            val card = assistant.parts.asReversed().filterIsInstance<AgentPart.Subagent>()
                .firstOrNull { it.card.subagentId == subagentId }
            if (card != null) return card.card
        }
        return null
    }

    private fun removeToolPart(state: AgentChatState, toolCallId: String): AgentChatState {
        for (turnIdx in state.turns.indices.reversed()) {
            val assistant = state.turns[turnIdx] as? AgentTurn.Assistant ?: continue
            val parts = assistant.parts.filterNot {
                it is AgentPart.Tool && it.call.toolCallId == toolCallId
            }
            if (parts.size == assistant.parts.size) continue
            return state.copy(turns = state.turns.toMutableList().also {
                it[turnIdx] = assistant.copy(parts = parts)
            })
        }
        return state
    }

    private fun removeOrchestrationTools(state: AgentChatState): AgentChatState =
        state.updateLastAssistant { assistant ->
            assistant.copy(parts = assistant.parts.filterNot {
                it is AgentPart.Tool && it.call.tool in ORCHESTRATION_TOOLS
            })
        }

    /**
     * Fold one wrapped child [AgentEvent] into a sub-agent card. Self-contained: no
     * ephemeral causality gate, no citations sidebar — the card's own bookkeeping
     * only ([AgentSubagentCard.stepCount], tokens, reached documents) plus the
     * pending tool-call identity it needs to pair a child's tool result with the
     * call that opened it.
     *
     * What a child streams and the card shows are different things: a researcher's
     * prose and reasoning are not on the card at any size, so they are not kept.
     * Any event kind not handled here (citation / nested subagent.* / error /
     * Unknown) leaves the card unchanged — the graceful-degrade arm, the Android
     * twin of iOS's `.unknown` fallthrough. Mirrors the iOS `reduceChildEvent`.
     */
    private fun reduceChildEvent(card: AgentSubagentCard, childEvent: AgentEvent): AgentSubagentCard {
        return when (childEvent) {
            is AgentEvent.MessageStart ->
                // A child request boundary. `childTurns` is scratch state for the
                // identity of the tool calls in flight, so only the current request's
                // is worth keeping: a reader issues many sequential requests, and
                // holding every one grows a structure nothing reads. Idempotent on
                // re-delivery.
                if (card.childTurns.lastOrNull()?.id == childEvent.messageId) {
                    card
                } else {
                    card.copy(childTurns = listOf(AgentChildTurn(childEvent.messageId)))
                }

            is AgentEvent.TextDelta, is AgentEvent.ThinkingDelta ->
                // The card renders a researcher's identity, step count, token total,
                // reached documents and terminal summary — never its prose or its
                // reasoning, so neither is kept. A research run streams thousands of
                // these on the scope that paints the transcript, and every one that is
                // retained is copied again by the next.
                card

            is AgentEvent.ToolInputStart -> {
                if (childEvent.tool == "plan") return card
                var counted = false
                val next = card.mutateLastChildTurn { turn ->
                    val have = turn.parts.any {
                        it is AgentPart.Tool && it.call.toolCallId == childEvent.toolCallId
                    }
                    if (have) {
                        turn
                    } else {
                        // A new child tool call is one "step" of the sub-agent's work.
                        counted = true
                        turn.copy(parts = turn.parts + AgentPart.Tool(AgentToolCall(childEvent.toolCallId, childEvent.tool, argsKnown = false)))
                    }
                }
                if (counted) next.copy(stepCount = next.stepCount + 1) else next
            }

            is AgentEvent.ToolStart -> {
                if (childEvent.tool == "plan") return card
                val summary = childEvent.argsSummary ?: summarizeArgs(childEvent.tool, childEvent.args)
                var counted = false
                val next = card.mutateLastChildTurn { turn ->
                    val idx = turn.parts.indexOfLast {
                        it is AgentPart.Tool && it.call.toolCallId == childEvent.toolCallId
                    }
                    if (idx >= 0) {
                        val call = (turn.parts[idx] as AgentPart.Tool).call
                        turn.replaceAt(idx, AgentPart.Tool(call.copy(args = childEvent.args, argsSummary = summary, argsKnown = true)))
                    } else {
                        // No prior input_start (replay / non-Anthropic backends skip
                        // it): this is the step boundary, count it here.
                        counted = true
                        turn.copy(parts = turn.parts + AgentPart.Tool(AgentToolCall(childEvent.toolCallId, childEvent.tool, args = childEvent.args, argsSummary = summary, argsKnown = true)))
                    }
                }
                if (counted) next.copy(stepCount = next.stepCount + 1) else next
            }

            is AgentEvent.ToolResult -> {
                val result = childEvent.result
                if (result is AgentToolResult.PlanUpdated) {
                    card
                } else {
                    // Feed the research working-set FIRST, before touching the transcript:
                    // the docs accrue off the result alone, independent of a matching
                    // tool part, so an out-of-order result (no preceding input/tool start)
                    // still feeds the surface. Mirrors the iOS docsFromChildToolResult.
                    val withDocs = mergeCardDocs(card, docsFromChildToolResult(result))
                    withDocs.mutateLastChildTurn { turn ->
                        val idx = turn.parts.indexOfLast {
                            it is AgentPart.Tool && it.call.toolCallId == childEvent.toolCallId
                        }
                        if (idx < 0) {
                            turn
                        } else {
                            // The result has already given the working set its document
                            // refs, and the part existed only to pair this result with the
                            // call that opened it. Drop it rather than hold a payload —
                            // a fetched document body, a SQL page, a trail — that nothing
                            // on the card reads.
                            turn.copy(parts = turn.parts.filterIndexed { i, _ -> i != idx })
                        }
                    }
                }
            }

            is AgentEvent.ToolChildResult ->
                // Batch tools surface their source-bearing singular outcomes
                // before the terminal batch result. The compact researcher row
                // tracks that working set without duplicating batch cards.
                mergeCardDocs(card, docsFromChildToolResult(childEvent.result))

            is AgentEvent.MessageEnd ->
                // The request is over, so the tool-pairing scratch it accumulated has
                // nothing left to pair.
                withChildUsage(card, childEvent.messageId, childEvent.usage, terminal = true)
                    .copy(childTurns = emptyList())

            is AgentEvent.UsageUpdate -> withChildUsage(card, childEvent.messageId, childEvent.usage)

            // userMessage / citation / citationsUpdate / nested subagent.* / error /
            // Unknown are not part of the inline transcript: graceful degrade.
            else -> card
        }
    }

    private fun withChildUsage(
        card: AgentSubagentCard,
        messageId: String,
        usage: AgentUsage?,
        terminal: Boolean = false,
    ): AgentSubagentCard {
        if (terminal && card.completedUsageByMessage.containsKey(messageId)) return card
        val snapshot = mergeUsage(card.liveUsageByMessage[messageId], usage)
        val live = card.liveUsageByMessage.toMutableMap()
        val completed = card.completedUsageByMessage.toMutableMap()
        if (terminal) {
            live.remove(messageId)
            completed[messageId] = snapshot
        } else {
            live[messageId] = snapshot
        }
        return card.copy(
            completedUsageByMessage = completed,
            liveUsageByMessage = live,
            tokens = completed.values.sumOf { it.total } + live.values.sumOf { it.total },
        )
    }

    private fun mergeUsage(previous: AgentUsage?, next: AgentUsage?): AgentUsage = AgentUsage(
        inputTokens = next?.inputTokens ?: previous?.inputTokens,
        outputTokens = next?.outputTokens ?: previous?.outputTokens,
        cacheReadTokens = next?.cacheReadTokens ?: previous?.cacheReadTokens,
        cacheCreationTokens = next?.cacheCreationTokens ?: previous?.cacheCreationTokens,
    )

    // --- verified-report artifact ---

    /**
     * Fold the additive `agent.deep_research.summary` onto the assistant turn it names
     * (`messageId`) as an [AgentTurn.Assistant.reportArtifact] field — located by id, so
     * it lands even if later parts attached to the turn after the report streamed. A turn
     * we never opened is a no-op (graceful degrade for a stray event). Pure; the
     * cross-session guard lives one layer up in [AgentCoordinator.handle]. Mirrors the iOS
     * `attachReportArtifact`.
     */
    private fun attachReportArtifact(state: AgentChatState, event: AgentEvent.DeepResearchSummary): AgentChatState =
        state.updateAssistantById(event.messageId) {
            it.copy(
                reportArtifact = AgentReportArtifact(
                    stoppedReason = event.stoppedReason,
                    plan = event.plan,
                    treeUsage = event.treeUsage,
                    verification = event.verification,
                ),
            )
        }

    // --- research working-set surface ---

    /**
     * Extract the documents a child tool result reached, in the minimal source-tintable
     * [AgentResearchDoc] form the working-set surface paints — with NO branching on a
     * specific source (source identity rides each ref's `sourceId`, resolved through the
     * registry by the view). Returns a (possibly empty) list; result kinds that carry no
     * documents (SQL, people, plan, triggers, errors, unknown) yield none — graceful
     * degrade. Generic over the document-bearing kinds (search / document / document.byUrl
     * / trace_connections). Mirrors the iOS / portal `docsFromChildToolResult`.
     */
    fun docsFromChildToolResult(result: AgentToolResult): List<AgentResearchDoc> {
        fun make(ref: AgentDocRef) = AgentResearchDoc(ref.documentId, ref.title, ref.sourceId)
        return when (result) {
            is AgentToolResult.SearchResults -> result.results.map(::make)
            is AgentToolResult.DocumentResult -> listOf(make(result.ref))
            is AgentToolResult.SearchBatch -> result.items.flatMap(::docsFromChildToolResult)
            is AgentToolResult.DocumentBatch -> result.items.flatMap(::docsFromChildToolResult)
            is AgentToolResult.DocumentByUrl -> result.ref?.let { listOf(make(it)) } ?: emptyList()
            is AgentToolResult.EventTrailBuilt -> {
                // Top-level events plus their attachments — the same flatten the trail card
                // uses, so a researcher's trail walk contributes its docs.
                val out = mutableListOf<AgentResearchDoc>()
                for (ev in result.events) {
                    ev.doc?.let { out.add(AgentResearchDoc(it.documentId, it.title, it.sourceId)) }
                    for (att in ev.attachments) {
                        att.doc?.let { out.add(AgentResearchDoc(it.documentId, it.title, it.sourceId)) }
                    }
                }
                out
            }
            else -> emptyList()
        }
    }

    /**
     * Append new docs to a card's [AgentSubagentCard.docs], deduped by documentId (existing
     * entries win, preserving arrival order). No-op when nothing new arrives. Mirrors the
     * iOS / portal `mergeCardDocs`.
     */
    private fun mergeCardDocs(card: AgentSubagentCard, incoming: List<AgentResearchDoc>): AgentSubagentCard {
        if (incoming.isEmpty()) return card
        val seen = card.docs.mapTo(HashSet()) { it.documentId }
        val additions = incoming.filter { seen.add(it.documentId) }
        return if (additions.isEmpty()) card else card.copy(docs = card.docs + additions)
    }

    /**
     * Project the sub-agent cards on the latest assistant turn into one panel descriptor per
     * researcher, in spawn order — the view contract for the working-set surface. A pure
     * function of [AgentChatState.turns] so it unit-tests without Compose. The most-recent
     * assistant turn is the run in flight: its [AgentPart.Subagent] cards are the researchers
     * (matches the iOS / portal selector, which stops at the latest assistant turn). Mirrors
     * the iOS `researchPanels`.
     */
    fun researchPanels(state: AgentChatState): List<AgentResearchPanel> {
        for (turn in state.turns.asReversed()) {
            val assistant = turn as? AgentTurn.Assistant ?: continue
            return assistant.parts.mapNotNull { part ->
                (part as? AgentPart.Subagent)?.card?.let { card ->
                    AgentResearchPanel(
                        subagentId = card.subagentId,
                        specialist = card.specialist,
                        title = card.title,
                        task = card.task,
                        docs = card.docs,
                        stepCount = card.stepCount,
                        tokens = card.tokens,
                        status = card.status,
                        summary = card.summary,
                    )
                }
            }
        }
        return emptyList()
    }

    /**
     * True when the research working-set surface should be on screen: a Deep Research run is
     * in flight ([AgentChatState.deepResearch]) AND at least one researcher panel exists. Once
     * `deepResearch` clears (the run ended) the surface collapses even though the finished
     * cards still live on the transcript. Mirrors the iOS `isResearchWorkspaceActive`.
     */
    fun isResearchWorkspaceActive(state: AgentChatState): Boolean =
        state.deepResearch && researchPanels(state).isNotEmpty()

    /**
     * Whether the turn-level "working" dots are eligible to show: the turn is in flight AND its
     * trailing content is static, so no per-item affordance (thinking shimmer, pending-tool
     * spinner, running sub-agent) is already signalling activity. The view debounces the actual
     * reveal against streamed-token cadence, so this only answers "is there a live self-animating
     * tail?", not "has the stream gone quiet?". Pure over the state so it is unit-testable
     * without a view. Mirrors the iOS `AgentCoordinator.workingIndicatorActive`.
     */
    fun workingIndicatorActive(state: AgentChatState): Boolean {
        if (!state.busy) return false
        val last = state.turns.lastOrNull() ?: return false
        // Sent, awaiting the first `message.start` — the assistant turn doesn't exist yet,
        // so nothing else can be animating.
        if (last is AgentTurn.User) return true
        val assistant = last as? AgentTurn.Assistant ?: return false
        if (assistant.stopReason != null) return false
        // `message.start` landed but no delta yet — the assistant turn renders nothing.
        val tail = assistant.parts.lastOrNull() ?: return true
        return when (tail) {
            is AgentPart.Text, is AgentPart.Unknown -> true
            // Live trailing thinking part paints its own shimmer + dots.
            is AgentPart.Thinking -> false
            is AgentPart.Tool -> {
                // A batch retrieval tool renders per-child cards only when the backend streams
                // `agent.tool.child.*` progress (Codex). With no children it shows NOTHING for the
                // often-multi-second batch — running or just-finished — so the dots are the only
                // "still working" signal; with children the per-child cards animate. A pending
                // singular tool shows its own spinner; a completed singular card is static while
                // the model generates the next step.
                if (tail.call.tool in BATCH_EPHEMERAL_TOOLS) {
                    tail.call.children.isEmpty()
                } else {
                    tail.call.result != null
                }
            }
            // A running sub-agent card spins; a finished one is static.
            is AgentPart.Subagent -> tail.card.status != null
        }
    }

    /**
     * The citations the reference drawer should surface: only the ones the agent
     * recorded for THIS conversation via the `annotate` tool — each carries a quote
     * entry or a doc note. The merged citation set a Deep Research run emits
     * (`agent.citations.update`: refs without entries) belongs to the report-artifact
     * card alone, so it is excluded here. The drawer therefore stays untouched during
     * Deep Research, matching iOS and the portal.
     */
    fun drawerCitations(state: AgentChatState): List<AgentCitation> =
        state.citations.filter { it.entries.isNotEmpty() || it.docNote != null }

    // --- gate helpers ---

    private fun eventAppendsToTurn(e: AgentEvent): Boolean = when (e) {
        is AgentEvent.TextDelta, is AgentEvent.ThinkingDelta,
        is AgentEvent.ToolInputStart, is AgentEvent.ToolStart, is AgentEvent.ToolResult,
        is AgentEvent.SubagentSpawned, is AgentEvent.SubagentResult,
        -> true
        else -> false
    }

    private fun activeEphemeralGateIndex(state: AgentChatState): Int? {
        val turnIdx = state.turns.indexOfLast { it is AgentTurn.Assistant }
        if (turnIdx < 0) return null
        val assistant = state.turns[turnIdx] as AgentTurn.Assistant
        for (i in assistant.parts.indices.reversed()) {
            val part = assistant.parts[i]
            if (part !is AgentPart.Tool) continue
            // A batch parent (search_many / fetch_many) never gates — it renders as N independent
            // per-child cards with their own dismiss lifecycles, so there is no single card to
            // drive a parent flush; its answer text streams immediately. Skip it (and any
            // non-ephemeral tool) and keep looking further back for a gating ephemeral card.
            if (!actsAsGate(part.call.tool)) continue
            // First gate-acting ephemeral tool from the tail: a gate iff it has a result and is not
            // yet dismissed. Mirrors the portal's findActiveGateIndex / iOS activeEphemeralGateIndex.
            return if (part.call.result != null && !part.call.tailDismissed) i else null
        }
        return null
    }

    /** Gate whose parked tail needs a coordinator-owned timeout if its UI disappears. */
    internal fun activeEphemeralGateWithPendingTail(state: AgentChatState): String? {
        val index = activeEphemeralGateIndex(state) ?: return null
        val assistant = state.turns.lastOrNull { it is AgentTurn.Assistant } as? AgentTurn.Assistant
            ?: return null
        val call = (assistant.parts.getOrNull(index) as? AgentPart.Tool)?.call ?: return null
        return call.toolCallId.takeIf { call.pendingTail.isNotEmpty() }
    }

    private fun enqueueOnGate(state: AgentChatState, partIdx: Int, event: AgentEvent): AgentChatState =
        state.updateLastAssistant { a ->
            if (partIdx >= a.parts.size) return@updateLastAssistant a
            val part = a.parts[partIdx] as? AgentPart.Tool ?: return@updateLastAssistant a
            a.replaceAt(partIdx, AgentPart.Tool(part.call.copy(pendingTail = part.call.pendingTail + event)))
        }

    // --- batch tool children (search_many / fetch_many) ---

    /**
     * Upsert one child (keyed by [childIndex]) onto the batch tool part named by [toolCallId] on the
     * current assistant turn, keeping [AgentToolCall.children] sorted by index. A stray child for a
     * part we never opened is a no-op (graceful degrade). Mirrors the portal's `agent.tool.child.*`
     * reduction onto `part.children`.
     */
    private fun applyToolChild(
        state: AgentChatState,
        toolCallId: String,
        childIndex: Int,
        upsert: (AgentToolChild?) -> AgentToolChild,
    ): AgentChatState = state.updateLastAssistant { a ->
        val idx = a.parts.indexOfLast { it is AgentPart.Tool && it.call.toolCallId == toolCallId }
        if (idx < 0) return@updateLastAssistant a
        val call = (a.parts[idx] as AgentPart.Tool).call
        val existing = call.children.firstOrNull { it.index == childIndex }
        val merged = upsert(existing)
        val children = (call.children.filter { it.index != childIndex } + merged).sortedBy { it.index }
        a.replaceAt(idx, AgentPart.Tool(call.copy(children = children)))
    }

    // --- citations ---

    private fun applyCitation(state: AgentChatState, e: AgentEvent.Citation): AgentChatState {
        val isDocNote = e.quote == null && e.note != null
        val entry = AgentCitationEntry(e.toolCallId, e.messageId, e.quote, e.note, e.quoteAuthor, e.quoteIsSelf)

        val citations = state.citations.toMutableList()
        val byDoc = state.citationsByDocId.toMutableMap()
        val existing = byDoc[e.ref.documentId]
        if (existing != null) {
            val c = citations[existing]
            citations[existing] = if (isDocNote) c.copy(docNote = e.note) else c.copy(entries = c.entries + entry)
        } else {
            byDoc[e.ref.documentId] = citations.size
            val seed = AgentCitation(
                documentId = e.ref.documentId,
                ref = e.ref,
                docNote = if (isDocNote) e.note else null,
                entries = if (isDocNote) emptyList() else listOf(entry),
            )
            citations.add(seed)
        }

        return state.copy(citations = citations, citationsByDocId = byDoc)
            .updateAssistantById(e.messageId) { it.copy(citationCount = it.citationCount + 1) }
    }

    private fun applyCitationsUpdate(state: AgentChatState, e: AgentEvent.CitationsUpdate): AgentChatState {
        val citations = state.citations.toMutableList()
        val byDoc = state.citationsByDocId.toMutableMap()
        for (ref in e.added) {
            if (byDoc[ref.documentId] == null) {
                byDoc[ref.documentId] = citations.size
                citations.add(AgentCitation(documentId = ref.documentId, ref = ref))
            }
        }
        for (id in e.removed) {
            val idx = byDoc[id] ?: continue
            citations.removeAt(idx)
            byDoc.remove(id)
            for ((docId, otherIdx) in byDoc.toList()) {
                if (otherIdx > idx) byDoc[docId] = otherIdx - 1
            }
        }
        return state.copy(citations = citations, citationsByDocId = byDoc)
    }

    // --- arg/title helpers ---

    fun summarizeArgs(tool: String, args: JsonElement): String {
        val obj = args as? JsonObject ?: return ""
        fun s(key: String) = obj[key]?.jsonPrimitive?.contentOrNull
        fun i(key: String) = obj[key]?.jsonPrimitive?.intOrNull
        fun strs(key: String) = (obj[key] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
        return when (tool) {
            "search_documents" -> {
                val query = s("query") ?: return ""
                val extras = buildList {
                    i("limit")?.let { add("limit=$it") }
                }
                if (extras.isEmpty()) query else "$query (${extras.joinToString(", ")})"
            }
            "fetch_document" -> s("documentId").orEmpty().take(24)
            "trace_connections" -> {
                val head = strs("seedIds").joinToString(",") { it.take(8) }
                val extras = buildList {
                    i("depth")?.let { add("depth=$it") }
                    i("fanoutCap")?.let { add("fanout=$it") }
                }
                if (extras.isEmpty()) head else "$head ${extras.joinToString(" ")}"
            }
            "run_sql" -> s("sql").orEmpty().take(80)
            "lookup_people" -> s("query").orEmpty()
            "search_loops" -> s("query").orEmpty()
            "fetch_loop" -> s("loopId").orEmpty().take(24)
            "lookup_document_by_url" -> {
                val url = s("url").orEmpty()
                if (url.length > 80) url.take(77) + "…" else url
            }
            else -> OmnesisJson.encodeToString(JsonElement.serializer(), args).take(120)
        }
    }

    fun deriveTitle(text: String): String {
        val oneLine = text.replace("\n", " ").trim()
        return if (oneLine.length > 70) oneLine.take(69) + "…" else oneLine
    }
}

// --- immutable update helpers on the turn list ---

private fun AgentChatState.updateLastAssistant(
    transform: (AgentTurn.Assistant) -> AgentTurn.Assistant,
): AgentChatState {
    val idx = turns.indexOfLast { it is AgentTurn.Assistant }
    if (idx < 0) return this
    return copy(turns = turns.toMutableList().also { it[idx] = transform(turns[idx] as AgentTurn.Assistant) })
}

private fun AgentChatState.updateAssistantById(
    messageId: String,
    transform: (AgentTurn.Assistant) -> AgentTurn.Assistant,
): AgentChatState {
    val idx = turns.indexOfLast { it is AgentTurn.Assistant && it.id == messageId }
    if (idx < 0) return this
    return copy(turns = turns.toMutableList().also { it[idx] = transform(turns[idx] as AgentTurn.Assistant) })
}

/**
 * Append-or-replace a record citation by its `recordKey` (last wins), preserving first-seen
 * order. Used by both the live reducer and the resume-path turn builder so a re-cite updates the
 * existing timeline row's metadata rather than duplicating it.
 */
internal fun mergeRecord(records: List<AgentTrailRecord>, record: AgentTrailRecord): List<AgentTrailRecord> {
    val idx = records.indexOfFirst { it.recordKey == record.recordKey }
    return if (idx >= 0) {
        records.toMutableList().also { it[idx] = record }
    } else {
        records + record
    }
}

private fun AgentTurn.Assistant.replaceLast(part: AgentPart): AgentTurn.Assistant =
    copy(parts = parts.toMutableList().also { it[it.size - 1] = part })

private fun AgentTurn.Assistant.replaceAt(index: Int, part: AgentPart): AgentTurn.Assistant =
    copy(parts = parts.toMutableList().also { it[index] = part })

// --- sub-agent child-turn update helpers ---

/**
 * Mutate the scratch state of the child request in flight. Seeds an implicit entry
 * if a tool event arrives before any `message.start` (defensive; the orchestrator
 * emits start first). Mirrors the iOS `mutateLastChildTurn`.
 */
private fun AgentSubagentCard.mutateLastChildTurn(
    transform: (AgentChildTurn) -> AgentChildTurn,
): AgentSubagentCard {
    val turns = if (childTurns.isEmpty()) listOf(AgentChildTurn(id = subagentId)) else childTurns
    val idx = turns.size - 1
    return copy(childTurns = turns.toMutableList().also { it[idx] = transform(turns[idx]) })
}

private fun AgentChildTurn.replaceAt(index: Int, part: AgentPart): AgentChildTurn =
    copy(parts = parts.toMutableList().also { it[index] = part })
