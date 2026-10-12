// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

@Serializable
data class AgentContextAssessment(
    val inputTokens: Int? = null,
    val peakInputTokens: Int? = null,
    val maxInputTokens: Int? = null,
    val contextWindowTokens: Int? = null,
    val reservedOutputTokens: Int? = null,
    val safetyMarginTokens: Int? = null,
    val measurement: String = "unknown",
    val limitSource: String = "unknown",
    val requestIteration: Int = 1,
)

@Serializable
data class AgentTerminalFailure(
    val code: String = "",
    val message: String = "",
    val retryable: Boolean = false,
    val backend: String = "",
    val model: String = "",
    /** The provider's own disposition, when the gateway had one to forward. */
    val provider: AgentProviderFailureDetail? = null,
)

@Serializable
data class AgentConversationTerminalFailure(
    val code: String = "",
    val message: String = "",
    val retryable: Boolean = false,
    val backend: String = "",
    val model: String = "",
    val failedAt: String = "",
    val context: AgentContextAssessment? = null,
    /** The provider's own disposition, when the gateway had one to forward. */
    val provider: AgentProviderFailureDetail? = null,
)

/** `POST /agent/sessions` response (create or resume). */
@Serializable
data class CreateSessionResponse(
    val sessionId: String = "",
    val model: String = "",
    val backend: String = "",
    val title: String = "",
    val messageCount: Int = 0,
    /**
     * True when a turn is genuinely in flight for this session right now (only a
     * live in-memory session can be busy). Defaulted so a gateway that omits the
     * field is treated as idle. The coordinator uses this on foreground/resync
     * reconcile to avoid clobbering a still-running turn. Mirrors the iOS
     * `CreateSessionResponse.busy`.
     */
    val busy: Boolean = false,
    val messages: List<ChatMessage> = emptyList(),
    /** Cursor for older messages when session creation opted into a bounded transcript. */
    val messagePageInfo: PageInfo? = null,
    /** New gateways already removed any hidden anchored-thread prefix. */
    val messagesAreVisible: Boolean = false,
    /** Durable context exhaustion; transcript remains readable but cannot accept sends. */
    val terminalFailure: AgentConversationTerminalFailure? = null,
    /** Durable marker for a partial latest answer; does not freeze the conversation. */
    val lastTurnFailure: AgentTerminalFailure? = null,
    /** Anchor metadata: a watch firing's thread or the standing Morning brief conversation. */
    val origin: ConversationOrigin? = null,
    /** Active-turn state not reconstructible from persisted [ChatMessage]s. */
    val replayEvents: List<AgentEvent> = emptyList(),
    /** Last SSE sequence represented by [messages] and [replayEvents]. */
    val eventCursor: Long? = null,
)

/**
 * Where a conversation came from, when it did not start as a blank chat. Absent on plain
 * threads. [kind] is `"watch_firing"` or `"daily_brief"`; any other kind decodes with every
 * kind-specific field at its default, which keeps the thread an ordinary visible conversation
 * rather than hiding anything behind a card this build cannot draw.
 *
 * Gateway TS shape:
 *
 * ```ts
 * type ConversationOrigin =
 *   | { kind: "watch_firing"; firingId: string; runId: string; watchId: string;
 *       watch?: WatchFiringOriginSnapshot; seedMessageCount?: number }
 *   | { kind: "daily_brief"; runId: string; briefs: DailyBriefMessageRef[] };
 * ```
 */
@Serializable
data class ConversationOrigin(
    val kind: String = "",
    /** The run that seeded the thread (a watch firing) or sent its latest brief. */
    val runId: String? = null,
    /** The watch that fired — the thread's durable subject. */
    val watchId: String? = null,
    val watch: WatchFiringOriginSnapshot? = null,
    /**
     * How many messages at the start of the thread are the folded transcript of the run that
     * created it. Clients hide that prefix and show the origin's card in its place.
     */
    val seedMessageCount: Int? = null,
    /**
     * The morning briefs in a `daily_brief` thread, oldest first. Empty on conversation-list
     * summaries, which carry only the anchor; full on a session or a messages page.
     */
    @Serializable(with = LenientDailyBriefRefListSerializer::class)
    val briefs: List<DailyBriefMessageRef> = emptyList(),
) {
    /** The standing Morning brief conversation: pinned, and never deletable. */
    val isDailyBrief: Boolean get() = kind == DAILY_BRIEF_KIND

    /** The newest brief that names a real message, or null outside a `daily_brief` thread. */
    val latestDailyBrief: DailyBriefMessageRef?
        get() = if (isDailyBrief) briefs.lastOrNull { it.messageIndex >= 0 } else null

    companion object {
        const val DAILY_BRIEF_KIND = "daily_brief"
    }
}

