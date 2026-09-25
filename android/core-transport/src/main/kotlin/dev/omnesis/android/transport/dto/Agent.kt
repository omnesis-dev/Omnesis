// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** A document reference surfaced by the agent (search hit, citation, tool result). */
@Serializable
data class AgentDocRef(
    val documentId: String,
    val sourceType: String = "",
    val sourceId: String = "",
    val documentType: String? = null,
    val title: String? = null,
    val snippet: String? = null,
    val ts: Double? = null,
    val url: String? = null,
    val appUrl: String? = null,
    val mimeType: String? = null,
    val people: List<String>? = null,
    val unitName: String? = null,
    /**
     * Open loops the Cognition Steward tracks that this document is a source for — the
     * "what is this part of" connection, attached inline in experimental mode.
     * Absent/empty when no tracked loop references the document.
     */
    val openLoops: List<AgentDocLoopRef>? = null,
    /**
     * Durable annotations the Cognition Steward recorded ABOUT this document — grounded
     * priors, never facts. Attached inline on fetch results in experimental mode;
     * absent/empty when none exist.
     */
    val annotations: List<AgentDocAnnotationHint>? = null,
)

/**
 * A compact reference to an open loop this document is a source for — a pointer,
 * not the loop's full state (that lives behind `fetch_loop`). Mirrors `DocLoopRef`
 * in `@omnesis/core/agent-protocol.ts`.
 */
@Serializable
data class AgentDocLoopRef(
    val loopId: String,
    val title: String = "",
    /** Lifecycle state: `open` | `snoozed` (terminal loops are never attached). */
    val state: String = "",
    /** Importance the Cognition Steward assigned (0-1), for ordering. */
    val importance: Double? = null,
)

/**
 * A hint-shaped view of a durable annotation the Cognition Steward recorded ABOUT a
 * document — a grounded prior to reground against, never a hard fact. The
 * verbatim evidence quote is deliberately absent from the wire shape. Mirrors
 * `DocAnnotationHint`.
 */
@Serializable
data class AgentDocAnnotationHint(
    /** Open-vocabulary claim kind (`topic`, `entity`, `commitment-status`, …). */
    val claimType: String = "",
    val claim: String = "",
    /** Recorded confidence (0-1), always below certainty. */
    val confidence: Double = 0.0,
)

/**
 * A loop summary row in a `search_loops` result — richer than the inline
 * [AgentDocLoopRef] chip: enough for the reader to judge the obligation without
 * opening it. Mirrors `LoopSummary`.
 */
@Serializable
data class AgentLoopSummary(
    val loopId: String,
    val title: String = "",
    val description: String? = null,
    /** Lifecycle state: `open` | `snoozed`. */
    val state: String = "",
    val importance: Double? = null,
    val confidence: Double? = null,
    /** Human/ISO deadline string the port derived from the loop, when it has one. */
    val deadline: String? = null,
)

/**
 * The full read-only view of one open loop from `fetch_loop`: its summary plus the
 * people it concerns, its source documents, and its recent ledger. Mirrors
 * `LoopDetail` (`LoopSummary` + these fields) in `@omnesis/core/agent-protocol.ts`.
 */
@Serializable
data class AgentLoopDetail(
    val loopId: String,
    val title: String = "",
    val description: String? = null,
    val state: String = "",
    val importance: Double? = null,
    val confidence: Double? = null,
    val deadline: String? = null,
    /** People who need to act (canonical display names). */
    val actors: List<String>? = null,
    /** People with a stake (canonical display names). */
    val involved: List<String>? = null,
    /** Source document ids the loop rests on. */
    val docIds: List<String>? = null,
    /** Recent ledger entries, oldest → newest. */
    val ledger: List<AgentLoopLedgerEntry>? = null,
)

/** One ledger entry on a loop — a unix-ms-stamped note. Mirrors `{ at, note }`. */
@Serializable
data class AgentLoopLedgerEntry(
    val at: Long = 0,
    val note: String = "",
)

@Serializable
data class AgentPersonSummary(
    val canonicalId: String,
    val displayName: String = "",
    val aliases: List<String> = emptyList(),
    val emailCount: Int? = null,
    val meetingCount: Int? = null,
    val chatCount: Int? = null,
    val lastInteraction: Double? = null,
    val avatarHash: String? = null,
    val interactionScore: Double? = null,
)

@Serializable
data class AgentSqlSource(
    val sourceId: String,
    val sourceType: String = "",
    val displayName: String = "",
)

/** A plan step. `status` is "pending" | "in_progress" | "done" (kept as a String for forward-compat). */
@Serializable
data class AgentPlanItem(
    val id: String,
    val label: String = "",
    val status: String = "pending",
)

/**
 * One event on a trail. An event carries a [doc], a [record] (#757), or BOTH:
 *   - [doc] only — an ordinary document event.
 *   - [doc] + [record] — a document and its `same-entity` analytics row collapsed into ONE
 *     timeline entity (dedup on [AgentTrailRecord.recordKey]); `at` is the row's semantic time
 *     so the record places chronologically.
 *   - [record] only — a bound row reached from the seed that binds no document; it stands as
 *     its own point-in-time entity.
 *
 * The gateway always sends at least one of the two (its schema refines it); both are nullable
 * here so a record-only event omits `doc` and a deduped doc+row event carries both. Mirrors
 * the iOS `AgentTrailEvent` shape and `TrailEvent` in `@omnesis/core/agent-protocol.ts`.
 */
