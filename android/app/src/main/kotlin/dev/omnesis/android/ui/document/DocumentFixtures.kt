// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import dev.omnesis.android.transport.dto.AgentTrailEvent
import dev.omnesis.android.transport.dto.AgentTrailEventDoc
import dev.omnesis.android.transport.dto.AgentTrailEventPerson
import dev.omnesis.android.transport.dto.DocumentNearDupes
import dev.omnesis.android.transport.dto.NearDupEdge
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Invented fixtures for previews + parity screenshots. All data is fictional (privacy
 * rule) — never sourced from the corpus. Shared by `@Preview` blocks here and the
 * Roborazzi parity test so the snapshots and the live screen render the same shapes.
 */
internal fun sampleMetadata(
    documentType: String,
    sourceUrl: String? = null,
    mimeType: String? = null,
    tags: List<String> = emptyList(),
): JsonElement = buildJsonObject {
    put("documentType", documentType)
    sourceUrl?.let { put("sourceUrl", it) }
    mimeType?.let { put("mimeType", it) }
    if (tags.isNotEmpty()) {
        put("tags", kotlinx.serialization.json.buildJsonArray { tags.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
    }
}

internal fun sampleNearDupes() = DocumentNearDupes(
    edges = listOf(
        NearDupEdge(
            otherDocId = "d-dup-1", otherTitle = "Re: Standup notes — Mar 9",
            otherSourceId = "gmail:user@example.com", jaccard = 0.92,
        ),
        NearDupEdge(
            otherDocId = "d-dup-2", otherTitle = "Marathon entry form v2.pdf",
            otherSourceId = "google-drive:user@example.com", jaccard = 0.81,
        ),
    ),
)

/**
 * A multi-day, multi-source event trail exercising the spine timeline: alternating
 * sources (so the spine cross-fades), date-band headers, and a file-like (PDF) row.
 */
internal fun sampleTrailEvents(): List<AgentTrailEvent> = listOf(
    trailEvent("e0", "2026-01-10T10:20:00Z", "gmail:user@example.com", "Q4 budget review", documentType = "email"),
    trailEvent("e1", "2026-02-11T11:20:00Z", "notes:local", "Standup notes — Mar 9", documentType = "note"),
    trailEvent("e2", "2026-03-12T12:22:00Z", "whatsapp:demo", "Trip planning thread", documentType = "conversation"),
    trailEvent(
        "e3", "2026-04-13T14:23:00Z", "google-drive:user@example.com",
        "Marathon entry form v2.pdf", documentType = "file", mimeType = "application/pdf",
    ),
    trailEvent("e4", "2026-05-14T15:24:00Z", "gmail:user@example.com", "Re: Studio Northstar quote", documentType = "email"),
)

private fun trailEvent(
    id: String,
    at: String,
    sourceId: String,
    title: String,
    documentType: String,
    mimeType: String? = null,
) = AgentTrailEvent(
    eventId = id,
    at = at,
    kind = "event",
    doc = AgentTrailEventDoc(
        documentId = "doc-$id",
        title = title,
        sourceId = sourceId,
        documentType = documentType,
        mimeType = mimeType,
    ),
    people = listOf(AgentTrailEventPerson(personId = "self", name = "You", role = "sender", isSelf = true)),
)
