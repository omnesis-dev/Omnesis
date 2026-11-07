// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.*
import dev.omnesis.android.transport.dto.*

/** Display/navigation hints only. Every Apply still requires a fresh exact-policy preview. */
internal class SourceFilterPickerState(initialKind: String, initialIdentifier: String) {
    internal data class Location(val kind: String, val query: String, val trail: List<String>)
    internal class Page {
        var cursor by mutableStateOf<String?>(null)
        var options by mutableStateOf<ScopeOptions?>(null)
        var error by mutableStateOf<String?>(null)
        var loading by mutableStateOf(false)
        var retry by mutableIntStateOf(0)
        var loaded = false
        var loadedCursor: String? = null
        var request: Any? = null
        val listState = LazyListState()
    }
    private val pages = mutableMapOf<Location, Page>()
    private val kindLocations = mutableMapOf<String, Pair<String, List<ScopeOption>>>()
    private val trailQueries = mutableMapOf<Pair<String, List<String>>, String>()
    var kind by mutableStateOf(initialKind)
    var query by mutableStateOf("")
    var ancestors by mutableStateOf<List<ScopeOption>>(emptyList())
    val location get() = Location(kind, query, ancestors.map { scopeRefKey(it.ref) })
    val page get() = pages.getOrPut(location) { Page() }
    val options get() = page.options
    val error get() = page.error
    val loading get() = page.loading
    val listState get() = page.listState
    var enteringIdentifier by mutableStateOf(false)
    var identifierType by mutableStateOf(initialIdentifier)
    var typed by mutableStateOf("")
    val parent: String? get() = ancestors.lastOrNull()?.ref?.id
    fun chooseKind(value: String) {
        if (value == kind) return
        kindLocations[kind] = query to ancestors
        val target = kindLocations[value]
        kind = value; query = target?.first.orEmpty(); ancestors = target?.second.orEmpty(); enteringIdentifier = false
    }
    private fun moveTo(trail: List<ScopeOption>) {
        trailQueries[kind to ancestors.map { scopeRefKey(it.ref) }] = query
        ancestors = trail
        query = trailQueries[kind to trail.map { scopeRefKey(it.ref) }].orEmpty()
    }
    fun open(folder: ScopeOption) = moveTo(ancestors + folder)
    fun goToAncestor(index: Int) = moveTo(ancestors.take(index + 1))
    fun refresh() {
        page.apply { cursor = null; options = null; loaded = false; error = null; retry++ }
    }
}
