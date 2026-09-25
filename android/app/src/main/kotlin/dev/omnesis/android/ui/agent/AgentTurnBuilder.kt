// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AgentTrailRecord
import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.UserPart
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Rebuilds the rendering state (turns / citations / records) from a resumed
 * `ChatMessage[]` history. Faithful port of the iOS `AgentTurnBuilder`: a user-text
 * message starts a turn; subsequent assistant messages and user(tool_result) messages
 * fold into the same assistant turn until the next user-text. `plan` and ephemeral
 * tools are dropped from the rebuilt history (they're transient).
 */
object AgentTurnBuilder {

    fun turns(messages: List<ChatMessage>, idPrefix: String = ""): List<AgentTurn> {
        val out = mutableListOf<AgentTurn>()
        var i = 0
        var n = 0
        while (i < messages.size) {
            when (val m = messages[i]) {
                is ChatMessage.Unknown -> {
                    out.add(AgentTurn.Assistant(id = "${idPrefix}a-$n", parts = listOf(AgentPart.Unknown("message", m.role))))
                    n++; i++
                }

                is ChatMessage.User -> {
                    val text = m.parts.firstNotNullOfOrNull { (it as? UserPart.Text)?.text }
                    if (text != null) {
                        out.add(AgentTurn.User("${idPrefix}u-$n", text))
                        n++
                    }
                    i++
                }

                is ChatMessage.Assistant -> {
                    val parts = mutableListOf<AgentPart>()
                    var citationCount = 0
                    var stopReason: String? = null
                    var stopped: String? = null
                    var failure: AgentTurnFailure? = null
                    var reportArtifact: AgentReportArtifact? = null
                    val assistantId = "${idPrefix}a-$n"
                    n++
                    val toolIndexById = mutableMapOf<String, Int>()
                    fold@ while (i < messages.size) {
                        when (val fm = messages[i]) {
                            is ChatMessage.Unknown -> break@fold
                            is ChatMessage.Assistant -> {
                                for (p in fm.parts) {
                                    when (p) {
                                        is AssistantPart.Unknown -> parts.add(AgentPart.Unknown("message part", p.kind))
                                        // A turn that died left a marker in model-visible
                                        // history so the model knows on its next turn that it
                                        // failed. The reader gets the styled failure instead —
                                        // rendering the marker as prose too would show the
                                        // same failure twice.
                                        is AssistantPart.Text -> {
                                            val marked = splitTerminalFailureMarker(p.text)
                                            if (marked == null) {
                                                parts.add(AgentPart.Text(p.text))
                                            } else {
                                                if (marked.first.isNotEmpty()) parts.add(AgentPart.Text(marked.first))
                                                if (marked.second.code == "canceled") {
                                                    // A stopped reply is an outcome, not a failure: the
                                                    // live view ends such a turn with no error
                                                    // affordance, so a reopened one says only that
                                                    // it stopped.
                                                    stopReason = "canceled"
                                                    stopped = marked.second.message
                                                } else {
                                                    failure = marked.second
                                                }
                                            }
                                        }
                                        // Thinking is a transient live-stream indicator (see
                                        // ThinkingBlock in AgentBubbles) — like the ephemeral
                                        // tool cards below, it is never rebuilt into resumed
                                        // history. Drop it so reopening a past conversation
                                        // shows the answer alone. The server record is untouched.
                                        is AssistantPart.Thinking -> continue
                                        // Persisted Deep Research artifact (#748): rebuild the
                                        // same `reportArtifact` the live
                                        // `agent.deep_research.summary` event folds on (see
                                        // AgentReducer.attachReportArtifact) so the verified-report
                                        // card renders on reload exactly as live. Its citations are
                                        // seeded separately in reportArtifactCitations(). Mirrors
                                        // the portal reducer's `report_artifact` branch.
                                        is AssistantPart.ReportArtifact ->
                                            reportArtifact = AgentReportArtifact(
                                                stoppedReason = p.stoppedReason,
                                                plan = p.plan,
                                                treeUsage = p.treeUsage,
                                                verification = p.verification,
                                            )
                                        is AssistantPart.ToolUse -> {
                                            if (p.tool in AgentReducer.HIDDEN_TRANSCRIPT_TOOLS || p.tool in AgentReducer.EPHEMERAL_TOOLS) continue
                                            parts.add(
                                                AgentPart.Tool(
                                                    AgentToolCall(
                                                        p.toolCallId, p.tool, args = p.args,
                                                        argsSummary = AgentReducer.summarizeArgs(p.tool, p.args), argsKnown = true,
                                                    ),
                                                ),
                                            )
                                            toolIndexById[p.toolCallId] = parts.size - 1
                                            // Citation tools count toward the turn's reference count:
                                            // `annotate` / `cite_record` cite one each; `annotate_many`
                                            // contributes one per child annotation (no `agent.citation`
                                            // events on reload, so the count is derived from the args).
                                            when (p.tool) {
                                                "annotate_many" -> citationCount += annotateManyCount(p.args)
                                                "annotate", "cite_record" -> citationCount++
                                            }
                                        }
                                    }
                                }
                                i++
                            }
                            is ChatMessage.User -> {
                                for (p in fm.parts) {
                                    when (p) {
                                        is UserPart.ToolResultPart -> {
                                            val idx = toolIndexById[p.toolCallId]
                                            if (idx != null) {
                                                val call = (parts[idx] as AgentPart.Tool).call
                                                parts[idx] = AgentPart.Tool(call.copy(result = p.result))
                                            }
                                        }
                                        is UserPart.Unknown -> parts.add(AgentPart.Unknown("user content", p.kind))
                                        is UserPart.Text -> Unit
                                    }
                                }
                                if (fm.parts.any { it is UserPart.Text }) break@fold
                                i++
                            }
                        }
                    }
                    out.add(
                        AgentTurn.Assistant(
                            id = assistantId,
                            parts = parts,
                            stopReason = stopReason,
                            failure = failure,
                            stopped = stopped,
                            citationCount = citationCount,
                            reportArtifact = reportArtifact,
                        ),
                    )
                }
            }
        }
        return out
    }

    /**
     * The marker the agent session appends to model-visible history when a turn dies, so the
     * model knows on its next turn that it failed.
     */
    const val TERMINAL_FAILURE_MARKER = "Model request failed: "

    /**
     * Lift that marker out of one assistant text part: the body the turn had produced before it
     * died, paired with the failure the marker records. Null when the text is an ordinary answer.
     *
     * The match is anchored where the session writes the marker — at the very start of the text,
     * or after the blank line separating it from whatever the turn produced first. An assistant
     * that merely quotes the phrase mid-sentence, explaining a log line say, is answering rather
     * than failing, and its answer must survive the reopen intact.
     */
    fun splitTerminalFailureMarker(text: String): Pair<String, AgentTurnFailure>? {
        val at = anchoredMarkerIndex(text)
        if (at < 0) return null
        val tail = text.substring(at + TERMINAL_FAILURE_MARKER.length)
        val separator = tail.indexOf(": ")
        if (separator < 0) return null
        val code = tail.substring(0, separator).trim()
        val message = tail.substring(separator + 2).trim()
        if (code.isEmpty() || message.isEmpty()) return null
        // The marker carries the code and the sentence; the provider's disposition reaches only
        // the live stream and the conversation record, both of which hold the whole failure.
        return text.substring(0, at).trim() to AgentTurnFailure(message = message, code = code)
    }

    private fun anchoredMarkerIndex(text: String): Int {
        if (text.startsWith(TERMINAL_FAILURE_MARKER)) return 0
        val at = text.lastIndexOf("\n\n$TERMINAL_FAILURE_MARKER")
        return if (at < 0) -1 else at + 2
    }

    /**
     * The sentence a failed turn shows. The gateway names the condition; a record that carries no
     * sentence still gets one, since a bubble with an error style and no words says nothing at all.
     */
    fun failureSentence(message: String, truncated: Boolean): String {
        val trimmed = message.trim()
        if (trimmed.isNotEmpty()) return trimmed
        return if (truncated) {
            "The model reached its output limit before completing this response."
        } else {
            "The turn failed."
        }
    }

    fun citations(messages: List<ChatMessage>, idPrefix: String = ""): List<AgentCitation> {
        val byDoc = mutableMapOf<String, Int>()
        val out = mutableListOf<AgentCitation>()
        var n = 0
        var assistantSlot: String? = null
        val pendingAnnotates = mutableMapOf<String, String>() // toolCallId -> assistant slot id

        for (m in messages) {
            when (m) {
                is ChatMessage.Unknown -> Unit
                is ChatMessage.User -> {
                    for (p in m.parts) {
                        val tr = p as? UserPart.ToolResultPart ?: continue
                        val messageId = pendingAnnotates.remove(tr.toolCallId) ?: continue
                        // Fan an `annotate.batch` (annotate_many) out to one citation per child,
                        // using the SAME stable `<toolCallId>#<idx>` ids the live `agent.citation`
                        // events carry, so live and reloaded Timeline state are identical. A singular
                        // `annotate.recorded` keeps the bare `toolCallId`.
                        val recs = annotateRecordedItems(tr.result)
                        recs.forEachIndexed { idx, r ->
                            val childCallId = if (recs.size > 1) "${tr.toolCallId}#$idx" else tr.toolCallId
                            val isDocNote = r.quote == null && r.note != null
                            val existing = byDoc[r.documentId]
                            if (existing != null) {
                                val c = out[existing]
                                out[existing] = if (isDocNote) c.copy(docNote = r.note)
                                else c.copy(entries = c.entries + AgentCitationEntry(childCallId, messageId, r.quote, r.note, r.quoteAuthor, r.quoteIsSelf))
                            } else {
                                byDoc[r.documentId] = out.size
                                out.add(
                                    AgentCitation(
                                        documentId = r.documentId, ref = r.ref,
                                        docNote = if (isDocNote) r.note else null,
                                        entries = if (isDocNote) emptyList() else listOf(AgentCitationEntry(childCallId, messageId, r.quote, r.note, r.quoteAuthor, r.quoteIsSelf)),
                                    ),
                                )
                            }
                        }
                    }
                    if (m.parts.any { it is UserPart.Text }) {
                        n++
                        assistantSlot = null
                    }
                }
                is ChatMessage.Assistant -> {
                    val slot = assistantSlot ?: "${idPrefix}a-$n"
                    assistantSlot = slot
                    for (p in m.parts) {
                        if (p is AssistantPart.ToolUse && (p.tool == "annotate" || p.tool == "annotate_many")) {
                            pendingAnnotates[p.toolCallId] = slot
                        }
                    }
                }
            }
        }
        return out
    }

    /**
     * The merged citation refs carried on any persisted Deep Research `report_artifact` part
     * (#748), in transcript order, deduped by documentId. A deep-research run cites via this
     * single merged set, NOT via `annotate` tool pairs, so [citations] reconstructs none of them
     * — without seeding from here the resumed report card renders "0 sources" and no inline
     * markers. Mirrors the iOS `reportArtifactCitations` and the portal `load-conversation`
     * reducer seeding `state.citations` from `turn.reportCitations`.
     */
    fun reportArtifactCitations(messages: List<ChatMessage>): List<AgentDocRef> {
        val seen = mutableSetOf<String>()
        val out = mutableListOf<AgentDocRef>()
        for (m in messages) {
            val assistant = m as? ChatMessage.Assistant ?: continue
            for (p in assistant.parts) {
                val artifact = p as? AssistantPart.ReportArtifact ?: continue
                for (ref in artifact.citations) {
                    if (seen.add(ref.documentId)) out.add(ref)
                }
            }
        }
        return out
    }

    /**
     * Rebuild the directly-cited records (#757) from a resumed history: walk every user
     * `tool_result` part for a `cite_record.recorded` result, deduped by `recordKey` (last wins).
     * A record the agent cited directly is restored onto the timeline feed through here.
     */
    fun records(messages: List<ChatMessage>): List<AgentTrailRecord> {
        var out = emptyList<AgentTrailRecord>()
        for (m in messages) {
            val user = m as? ChatMessage.User ?: continue
            for (p in user.parts) {
                val tr = p as? UserPart.ToolResultPart ?: continue
                val r = tr.result as? AgentToolResult.CiteRecord ?: continue
                out = mergeRecord(out, r.toTrailRecord())
            }
        }
        return out
    }

    /**
     * The `annotate.recorded` items in a persisted tool result: one for a singular `annotate`, N
     * (in order) for an `annotate.batch` (annotate_many), none otherwise. Lets the reload rebuilder
     * fan a batch out to one citation per child — matching the live path so live and reloaded
     * Timeline state are identical. Mirrors the portal's `annotateRecordedItems`.
     */
    private fun annotateRecordedItems(result: AgentToolResult): List<AgentToolResult.AnnotateRecorded> =
        when (result) {
            is AgentToolResult.AnnotateRecorded -> listOf(result)
            is AgentToolResult.AnnotateBatch -> result.items.filterIsInstance<AgentToolResult.AnnotateRecorded>()
            else -> emptyList()
        }

    /** Child-annotation count of an `annotate_many` tool_use's args (`annotations.length`, else 1). */
    private fun annotateManyCount(args: JsonElement): Int =
        ((args as? JsonObject)?.get("annotations") as? JsonArray)?.size ?: 1

    fun stateFrom(messages: List<ChatMessage>, idPrefix: String = ""): AgentChatState {
        val cits = citations(messages, idPrefix).toMutableList()
        // Seed the Citations set from any persisted Deep Research `report_artifact` part (#748).
        // A deep-research run cites via the merged artifact set, not via `annotate` tool pairs, so
        // `citations` reconstructs none of them — without this the resumed report card renders
        // "0 sources" and no inline markers. Each seed has empty entries (no quote/note context
        // survives — mirrors the live `applyCitationsUpdate` seeding shape and the portal reducer).
        val seen = cits.mapTo(mutableSetOf()) { it.documentId }
        for (ref in reportArtifactCitations(messages)) {
            if (seen.add(ref.documentId)) cits.add(AgentCitation(documentId = ref.documentId, ref = ref))
        }
        return AgentChatState(
            turns = turns(messages, idPrefix),
            citations = cits,
            citationsByDocId = cits.mapIndexed { i, c -> c.documentId to i }.toMap(),
            records = records(messages),
        )
    }
}
