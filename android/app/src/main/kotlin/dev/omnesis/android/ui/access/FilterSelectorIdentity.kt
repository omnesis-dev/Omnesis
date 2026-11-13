// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*

/**
 * The identity of a filter entry: an item by its field, device and id; a person by the exact set of addresses captured
 * for them. Names are hints only, so a renamed item is the same entry and a new captured address is a new one.
 */
internal fun filterRefKey(ref: FilterRef): String = buildString {
    fun field(value: String) { append(value.length); append(':'); append(value) }
    if (ref.isPerson) {
        append("person:")
        val values = ref.identifiers.orEmpty().distinct().sortedWith(compareBy<FilterIdentifier> { it.type }.thenBy { it.value })
        append(values.size); append(':')
        values.forEach { field(it.type); field(it.value) }
    } else {
        append("item:")
        field(ref.capability); field(ref.field.orEmpty()); field(ref.device.orEmpty()); field(ref.id.orEmpty())
    }
}

/** Later page metadata replaces an earlier hint without changing its selector or row position. */
internal fun mergeFilterOptions(previous: List<FilterOption>, incoming: List<FilterOption>): List<FilterOption> =
    (previous + incoming).associateBy { filterRefKey(it.ref) }.values.toList()
