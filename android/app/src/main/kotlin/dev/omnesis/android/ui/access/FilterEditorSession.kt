// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** What the session has learnt about an entry from the choices and previews it read: its full name and its depth in its tree. */
internal data class FilterEntryHint(val label: String, val depth: Int? = null)

/**
 * One editing session's view of the gateway: at most two requests in flight, and what the responses taught about
 * each account (its fields) and each entry (its name and depth), so every screen of the session names and captions
 * entries alike. Hints are presentation only; counts and states always come from a fresh response.
 */
internal class FilterEditorSession(private val delegate: FilterEditorGateway) : FilterEditorGateway {
    private val admission = Semaphore(2)
    private val mutableHints = MutableStateFlow<Map<Pair<String, String>, FilterEntryHint>>(emptyMap())
    private val mutableEditors = MutableStateFlow<Map<String, FilterEditor>>(emptyMap())
    val hints = mutableHints.asStateFlow()
    /** The latest editor response of each account this session read. */
    val editors = mutableEditors.asStateFlow()
    fun label(sourceId: String, ref: FilterRef): String? = hints.value[sourceId to filterRefKey(ref)]?.label ?: ref.label
    private fun remember(sourceId: String, values: List<Pair<FilterRef, FilterEntryHint>>) {
        mutableHints.update { previous ->
            previous + values.associate { (ref, hint) ->
                val key = sourceId to filterRefKey(ref)
                key to hint.copy(depth = hint.depth ?: previous[key]?.depth)
            }
        }
    }
    private suspend fun <T> admitted(call: suspend () -> T): T = admission.withPermit { withContext(NonCancellable) { call() } }

    override suspend fun editor(sourceId: String): FilterEditor = admitted { delegate.editor(sourceId) }.also { result ->
        check(result.sourceId == sourceId) { "The filter belongs to another source. Reopen this filter." }
        mutableEditors.update { it + (sourceId to result) }
    }
    override suspend fun preview(policy: SourceFilter): FilterPreview = admitted { delegate.preview(policy) }.also { result ->
        check(result.pending || result.sourceId == policy.sourceId) { "The preview belongs to another source. Reopen this filter." }
        remember(policy.sourceId, result.items.filter { it.missing != true }.map { it.ref to FilterEntryHint(it.label, it.depth) })
    }
    override suspend fun options(sourceId: String, field: String, query: String, parentId: String?, device: String?, cursor: String?): FilterOptions =
        admitted { delegate.options(sourceId, field, query, parentId, device, cursor) }.also { result ->
            check(result.sourceId == sourceId) { "The choices belong to another source. Reopen this filter." }
            remember(sourceId, result.items.map { it.ref to FilterEntryHint(it.label, it.depth) })
        }
    override suspend fun identifier(type: String, value: String): FilterIdentifierCheck = admitted { delegate.identifier(type, value) }
    override suspend fun resync(sourceId: String) = admitted { delegate.resync(sourceId) }
}

/** This gateway behind one session, so every screen of an editor shares the hints and the admission it holds. */
internal fun FilterEditorGateway.editorSession(): FilterEditorSession = this as? FilterEditorSession ?: FilterEditorSession(this)
