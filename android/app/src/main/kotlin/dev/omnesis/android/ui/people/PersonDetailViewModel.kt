// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.Annotation
import dev.omnesis.android.transport.dto.AnnotationsResponse
import dev.omnesis.android.transport.dto.PersonDetail
import dev.omnesis.android.transport.dto.PersonDocumentEntry
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.AnnotationDependentsUi
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.appendUnique
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

@HiltViewModel
class PersonDetailViewModel @Inject constructor(
    private val session: SessionManager,
    private val catalog: SourceCatalog,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    val personId: String = checkNotNull(savedStateHandle["id"]) { "missing person id" }

    /**
     * Canonical name of the tapped row, passed through nav so the header + top-app-bar title
     * populate instantly while the detail fetch is in flight (the iOS `presetName` pattern).
     * Empty when opened from a surface that has no name to hand (e.g. a graph row).
     */
    val presetName: String? = (savedStateHandle.get<String>("name"))?.takeIf { it.isNotBlank() }

    /** Resolve a merged-from row's source-strip glyph generically via the catalog. */
    fun iconFor(sourceId: String): SourceIconModel = catalog.iconModel(sourceId)

    /** A document linked to the person, enriched with its title/source for display. */
    data class DocRow(
        val id: String,
        val title: String,
        val sourceLabel: String,
        val icon: SourceIconModel,
        val roles: List<String>,
        val docTypeLabel: String? = null,
        val whenLabel: String? = null,
        val loaded: Boolean = true,
    )

    data class Content(
        val person: PersonDetail,
        val docs: List<DocRow>,
        val documentsPaging: CursorPagingState = CursorPagingState(),
        // The agent's durable LLM observations about this person (self = the user's "Profile").
        // Empty when no observations exist or the endpoint is unavailable.
        val annotations: List<Annotation> = emptyList(),
        val annotationsPaging: CursorPagingState = CursorPagingState(),
        val annotationDependents: Map<String, AnnotationDependentsUi> = emptyMap(),
    )

    private val _state = MutableStateFlow<Loadable<Content>>(Loadable.Loading)
    val state = _state.asStateFlow()

    private val pageSize = 30
    private val loaded = mutableListOf<DocRow>()
    private var generation = 0L

    init {
        load()
    }

    fun load() {
        val requestGeneration = ++generation
        _state.value = Loadable.Loading
        viewModelScope.launch {
            runCatching {
                val s = session.requireSession()
                coroutineScope {
                    val personDeferred = async { s.search.person(personId) }
                    val entriesDeferred = async { s.search.personDocuments(personId, pageSize, 0) }
                    // Fetch alongside the other panels; older gateways may not expose annotations.
                    val annotationsDeferred = async {
                        runCatching { s.search.personAnnotations(personId) }
                            .getOrNull() ?: AnnotationsResponse()
                    }
                    val person = personDeferred.await()
                    val entries = entriesDeferred.await()
                    val annotationPage = annotationsDeferred.await()
                    // Emit placeholder rows immediately (title "Loading…", neutral fallback glyph),
                    // then patch each as its document detail resolves — the iOS progressive-fill
                    // pattern, so rows appear instantly instead of after the whole batch awaits.
                    val placeholders = entries.map { placeholderRow(it) }
                    Content(
                        person,
                        placeholders,
                        documentsPaging = CursorPagingState(
                            nextCursor = personDocumentNextOffset(
                                offset = 0,
                                rawPageSize = entries.size,
                                pageSize = pageSize,
                            ),
                        ),
                        annotations = annotationPage.annotations,
                        annotationsPaging = CursorPagingState(
                            nextCursor = annotationPage.pageInfo.nextCursor,
                        ),
                    )
                }
            }.fold(
                onSuccess = { content ->
                    val committed = replaceInitialPersonDocumentPage(
                        requestGeneration = requestGeneration,
                        currentGeneration = generation,
                        loaded = loaded,
                        documents = content.docs,
                    )
                    if (!committed) return@fold
                    _state.value = Loadable.Content(content)
                    enrich(content.docs.filterNot { it.loaded }.map { it.id }, requestGeneration)
                },
                onFailure = {
                    if (requestGeneration == generation) _state.value = Loadable.Error(it)
                },
            )
        }
    }

    fun loadMoreAnnotations() {
        val current = (_state.value as? Loadable.Content)?.value ?: return
        val started = current.annotationsPaging.beginLoadMore() ?: return
        val requestGeneration = generation
        _state.value = Loadable.Content(current.copy(annotationsPaging = started.state))
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.personAnnotations(
                    personId,
                    cursor = started.request.cursor,
                )
            }.fold(
                onSuccess = { page ->
                    if (requestGeneration != generation) return@fold
                    val latest = (_state.value as? Loadable.Content)?.value ?: return@fold
                    if (!latest.annotationsPaging.owns(started.request)) return@fold
                    val merged = appendUnique(latest.annotations, page.annotations) { it.id }
                    _state.value = Loadable.Content(
                        latest.copy(
                            annotations = merged,
                            annotationsPaging = latest.annotationsPaging.finishLoadMore(
                                started.request,
                                page.pageInfo.nextCursor,
                                merged.size > latest.annotations.size,
                            ),
                        ),
                    )
                },
                onFailure = { error ->
                    if (requestGeneration != generation) return@fold
                    val latest = (_state.value as? Loadable.Content)?.value ?: return@fold
                    _state.value = Loadable.Content(
                        latest.copy(
                            annotationsPaging = latest.annotationsPaging.failLoadMore(
                                started.request,
                                error,
                            ),
                        ),
                    )
                },
            )
        }
    }

    fun toggleAnnotationDependents(annotation: Annotation) {
        val content = (_state.value as? Loadable.Content)?.value ?: return
        val existing = content.annotationDependents[annotation.id]
        if (existing?.expanded == true) {
            updateAnnotationDependents(annotation.id, existing.copy(expanded = false))
        } else if (existing != null && existing.items.isNotEmpty()) {
            updateAnnotationDependents(annotation.id, existing.copy(expanded = true))
        } else {
            loadAnnotationDependents(annotation, firstPage = true)
        }
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
            dependentState.copy(expanded = true, loading = firstPage, paging = started.state),
        )
        viewModelScope.launch {
            runCatching {
                session.requireSession().search.annotationDependents(
                    "person",
                    annotation.id,
                    cursor = started.request.cursor,
                )
            }.fold(
                onSuccess = { page ->
                    if (requestGeneration != generation) return@fold
                    val latest = (_state.value as? Loadable.Content)?.value
                        ?.annotationDependents?.get(annotation.id) ?: return@fold
                    val items = if (firstPage) page.items
                    else appendUnique(latest.items, page.items) { "${it.kind}:${it.id}" }
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
        val current = (_state.value as? Loadable.Content)?.value ?: return
        _state.value = Loadable.Content(
            current.copy(annotationDependents = current.annotationDependents + (id to value)),
        )
    }

    fun loadMore() {
        val current = (_state.value as? Loadable.Content)?.value ?: return
        val started = current.documentsPaging.beginLoadMore() ?: return
        val pageOffset = started.request.cursor?.toIntOrNull() ?: return
        val requestGeneration = generation
        _state.value = Loadable.Content(current.copy(documentsPaging = started.state))
        viewModelScope.launch {
            runCatching {
                val s = session.requireSession()
                val entries = s.search.personDocuments(personId, pageSize, pageOffset)
                if (requestGeneration != generation) return@launch
                val placeholders = entries.map { placeholderRow(it) }
                val known = loaded.asSequence().map { it.id }.toHashSet()
                val unique = placeholders.filter { known.add(it.id) }
                loaded.addAll(unique)
                PersonDocumentPageResult(
                    newDocuments = unique,
                    nextCursor = personDocumentNextOffset(
                        offset = pageOffset,
                        rawPageSize = entries.size,
                        pageSize = pageSize,
                    ),
                )
            }.fold(
                onSuccess = { page ->
                    if (requestGeneration != generation) return@fold
                    val latest = (_state.value as? Loadable.Content)?.value ?: return@fold
                    if (!latest.documentsPaging.owns(started.request)) return@fold
                    val content = mergePersonDocumentPage(
                        latest = latest,
                        docs = loaded.toList(),
                        paging = latest.documentsPaging.finishLoadMore(
                            started.request,
                            page.nextCursor,
                            madeProgress = page.newDocuments.isNotEmpty(),
                        ),
                    )
                    _state.value = Loadable.Content(content)
                    enrich(page.newDocuments.map { it.id }, requestGeneration)
                },
                onFailure = { error ->
                    if (requestGeneration == generation) {
                        val latest = (_state.value as? Loadable.Content)?.value ?: return@fold
                        _state.value = Loadable.Content(
                            latest.copy(
                                documentsPaging = latest.documentsPaging.failLoadMore(
                                    started.request,
                                    error,
                                ),
                            ),
                        )
                    }
                },
            )
        }
    }

    /** A not-yet-resolved row: "Loading…" title, neutral fallback icon. Mirrors iOS displayTitle. */
    private fun placeholderRow(entry: PersonDocumentEntry): DocRow = DocRow(
        id = entry.id,
        title = "Loading…",
        sourceLabel = "",
        icon = SourceIconModel(fallbackInitial = "?"),
        roles = entry.roles,
        loaded = false,
    )

    /**
     * Fetch each entry's document detail in parallel; as each resolves, patch the matching row
     * in place and re-emit, so the list fills progressively (the iOS docPreviews/loadDocPreviews
     * pattern) rather than waiting for the whole batch.
     */
    private fun enrich(ids: List<String>, requestGeneration: Long = generation) {
        if (ids.isEmpty()) return
        val s = session.requireSession()
        for (id in ids) {
            viewModelScope.launch {
                val doc = runCatching { s.search.document(id) }.getOrNull() ?: return@launch
                if (requestGeneration != generation) return@launch
                val sourceId = doc.sourceId
                val type = (doc.metadata as? JsonObject)?.get("documentType")?.jsonPrimitive?.contentOrNull
                val idx = loaded.indexOfFirst { it.id == id }
                if (idx < 0) return@launch
                val roles = loaded[idx].roles
                loaded[idx] = DocRow(
                    id = id,
                    title = doc.title?.takeIf { it.isNotBlank() } ?: "(untitled)",
                    // Source-FAMILY human name (e.g. "Gmail"), matching iOS humanName(for:
                    // sourceTypeFromId(...)) — not the per-instance "Gmail (work)" label.
                    sourceLabel = sourceId?.let { catalog.familyLabel(it) }.orEmpty(),
                    icon = sourceId?.let { catalog.iconModel(it) } ?: SourceIconModel(fallbackInitial = "?"),
                    roles = roles,
                    docTypeLabel = personDocTypeLabel(type),
                    whenLabel = personRelativeTime(doc.sourceCreatedAt),
                    loaded = true,
                )
                val current = (_state.value as? Loadable.Content)?.value ?: return@launch
                _state.value = Loadable.Content(current.copy(docs = loaded.toList()))
            }
        }
    }
}

/**
 * Commit one owned initial document page by replacement, never append.
 *
 * The network response is built entirely in request-local values. Only the
 * winning refresh calls this helper, so an older response cannot leave rows
 * or an offset behind for a newer refresh.
 */
internal fun replaceInitialPersonDocumentPage(
    requestGeneration: Long,
    currentGeneration: Long,
    loaded: MutableList<PersonDetailViewModel.DocRow>,
    documents: List<PersonDetailViewModel.DocRow>,
): Boolean {
    if (requestGeneration != currentGeneration) return false
    loaded.clear()
    loaded.addAll(documents)
    return true
}

/**
 * Apply only document-page fields to the latest content. Annotation/dependent requests can
 * complete while the page is in flight and must never be replaced by its request snapshot.
 */
internal fun mergePersonDocumentPage(
    latest: PersonDetailViewModel.Content,
    docs: List<PersonDetailViewModel.DocRow>,
    paging: CursorPagingState,
): PersonDetailViewModel.Content = latest.copy(
    docs = docs,
    documentsPaging = paging,
)

internal data class PersonDocumentPageResult(
    val newDocuments: List<PersonDetailViewModel.DocRow>,
    val nextCursor: String?,
)

internal fun personDocumentNextOffset(
    offset: Int,
    rawPageSize: Int,
    pageSize: Int,
): String? = if (rawPageSize == pageSize) (offset + rawPageSize).toString() else null
