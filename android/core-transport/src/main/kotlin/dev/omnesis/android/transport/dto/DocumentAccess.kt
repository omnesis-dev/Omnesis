// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

// What a filter sees of one document, and which access levels can read it. Both routes are the
// owner's (`/admin/documents/:id/...`); every sentence is the gateway's.

/** One item a document belongs to: its name from the account's list, or its raw id when the list does not hold it. */
@Serializable data class DocumentFilterItem(val id: String, val label: String, val listed: Boolean = true)

/**
 * What one filterable field holds for a document. [PRESENT] with no items means none; [TOO_OLD] and [UNKNOWN] carry
 * the gateway's [stateText] instead of items.
 */
@Serializable data class DocumentFilterField(
    val field: String,
    val noun: FilterNoun,
    val state: String,
    val stateText: String = "",
    val items: List<DocumentFilterItem> = emptyList(),
) {
    companion object {
        const val PRESENT = "present"
        const val TOO_OLD = "too-old"
        const val UNKNOWN = "unknown"
    }
}

/** `GET /admin/documents/:id/filter-details`: the record's filter details and the source version that wrote it (0 = before versions). */
@Serializable data class DocumentFilterDetails(
    val documentId: String,
    val sourceVersion: Int = 0,
    val fields: List<DocumentFilterField> = emptyList(),
)

/** An agent on an access level: an OAuth/MCP connection or a paired integration device. */
@Serializable data class AuditAgent(val id: String, val name: String, val kind: String) {
    val integration: Boolean get() = kind == "device"
}

/** Whether one capability of a level can read the document, and why, in the gateway's words. */
@Serializable data class AuditVerdict(val readable: Boolean, val code: String, val text: String)

@Serializable data class AuditLevel(
    val id: String,
    val name: String,
    val agents: List<AuditAgent> = emptyList(),
    val answer: AuditVerdict,
    val direct: AuditVerdict,
)

/** The two notes the audit page states: what "readable" means for Answer, and that the page is the owner's alone. */
@Serializable data class AuditNotes(val answer: String, val owner: String)

/** `GET /admin/documents/:id/access`: every access level, in the gateway's order, with its agents and two verdicts. */
@Serializable data class DocumentAccessAudit(
    val documentId: String,
    val title: String,
    val sourceId: String,
    val sourceName: String,
    val sourceVersion: Int = 0,
    val notes: AuditNotes,
    val levels: List<AuditLevel> = emptyList(),
)