/** Where one morning brief sits in the Morning brief conversation. */
@Serializable
data class DailyBriefMessageRef(
    /** The local day the brief was written for (`YYYY-MM-DD`). */
    val day: String = "",
    /** Index of the brief's assistant message in the conversation's visible messages. */
    val messageIndex: Int = -1,
    /** Stable id of the brief message. */
    val messageId: String = "",
    /** When the brief was sent (ISO 8601, UTC); absent on briefs recorded before it was kept. */
    val sentAt: String? = null,
)

/**
 * Decodes the brief index one entry at a time, dropping any entry that is not an object with
 * a string `day`, a whole-number `messageIndex` and a string `messageId`; a `sentAt` that is not
 * a string reads as absent. The index lays out the conversation's days, so a malformed entry
 * must never cost the whole conversation.
 */
object LenientDailyBriefRefListSerializer : KSerializer<List<DailyBriefMessageRef>> {
    private val delegate = ListSerializer(DailyBriefMessageRef.serializer())
    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun serialize(encoder: Encoder, value: List<DailyBriefMessageRef>) =
        delegate.serialize(encoder, value)

    override fun deserialize(decoder: Decoder): List<DailyBriefMessageRef> {
        val json = decoder as? JsonDecoder ?: return delegate.deserialize(decoder)
        val array = json.decodeJsonElement() as? JsonArray ?: return emptyList()
        return array.mapNotNull { element ->
            val o = element as? JsonObject ?: return@mapNotNull null
            fun str(key: String): String? = (o[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val index = (o["messageIndex"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
            DailyBriefMessageRef(
                day = str("day") ?: return@mapNotNull null,
                messageIndex = index?.takeIf { it >= 0 } ?: return@mapNotNull null,
                messageId = str("messageId") ?: return@mapNotNull null,
                sentAt = str("sentAt"),
            )
        }
    }
}

/**
 * The watch and firing as they read when the thread was opened, so the card survives the watch
 * being renamed, edited or deleted.
 */
@Serializable
data class WatchFiringOriginSnapshot(
    /** The watch's operator-facing name. */
    val name: String = "",
    /** What the watch was watching for, in the operator's own words. */
    val condition: String = "",
    /** When the firing happened, in epoch milliseconds. */
    val firedAt: Long = 0L,
)

/** `POST /agent/sessions/:id/messages` response. */
@Serializable
data class SendMessageResponse(
    val messageId: String = "",
    val userMessageId: String? = null,
)

/** `GET /agent/conversations` row. The wire key is `id`. */
@Serializable
data class ConversationSummary(
    @SerialName("id") val sessionId: String,
    val title: String = "",
    val model: String = "",
    val backend: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
    val messageCount: Int = 0,
    /**
     * Whether the user pinned this conversation to the top of the list.
     * Defaulted so a gateway that omits the field decodes as unpinned.
     */
    val pinned: Boolean = false,
    /**
     * Whether the agent has written something here the user has not seen.
     * Defaulted so a gateway that predates read state decodes as read.
     */
    val unread: Boolean = false,
    /**
     * The conversation's anchor, without the per-kind detail a session carries. Lets the list
     * withhold Delete from the Morning brief conversation, which the gateway refuses to delete.
     */
    val origin: ConversationOrigin? = null,
) {
    /** Whether the gateway lets this conversation be deleted. */
    val deletable: Boolean get() = origin?.isDailyBrief != true
}

@Serializable
data class ConversationsResponse(
    val conversations: List<ConversationSummary> = emptyList(),
    val nextCursor: String? = null,
)

/** `GET /agent/conversations/:id`. */
@Serializable
data class ConversationRecord(
    val id: String = "",
    val callerId: String = "",
    val model: String = "",
    val backend: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
    val title: String = "",
    val messages: List<ChatMessage> = emptyList(),
    val terminalFailure: AgentConversationTerminalFailure? = null,
    val lastTurnFailure: AgentTerminalFailure? = null,
)

@Serializable
data class ConversationMessagePage(
    val messages: List<ChatMessage> = emptyList(),
    val messagePageInfo: PageInfo = PageInfo(limit = messages.size),
    val messageCount: Int = messages.size,
    val messagesAreVisible: Boolean = true,
    /**
     * Carried here as well as on the session, so reading a conversation without minting a
     * session still learns what the thread is anchored to and can draw its card.
     */
    val origin: ConversationOrigin? = null,
)

/** `GET /agent/model`. */
@Serializable
data class ModelDisplay(
    val providerId: String = "",
    val providerLabel: String = "",
    val modelName: String = "",
    val available: Boolean = false,
    val configured: Boolean = false,
)
