// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.GatewayException
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
class MergeRulesViewModel @Inject constructor(
    private val session: SessionManager,
    private val catalog: SourceCatalog,
) : ViewModel() {

    /** Resolve a side's source-strip glyph generically via the catalog (no source branching). */
    fun iconFor(sourceId: String): SourceIconModel = catalog.iconModel(sourceId)

    private val _state = MutableStateFlow<Loadable<List<MergeIdentity>>>(Loadable.Loading)
    val state = _state.asStateFlow()
    private val _paging = MutableStateFlow(CursorPagingState())
    val paging = _paging.asStateFlow()
    private val _query = MutableStateFlow("")
    val query = _query.asStateFlow()
    private val _filter = MutableStateFlow(MergeTriggerFilter.ALL)
    val filter = _filter.asStateFlow()
    private var searchJob: Job? = null

    init {
        load()
    }

    fun load() {
        val started = _paging.value.beginRefresh()
        val query = _query.value
        val filter = _filter.value
        _paging.value = started.state
        _state.update { it.reloading() }
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.mergeRuleGroups(
                    limit = 25,
                    query = query,
                    kind = filter.kind,
                )
            }
                .fold(
                    onSuccess = { page ->
                        if (!_paging.value.owns(started.request)) return@fold
                        _state.value = Loadable.Content(page.items.map { MergeIdentity(it) })
                        _paging.value = _paging.value.finishRefresh(
                            started.request,
                            page.pageInfo.nextCursor,
                        )
                    },
                    onFailure = { error ->
                        if (!_paging.value.owns(started.request)) return@fold
                        if (error is GatewayException.NotFound) {
                            runCatching { session.requireSession().search.mergeRules() }.fold(
                                onSuccess = { rules ->
                                    if (!_paging.value.owns(started.request)) return@fold
                                    _state.value = Loadable.Content(
                                        MergeIdentity.build(rules, filter, query),
                                    )
                                    _paging.value = _paging.value.finishRefresh(started.request, null)
                                },
                                onFailure = { legacyError ->
                                    if (!_paging.value.owns(started.request)) return@fold
                                    _state.value = Loadable.Error(legacyError)
                                    _paging.value = _paging.value.failRefresh(started.request)
                                },
                            )
                        } else {
                            _state.value = Loadable.Error(error)
                            _paging.value = _paging.value.failRefresh(started.request)
                        }
                    },
                )
        }
    }

    fun onQueryChange(value: String) {
        _query.value = value
        _paging.value = _paging.value.reset()
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(250)
            load()
        }
    }

    fun onFilterChange(value: MergeTriggerFilter) {
        if (_filter.value == value) return
        _filter.value = value
        _paging.value = _paging.value.reset()
        searchJob?.cancel()
        load()
    }

    fun loadMore() {
        val current = (_state.value as? Loadable.Content)?.value ?: return
        val started = _paging.value.beginLoadMore() ?: return
        val query = _query.value
        val filter = _filter.value
        _paging.value = started.state
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.mergeRuleGroups(
                    limit = 25,
                    cursor = started.request.cursor,
                    query = query,
                    kind = filter.kind,
                )
            }.fold(
                onSuccess = { page ->
                    if (!_paging.value.owns(started.request)) return@fold
                    val merged = appendUnique(current, page.items.map { MergeIdentity(it) }) { it.id }
                    _state.value = Loadable.Content(merged)
                    _paging.value = _paging.value.finishLoadMore(
                        started.request,
                        page.pageInfo.nextCursor,
                        madeProgress = merged.size > current.size,
                    )
                },
                onFailure = {
                    _paging.value = _paging.value.failLoadMore(started.request, it)
                },
            )
        }
    }
}
