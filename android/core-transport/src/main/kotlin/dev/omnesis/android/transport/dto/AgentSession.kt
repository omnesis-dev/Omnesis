// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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
    /** Anchor metadata for conversations created from a brief or a watch firing. */
    val origin: ConversationOrigin? = null,
    /** Active-turn state not reconstructible from persisted [ChatMessage]s. */
    val replayEvents: List<AgentEvent> = emptyList(),
    /** Last SSE sequence represented by [messages] and [replayEvents]. */
    val eventCursor: Long? = null,
)

/**
 * What a conversation is a reply to, when it did not start as a blank chat. Absent on plain
 * threads. [kind] is `"brief"` or `"watch_firing"`; an unrecognised kind decodes with both
 * snapshots null, which keeps the seeded prefix visible rather than hiding it behind a card
 * this build cannot draw.
 */
@Serializable
data class ConversationOrigin(
    val kind: String = "",
    /** The watch that fired — the thread's durable subject. */
    val watchId: String? = null,
    val brief: BriefOriginSnapshot? = null,
    val watch: WatchFiringOriginSnapshot? = null,
    /**
     * How many messages at the start of the thread are the folded transcript of the run that
     * created it. Clients hide that prefix and show the origin's card in its place.
     */
    val seedMessageCount: Int? = null,
)

/**
 * The brief as it read when the thread was opened, so the card survives the brief itself
 * expiring or being deleted.
 */
@Serializable
data class BriefOriginSnapshot(
    val title: String = "",
    val description: String = "",
    val body: String? = null,
)

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
)

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
