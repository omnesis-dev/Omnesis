// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.ConversationRecord
import dev.omnesis.android.transport.dto.ConversationMessagePage
import dev.omnesis.android.transport.dto.ConversationSummary
import dev.omnesis.android.transport.dto.ConversationsResponse
import dev.omnesis.android.transport.dto.CreateSessionResponse
import dev.omnesis.android.transport.dto.ModelDisplay
import dev.omnesis.android.transport.dto.SendMessageResponse
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.getJson
import dev.omnesis.android.transport.http.patchJson
import dev.omnesis.android.transport.http.postJson
import java.time.ZoneId
import kotlinx.serialization.Serializable

/** Agent control HTTP (sessions, messages, conversations). The SSE stream lives in [AgentEventSource]. */
class AgentClient(private val http: GatewayHttp) {

    /**
     * The device's own IANA zone rides along so the agent speaks in the clock
     * the phone is showing. The gateway sits on a machine that stays home while
     * the phone travels, so its zone is not a stand-in: a wall-clock time
     * rendered in it is the wrong hour anywhere else.
     */
    suspend fun createSession(
        resumeFromId: String? = null,
        transcriptLimit: Int? = null,
        timeZone: String? = deviceTimeZone(),
        profile: AgentSessionProfile = AgentSessionProfile.INTERACTIVE,
    ): CreateSessionResponse =
        http.postJson(
            "agent/sessions",
            transcriptLimit?.let { mapOf("transcriptLimit" to it.coerceIn(0, 500).toString()) }
                ?: emptyMap(),
            CreateSessionBody(resumeFromId, profile = profile.wireValue, timeZone = timeZone),
        )

    /**
     * `deepResearch` is the per-message Deep Research flag, armed by the
     * composer's `/`→pill. When `false` the POST body is byte-identical to a
     * plain turn (the key is dropped — see [SendMessageBody]); `true` adds
     * `"deepResearch": true`, which the gateway route honours to enter the
     * explicit Deep Research loop. Explicit-only: there is no auto-gating.
     */
    suspend fun sendMessage(
        sessionId: String,
        text: String,
        deepResearch: Boolean = false,
        notifyAfterMs: Int? = null,
        viewingForMs: Int? = null,
    ): SendMessageResponse =
        http.postJson(
            "agent/sessions/$sessionId/messages",
            SendMessageBody.of(text, deepResearch, notifyAfterMs, viewingForMs),
        )

    suspend fun cancel(sessionId: String): Boolean =
        http.postJson<Map<String, String>, OkResponse>("agent/sessions/$sessionId/cancel", emptyMap()).ok

    suspend fun conversationPage(
        limit: Int = 50,
        cursor: String? = null,
    ): ConversationsResponse {
        val query = buildMap {
            put("limit", limit.toString())
            if (!cursor.isNullOrBlank()) put("cursor", cursor)
        }
        return http.getJson("agent/conversations", query)
    }

    suspend fun conversations(): List<ConversationSummary> =
        conversationPage().conversations

    suspend fun conversation(id: String): ConversationRecord =
        http.getJson("agent/conversations/$id")

    /**
     * Report that this app is showing a conversation to the user, which clears
     * its unread marker on every surface. Distinct from fetching it: a sync is
     * not a read, so only a screen that actually rendered it may say this.
     *
     * [viewing] says whether it is still on screen. True holds it open, so an
     * answer arriving now counts as seen; false says the user moved on.
     */
    suspend fun markConversationSeen(
        id: String,
        viewing: Boolean,
    ): Boolean = http.postJson<ConversationSeenBody, OkResponse>(
        "agent/conversations/$id/seen",
        ConversationSeenBody(viewing),
    ).ok

    suspend fun conversationMessages(
        id: String,
        limit: Int = 25,
        cursor: String? = null,
    ): ConversationMessagePage = http.getJson(
        "agent/conversations/$id/messages",
        buildMap {
            put("limit", limit.coerceIn(1, 500).toString())
            cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
        },
    )

    suspend fun deleteConversation(id: String) {
        http.execute(http.newRequest(http.urlFor("agent/conversations/$id")).delete().build())
    }

    /** PATCH `/agent/conversations/:id` — pin or unpin a stored transcript. */
    suspend fun setPinned(id: String, pinned: Boolean) {
        http.patchJson<PinBody, OkResponse>("agent/conversations/$id", PinBody(pinned))
    }

    suspend fun model(): ModelDisplay = http.getJson("agent/model")
}

/** Prompt/tool profile requested when a session is created or resumed. */
enum class AgentSessionProfile(internal val wireValue: String) {
    /** Full visual-chat timeline and citation tools. */
    INTERACTIVE("interactive"),

    /** Concise spoken replies for a bounded voice surface. */
    VOICE("voice"),
}

@Serializable
data class CreateSessionBody(
    val resumeFromId: String? = null,
    /** Visual chat defaults to `interactive`; bounded voice callers opt into `voice`. */
    val profile: String,
    val timeZone: String? = null,
)

/**
 * The device's current IANA zone, or null where it cannot be resolved — read
 * per call rather than cached, since a phone that crosses a border changes zone
 * while the process stays alive.
 */
internal fun deviceTimeZone(): String? = runCatching { ZoneId.systemDefault().id }.getOrNull()

@Serializable
data class PinBody(val pinned: Boolean)

/**
 * The `/messages` POST body. `deepResearch` is nullable so `OmnesisJson`
 * (`explicitNulls = false`) drops optional flags for a plain turn — a default
 * send's payload is byte-identical to before these flags existed. [of] is the
 * unit-test seam: it sets `deepResearch` only when the per-message pill is
 * armed; bounded voice callers opt into the two timing fields explicitly.
 */
@Serializable
data class SendMessageBody(
    val text: String,
    val deepResearch: Boolean? = null,
    val notifyAfterMs: Int? = null,
    val viewingForMs: Int? = null,
) {
    companion object {
        fun of(
            text: String,
            deepResearch: Boolean,
            notifyAfterMs: Int? = null,
            viewingForMs: Int? = null,
        ): SendMessageBody = SendMessageBody(
            text = text,
            deepResearch = if (deepResearch) true else null,
            notifyAfterMs = notifyAfterMs,
            viewingForMs = viewingForMs,
        )
    }
}

@Serializable
data class OkResponse(val ok: Boolean = false)

/** Body of `POST /agent/conversations/:id/seen`. */
@Serializable
data class ConversationSeenBody(val viewing: Boolean)
