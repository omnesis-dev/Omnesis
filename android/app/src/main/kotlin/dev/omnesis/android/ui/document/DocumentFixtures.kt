// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import dev.omnesis.android.transport.dto.AgentTrailEvent
import dev.omnesis.android.transport.dto.AgentTrailEventDoc
import dev.omnesis.android.transport.dto.AgentTrailEventPerson
import dev.omnesis.android.transport.dto.AuditAgent
import dev.omnesis.android.transport.dto.AuditLevel
import dev.omnesis.android.transport.dto.AuditNotes
import dev.omnesis.android.transport.dto.AuditVerdict
import dev.omnesis.android.transport.dto.DocumentAccessAudit
import dev.omnesis.android.transport.dto.DocumentFilterDetails
import dev.omnesis.android.transport.dto.DocumentFilterField
import dev.omnesis.android.transport.dto.DocumentFilterItem
import dev.omnesis.android.transport.dto.FilterNoun
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

/**
 * The invented WhatsApp day the filter-details and "Who can read this?" renders show, with the details a filter sees
 * of it and the verdict of every access level, as the gateway would send them.
 */
internal object DocumentFixtures {
    private const val SOURCE_ID = "whatsapp-messages:+15550100123"
    private const val SOURCE_NAME = "WhatsApp · +1 (555) 010-0123"

    val workshopDay = dev.omnesis.android.transport.dto.DocumentDetail(
        id = "0f6c2a1e-6b8d-4e43-9c2a-5d1e7b3f9a10", providerId = "whatsapp:+15550100123", sourceId = SOURCE_ID, externalId = "day:120363000000000001@g.us:2026-03-14",
        title = "Workshop planning — 14 March",
        content = "Maya Reeves: Shall we book the room for Thursday?\nJamie Lopez: Thursday works. I'll bring the slides.",
        metadata = sampleMetadata(documentType = "conversation"),
        sourceCreatedAt = "2026-03-14T09:12:00Z", sourceUpdatedAt = "2026-03-14T18:40:00Z", ingestedAt = "2026-03-14T18:41:00Z",
    )

    val filterDetails = DocumentFilterDetails(
        documentId = workshopDay.id, sourceVersion = 1,
        fields = listOf(
            DocumentFilterField("extra.chatId", FilterNoun("chat", "chats"), DocumentFilterField.PRESENT,
                items = listOf(DocumentFilterItem("chat-workshop", "Workshop planning"))),
            DocumentFilterField("\$people", FilterNoun("person", "people"), DocumentFilterField.PRESENT,
                items = listOf(DocumentFilterItem("+15550100142", "Maya Reeves"), DocumentFilterItem("+15550100187", "Jamie Lopez"))),
        ),
    )

    /** The day's details as the owner's inspector shows them, with the WhatsApp [icon]. */
    fun bundle(icon: dev.omnesis.android.designsystem.components.SourceIconModel) = DocumentDetailViewModel.DocumentBundle(
        doc = workshopDay,
        sourceDisplay = DocumentDetailViewModel.SourceDisplayLookup(mapOf(SOURCE_ID to DocumentDetailViewModel.SourceDisplay(SOURCE_NAME, icon))),
        owner = true,
        filterDetails = filterDetails,
    )

    private fun verdict(readable: Boolean, code: String, text: String) = AuditVerdict(readable, code, text)
    private val directNotGranted = verdict(false, "permission-not-granted", "Direct is not granted on this level")

    val audit = DocumentAccessAudit(
        documentId = workshopDay.id, title = workshopDay.title, sourceId = SOURCE_ID, sourceName = "WhatsApp", sourceVersion = 1,
        notes = AuditNotes(
            answer = "“Can read” under Answer means Omnesis may use this document when answering that agent. Whether an answer is then released is decided by the privacy policy’s review.",
            owner = "This page is for you, the owner. It is never available to an external agent.",
        ),
        levels = listOf(
            AuditLevel("level-family", "Family helper", emptyList(),
                answer = verdict(true, "readable", "This account is shared with all content"), direct = directNotGranted),
            AuditLevel("level-notes", "Notes capture", emptyList(),
                answer = verdict(false, "permission-not-granted", "Answer is not granted on this level"), direct = directNotGranted),
            AuditLevel("level-research", "Research assistant",
                listOf(AuditAgent("grant-aurora", "Aurora Planner", "connection"), AuditAgent("grant-northstar", "Northstar Assistant", "connection"), AuditAgent("device-kitchen", "Kitchen speaker", "device")),
                answer = verdict(false, "hidden-by-item", "Hidden by: chat Workshop planning"), direct = verdict(false, "account-not-shared", "This account is not shared")),
        ),
    )
}
