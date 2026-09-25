// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.RecentDocument
import dev.omnesis.android.transport.dto.RecentItemsResponse
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.reloading
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.appendUnique
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class SourceRecentViewModel @Inject constructor(
    private val session: SessionManager,
    private val catalog: SourceCatalog,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    val sourceId: String = checkNotNull(savedStateHandle["id"]) { "missing source id" }
    val label: String get() = catalog.label(sourceId)

    /** Brand icon for a recent row, resolved generically from its `sourceId` via the catalog. */
    fun iconFor(rowSourceId: String): SourceIconModel = catalog.iconModel(rowSourceId)

    private val _state = MutableStateFlow<Loadable<RecentItemsResponse>>(Loadable.Loading)
    val state = _state.asStateFlow()
    private val _paging = MutableStateFlow(CursorPagingState())
    val paging = _paging.asStateFlow()
    /**
     * Whether this is a gateway-internal source (a dataset the gateway hosts itself):
     * internal rows offer Manage notes instead of delete. Resolved alongside
     * the recent fetch.
     */
    private val _isInternal = MutableStateFlow(false)
    val isInternal = _isInternal.asStateFlow()

    // Single-document privacy delete (#1065) error surface; null = no error.
    private val _deleteError = MutableStateFlow<String?>(null)
    val deleteError = _deleteError.asStateFlow()

    init {
        load()
    }

    fun load() {
        val started = _paging.value.beginRefresh()
        _paging.value = started.state
        _state.value = _state.value.reloading()
        viewModelScope.launch {
            runCatching {
                val s = session.requireSession()
                // Ensure brand-icon metadata is present so each row's source icon resolves
                // (the catalog is a shared singleton; loading is idempotent and cheap when warm).
                runCatching { catalog.load(s.admin) }
                val listed = runCatching { s.admin.sourcesAndInternal() }.getOrNull()
                val page = s.search.recent(sourceId, limit = 30)
                _isInternal.value = resolveRecentInternal(
                    sourceId = sourceId,
                    envelopeInternal = page.isInternal,
                    registeredIds = listed?.first?.map { it.id } ?: emptyList(),
                    internalIds = listed?.second?.map { it.id } ?: emptyList(),
                )
                page
            }.fold(
                onSuccess = {
                    if (!_paging.value.owns(started.request)) return@fold
                    _state.value = Loadable.Content(it)
                    _paging.value = _paging.value.finishRefresh(started.request, it.pageInfo.nextCursor)
                },
                onFailure = {
                    if (!_paging.value.owns(started.request)) return@fold
                    _state.value = Loadable.Error(it)
                    _paging.value = _paging.value.failRefresh(started.request)
                },
            )
        }
    }

    fun loadMore() {
        if ((_state.value as? Loadable.Content)?.value == null) return
        val started = _paging.value.beginLoadMore() ?: return
        _paging.value = started.state
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.recent(
                    sourceId,
                    limit = 30,
                    cursor = started.request.cursor,
                )
            }.fold(
                onSuccess = { incoming ->
                    if (!_paging.value.owns(started.request)) return@fold
                    val latest = (_state.value as? Loadable.Content)?.value ?: return@fold
                    val merged = mergeRecentPage(latest, incoming)
                    val before = when (latest) {
                        is RecentItemsResponse.Documents -> latest.documents.size
                        is RecentItemsResponse.Analytics -> latest.rows.size
                        is RecentItemsResponse.Empty -> 0
                    }
                    val after = when (merged) {
                        is RecentItemsResponse.Documents -> merged.documents.size
                        is RecentItemsResponse.Analytics -> merged.rows.size
                        is RecentItemsResponse.Empty -> 0
                    }
                    _state.value = Loadable.Content(merged)
                    _paging.value = _paging.value.finishLoadMore(
                        started.request,
                        incoming.pageInfo.nextCursor,
                        madeProgress = after > before,
                    )
                },
                onFailure = {
                    _paging.value = _paging.value.failLoadMore(started.request, it)
                },
            )
        }
    }

    /**
     * Delete a recent-list document (#1065) — for good, or only this copy with
     * [keepCopy] — dropping its row in place.
     */
    fun delete(doc: RecentDocument, keepCopy: Boolean) {
        viewModelScope.launch {
            runCatching { session.requireSession().search.deleteDocument(doc.id, keepCopy) }.fold(
                onSuccess = { removeRow(doc.id) },
                onFailure = { err -> _deleteError.value = err.message ?: "Delete failed." },
            )
        }
    }

    fun clearDeleteError() {
        _deleteError.value = null
    }

    /**
     * Tell Omnesis URL for managing a daily document's original notes, or
     * null when the device is unpaired. The day seeds the history so a
     * link from an old daily document still lands on relevant notes.
     */
    fun manageNotesUrl(day: String?): String? = manageNotesUrl(session, day)

    /**
     * Tell Omnesis URL for one recent row, or null when the row must not
     * offer the action: non-Notes sources (the link is Notes-specific),
     * and unpaired devices (no token to sign in with). Null hides the
     * row button instead of leaving a dead one.
     */
    fun manageNotesUrlFor(doc: RecentDocument): String? =
        if (!isNotesSource(doc.sourceId)) null
        else manageNotesUrl(notesDayForDocument(doc.externalId, doc.sourceCreatedAt))

    private fun removeRow(id: String) {
        val current = _state.value
        if (current is Loadable.Content) {
            val r = current.value
            if (r is RecentItemsResponse.Documents) {
                // Invalidate a page that may already contain this row in its response. Otherwise
                // its stale completion can resurrect the successfully deleted document.
                _paging.value = _paging.value.reset(_paging.value.nextCursor)
                _state.value = Loadable.Content(removeRecentDocument(r, id))
            }
        }
    }
}

/**
 * Whether the recent screen treats this source as gateway-internal (single
 * delete action). The recent envelope's flag wins; the sources list is the
 * fallback for older gateways. A registered row of the same id always wins
 * over an internal entry, matching every other client.
 */
internal fun resolveRecentInternal(
    sourceId: String,
    envelopeInternal: Boolean,
    registeredIds: List<String>,
    internalIds: List<String>,
): Boolean =
    envelopeInternal ||
        (internalIds.any { it == sourceId } && registeredIds.none { it == sourceId })

internal fun mergeRecentPage(
    current: RecentItemsResponse,
    incoming: RecentItemsResponse,
): RecentItemsResponse = when {
    current is RecentItemsResponse.Documents && incoming is RecentItemsResponse.Documents ->
        RecentItemsResponse.Documents(
            appendUnique(current.documents, incoming.documents) { it.id },
            incoming.pageInfo,
            isInternal = incoming.isInternal,
        )
    current is RecentItemsResponse.Analytics &&
        incoming is RecentItemsResponse.Analytics &&
        current.table == incoming.table &&
        current.columns == incoming.columns ->
        current.copy(
            rows = current.rows + incoming.rows,
            pageInfo = incoming.pageInfo,
            isInternal = incoming.isInternal,
        )
    // Any other combination means the source changed projection while the
    // screen was open (documents arriving, analytics replacing documents,
    // or a schema change). Adopt the server's new shape: keeping the stale
    // one would freeze the screen until reload, and concatenating across
    // different shapes misaligns rows. Mirrors the iOS recent view.
    else -> incoming
}

internal fun removeRecentDocument(
    current: RecentItemsResponse.Documents,
    id: String,
): RecentItemsResponse.Documents = current.copy(
    documents = current.documents.filterNot { it.id == id },
)
