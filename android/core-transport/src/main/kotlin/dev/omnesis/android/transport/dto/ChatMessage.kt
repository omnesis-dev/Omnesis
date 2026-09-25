// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** A persisted conversation message, returned on session resume. Mirrors the iOS `ChatMessage`. */
@Serializable(with = ChatMessageSerializer::class)
sealed interface ChatMessage {
    @Serializable
    data class User(val parts: List<UserPart> = emptyList()) : ChatMessage

    @Serializable
    data class Assistant(val parts: List<AssistantPart> = emptyList()) : ChatMessage

    @Serializable
    data class Unknown(val role: String = "unknown") : ChatMessage
}

object ChatMessageSerializer : JsonContentPolymorphicSerializer<ChatMessage>(ChatMessage::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<ChatMessage> =
        when (element.jsonObject["role"]?.jsonPrimitive?.contentOrNull) {
            "user" -> ChatMessage.User.serializer()
            "assistant" -> ChatMessage.Assistant.serializer()
            else -> ChatMessage.Unknown.serializer()
        }
}

@Serializable(with = UserPartSerializer::class)
sealed interface UserPart {
    @Serializable
    data class Text(val text: String = "") : UserPart

    @Serializable
    data class ToolResultPart(val toolCallId: String = "", val result: AgentToolResult) : UserPart

    @Serializable
    data class Unknown(val kind: String = "unknown") : UserPart
}

object UserPartSerializer : JsonContentPolymorphicSerializer<UserPart>(UserPart::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<UserPart> =
        when (element.jsonObject["kind"]?.jsonPrimitive?.contentOrNull) {
            "text" -> UserPart.Text.serializer()
            "tool_result" -> UserPart.ToolResultPart.serializer()
            else -> UserPart.Unknown.serializer()
        }
}

@Serializable(with = AssistantPartSerializer::class)
sealed interface AssistantPart {
    @Serializable
    data class Text(val text: String = "") : AssistantPart

    @Serializable
    data class Thinking(val text: String = "") : AssistantPart

    @Serializable
    data class ToolUse(val toolCallId: String = "", val tool: String = "", val args: JsonElement = JsonNull) : AssistantPart

    /**
     * The persisted verified-report artifact — the Deep Research write-back part the
     * gateway appends alongside the report prose so the card survives a reload. Carries exactly
     * the structured facts the live `agent.deep_research.summary` event delivers, plus the merged
     * [citations] that arrive live via `agent.citations.update`. Never sent to a model; the client
     * rebuilds the same `reportArtifact` + seeds the same Citations set the live run produced.
     * Mirrors the gateway `ReportArtifactPart`, the iOS `AssistantPart.reportArtifact`, and the
     * portal reducer's `report_artifact` branch.
     */
    @Serializable
    data class ReportArtifact(
        val stoppedReason: String = "",
        val plan: List<DeepResearchPlanItem> = emptyList(),
        val treeUsage: AgentUsage? = null,
        // A run that quoted nothing reports 0/0 — the badge then reads "no quotes to verify"
        // rather than a misleading green tick.
        val verification: DeepResearchVerification = DeepResearchVerification(),
        val citations: List<AgentDocRef> = emptyList(),
    ) : AssistantPart

    @Serializable
    data class Unknown(val kind: String = "unknown") : AssistantPart
}

object AssistantPartSerializer : JsonContentPolymorphicSerializer<AssistantPart>(AssistantPart::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<AssistantPart> =
        when (element.jsonObject["kind"]?.jsonPrimitive?.contentOrNull) {
            "text" -> AssistantPart.Text.serializer()
            "thinking" -> AssistantPart.Thinking.serializer()
            "tool_use" -> AssistantPart.ToolUse.serializer()
            "report_artifact" -> AssistantPart.ReportArtifact.serializer()
            else -> AssistantPart.Unknown.serializer()
        }
}
