// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.PeopleStats
import dev.omnesis.android.transport.dto.PersonSummary
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.reloading
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.appendUnique
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class PeopleViewModel @Inject constructor(
    private val session: SessionManager,
    private val catalog: SourceCatalog,
) : ViewModel() {

    /** Resolve a row's source-strip glyph generically via the catalog (no source branching). */
    fun iconFor(sourceId: String): SourceIconModel = catalog.iconModel(sourceId)

    data class State(
        val query: String = "",
        val people: Loadable<List<PersonSummary>> = Loadable.Loading,
        /** Summary counts for the two merge-shortcut buttons; null until first loaded. */
        val stats: PeopleStats? = null,
        val paging: CursorPagingState = CursorPagingState(),
    )

    private val _state = MutableStateFlow(State())
    val state = _state.asStateFlow()

    private var searchJob: Job? = null

    init {
        load()
        loadStats()
    }

    fun onQueryChange(query: String) {
        // Invalidate the old query immediately; its response must not repaint
        // beneath the new text during the debounce window.
        _state.update { it.copy(query = query, paging = it.paging.reset()) }
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(250) // debounce
            load()
        }
    }

    /** Reload the people list and the merge-shortcut counts together — used by
     *  pull-to-refresh and the error-state retry. The per-keystroke search path
     *  only reloads the list (see [onQueryChange]). */
    fun refresh() {
        load()
        loadStats()
    }

    fun load() {
        val query = _state.value.query.ifBlank { null }
        val started = _state.value.paging.beginRefresh()
        _state.update { it.copy(people = it.people.reloading(), paging = started.state) }
        viewModelScope.launch {
            runCatching { session.requireSession().search.peoplePage(query, limit = 50) }
                .fold(
                    onSuccess = { page ->
                        _state.update {
                            if (!it.paging.owns(started.request)) it
                            else it.copy(
                                people = Loadable.Content(page.items),
                                paging = it.paging.finishRefresh(started.request, page.pageInfo.nextCursor),
                            )
                        }
                    },
                    onFailure = { e ->
                        _state.update {
                            if (!it.paging.owns(started.request)) it
                            else it.copy(
                                people = Loadable.Error(e),
                                paging = it.paging.failRefresh(started.request),
                            )
                        }
                    },
                )
        }
    }

    fun loadMore() {
        val current = _state.value
        val people = (current.people as? Loadable.Content)?.value ?: return
        val started = current.paging.beginLoadMore() ?: return
        val query = current.query.ifBlank { null }
        _state.update { it.copy(paging = started.state) }
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.peoplePage(
                    query,
                    limit = 50,
                    cursor = started.request.cursor,
                )
            }.fold(
                onSuccess = { page ->
                    _state.update { latest ->
                        if (!latest.paging.owns(started.request)) return@update latest
                        val merged = appendUnique(people, page.items) { it.id }
                        latest.copy(
                            people = Loadable.Content(merged),
                            paging = latest.paging.finishLoadMore(
                                started.request,
                                page.pageInfo.nextCursor,
                                madeProgress = merged.size > people.size,
                            ),
                        )
                    }
                },
                onFailure = { error ->
                    _state.update {
                        it.copy(paging = it.paging.failLoadMore(started.request, error))
                    }
                },
            )
        }
    }

    /** Fetch the merge-shortcut counts. A failure leaves the buttons hidden
     *  rather than blocking the list (the list is the primary surface). */
    private fun loadStats() {
        viewModelScope.launch {
            runCatching { session.requireSession().search.peopleStats() }
                .onSuccess { s -> _state.update { it.copy(stats = s) } }
        }
    }
}
