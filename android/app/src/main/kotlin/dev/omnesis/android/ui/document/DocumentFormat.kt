// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import dev.omnesis.android.transport.dto.DocumentDetail
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Document-display formatting helpers ported from the iOS `DocumentRowHelpers` and the
 * `DocumentDetail` metadata convenience accessors. All of these are source-agnostic — they
 * read closed enums (documentType, linkType) or the doc's `metadata` JSON, never branch on
 * a specific source name. The human display name for a source is resolved separately
 * through `SourceCatalog`, not here.
 */

/** Pull a string field out of `metadata` (a `JsonObject` on the wire), or null. */
fun DocumentDetail.metadataString(key: String): String? {
    val obj = metadata as? JsonObject ?: return null
    return (obj[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
}

/** documentType from metadata. */
val DocumentDetail.documentType: String?
    get() = metadataString("documentType")

/** Web URL the source published for this doc (when any). */
val DocumentDetail.sourceUrl: String?
    get() = metadataString("sourceUrl")

/** Native-app deep link preferred on mobile clients. */
val DocumentDetail.appUrl: String?
    get() = metadataString("appUrl")

/** Tags pulled from `metadata.tags` (a string array on the wire). */
val DocumentDetail.tags: List<String>
    get() {
        val obj = metadata as? JsonObject ?: return emptyList()
        val arr = obj["tags"] as? JsonArray ?: return emptyList()
        return arr.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.takeIf { s -> s.isNotBlank() } }
    }

/**
 * Flat key/value list of `metadata.extra`. Nested objects flatten with dotted keys
 * (`mime.type`); arrays render as `[N items]`; nulls as "—". Keys starting `attachments`
 * are dropped (they show in the graph tab with rich rendering). Sorted by key. Ported
 * from the iOS `MetadataPane.flatten`.
 */
fun DocumentDetail.extras(): List<Pair<String, String>> {
    val obj = metadata as? JsonObject ?: return emptyList()
    val extra = obj["extra"] as? JsonObject ?: return emptyList()
    val rows = mutableListOf<Pair<String, String>>()
    flattenJson(extra, "", rows)
    return rows
        .filterNot { it.first.startsWith("attachments") }
        .sortedBy { it.first }
}

private fun flattenJson(obj: JsonObject, prefix: String, into: MutableList<Pair<String, String>>) {
    for ((key, value) in obj) {
        val path = if (prefix.isEmpty()) key else "$prefix.$key"
        when (value) {
            is JsonObject -> flattenJson(value, path, into)
            is JsonArray -> into.add(path to "[${value.size} items]")
            JsonNull -> into.add(path to "—")
            is JsonPrimitive -> into.add(path to (value.contentOrNull ?: "—"))
        }
    }
}

/** True for file-like docs whose meta line shows a file-type pill instead of a type label. */
fun isFileLike(documentType: String?): Boolean =
    documentType == "attachment" || documentType == "file"

/**
 * Map a `documentType` to a user-facing label. Mirrors the portal/iOS `docTypeLabel`.
 * Generic, not source-specific. Unknown types capitalise their first letter.
 */
fun docTypeLabel(type: String?): String? {
    if (type.isNullOrEmpty()) return null
    return when (type) {
        "email" -> "Email"
        "event" -> "Event"
        "conversation" -> "Conversation"
        "note" -> "Note"
        "page" -> "Page"
        "task" -> "Task"
        "reminder" -> "Reminder"
        "contact" -> "Contact"
        "bookmark" -> "Bookmark"
        "history" -> "History"
        "message" -> "Message"
        "activity" -> "Activity"
        "file", "document" -> "Document"
        else -> type.replaceFirstChar { it.uppercase() }
    }
}

/** Strip a trailing `:account` suffix from a sourceId, returning just the type. */
fun sourceTypeFromId(sourceId: String): String = sourceId.substringBefore(':')

/**
 * Format an ISO-8601 timestamp as a compact phrase: "12s ago", "5m ago", "3h ago",
 * "2d ago", or a short date for older entries. Returns the raw input when it can't be
 * parsed so something useful still renders. Ported from iOS `formatTimeAgo`.
 */
fun formatTimeAgo(iso: String?): String? {
    if (iso == null) return null
    val instant = parseInstant(iso) ?: return iso
    val diff = (System.currentTimeMillis() - instant.toEpochMilli()) / 1000.0
    return when {
        diff < 0 -> "just now"
        diff < 60 -> "${diff.toInt()}s ago"
        diff < 3600 -> "${(diff / 60).toInt()}m ago"
        diff < 86400 -> "${(diff / 3600).toInt()}h ago"
        diff < 86400 * 30 -> "${(diff / 86400).toInt()}d ago"
        else -> SHORT_DATE.format(instant.atZone(ZoneId.systemDefault()))
    }
}

/**
 * The links that open a document outside the app, in preference order: the native-app deep
 * link (`appUrl`) before the web link (`sourceUrl`), each filtered through a small scheme
 * blocklist, keeping only those [canOpen] says an installed app handles. A source publishes
 * one set of links for every platform, so an iOS-only deep link is skipped here in favour of
 * the web link, and a document whose links no app on this device opens gets no open action.
 */
fun openableDocUrls(appUrl: String?, sourceUrl: String?, canOpen: (String) -> Boolean): List<String> =
    listOfNotNull(externalDocUrl(appUrl), externalDocUrl(sourceUrl)).distinct().filter(canOpen)

private val BLOCKED_SCHEMES = setOf("file", "data", "javascript", "about")

private fun externalDocUrl(value: String?): String? {
    if (value.isNullOrBlank()) return null
    val scheme = value.substringBefore(':', "").lowercase().takeIf { it.isNotEmpty() && value.contains(':') }
        ?: return null
    return if (scheme in BLOCKED_SCHEMES) null else value
}

// MARK: - Timestamp parsing

private val SHORT_DATE: DateTimeFormatter =
    DateTimeFormatter.ofPattern("M/d/yy", Locale.US)

/** Parse an ISO-8601 instant, tolerating both fractional-second and plain forms. */
private fun parseInstant(iso: String?): Instant? {
    if (iso.isNullOrBlank()) return null
    return runCatching { Instant.parse(iso) }.getOrNull()
        ?: runCatching { ZonedDateTime.parse(iso).toInstant() }.getOrNull()
}
