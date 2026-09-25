// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * The watch runtime's own surface, as the phone reads it.
 *
 * Distinct from the subscription DTOs next door, which describe the *record* —
 * who asked for a watch, what they were told it would do, and what they may be
 * sent when it comes true. These describe the watch itself: the definition the
 * runtime evaluates, and what it has said.
 *
 * Every field the gateway may omit is optional with a default, because this
 * app ships ahead of and behind the gateway it pairs with: a phone in a pocket
 * is a client version the operator cannot upgrade in step. A missing field has
 * to read as "this gateway does not say" rather than as a decode failure that
 * empties the screen.
 */
@Serializable
data class WatchRecordDto(
    val id: String,
    val name: String,
    /** `active`, `paused` or `retired`. Rendered through the app's own vocabulary. */
    val status: String,
    /** Why it is not running, when the runtime could say. */
    val note: String? = null,
    val addedAt: String? = null,
    /** How many times it has said something, without reading any of them. */
    val firings: Int = 0,
    /** The journal sequence it started watching from. */
    val fromSeq: Int? = null,
    /** What it is watching for, in the operator's own words. */
    val request: String? = null,
    /** `omnesis-notify`, `agent-wake`, or absent for a watch that delivers nowhere. */
    val delivery: String? = null,
    /**
     * The record of what this watch may tell an integration. Absent when the operator asked
     * for the watch themselves and nothing outside Omnesis hears about it.
     */
    val disclosure: WatchDisclosureDto? = null,
    /** The runtime's own reading of whether the watch is any good. */
    val verdict: WatchVerdictDto? = null,
)

/**
 * What a watch may disclose, and to whom.
 *
 * The listing carries only the first four fields; reading one watch carries the rest. Both
 * decode into this one shape so a caller need not know which read produced it.
 */
@Serializable
data class WatchDisclosureDto(
    /** `integration` when something outside Omnesis asked for this watch, else `operator`. */
    val authoredBy: String = "",
    /** The privacy subscription this watch's disclosures are recorded against. */
    val subscriptionId: String = "",
    val status: String = "",
    val integrationName: String? = null,
    val revision: Int? = null,
    val interpretation: String? = null,
    val condition: String? = null,
    /** What the integration is woken with when the watch fires. */
    val instruction: String? = null,
    val evidence: String? = null,
    val expiresAt: Long? = null,
    val revokedAt: Long? = null,
    val firingCount: Int? = null,
    val lastFiredAt: Long? = null,
)

/**
 * Whether a watch is earning its keep.
 *
 * [actionable] is the runtime saying the operator should do something about it; a verdict that
 * is not actionable is the ordinary "working" case and is not worth marking on screen.
 */
@Serializable
data class WatchVerdictDto(
    val name: String = "",
    /** The evidence behind the verdict, e.g. how many events it looked at and admitted. */
    val because: String = "",
    val label: String? = null,
    val actionable: Boolean = false,
)

@Serializable
data class WatchListDto(val watches: List<WatchRecordDto> = emptyList())

/**
 * What delivering one firing did.
 *
 * The failing case is the one worth carrying: a notification that never
 * arrived looks exactly like a watch that never fired, and this is the only
 * place that difference is written down.
 */
@Serializable
data class WatchFiringDeliveryDto(
    /** `omnesis-notify` or `agent-wake` — a free string, so an unknown kind
     *  from a newer gateway renders rather than failing to decode. */
    val kind: String,
    /** How many destinations accepted it. Zero is an ordinary answer. */
    val delivered: Int,
    val attempted: Int? = null,
    /** Why nothing arrived, when the channel could say. */
    val error: String? = null,
)

/** A document the runtime read to decide a firing, named by the gateway. */
@Serializable
data class WatchFiringDocumentDto(
    val id: String,
    val title: String = "",
    /** The account-qualified source, e.g. `gmail:someone@example.com`. */
    val sourceId: String = "",
)

@Serializable
data class WatchFiringDto(
    /** The journal sequence — what makes a firing unique within a watch. */
    val seq: Int,
    /** When the thing it is about happened. */
    val firedAt: String,
    /** When the runtime recorded it. Absent on a firing older than the column. */
    val noticedAt: String? = null,
    /**
     * Absent for a watch that delivers nowhere, which is most of them: a
     * firing with no delivery block was never sent, and an outcome there would
     * read as a failure rather than as the watch doing exactly what was asked.
     */
    val delivery: WatchFiringDeliveryDto? = null,
    /**
     * What it read to decide. Empty for a firing reached through nothing — a
     * clock, a row, a deadline — and for one recorded before these were kept.
     */
    val documents: List<WatchFiringDocumentDto> = emptyList(),
)

@Serializable
data class WatchFiringsDto(
    @SerialName("watch") val watchName: String = "",
    val firings: List<WatchFiringDto> = emptyList(),
)

/** `GET /admin/watch/watches/:id` — one watch, with its definition and disclosure. */
@Serializable
data class WatchDetailDto(val watch: JsonElement)
