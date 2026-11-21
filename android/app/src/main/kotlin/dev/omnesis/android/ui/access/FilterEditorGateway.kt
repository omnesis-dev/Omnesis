// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.access.accessAuthorizationIdentity
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.*

/** What an account's filter editor asks the gateway. */
interface FilterEditorGateway {
    /** What the account's filter can match on, field by field, with each field's state. */
    suspend fun editor(sourceId: String): FilterEditor
    suspend fun options(sourceId: String, field: String, query: String, parentId: String?, device: String?, cursor: String?): FilterOptions
    suspend fun preview(policy: SourceFilter): FilterPreview
    /** The gateway's reading of a typed address: the canonical address, or the sentence to show under the field. */
    suspend fun identifier(type: String, value: String): FilterIdentifierCheck
    /** Reads the whole account again in place, so its older records gain what filters need. */
    suspend fun resync(sourceId: String)
}

/** Capture the paired owner once; an in-flight response cannot cross a re-pair. */
class PairedFilterEditorGateway(private val session: SessionManager) : FilterEditorGateway {
    private val owner = session.requireSession()
    private val identity = owner.pairing.accessAuthorizationIdentity()
    private fun checkPairing() {
        check(session.requireSession().pairing.accessAuthorizationIdentity() == identity) { "Gateway pairing changed. Reopen this editor." }
    }
    private suspend fun <T> paired(call: suspend () -> T): T {
        checkPairing()
        return call().also { checkPairing() }
    }
    override suspend fun editor(sourceId: String): FilterEditor = paired { owner.admin.filterEditor(sourceId) }
    override suspend fun options(sourceId: String, field: String, query: String, parentId: String?, device: String?, cursor: String?): FilterOptions =
        paired { owner.admin.filterOptions(sourceId, field, query, parentId, device, cursor) }
    override suspend fun preview(policy: SourceFilter): FilterPreview = paired { owner.admin.filterPreview(policy) }
    override suspend fun identifier(type: String, value: String): FilterIdentifierCheck = paired { owner.admin.checkFilterIdentifier(type, value) }
    override suspend fun resync(sourceId: String) = paired { owner.admin.resyncSource(sourceId, ResyncMode.IN_PLACE) }
}
