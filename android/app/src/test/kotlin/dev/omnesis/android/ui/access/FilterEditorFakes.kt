// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*

/** One options request as the editor sends it. */
internal data class FilterOptionsRequest(val sourceId: String, val field: String, val query: String, val parentId: String?, val device: String?, val cursor: String?)

/** A gateway for filter editor tests: each call answers through its lambda, and every resync asked for is recorded. */
internal class FakeFilterGateway(
    private val editorFor: suspend (String) -> FilterEditor = { error("No editor expected") },
    private val optionsFor: suspend (FilterOptionsRequest) -> FilterOptions = { FilterOptions(it.sourceId, it.field) },
    private val previewFor: suspend (SourceFilter) -> FilterPreview = { error("No preview expected") },
    private val identifierFor: suspend (String, String) -> FilterIdentifierCheck = { _, _ -> error("No address check expected") },
) : FilterEditorGateway {
    val resynced = mutableListOf<String>()
    val optionRequests = mutableListOf<FilterOptionsRequest>()
    var editorReads = 0
        private set
    override suspend fun editor(sourceId: String): FilterEditor { editorReads++; return editorFor(sourceId) }
    override suspend fun options(sourceId: String, field: String, query: String, parentId: String?, device: String?, cursor: String?): FilterOptions =
        FilterOptionsRequest(sourceId, field, query, parentId, device, cursor).also { optionRequests += it }.let { optionsFor(it) }
    override suspend fun preview(policy: SourceFilter): FilterPreview { assertProviderWirePolicy(policy); return previewFor(policy) }
    override suspend fun identifier(type: String, value: String): FilterIdentifierCheck = identifierFor(type, value)
    override suspend fun resync(sourceId: String) { resynced += sourceId }
}

/** A field of [capability] that takes entries now. */
internal fun readyField(
    field: String, capability: String, one: String, many: String, picker: String = "search", identifiers: List<String>? = null,
    levels: List<FilterNoun>? = null, insideText: String? = null, scope: String = "global",
) = FilterEditorField(field, capability, FilterNoun(one, many), levels = levels, inside = insideText?.let { FilterNoun(one, many) }, insideText = insideText,
    picker = picker, scope = scope, identifiers = identifiers, state = FilterFieldState(FilterFieldState.READY),
    counts = FilterHiddenCounts("ready"))

/** The people field of a source whose typed addresses may be [identifiers]. */
internal fun peopleField(vararg identifiers: String) = readyField(FilterRef.PEOPLE_FIELD, FilterRef.PERSON, "person", "people", identifiers = identifiers.toList())

/** A counted preview: [visible] of [total] shared, each entry counted as [count] says. */
internal fun readyPreview(
    sourceId: String, total: Long, visible: Long, items: List<FilterPreviewItem> = emptyList(),
    tooOldText: String? = null, unmatchedText: String? = null,
) = FilterPreview("ready", sourceId = sourceId, total = total, visible = visible, hidden = total - visible, items = items,
    tooOld = if (tooOldText != null) 1 else 0, unmatched = if (unmatchedText != null) 1 else 0, tooOldText = tooOldText, unmatchedText = unmatchedText)

/** A preview still being counted. */
internal fun pendingPreview(retryAfterMs: Long = ACCESS_REFRESH_INTERVAL_MILLIS) = FilterPreview("pending", retryAfterMs = retryAfterMs)
