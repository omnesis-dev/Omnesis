// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.PrivacyAnswerAgentTrace
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

/**
 * Answer agent-trace rendering: the native twin of the portal's
 * `PrivacyAgentTranscripts` (`exchange-detail.js`).
 *
 * One stored attempt contributes its TOOL parts, paired from the transcript's
 * `tool_use`/`tool_result` parts by `toolCallId` exactly like the portal's
 * `chatMessagesToTurns` — each pair renders through the SAME shared
 * [AuditToolCard] the Direct transcript uses, with the paired call as the raw
 * JSON. Non-tool parts are skipped; `annotate`/`cite_record`/`annotate_many`
 * are skipped once their result has landed (the Timeline owns citations, and
 * the portal renders nothing inline for those). A `tool_result` with no
 * matching `tool_use` is dropped like the portal drops orphan results, and a
 * part this client cannot read never fails the attempt.
 */

/** One paired tool call inside an attempt, in first-use encounter order. */
data class AgentTraceToolCall(
    val tool: String,
    val args: JsonElement?,
    val result: JsonElement?,
    /** The paired call (`{tool, args?, result?}`) — what the raw sheet shows. */
    val rawPart: JsonElement,
)

/** Citation tools stay silent by design — the Timeline owns their results. */
private val AgentTraceSilentTools = setOf("annotate", "cite_record", "annotate_many")

/**
 * Pair an attempt's transcript parts into tool calls. Pure Kotlin (no
 * Compose) so the pairing is unit testable in the logic lane.
 */
fun agentTraceToolCalls(trace: PrivacyAnswerAgentTrace): List<AgentTraceToolCall> {
    data class Pending(val tool: String, val args: JsonElement?)
    val pending = LinkedHashMap<String, Pending>()
    val results = HashMap<String, JsonElement?>()
    for (message in trace.messages) {
        val parts = (message as? JsonObject)?.get("parts") as? JsonArray ?: continue
        for (part in parts) {
            val fields = part as? JsonObject ?: continue
            val kind = (fields["kind"] as? JsonPrimitive)?.contentOrNull ?: continue
            val toolCallId = (fields["toolCallId"] as? JsonPrimitive)?.contentOrNull ?: continue
            when (kind) {
                "tool_use" -> {
                    val tool = (fields["tool"] as? JsonPrimitive)?.contentOrNull ?: continue
                    if (toolCallId !in pending) {
                        pending[toolCallId] = Pending(tool, fields["args"])
                    }
                }
                "tool_result" -> results.putIfAbsent(toolCallId, fields["result"])
                else -> continue
            }
        }
    }
    return pending.mapNotNull { (toolCallId, use) ->
        if (use.tool in AgentTraceSilentTools) return@mapNotNull null
        val result = results[toolCallId]?.takeUnless { it is JsonNull }
        val rawPart = buildJsonObject {
            put("tool", JsonPrimitive(use.tool))
            use.args?.let { put("args", it) }
            result?.let { put("result", it) }
        }
        AgentTraceToolCall(tool = use.tool, args = use.args, result = result, rawPart = rawPart)
    }
}

/** The record the shared card mapping reads: `{args, result}`, like a stored Direct payload. */
internal fun AgentTraceToolCall.cardRecord(): JsonElement = buildJsonObject {
    args?.let { put("args", it) }
    result?.let { put("result", it) }
}

/**
 * The shared cards for one paired call — batch calls project one card per
 * child, as in the Direct transcript and the portal. A call whose result
 * never landed (a truncated-away tail) reads "No result" under its header —
 * the portal's `StaticToolCard` shows the same empty line for a result-less
 * non-silent tool instead of a bare header.
 */
internal fun agentTraceCards(call: AgentTraceToolCall): List<TranscriptCard> =
    directTranscriptCards(call.tool, call.cardRecord()).map { card ->
        val base = card.content
        if (call.result != null || base.error != null || base.showsEmpty) return@map card
        if (base.sections != null || base.rows.isNotEmpty() || base.sql != null || base.note != null) {
            return@map card
        }
        card.copy(content = base.copy(showsEmpty = true))
    }

