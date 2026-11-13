// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*

/** Stable authority identity. Names are hints; a new captured identifier is a new selection. */
internal fun scopeRefKey(ref: ScopeRef): String = buildString {
    fun field(value: String) { append(value.length); append(':'); append(value) }
    field(ref.kind)
    val captured = ref.identifiers
    if (captured != null) {
        append("identifiers:")
        val values = captured.distinct().sortedWith(compareBy<ScopeIdentifier> { it.type }.thenBy { it.value })
        append(values.size); append(':')
        values.forEach { field(it.type); field(it.value) }
    } else {
        append("id:"); field(ref.id.orEmpty())
    }
}

/** Later page metadata replaces an earlier hint without changing its selector or row position. */
internal fun mergeScopeOptions(previous: List<ScopeOption>, incoming: List<ScopeOption>): List<ScopeOption> =
    (previous + incoming).associateBy { scopeRefKey(it.ref) }.values.toList()
