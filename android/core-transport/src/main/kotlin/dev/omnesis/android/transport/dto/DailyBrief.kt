// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * What one morning brief was based on: `GET /agent/conversations/:id/briefs/:day`.
 *
 * Gateway TS shape (`packages/gateway/src/http/routes/agent.ts`,
 * `packages/gateway/src/agent/daily-brief-detail.ts`):
 *
 * ```ts
 * { day: string; messageId: string; sentAt?: string;
 *   items: { rank: number; observationId: string; summary: string;
 *            sources: { id: string; title: string | null; sourceType: string | null;
 *                       createdAt: string | null }[];
 *            tasks: { id: string; title: string; state: string }[];
 *            reaction?: { kind: "up" | "not_interested" | "factual_error"; note?: string; at: string } }[] }
 * ```
 *
 * Decoded leniently: an item, source or task this build cannot read is dropped and the rest
 * still show, the way the iOS client reads it.
 */
@Serializable
data class DailyBriefItemsDto(
    val day: String = "",
    val messageId: String = "",
    /** When the brief was sent (ISO 8601, UTC), when the gateway recorded it. */
    val sentAt: String? = null,
    @Serializable(with = LenientBriefItemListSerializer::class)
    val items: List<DailyBriefItemDto> = emptyList(),
)

/** One thing a brief was based on: a plain sentence, the documents behind it, the tasks it touches. */
@Serializable
data class DailyBriefItemDto(
    /** The item's number as the brief showed it, from 1. */
    val rank: Int = 0,
    val observationId: String,
    val summary: String,
    @Serializable(with = LenientBriefSourceListSerializer::class)
    val sources: List<DailyBriefSourceDto> = emptyList(),
    @Serializable(with = LenientBriefTaskListSerializer::class)
    val tasks: List<DailyBriefTaskDto> = emptyList(),
    /** What the reader said about the item, once they have. */
    val reaction: DailyBriefReactionDto? = null,
)

/**
 * A reader's reaction to one brief item. [kind] is kept as the gateway spelled it so a kind this
 * build does not know still decodes; [kindOrNull] reads the ones it does.
 */
@Serializable
data class DailyBriefReactionDto(
    val kind: String,
    /** The words that came with it, when any did. */
    val note: String? = null,
    /** When it was recorded (ISO 8601); absent on an optimistic update until the gateway answers. */
    val at: String? = null,
) {
    val kindOrNull: DailyBriefReactionKind? get() = DailyBriefReactionKind.fromWire(kind)
}

/** The reactions a reader can give a brief item, as `PUT …/items/:observationId/reaction` names them. */
enum class DailyBriefReactionKind(val wire: String) {
    UP("up"),
    NOT_INTERESTED("not_interested"),
    FACTUAL_ERROR("factual_error"),
    ;

    companion object {
        fun fromWire(value: String): DailyBriefReactionKind? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * The gateway's answer to `PUT /agent/conversations/:id/briefs/:day/items/:observationId/reaction`.
 *
 * Gateway TS shape (`packages/gateway/src/http/routes/agent.ts`):
 *
 * ```ts
 * { observationId: string; reaction: "up" | "not_interested" | "factual_error" | null;
 *   note?: string; noteId?: string; at?: string }
 * ```
 */
@Serializable
data class DailyBriefReactionReceiptDto(
    val observationId: String = "",
    /** Null once the reaction was cleared. */
    val reaction: String? = null,
    val note: String? = null,
    /** The id the correction was saved under as a note, when a factual error came with words. */
    val noteId: String? = null,
    val at: String? = null,
) {
    /** The reaction as the item now carries it, or null when it was cleared. */
    val asReaction: DailyBriefReactionDto? get() = reaction?.let { DailyBriefReactionDto(kind = it, note = note, at = at) }
}

/** A document an item rests on. [sourceType] picks its icon through the source catalog. */
@Serializable
data class DailyBriefSourceDto(
    val id: String,
    /** Null when the document has no title. */
    val title: String? = null,
    val sourceType: String? = null,
    val createdAt: String? = null,
)

/** A task an item touches, with its current title and state. */
@Serializable
data class DailyBriefTaskDto(
    val id: String,
    /** Nullable on the wire so a task without a title still shows; read [label]. */
    val title: String? = null,
    /** `open`, `done`, … as the gateway names it; absent reads as open. */
    val state: String? = null,
) {
    val label: String get() = title.orEmpty()

    /** Finished one way or another. */
    val isResolved: Boolean get() = (state ?: TaskDto.STATE_OPEN).let { it != TaskDto.STATE_OPEN && it != "snoozed" }
}

/**
 * Decodes a list one element at a time, dropping each element that does not decode — a newer
 * or damaged entry costs only itself. A value that is not a list reads as empty.
 */
abstract class LenientListSerializer<T>(private val element: KSerializer<T>) : KSerializer<List<T>> {
    private val delegate = ListSerializer(element)
    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun serialize(encoder: Encoder, value: List<T>) = delegate.serialize(encoder, value)

    override fun deserialize(decoder: Decoder): List<T> {
        val json = decoder as? JsonDecoder ?: return delegate.deserialize(decoder)
        val array = json.decodeJsonElement() as? JsonArray ?: return emptyList()
        return array.mapNotNull { item -> decodeOrNull(json, item) }
    }

    private fun decodeOrNull(json: JsonDecoder, item: JsonElement): T? =
        if (item !is JsonObject) {
            null
        } else {
            runCatching { json.json.decodeFromJsonElement(element, item) }.getOrNull()
        }
}

object LenientBriefItemListSerializer : LenientListSerializer<DailyBriefItemDto>(DailyBriefItemDto.serializer())

object LenientBriefSourceListSerializer : LenientListSerializer<DailyBriefSourceDto>(DailyBriefSourceDto.serializer())

object LenientBriefTaskListSerializer : LenientListSerializer<DailyBriefTaskDto>(DailyBriefTaskDto.serializer())
