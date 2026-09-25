// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import androidx.compose.ui.graphics.Color
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.Annotation
import dev.omnesis.android.transport.dto.AnnotationsResponse
import dev.omnesis.android.transport.dto.DocumentAttachment
import dev.omnesis.android.transport.dto.DocumentDetail
import dev.omnesis.android.transport.dto.DocumentEventTrail
import dev.omnesis.android.transport.dto.DocumentNearDupes
import dev.omnesis.android.transport.dto.DocumentRefs
import dev.omnesis.android.transport.dto.PersonMention
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.AnnotationDependentsUi
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.appendUnique
import dev.omnesis.android.ui.sources.isNotesSource
import dev.omnesis.android.ui.sources.notesDayForDocument
import dev.omnesis.android.transport.dto.stableId
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Backs [DocumentDetailScreen]. Mirrors the iOS `DocumentDetailView.load()`: fetch the
 * doc first (so the body renders immediately), then fan out the secondary panels
 * concurrently — each swallowed on failure so the body still shows. The catalog resolves
 * every source's display name + icon up front so the composables never reach into the
 * registry themselves (the source-encapsulation rule).
 */
@HiltViewModel
class DocumentDetailViewModel @Inject constructor(
    private val session: SessionManager,
    val catalog: SourceCatalog,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val documentId: String = checkNotNull(savedStateHandle["id"]) { "missing document id" }

    /**
     * Everything the detail screen + inspector render, with source-display already
     * resolved. [sourceDisplay] is keyed by full sourceId so any row (inbound/near-dup/
     * person) can look up the human label + icon without touching the catalog.
     */
    data class DocumentBundle(
        val doc: DocumentDetail,
        val people: List<PersonMention> = emptyList(),
        val attachments: List<DocumentAttachment> = emptyList(),
        val refs: DocumentRefs? = null,
        val nearDupes: DocumentNearDupes? = null,
        // The agent's durable LLM observations grounded on this doc ("Enriched by Omnesis").
        // Empty when no observations exist or the endpoint is unavailable.
        val annotations: List<Annotation> = emptyList(),
        val outboundRefsPaging: CursorPagingState = CursorPagingState(),
        val inboundRefsPaging: CursorPagingState = CursorPagingState(),
        val nearDupesPaging: CursorPagingState = CursorPagingState(),
        /** Secondary graph endpoints are still resolving after the document body appears. */
        val graphLoading: Boolean = false,
        /** At least one graph endpoint failed, so an empty graph is not definitive. */
        val graphError: Throwable? = null,
        val annotationsPaging: CursorPagingState = CursorPagingState(),
        val annotationDependents: Map<String, AnnotationDependentsUi> = emptyMap(),
        val sourceDisplay: SourceDisplayLookup = SourceDisplayLookup.EMPTY,
    )

    /** Pre-resolved source display (label + icon + accent) for the sourceIds in the bundle. */
    data class SourceDisplayLookup(
        private val byId: Map<String, SourceDisplay> = emptyMap(),
    ) {
        operator fun get(sourceId: String): SourceDisplay = byId[sourceId] ?: SourceDisplay(
            label = sourceTypeFromId(sourceId),
            icon = SourceIconModel(fallbackInitial = sourceTypeFromId(sourceId).take(1)),
        )

        companion object {
            val EMPTY = SourceDisplayLookup()
        }
    }

    data class SourceDisplay(
        val label: String,
        val icon: SourceIconModel,
        val accent: Color? = null,
    )

    private val _state = MutableStateFlow<Loadable<DocumentBundle>>(Loadable.Loading)
    val state = _state.asStateFlow()
    private var generation = 0L

    // Single-document privacy delete in-flight / error state. Kept
    // separate from the loaded bundle so a failed delete leaves the document
    // on screen rather than replacing it with an error state.
    private val _deleting = MutableStateFlow(false)
    val deleting = _deleting.asStateFlow()
    private val _deleteError = MutableStateFlow<String?>(null)
    val deleteError = _deleteError.asStateFlow()

    init {
        load()
    }

    fun load() {
        val requestGeneration = ++generation
        _state.value = Loadable.Loading
        viewModelScope.launch {
            runCatching {
                val s = session.requireSession()
                val doc = s.search.document(documentId)
                if (requestGeneration != generation) return@launch
                // Show the body immediately, then enrich with the secondary panels.
                _state.value = Loadable.Content(
                    DocumentBundle(
                        doc = doc,
                        graphLoading = true,
                        sourceDisplay = resolveDisplay(setOf(doc.sourceId)),
                    ),
                )
                coroutineScope {
                    val peopleDeferred = async { runCatching { s.search.people(documentId) } }
                    val attachmentsDeferred = async { runCatching { s.search.attachments(documentId) } }
                    val refsDeferred = async { runCatching { s.search.refs(documentId) } }
                    val nearDupesDeferred = async { runCatching { s.search.nearDupes(documentId) } }
                    // Fetch alongside the other panels; older gateways may not expose annotations.
                    val annotationsDeferred = async {
                        runCatching { s.search.documentAnnotations(documentId) }
                            .getOrNull() ?: AnnotationsResponse()
                    }
                    val peopleResult = peopleDeferred.await()
                    val attachmentsResult = attachmentsDeferred.await()
                    val refsResult = refsDeferred.await()
                    val nearDupesResult = nearDupesDeferred.await()
                    val annotationPage = annotationsDeferred.await()
                    val people = peopleResult.getOrDefault(emptyList())
                    val attachments = attachmentsResult.getOrDefault(emptyList())
                    val refs = refsResult.getOrNull()
                    val nearDupes = nearDupesResult.getOrNull()
                    val graphError = sequenceOf(
                        peopleResult,
                        attachmentsResult,
                        refsResult,
                        nearDupesResult,
                    ).mapNotNull { it.exceptionOrNull() }.firstOrNull()
                    val sourceIds = buildSet {
                        add(doc.sourceId)
                        refs?.inbound?.forEach { add(it.sourceSourceId) }
                        refs?.outbound?.forEach { it.targetSourceId?.let(::add) }
                        nearDupes?.edges?.forEach { add(it.otherSourceId) }
                    }
                    DocumentBundle(
                        doc = doc,
                        people = people,
                        attachments = attachments,
                        refs = refs,
                        nearDupes = nearDupes,
                        annotations = annotationPage.annotations,
                        outboundRefsPaging = CursorPagingState(
                            nextCursor = refs?.outboundPageInfo?.nextCursor,
                        ),
                        inboundRefsPaging = CursorPagingState(
                            nextCursor = refs?.inboundPageInfo?.nextCursor,
                        ),
                        nearDupesPaging = CursorPagingState(nextCursor = nearDupes?.nextCursor),
                        graphLoading = false,
                        graphError = graphError,
                        annotationsPaging = CursorPagingState(
                            nextCursor = annotationPage.pageInfo.nextCursor,
                        ),
                        sourceDisplay = resolveDisplay(sourceIds),
                    )
                }
            }.fold(
                onSuccess = {
                    if (requestGeneration == generation) _state.value = Loadable.Content(it)
                },
                onFailure = {
                    if (requestGeneration == generation) _state.value = Loadable.Error(it)
                },
            )
        }
    }

    fun loadMoreOutboundRefs() = loadMoreRefs(outbound = true)

    fun loadMoreInboundRefs() = loadMoreRefs(outbound = false)

    private fun loadMoreRefs(outbound: Boolean) {
        val current = (_state.value as? Loadable.Content)?.value ?: return
        val paging = if (outbound) current.outboundRefsPaging else current.inboundRefsPaging
        val started = paging.beginLoadMore() ?: return
        val requestGeneration = generation
        updateBundle {
            if (outbound) it.copy(outboundRefsPaging = started.state)
            else it.copy(inboundRefsPaging = started.state)
        }
        viewModelScope.launch {
            runCatching {
                val search = session.requireSession().search
                if (outbound) {
                    search.outboundRefs(documentId, cursor = started.request.cursor)
                } else {
                    search.inboundRefs(documentId, cursor = started.request.cursor)
                }
            }.fold(
                onSuccess = { page ->
                    if (requestGeneration != generation) return@fold
                    updateBundle { latest ->
                        val refs = latest.refs ?: DocumentRefs()
                        if (outbound) {
                            @Suppress("UNCHECKED_CAST")
                            val incoming = page.items as List<dev.omnesis.android.transport.dto.OutboundRef>
                            val merged = appendUnique(refs.outbound, incoming) { it.stableId }
                            latest.copy(
                                refs = refs.copy(outbound = merged, outboundPageInfo = page.pageInfo),
                                outboundRefsPaging = latest.outboundRefsPaging.finishLoadMore(
                                    started.request,
                                    page.pageInfo.nextCursor,
                                    merged.size > refs.outbound.size,
                                ),
                                sourceDisplay = resolveDisplay(sourceIds(latest).apply {
                                    incoming.mapNotNullTo(this) { it.targetSourceId }
                                }),
                            )
                        } else {
                            @Suppress("UNCHECKED_CAST")
                            val incoming = page.items as List<dev.omnesis.android.transport.dto.InboundRef>
                            val merged = appendUnique(refs.inbound, incoming) { it.stableId }
                            latest.copy(
                                refs = refs.copy(inbound = merged, inboundPageInfo = page.pageInfo),
                                inboundRefsPaging = latest.inboundRefsPaging.finishLoadMore(
                                    started.request,
                                    page.pageInfo.nextCursor,
                                    merged.size > refs.inbound.size,
                                ),
                                sourceDisplay = resolveDisplay(sourceIds(latest).apply {
                                    incoming.mapTo(this) { it.sourceSourceId }
                                }),
                            )
                        }
                    }
                },
                onFailure = { error ->
                    if (requestGeneration != generation) return@fold
                    updateBundle {
                        if (outbound) {
                            it.copy(
                                outboundRefsPaging = it.outboundRefsPaging.failLoadMore(
                                    started.request,
                                    error,
                                ),
                            )
                        } else {
                            it.copy(
                                inboundRefsPaging = it.inboundRefsPaging.failLoadMore(
                                    started.request,
                                    error,
                                ),
                            )
                        }
                    }
                },
            )
        }
    }

    fun loadMoreNearDupes() {
        val current = (_state.value as? Loadable.Content)?.value ?: return
        val started = current.nearDupesPaging.beginLoadMore() ?: return
        val requestGeneration = generation
        updateBundle { it.copy(nearDupesPaging = started.state) }
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.nearDupes(
                    documentId,
                    cursor = started.request.cursor,
                )
            }.fold(
                onSuccess = { page ->
                    if (requestGeneration != generation) return@fold
                    updateBundle { latest ->
                        val existing = latest.nearDupes?.edges.orEmpty()
                        val merged = appendUnique(existing, page.edges) { it.otherDocId }
                        latest.copy(
                            nearDupes = page.copy(edges = merged),
                            nearDupesPaging = latest.nearDupesPaging.finishLoadMore(
                                started.request,
                                page.nextCursor,
                                merged.size > existing.size,
                            ),
                            sourceDisplay = resolveDisplay(sourceIds(latest).apply {
                                page.edges.mapTo(this) { it.otherSourceId }
                            }),
                        )
                    }
                },
                onFailure = { error ->
                    if (requestGeneration == generation) {
                        updateBundle {
                            it.copy(
                                nearDupesPaging = it.nearDupesPaging.failLoadMore(
                                    started.request,
                                    error,
                                ),
                            )
                        }
                    }
                },
            )
        }
    }

    fun loadMoreAnnotations() {
        val current = (_state.value as? Loadable.Content)?.value ?: return
        val started = current.annotationsPaging.beginLoadMore() ?: return
        val requestGeneration = generation
        updateBundle { it.copy(annotationsPaging = started.state) }
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.documentAnnotations(
                    documentId,
                    cursor = started.request.cursor,
                )
            }.fold(
                onSuccess = { page ->
                    if (requestGeneration != generation) return@fold
                    updateBundle { latest ->
                        val merged = appendUnique(latest.annotations, page.annotations) { it.id }
                        latest.copy(
                            annotations = merged,
                            annotationsPaging = latest.annotationsPaging.finishLoadMore(
                                started.request,
                                page.pageInfo.nextCursor,
                                merged.size > latest.annotations.size,
                            ),
                        )
                    }
                },
                onFailure = { error ->
                    if (requestGeneration == generation) {
                        updateBundle {
                            it.copy(
                                annotationsPaging = it.annotationsPaging.failLoadMore(
                                    started.request,
                                    error,
                                ),
                            )
                        }
                    }
                },
            )
        }
    }

    fun toggleAnnotationDependents(annotation: Annotation) {
        val bundle = (_state.value as? Loadable.Content)?.value ?: return
        val existing = bundle.annotationDependents[annotation.id]
        if (existing?.expanded == true) {
            updateAnnotationDependents(annotation.id, existing.copy(expanded = false))
            return
        }
        if (existing != null && existing.items.isNotEmpty()) {
            updateAnnotationDependents(annotation.id, existing.copy(expanded = true))
            return
        }
        loadAnnotationDependents(annotation, firstPage = true)
    }

    fun loadMoreAnnotationDependents(annotation: Annotation) {
        val current = (_state.value as? Loadable.Content)?.value ?: return
        val dependentState = current.annotationDependents[annotation.id] ?: return
        loadAnnotationDependents(
            annotation,
            firstPage = dependentState.shouldRetryFirstPage,
        )
    }

    private fun loadAnnotationDependents(annotation: Annotation, firstPage: Boolean) {
        val current = (_state.value as? Loadable.Content)?.value ?: return
        val dependentState = current.annotationDependents[annotation.id] ?: AnnotationDependentsUi()
        val started = if (firstPage) {
            dependentState.paging.beginRefresh()
        } else {
            dependentState.paging.beginLoadMore() ?: return
        }
        val requestGeneration = generation
        updateAnnotationDependents(
            annotation.id,
            dependentState.copy(
                expanded = true,
                loading = firstPage,
                paging = started.state,
            ),
        )
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.annotationDependents(
                    "doc",
                    annotation.id,
                    cursor = started.request.cursor,
                )
            }.fold(
                onSuccess = { page ->
                    if (requestGeneration != generation) return@fold
                    val latest = (_state.value as? Loadable.Content)?.value
                        ?.annotationDependents?.get(annotation.id) ?: return@fold
                    val items = if (firstPage) {
                        page.items
                    } else {
                        appendUnique(latest.items, page.items) { "${it.kind}:${it.id}" }
                    }
                    val paging = if (firstPage) {
                        latest.paging.finishRefresh(started.request, page.pageInfo.nextCursor)
                    } else {
                        latest.paging.finishLoadMore(
                            started.request,
                            page.pageInfo.nextCursor,
                            items.size > latest.items.size,
                        )
                    }
                    updateAnnotationDependents(
                        annotation.id,
                        latest.copy(loading = false, items = items, paging = paging),
                    )
                },
                onFailure = { error ->
                    if (requestGeneration != generation) return@fold
                    val latest = (_state.value as? Loadable.Content)?.value
                        ?.annotationDependents?.get(annotation.id) ?: return@fold
                    updateAnnotationDependents(
                        annotation.id,
                        latest.copy(
                            expanded = true,
                            loading = false,
                            paging = if (firstPage) {
                                latest.paging.failRefresh(started.request, error)
                            } else {
                                latest.paging.failLoadMore(started.request, error)
                            },
                        ),
                    )
                },
            )
        }
    }

    private fun updateAnnotationDependents(id: String, value: AnnotationDependentsUi) {
        updateBundle {
            it.copy(annotationDependents = it.annotationDependents + (id to value))
        }
    }

    private fun updateBundle(transform: (DocumentBundle) -> DocumentBundle) {
        val current = (_state.value as? Loadable.Content)?.value ?: return
        _state.value = Loadable.Content(transform(current))
    }

    private fun sourceIds(bundle: DocumentBundle): MutableSet<String> = buildSet {
        add(bundle.doc.sourceId)
        bundle.refs?.inbound?.forEach { add(it.sourceSourceId) }
        bundle.refs?.outbound?.forEach { it.targetSourceId?.let(::add) }
        bundle.nearDupes?.edges?.forEach { add(it.otherSourceId) }
    }.toMutableSet()

    /**
     * Fetch the document's event trail (`GET /documents/:id/trail`) for the inspector
     * Timeline tab — the same `EventTrail` shape the agent's `trace_connections` tool returns.
     * The Timeline renderer threads the decoded events into the spine; an empty trail or
     * a fetch miss both read as "nothing to thread".
     */
    suspend fun loadTrail(): DocumentEventTrail = session.requireSession().search.documentTrail(documentId)

    /**
     * Delete this document for privacy: for good by default, or only
     * this copy with [keepCopy] so the source may bring it back. On success the
     * screen pops via [onDone]; there's deliberately no reload (the document is
     * gone, so re-fetching would 404 into an error as the caller pops).
     */
    fun delete(keepCopy: Boolean, onDone: () -> Unit) {
        _deleting.value = true
        _deleteError.value = null
        viewModelScope.launch {
            runCatching { session.requireSession().search.deleteDocument(documentId, keepCopy) }.fold(
                onSuccess = {
                    _deleting.value = false
                    onDone()
                },
                onFailure = { err ->
                    _deleting.value = false
                    _deleteError.value = err.message ?: "Delete failed."
                },
            )
        }
    }

    fun clearDeleteError() {
        _deleteError.value = null
    }

    /**
     * Tell Omnesis URL for managing this daily document's original notes,
     * or null when the device is unpaired. The day seeds the history so a
     * link from an old daily document still lands on relevant notes.
     */
    fun manageNotesUrl(day: String?): String? =
        dev.omnesis.android.ui.sources.manageNotesUrl(session, day)

    /**
     * Tell Omnesis URL for this document, or null when it must not offer
     * the action: non-Notes sources (the link is Notes-specific), and
     * unpaired devices (no token to sign in with). Null hides the toolbar
     * button instead of leaving a dead one.
     */
    fun manageNotesUrlFor(doc: DocumentDetail): String? =
        if (!isNotesSource(doc.sourceId)) null
        else manageNotesUrl(notesDayForDocument(doc.externalId, doc.sourceCreatedAt))

    private fun resolveDisplay(sourceIds: Set<String>): SourceDisplayLookup =
        SourceDisplayLookup(
            sourceIds.filter { it.isNotBlank() }.associateWith { id ->
                SourceDisplay(
                    label = catalog.label(id),
                    icon = catalog.iconModel(id),
                    accent = catalog.accentColor(id),
                )
            },
        )
}
