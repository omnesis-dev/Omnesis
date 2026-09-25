// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/**
 * `GET /documents/:id`. Mirrors the iOS `DocumentDetail` (snake_case wire keys).
 * `metadata` is a TEXT column that may arrive as stringified JSON or a parsed
 * object — [FlexibleJsonElementSerializer] handles both.
 */
@Serializable
data class DocumentDetail(
    val id: String,
    @SerialName("provider_id") val providerId: String,
    @SerialName("source_id") val sourceId: String,
    /**
     * True when the document belongs to a gateway-internal source
     * (a dataset the gateway hosts itself). Absent on older gateways → false.
     */
    @SerialName("internal") val isInternal: Boolean = false,
    @SerialName("external_id") val externalId: String,
    val title: String,
    val content: String = "",
    @SerialName("content_hash") val contentHash: String = "",
    @Serializable(with = FlexibleJsonElementSerializer::class)
    val metadata: JsonElement = JsonNull,
    @SerialName("source_created_at") val sourceCreatedAt: String,
    @SerialName("source_updated_at") val sourceUpdatedAt: String? = null,
    @SerialName("ingested_at") val ingestedAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

/** `GET /documents/:id/people` -> `{ people: [...] }`. */
@Serializable
data class PeopleResponse(val people: List<PersonMention> = emptyList())

@Serializable
data class PersonMention(
    val personId: String,
    val canonicalName: String,
    val role: String = "",
    val isSelf: Boolean = false,
    val aliases: List<PersonAlias> = emptyList(),
)

/**
 * Best-effort display label: canonicalName when non-blank, else the first alias
 * (typically a phone or email), else "(unknown)". So phone-only contacts that carry
 * no canonical name still render a label instead of a blank row. Mirrors the iOS
 * `PersonMention.displayName`.
 */
val PersonMention.displayName: String
    get() = canonicalName.ifBlank { aliases.firstOrNull()?.alias.orEmpty() }.ifBlank { "(unknown)" }

@Serializable
data class PersonAlias(
    val id: String,
    val aliasType: String,
    val alias: String,
    val sourceId: String? = null,
)

/** `GET /documents/:id/refs`. */
@Serializable
data class DocumentRefs(
    val outbound: List<OutboundRef> = emptyList(),
    val inbound: List<InboundRef> = emptyList(),
    val outboundPageInfo: PageInfo = PageInfo(limit = outbound.size),
    val inboundPageInfo: PageInfo = PageInfo(limit = inbound.size),
)

@Serializable
data class OutboundRef(
    val linkType: String,
    val rawTarget: String = "",
    val normalizedTarget: String = "",
    val targetDocId: String? = null,
    val targetTitle: String? = null,
    val targetSourceId: String? = null,
    val targetSourceUrl: String? = null,
    val targetAppUrl: String? = null,
)

@Serializable
data class InboundRef(
    val sourceDocId: String,
    val sourceTitle: String = "",
    val sourceSourceId: String = "",
    val linkType: String,
    val sourceSourceUrl: String? = null,
    val sourceAppUrl: String? = null,
)

/** Stable UI identity for one outbound reference row. */
val OutboundRef.stableId: String
    get() = listOf(linkType, rawTarget, normalizedTarget, targetDocId.orEmpty()).joinToString("\u0000")

/** Stable UI identity for one inbound reference row. */
val InboundRef.stableId: String
    get() = listOf(sourceDocId, linkType).joinToString("\u0000")

/** `GET /documents/:id/attachments` -> `{ attachments: [...] }`. */
@Serializable
data class AttachmentsResponse(val attachments: List<DocumentAttachment> = emptyList())

@Serializable
data class DocumentAttachment(
    val id: String,
    val externalId: String,
    val title: String,
    val attachmentId: String,
    val mimeType: String? = null,
    val sizeBytes: Long? = null,
    val pages: Int? = null,
    val truncated: Boolean? = null,
    val sourceUrl: String? = null,
    val appUrl: String? = null,
)

/**
 * `GET /documents/:id/near-dupes` — the near-duplicate graph for one document. Mirrors
 * the iOS `DocumentNearDupes` (= `NearDupEdgesResponse` in
 * `packages/gateway/src/near-dupes/types.ts`).
 */
@Serializable
data class DocumentNearDupes(
    val edges: List<NearDupEdge> = emptyList(),
    val nextCursor: String? = null,
)

/**
 * One near-duplicate edge linking this doc to a similar one. Carries the verified
 * Jaccard plus the pair-exclusivity / containment counters so a "why" hover can render
 * without an extra round-trip. Mirrors `NearDupEdgeDto`.
 */
@Serializable
data class NearDupEdge(
    val otherDocId: String,
    val otherTitle: String = "",
    val otherSourceId: String = "",
    val otherDocType: String = "",
    val otherSourceUrl: String? = null,
    val otherAppUrl: String? = null,
    val jaccard: Double = 0.0,
    val pairUniqueDf2: Int = 0,
    val pairUniqueDf5: Int = 0,
    val containmentMin: Double = 0.0,
    val gateFamily: String = "",
)

/**
 * `GET /documents/:id/trail` — the chronological `EventTrail` the gateway builds by
 * walking the link graph out from one seed document. Identical shape to the agent's
 * `trace_connections` tool result, so the typed [AgentTrailEvent] rows feed straight into
 * the inspector Timeline renderer. Mirrors the iOS `DocumentEventTrail`.
 */
@Serializable
data class DocumentEventTrail(
    val seeds: List<String> = emptyList(),
    val events: List<AgentTrailEvent> = emptyList(),
    val truncated: Boolean = false,
)
