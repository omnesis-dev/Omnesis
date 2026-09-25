// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.MergeCandidatesResponse
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.reloading
import dev.omnesis.android.ui.common.appendUnique
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Drives the merge-candidate review queue. Holds the loaded page; the merge /
 * dismiss mutations are suspend functions the Content composable awaits, then
 * the VM reloads so the collapsed cluster drops out.
 */
@HiltViewModel
class MergeCandidatesViewModel @Inject constructor(
    private val session: SessionManager,
    private val catalog: SourceCatalog,
) : ViewModel() {

    /** Resolve a member's source-strip glyph generically via the catalog (no source branching). */
    fun iconFor(sourceId: String): SourceIconModel = catalog.iconModel(sourceId)

    private val _state = MutableStateFlow<Loadable<MergeCandidatesResponse>>(Loadable.Loading)
    val state = _state.asStateFlow()

    // Pending / Denied filter — switching it refetches, since each status is a
    // distinct gateway query.
    private val _status = MutableStateFlow(MergeCandidateStatus.PENDING)
    val status = _status.asStateFlow()
    private val _query = MutableStateFlow("")
    val query = _query.asStateFlow()
    private val _paging = MutableStateFlow(CursorPagingState())
    val paging = _paging.asStateFlow()
    private var searchJob: Job? = null

    init {
        load()
    }

    fun setStatus(next: MergeCandidateStatus) {
        if (_status.value == next) return
        _status.value = next
        _paging.value = _paging.value.reset()
        load()
    }

    fun load() {
        val started = _paging.value.beginRefresh()
        val status = _status.value
        val query = _query.value
        _paging.value = started.state
        _state.update { it.reloading() }
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.mergeCandidates(
                    status = status.wire,
                    clusterLimit = 25,
                    query = query,
                )
            }
                .fold(
                    onSuccess = { page ->
                        if (!_paging.value.owns(started.request)) return@fold
                        _state.update { Loadable.Content(page) }
                        _paging.value = _paging.value.finishRefresh(
                            started.request,
                            page.pageInfo.nextCursor,
                        )
                    },
                    onFailure = { e ->
                        if (!_paging.value.owns(started.request)) return@fold
                        _state.update { Loadable.Error(e) }
                        _paging.value = _paging.value.failRefresh(started.request)
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

    fun loadMore() {
        val current = (_state.value as? Loadable.Content)?.value ?: return
        val started = _paging.value.beginLoadMore() ?: return
        val status = _status.value
        val query = _query.value
        _paging.value = started.state
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.mergeCandidates(
                    status = status.wire,
                    clusterLimit = 25,
                    cursor = started.request.cursor,
                    query = query,
                )
            }.fold(
                onSuccess = { page ->
                    if (!_paging.value.owns(started.request)) return@fold
                    val merged = appendUnique(current.items, page.items) { it.id }
                    _state.value = Loadable.Content(page.copy(items = merged))
                    _paging.value = _paging.value.finishLoadMore(
                        started.request,
                        page.pageInfo.nextCursor,
                        madeProgress = merged.size > current.items.size,
                    )
                },
                onFailure = {
                    _paging.value = _paging.value.failLoadMore(started.request, it)
                },
            )
        }
    }

    /** Merge the checked members of a cluster, then reload. Throws on failure. */
    suspend fun merge(personIds: List<String>): Int {
        val result = session.requireSession().search.mergeCluster(personIds)
        reload()
        return result.rulesCreated
    }

    /** Deny every candidate in a cluster, then reload. Throws on failure. */
    suspend fun dismiss(candidateIds: List<String>) {
        val search = session.requireSession().search
        for (id in candidateIds) search.denyMergeCandidate(id)
        reload()
    }

    private suspend fun reload() {
        val started = _paging.value.beginRefresh()
        val status = _status.value
        val query = _query.value
        _paging.value = started.state
        runCatching {
            session.requireSession().search.mergeCandidates(
                status = status.wire,
                clusterLimit = 25,
                query = query,
            )
        }.fold(
            onSuccess = { page ->
                if (!_paging.value.owns(started.request)) return@fold
                _state.update { Loadable.Content(page) }
                _paging.value = _paging.value.finishRefresh(started.request, page.pageInfo.nextCursor)
            },
            onFailure = {
                _paging.value = _paging.value.failRefresh(started.request)
            },
        )
    }
}
