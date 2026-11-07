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

/** Labels are presentation-only; counts and Apply validation always require a fresh response. */
internal class ScopePreviewSession(private val delegate: ScopeEditorGateway) : ScopeEditorGateway {
    private val admission = Semaphore(2)
    private val mutableLabels = MutableStateFlow<Map<Pair<String, ScopeRef>, String>>(emptyMap())
    val labels = mutableLabels.asStateFlow()
    fun label(sourceId: String, ref: ScopeRef): String? = labels.value[sourceId to ref] ?: ref.label
    private fun rememberLabels(sourceId: String, values: List<Pair<ScopeRef, String>>) {
        mutableLabels.update { previous -> previous + values.associate { (ref, label) -> (sourceId to ref) to label } }
    }
    override suspend fun preview(policy: ScopePolicy): ScopePreview = admission.withPermit {
        withContext(NonCancellable) { delegate.preview(policy) }.also { result ->
            check(result.sourceId == policy.sourceId) { "The preview belongs to another source. Reopen this filter." }
            rememberLabels(policy.sourceId, result.items.filter { it.missing != true }.map { it.ref to it.label })
        }
    }
    override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions =
        admission.withPermit { withContext(NonCancellable) { delegate.options(sourceId, kind, query, parentId, cursor) }.also { result ->
            check(result.sourceId == sourceId) { "The choices belong to another source. Reopen this filter." }
            rememberLabels(sourceId, result.items.map { it.ref to it.label })
        } }
}
