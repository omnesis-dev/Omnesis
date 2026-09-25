// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.search

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.SearchResponse
import dev.omnesis.android.transport.dto.SearchResultItem
import dev.omnesis.android.ui.common.classifyGatewayError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class SearchViewModel @Inject constructor(
    private val session: SessionManager,
    val catalog: SourceCatalog,
    private val launchBus: SearchLaunchBus,
) : ViewModel() {

    sealed interface Status {
        data object Idle : Status
        data object Loading : Status

        /**
         * A completed search. [items] + [tookMs] are the at-a-glance summary; [response]
         * carries the full payload (stages/timing/debug) so the pipeline footer can render.
         * [response] is nullable so lightweight previews can build a results state from items
         * alone.
         */
        data class Results(
            val items: List<SearchResultItem>,
            val tookMs: Double?,
            val response: SearchResponse? = null,
            /**
             * A re-run of this same query is in flight and the results below are the previous
             * ones. Only a re-run keeps them: a *new* query's old results answer a different
             * question, so that still clears to [Loading].
             */
            val refreshing: Boolean = false,
        ) : Status

        data class Failed(val message: String) : Status
    }

    data class State(
        val query: String = "",
        val status: Status = Status.Idle,
        val hasSearched: Boolean = false,
        val lastQuery: String = "",
    )

    private val _state = MutableStateFlow(State())
    val state = _state.asStateFlow()
    private val resultFence = SearchResultFence()

    init {
        viewModelScope.launch {
            launchBus.request.filterNotNull().collect { request ->
                onQueryChange(request.query)
                search()
                launchBus.consume(request)
            }
        }
    }

    fun onQueryChange(v: String) {
        if (_state.value.query != v) resultFence.invalidate()
        _state.update { searchStateAfterQueryEdit(it, v) }
    }

    fun onClear() {
        resultFence.invalidate()
        _state.update {
            it.copy(query = "", status = Status.Idle, hasSearched = false, lastQuery = "")
        }
    }

    fun search() {
        val s = _state.value
        val trimmed = s.query.trim()
        if (trimmed.isBlank()) return
        val previous = s.status
        val isRerun = previous is Status.Results && trimmed == s.lastQuery
        val generation = resultFence.begin()
        _state.update {
            it.copy(
                status = if (isRerun) {
                    (previous as Status.Results).copy(refreshing = true)
                } else {
                    Status.Loading
                },
                hasSearched = true,
                lastQuery = trimmed,
            )
        }
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.search(
                    text = trimmed,
                    limit = 30,
                    verbose = true,
                )
            }.fold(
                onSuccess = { resp ->
                    if (!resultFence.isCurrent(generation)) return@fold
                    _state.update {
                        it.copy(status = Status.Results(resp.results, resp.timing?.totalMs, resp))
                    }
                },
                onFailure = { e ->
                    if (!resultFence.isCurrent(generation)) return@fold
                    _state.update { it.copy(status = Status.Failed(classifyGatewayError(e))) }
                },
            )
        }
    }
}

/** Keeps late responses from an older manual/App Actions query from replacing newer results. */
internal class SearchResultFence {
    private var generation = 0L

    fun begin(): Long = ++generation
    fun invalidate() {
        generation++
    }
    fun isCurrent(candidate: Long): Boolean = candidate == generation
}

internal fun searchStateAfterQueryEdit(
    state: SearchViewModel.State,
    query: String,
): SearchViewModel.State = if (state.status is SearchViewModel.Status.Loading && state.query != query) {
    state.copy(query = query, status = SearchViewModel.Status.Idle, hasSearched = false)
} else {
    state.copy(query = query)
}
