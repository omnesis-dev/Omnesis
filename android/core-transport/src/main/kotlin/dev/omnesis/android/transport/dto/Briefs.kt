// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Wire DTOs for the gateway's Omnesis Briefs surface — the proactive awareness feed the
 * Cognition Steward maintains. Hand-ported from the iOS `BriefsClient` Codable structs,
 * which are the de-facto wire spec.
 *
 * Every endpoint 404s unless the gateway reports the feature active (experimental mode
 * AND a background-agent model assigned), so the client treats "not found" as "the
 * feature is off" rather than as an error worth showing.
 *
 * Gateway TS shape (the contract these mirror):
 *
 * ```ts
 * // GET /briefs/feed?limit&cursor -> { briefs: Brief[]; nextCursor?: string }
 * // GET /briefs/count             -> { unread: number }
 * // POST /briefs/:id/read         -> {}
 * // POST /briefs/:id/dismiss      body: { reason: DismissReason; feedback?: string; snoozeUntil?: string }
 * // POST /briefs/:id/thread       -> { conversationId: string; created: boolean }
 * type Brief = {
 *   id: string;
 *   kind: "info" | "loop";
 *   state: "unread" | "read";
 *   title: string;
 *   description: string;          // short, glanceable, <30 words by contract
 *   body?: string;                // long-form context, revealed on scroll
 *   confidence: number;
 *   urgency: number;
 *   createdAt: string;            // ISO 8601
 *   eventAt?: string;             // when the real-world event happens
 *   relevantUntil?: string;       // after this the brief stops being shown
 *   citations: BriefCitation[];
 *   threadConversationId?: string;
 * };
 * ```
 *
 * Decoded with [OmnesisJson] (forward-compatible: unknown keys ignored, missing optionals
 * default), so a newer gateway never crashes this client.
 */
@Serializable
data class BriefRecordDto(
    val id: String,
    val kind: BriefKindDto = BriefKindDto.INFO,
    val state: BriefReadStateDto = BriefReadStateDto.UNREAD,
    val title: String = "",
    val description: String = "",
    val body: String? = null,
    val confidence: Double = 0.0,
    val urgency: Double = 0.0,
    val createdAt: String = "",
    val eventAt: String? = null,
    val relevantUntil: String? = null,
    val citations: List<BriefCitationDto> = emptyList(),
    val threadConversationId: String? = null,
)

/**
 * What kind of thing the brief is about.
 *
 * `info` briefs are context to note and are cleared by acknowledging them; `loop` briefs
 * are attached to a tracked open loop, and clearing one reports it handled — which
 * propagates into resolving the underlying loop. That difference is the whole reason
 * [clearActionReason] exists: the gateway enforces the pairing with a 400.
 */
@Serializable
enum class BriefKindDto {
    @SerialName("info")
    INFO,

    @SerialName("loop")
    LOOP,
    ;

    /** The dismiss reason a "clear this brief" action reports for this kind. */
    val clearActionReason: BriefDismissReasonDto
        get() = when (this) {
            LOOP -> BriefDismissReasonDto.ALREADY_HANDLED
            INFO -> BriefDismissReasonDto.ACKNOWLEDGED
        }

    /**
     * The verb the clear action reads as. A loop is a tracked to-do, so finishing it
     * reads "Done"; an info brief is context to note, so clearing it reads "Got it".
     */
    val clearActionLabel: String
        get() = when (this) {
            LOOP -> "Done"
            INFO -> "Got it"
        }
}

/** The two states the feed ever returns — dismissed briefs are never shown. */
@Serializable
enum class BriefReadStateDto {
    @SerialName("unread")
    UNREAD,

    @SerialName("read")
    READ,
}

/**
 * The dismiss sheet's reasons, as the gateway spells them.
 *
 * `ALREADY_HANDLED` applies only to loop briefs and `ACKNOWLEDGED` only to info briefs
 * (the gateway enforces the pairing with a 400). `SNOOZED` is the one non-terminal exit
 * and may carry a user-picked re-surface time — absent there means "the agent decides".
 */
@Serializable
enum class BriefDismissReasonDto {
    @SerialName("not_relevant")
    NOT_RELEVANT,

    @SerialName("wrong")
    WRONG,

    @SerialName("already_handled")
    ALREADY_HANDLED,

    @SerialName("acknowledged")
    ACKNOWLEDGED,

    @SerialName("snoozed")
    SNOOZED,
    ;

    /** The wire value, for the request body. */
    val wire: String
        get() = when (this) {
            NOT_RELEVANT -> "not_relevant"
            WRONG -> "wrong"
            ALREADY_HANDLED -> "already_handled"
            ACKNOWLEDGED -> "acknowledged"
            SNOOZED -> "snoozed"
        }
}

/** One display-ready citation on a brief. [docId] opens the in-app document view. */
@Serializable
data class BriefCitationDto(
    val docId: String,
    val title: String = "",
    val providerId: String = "",
    val sourceId: String = "",
)

/** `GET /briefs/feed` — one ranked page, first entry on top. */
@Serializable
data class BriefPageDto(
    val briefs: List<BriefRecordDto> = emptyList(),
    val nextCursor: String? = null,
)

/** `GET /briefs/count` — showable unread briefs, for the menu's badge. */
@Serializable
data class BriefsCountDto(val unread: Int = 0)

/**
 * `POST /briefs/:id/dismiss` request body.
 *
 * The gateway's schema is strict: [feedback] and [snoozeUntil] are omitted rather than
 * sent as null when absent, which `encodeDefaults = false` gives us, and [snoozeUntil] is
 * only valid alongside [BriefDismissReasonDto.SNOOZED].
 */
@Serializable
data class DismissBriefBody(
    val reason: String,
    val feedback: String? = null,
    val snoozeUntil: String? = null,
)

/**
 * `POST /briefs/:id/thread` — the brief's talk-back thread.
 *
 * [created] is false when the brief already had a thread and it was reused; the call is
 * idempotent either way, so the app never branches on it to decide whether to offer the
 * affordance.
 */
@Serializable
data class OpenBriefThreadDto(
    val conversationId: String,
    val created: Boolean = false,
)
