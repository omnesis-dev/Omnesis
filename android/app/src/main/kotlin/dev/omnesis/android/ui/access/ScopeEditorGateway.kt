// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.access.accessAuthorizationIdentity
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.*

interface ScopeEditorGateway {
    suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions
    suspend fun preview(policy: ScopePolicy): ScopePreview
}

/** Capture the paired owner once; an in-flight response cannot cross a re-pair. */
class PairedScopeEditorGateway(private val session: SessionManager) : ScopeEditorGateway {
    private val owner = session.requireSession()
    private val identity = owner.pairing.accessAuthorizationIdentity()
    private fun checkPairing() {
        check(session.requireSession().pairing.accessAuthorizationIdentity() == identity) { "Gateway pairing changed. Reopen this editor." }
    }
    override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions {
        checkPairing()
        return owner.admin.scopeOptions(sourceId, kind, query, parentId, cursor).also { checkPairing() }
    }
    override suspend fun preview(policy: ScopePolicy): ScopePreview {
        checkPairing()
        return owner.admin.scopePreview(policy).also { checkPairing() }
    }
}
