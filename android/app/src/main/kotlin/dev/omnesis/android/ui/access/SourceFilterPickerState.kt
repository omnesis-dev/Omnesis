// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.*
import dev.omnesis.android.transport.dto.*

/** Where the picker is and what it has listed. Navigation hints only: applying a filter still needs a fresh preview of that exact filter. */
internal class SourceFilterPickerState(initialField: String = "", initialIdentifier: String = "") {
    internal data class Location(val field: String, val query: String, val trail: List<String>)
    internal class Page {
        var cursor by mutableStateOf<String?>(null)
        var options by mutableStateOf<FilterOptions?>(null)
        var error by mutableStateOf<String?>(null)
        var loading by mutableStateOf(false)
        var retry by mutableIntStateOf(0)
        /** Raised to read the first page again without dropping what is listed; [polled] is the last raise that was served. */
        var poll by mutableIntStateOf(0)
        var polled = 0
        var loaded = false
        var loadedCursor: String? = null
        var request: Any? = null
        val listState = LazyListState()
    }
    private val pages = mutableMapOf<Location, Page>()
    private val fieldLocations = mutableMapOf<String, Pair<String, List<FilterOption>>>()
    private val trailQueries = mutableMapOf<Pair<String, List<String>>, String>()
    var field by mutableStateOf(initialField)
    var query by mutableStateOf("")
    var ancestors by mutableStateOf<List<FilterOption>>(emptyList())
    val location get() = Location(field, query, ancestors.map { filterRefKey(it.ref) })
    val page get() = pages.getOrPut(location) { Page() }
    val options get() = page.options
    val error get() = page.error
    val loading get() = page.loading
    val listState get() = page.listState
    var enteringIdentifier by mutableStateOf(false)
    var identifierType by mutableStateOf(initialIdentifier)
    var typed by mutableStateOf("")
    /** What the gateway said of the address last typed, until the text changes. */
    var identifierError by mutableStateOf<String?>(null)
    /** The item whose children are listed; null at the top, and at a device of a per-device tree. */
    val parent: String? get() = ancestors.lastOrNull()?.ref?.id?.takeIf { it.isNotEmpty() }
    /** The device whose tree is listed, once one is opened. */
    val device: String? get() = ancestors.firstNotNullOfOrNull { it.ref.device }
    /** The opened item, whose own row ("Select this folder") stands above its children; null at the top. */
    val current: FilterOption? get() = ancestors.lastOrNull()
    /** The listing the opened item itself appears in: its parent's id and device. */
    val currentParent: Pair<String?, String?> get() = ancestors.dropLast(1).let { trail ->
        trail.lastOrNull()?.ref?.id?.takeIf { it.isNotEmpty() } to trail.firstNotNullOfOrNull { it.ref.device }
    }
    /** Counts read since an item was opened, by entry key: an opened item keeps the count it had then until one arrives. */
    private val counts = mutableStateMapOf<String, Long>()
    fun learnCounts(items: List<FilterOption>) = items.forEach { item -> item.count?.let { counts[filterRefKey(item.ref)] = it } }
    /** The count of [option], or the one read for it since it was listed. */
    fun countOf(option: FilterOption): Long? = option.count ?: counts[filterRefKey(option.ref)]
    fun chooseField(value: String) {
        if (value == field) return
        fieldLocations[field] = query to ancestors
        val target = fieldLocations[value]
        field = value; query = target?.first.orEmpty(); ancestors = target?.second.orEmpty(); enteringIdentifier = false
    }
    /** Starts on the first of [fields], unless the picker already stands on one of them. */
    fun settle(fields: List<FilterEditorField>) {
        if (fields.none { it.field == field }) fields.firstOrNull()?.let { field = it.field; query = ""; ancestors = emptyList() }
    }
    private fun moveTo(trail: List<FilterOption>) {
        trailQueries[field to ancestors.map { filterRefKey(it.ref) }] = query
        ancestors = trail
        query = trailQueries[field to trail.map { filterRefKey(it.ref) }].orEmpty()
    }
    fun open(folder: FilterOption) = moveTo(ancestors + folder)
    fun goToAncestor(index: Int) = moveTo(ancestors.take(index + 1))
}

/** The picker of each filter opened on one draft, so reopening an account's filter returns to where it was left. */
internal class SourceFilterNavigation {
    private val pickers = mutableMapOf<Pair<String, AccessCapability>, SourceFilterPickerState>()
    fun of(source: AccessSourceInstance, capability: AccessCapability): SourceFilterPickerState =
        pickers.getOrPut(source.id to capability) { SourceFilterPickerState() }
}