@Serializable
data class AgentTrailEvent(
    val eventId: String,
    val at: String? = null,
    val kind: String = "",
    val doc: AgentTrailEventDoc? = null,
    val record: AgentTrailRecord? = null,
    val attachments: List<AgentTrailEvent> = emptyList(),
    val people: List<AgentTrailEventPerson> = emptyList(),
    val related: List<AgentTrailEventRelated> = emptyList(),
) {
    /**
     * Source-agnostic source id for icon/colour lookup. A document or deduped doc+record event
     * uses `doc.sourceId`; a record-only event uses `record.sourceId`. Mirrors the portal's
     * `eventSourceId(ev)` and the iOS `eventSourceId`.
     */
    val eventSourceId: String? get() = doc?.sourceId ?: record?.sourceId

    /**
     * Stable timeline-entity identity used for dedup + ordering. A document (or deduped) event
     * keys on its `doc.documentId`; a record-only event keys on its `record.recordKey`. Mirrors
     * the portal reducer's identity choice and the iOS `entityId`.
     */
    val entityId: String get() = doc?.documentId ?: record?.recordKey ?: eventId
}

@Serializable
data class AgentTrailEventDoc(
    val documentId: String,
    val title: String = "",
    val sourceId: String = "",
    val sourceUrl: String? = null,
    val appUrl: String? = null,
    val documentType: String? = null,
    val mimeType: String? = null,
)

@Serializable
data class AgentTrailEventPerson(
    val personId: String,
    val name: String = "",
    val role: String = "",
    val isSelf: Boolean = false,
)

@Serializable
data class AgentTrailEventRelated(
    val documentId: String,
    val title: String = "",
    val sourceId: String = "",
    val linkType: String = "",
    val direction: String = "",
)

/**
 * One declared key column of a record citation (#757). The gateway derives the label/value
 * from the table's record-display contract and redacts `sensitive` columns server-side — the
 * value here is print-ready. The wire value is heterogeneous (`string | number | boolean |
 * null`); [AgentTrailRecordKeyFieldValueSerializer] coerces every shape to a display string so
 * the renderer prints it verbatim. A `null` value (an explicit JSON null, rendered as an
 * em-dash) decodes to a `null` [value]. Mirrors the iOS `AgentTrailRecordKeyField`.
 */
@Serializable
data class AgentTrailRecordKeyField(
    val label: String = "",
    @Serializable(with = AgentTrailRecordKeyFieldValueSerializer::class)
    val value: String? = null,
)

/**
 * Coerces a `string | number | boolean | null` wire value into a print-ready display string,
 * matching the iOS decoder: integral numbers drop the trailing `.0`, booleans become
 * `"true"`/`"false"`, an explicit null becomes `null` (an em-dash at the renderer). Any
 * unexpected shape (array/object — never sent for a key field) also degrades to `null`.
 */
object AgentTrailRecordKeyFieldValueSerializer : KSerializer<String?> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("AgentTrailRecordKeyFieldValue", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): String? {
        val json = decoder as? JsonDecoder ?: return decoder.decodeString()
        val prim = json.decodeJsonElement() as? JsonPrimitive ?: return null
        if (prim is JsonNull) return null
        if (prim.isString) return prim.content
        prim.booleanOrNull?.let { return if (it) "true" else "false" }
        prim.longOrNull?.let { return it.toString() }
        prim.doubleOrNull?.let { d ->
            return if (d == d.toLong().toDouble()) d.toLong().toString() else d.toString()
        }
        return prim.content
    }

    override fun serialize(encoder: Encoder, value: String?) {
        if (value == null) encoder.encodeNull() else encoder.encodeString(value)
    }
}

/**
 * A DuckDB analytics row surfaced on the trail as a point-in-time record (#757). The gateway
 * derives every display string from the table's declared record-display contract, so the
 * renderer prints these directly and never learns a column name or branches on a source.
 *
 * [recordKey] (= `analyticsRowKey(table, pk)`) is the stable identity the timeline dedups on:
 * a document plus its `same-entity` row collapse to ONE event (the doc event carries the
 * [record]), so a row never appears twice. [boundDocumentId] deep-links the co-described
 * document when non-null; when null the record renders with no tap target (no dead link).
 * Mirrors the iOS `AgentTrailRecord` and `TrailRecord` in `@omnesis/core/agent-protocol.ts`.
 */
@Serializable
data class AgentTrailRecord(
    val recordKey: String,
    val table: String = "",
    val tableDisplayName: String = "",
    val title: String = "",
    val keyFields: List<AgentTrailRecordKeyField> = emptyList(),
    /** ISO-8601 declared semantic time. Always present (a timeless row is never surfaced). */
    val semanticTime: String = "",
    val sourceId: String = "",
    val sourceType: String = "",
    /** Co-described document id when the row binds one, else `null`. */
    val boundDocumentId: String? = null,
)

@Serializable
data class AgentTriggerSummary(
    val id: String,
    val name: String = "",
    val kind: String = "",
    val enabled: Boolean = false,
    val expired: Boolean = false,
    val lastFiredAt: Long? = null,
    val fireCount: Int = 0,
    val actionKinds: List<String> = emptyList(),
    val agentManageable: Boolean = false,
)

@Serializable
data class AgentTriggerRecord(
    val id: String,
    val name: String = "",
    val kind: String = "",
    val enabled: Boolean = false,
    val expired: Boolean = false,
    val lastFiredAt: Long? = null,
    val fireCount: Int = 0,
    val actionKinds: List<String> = emptyList(),
    val agentManageable: Boolean = false,
    val spec: JsonElement = JsonNull,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

@Serializable
data class AgentTriggerFiring(
    val id: String,
    val triggerId: String = "",
    val firedAt: Long = 0,
    val kind: String = "",
    val status: String = "",
    val batchSize: Int = 0,
    val durationMs: Int = 0,
    val error: String? = null,
)