/** Header line for one attempt: "Attempt N · provider / model" plus the stop reason when present. */
internal fun agentTraceAttemptHeader(trace: PrivacyAnswerAgentTrace): String = buildString {
    append("Attempt ${trace.attempt} · ${trace.provider} / ${trace.model}")
    trace.terminalStopReason?.takeIf { it.isNotBlank() }?.let { append(" · $it") }
}

/** The per-attempt truncation note, or null when the stored attempt is complete. */
internal fun agentTraceTruncatedNote(trace: PrivacyAnswerAgentTrace): String? {
    if (!trace.truncated) return null
    val omitted = trace.omittedParts
    return if (omitted != null && omitted > 0) {
        "$omitted observable transcript ${if (omitted == 1) "part was" else "parts were"} " +
            "omitted from this stored transcript."
    } else {
        "This stored transcript is incomplete; some activity could not be shown."
    }
}

/**
 * The agent-transcript section under an exchange's draft card. Renders nothing
 * when the gateway sent no traces — old gateways omit them, which is version
 * skew, never an error.
 */
@Composable
fun PrivacyAgentTranscripts(
    traces: List<PrivacyAnswerAgentTrace>,
    omittedAttempts: Int,
    onOpenDocument: (String) -> Unit = {},
    onOpenPerson: (canonicalId: String, name: String?) -> Unit = { _, _ -> },
    onOpenUrl: (String) -> Unit = {},
    catalog: SourceCatalog = SourceCatalog(),
) {
    if (traces.isEmpty() && omittedAttempts <= 0) return
    val c = OmTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        Text(
            if (traces.size == 1) "Agent transcript" else "Agent transcripts",
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
            color = c.textPrimary,
        )
        Text(
            "Local generation activity. Only the final draft, when one exists, enters the privacy check.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
        )
        if (omittedAttempts > 0) {
            Text(
                "$omittedAttempts additional stored " +
                    "attempt${if (omittedAttempts == 1) "" else "s"} could " +
                    "not be shown in this bounded view.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textMuted,
            )
        }
        traces.forEachIndexed { index, trace ->
            PrivacyAgentTranscript(
                trace = trace,
                open = index == 0,
                onOpenDocument = onOpenDocument,
                onOpenPerson = onOpenPerson,
                onOpenUrl = onOpenUrl,
                catalog = catalog,
            )
        }
    }
}

@Composable
private fun PrivacyAgentTranscript(
    trace: PrivacyAnswerAgentTrace,
    open: Boolean,
    onOpenDocument: (String) -> Unit,
    onOpenPerson: (canonicalId: String, name: String?) -> Unit,
    onOpenUrl: (String) -> Unit,
    catalog: SourceCatalog,
) {
    val c = OmTheme.colors
    var expanded by remember(trace.sessionId, trace.attempt) { mutableStateOf(open) }
    val calls = remember(trace) { agentTraceToolCalls(trace) }
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                agentTraceAttemptHeader(trace),
                style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = if (expanded) "Collapse attempt" else "Expand attempt",
                tint = c.textMuted,
                modifier = Modifier.size(11.dp),
            )
        }
        if (expanded) {
            if (calls.isEmpty()) {
                Text(
                    "No transcript messages were recorded.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textMuted,
                )
            } else {
                calls.forEach { call ->
                    agentTraceCards(call).forEach { card ->
                        AuditToolCard(
                            tool = card.tool,
                            content = card.content,
                            rawPayload = call.rawPart,
                            timeText = null,
                            onOpenDocument = onOpenDocument,
                            onOpenPerson = onOpenPerson,
                            onOpenUrl = onOpenUrl,
                            catalog = catalog,
                        )
                    }
                }
            }
            agentTraceTruncatedNote(trace)?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textMuted,
                )
            }
        }
    }
}
