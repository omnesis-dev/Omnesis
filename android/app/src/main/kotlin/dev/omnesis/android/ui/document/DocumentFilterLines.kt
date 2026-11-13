// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import dev.omnesis.android.transport.dto.DocumentFilterDetails
import dev.omnesis.android.transport.dto.DocumentFilterField

/** One line of a document's filter details, as the inspector lists it: "Chat" — "Workshop planning". */
internal data class FilterDetailLine(val label: String, val value: String)

/** What a field holding no items of its kind says. */
internal const val NO_FILTER_ITEMS = "None"

/**
 * The lines that say what a filter sees of a document: one per filterable field of its source, named in the singular
 * for one item and the plural otherwise, then the source version that wrote the record. A field too old to carry its
 * detail, or whose detail is unknown, says so in the gateway's words.
 */
internal fun DocumentFilterDetails.lines(): List<FilterDetailLine> = fields.map { field ->
    val present = field.state == DocumentFilterField.PRESENT
    val noun = if (present && field.items.size == 1) field.noun.one else field.noun.many
    val value = when {
        present -> field.items.joinToString { it.label }.ifEmpty { NO_FILTER_ITEMS }
        else -> field.stateText.ifBlank { if (field.state == DocumentFilterField.TOO_OLD) "Too old to carry its ${field.noun.many}" else "Not recorded" }
    }
    FilterDetailLine(noun.replaceFirstChar { it.uppercase() }, value)
} + FilterDetailLine("Source version", sourceVersion.toString())
