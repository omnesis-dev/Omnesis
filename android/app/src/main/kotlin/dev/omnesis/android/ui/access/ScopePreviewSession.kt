// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.util.concurrent.ConcurrentHashMap

/** Labels are presentation-only; counts and Apply validation always require a fresh response. */
internal class ScopePreviewSession(private val delegate: ScopeEditorGateway) : ScopeEditorGateway {
    private val admission = Semaphore(2)
    private val labels = ConcurrentHashMap<Pair<String, ScopeRef>, String>()
    fun label(sourceId: String, ref: ScopeRef): String? = labels[sourceId to ref] ?: ref.label
    override suspend fun preview(policy: ScopePolicy): ScopePreview = admission.withPermit {
        withContext(NonCancellable) { delegate.preview(policy) }.also { result ->
            check(result.sourceId == policy.sourceId) { "The preview belongs to another source. Reopen this filter." }
            result.items.filter { it.missing != true }.forEach { labels[policy.sourceId to it.ref] = it.label }
        }
    }
    override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions =
        admission.withPermit { withContext(NonCancellable) { delegate.options(sourceId, kind, query, parentId, cursor) }.also { result ->
            check(result.sourceId == sourceId) { "The choices belong to another source. Reopen this filter." }
            result.items.forEach { labels[sourceId to it.ref] = it.label }
        } }
}
