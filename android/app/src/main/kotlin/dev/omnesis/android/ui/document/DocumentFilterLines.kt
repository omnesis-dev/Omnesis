// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import dev.omnesis.android.transport.dto.DocumentFilterDetails
import dev.omnesis.android.transport.dto.DocumentFilterField

/** One line of a document's filter details, as the inspector lists it: "Chat" — "Workshop planning". */
internal data class FilterDetailLine(val label: String, val value: String)

/** What a field holding no items of its kind says. */
internal const val NO_FILTER_ITEMS = "None"
/** What a field the record cannot answer for says when the gateway sent no sentence. */
internal const val NOT_RECORDED = "Not recorded"

/**
 * The lines that say what a filter sees of a document: one per filterable field of its source, named in the singular
 * for one item and the plural otherwise, then the source version that wrote the record. A field too old to carry its
 * detail, or whose detail is unknown, says so in the gateway's words. A source no filter can use has no lines at all,
 * so the inspector leaves the section out instead of showing a lone source version.
 */
internal fun DocumentFilterDetails.lines(): List<FilterDetailLine> = if (fields.isEmpty()) emptyList() else fields.map { field ->
    val present = field.state == DocumentFilterField.PRESENT
    val noun = if (present && field.items.size == 1) field.noun.one else field.noun.many
    val value = when {
        present -> field.items.joinToString { it.label }.ifEmpty { NO_FILTER_ITEMS }
        else -> field.stateText.ifBlank { NOT_RECORDED }
    }
    FilterDetailLine(noun.replaceFirstChar { it.uppercase() }, value)
} + FilterDetailLine("Source version", sourceVersion.toString())
