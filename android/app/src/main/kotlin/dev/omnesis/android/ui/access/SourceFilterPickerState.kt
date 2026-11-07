// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.*
import dev.omnesis.android.transport.dto.*

/** Kept above the picker so returning from review retains the exact search and folder location. */
internal class SourceFilterPickerState(initialKind: String, initialIdentifier: String) {
    var kind by mutableStateOf(initialKind)
    var query by mutableStateOf("")
    var ancestors by mutableStateOf<List<ScopeOption>>(emptyList())
    var cursor by mutableStateOf<String?>(null)
    var options by mutableStateOf<ScopeOptions?>(null)
    var error by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
    var retry by mutableIntStateOf(0)
    var request: Any? = null
    var enteringIdentifier by mutableStateOf(false)
    var identifierType by mutableStateOf(initialIdentifier)
    var typed by mutableStateOf("")
    val listState = LazyListState()
    var location: Triple<String, String, String?>? = null
    val parent: String? get() = ancestors.lastOrNull()?.ref?.id
    fun chooseKind(value: String) {
        kind = value; query = ""; ancestors = emptyList(); cursor = null; enteringIdentifier = false
    }
    fun open(folder: ScopeOption) { ancestors = ancestors + folder; query = ""; cursor = null }
    fun goToAncestor(index: Int) { ancestors = ancestors.take(index + 1); query = ""; cursor = null }
}
