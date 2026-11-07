// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.access.accessAuthorizationIdentity
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class AccessManagementState(
    val overview: AccessOverview? = null, val draft: AccessLevelDraft? = null,
    val loading: Boolean = false, val error: String? = null, val conflict: Boolean = false, val errorCode: String? = null,
)

@HiltViewModel
class AccessManagementViewModel @Inject constructor(private val session: SessionManager, private val sourceCatalog: dev.omnesis.android.sources.SourceCatalog) : ViewModel() {
    private val pairingIdentity = session.requireSession().pairing.accessAuthorizationIdentity()
    private fun activeOwner() = session.requireSession().also {
        check(it.pairing.accessAuthorizationIdentity() == pairingIdentity) { "Gateway pairing changed. Reopen Access." }
    }
    private val mutable = MutableStateFlow(AccessManagementState())
    val state = mutable.asStateFlow()
    val scopeGateway: ScopeEditorGateway = ScopePreviewSession(PairedScopeEditorGateway(session))
    fun sourceIcon(sourceId: String) = sourceCatalog.iconModel(sourceId)
    fun sourceName(sourceId: String) = sourceCatalog.familyLabel(sourceId)
    fun refresh(reloadDraft: Boolean = false) {
        viewModelScope.launch {
            mutable.update { it.copy(loading = true) }
            try {
                val owner = activeOwner()
                val identity = owner.pairing.accessAuthorizationIdentity()
                val overview = owner.admin.accessOverview()
                if (reloadDraft) check(state.value.draft?.id == "new" || overview.levels.any { it.id == state.value.draft?.id }) { "This access level is no longer available. Your unsaved draft is retained; close it to return to Access." }
                sourceCatalog.ensureLoaded(owner.admin)
                check(session.requireSession().pairing.accessAuthorizationIdentity() == identity) { "Gateway pairing changed" }
                mutable.update { old -> old.copy(overview = overview, loading = false, error = null, errorCode = if (reloadDraft) null else old.errorCode,
                    draft = if (reloadDraft) overview.levels.firstOrNull { it.id == old.draft?.id }?.let { AccessLevelDraft.opening(it, overview) } else old.draft,
                    conflict = if (reloadDraft) false else old.conflict || (old.draft?.expectedRevision != null && overview.levels.firstOrNull { it.id == old.draft.id }?.revision != old.draft.expectedRevision)) }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { mutable.update { it.copy(loading = false, error = accessManagementError(error)) } }
        }
    }
    fun edit(level: AccessLevelSummary?) {
        val overview = state.value.overview ?: return
        mutable.update { it.copy(draft = AccessLevelDraft.opening(level, overview), error = null, conflict = false, errorCode = null) }
    }
    fun update(draft: AccessLevelDraft) = mutable.update { if (it.loading) it else {
        val keepDependency = it.errorCode == "level-in-use" && draft.rule(AccessCapability.ANSWER) == null
        it.copy(draft = draft, error = if (it.conflict || keepDependency) it.error else null, errorCode = if (keepDependency) it.errorCode else null)
    } }
    fun closeEditor() = mutable.update { if (it.loading) it else it.copy(draft = null, error = null, conflict = false, errorCode = null) }
    fun save() {
        val overview = state.value.overview ?: return
        val draft = state.value.draft?.takeIf { it.validFor(overview) && !state.value.loading && !state.value.conflict } ?: return
        viewModelScope.launch {
            mutable.update { it.copy(loading = true, error = null) }
            try {
                val owner = activeOwner()
                val identity = owner.pairing.accessAuthorizationIdentity()
                if (draft.expectedRevision == null) owner.admin.createAccessLevel(AccessLevelCreateBody(draft.name.trim(), draft.serializedRules))
                else owner.admin.updateAccessLevel(draft.id, AccessLevelUpdateBody(draft.name.trim(), draft.serializedRules, draft.expectedRevision, draft.expectedFilterRevisions))
                check(session.requireSession().pairing.accessAuthorizationIdentity() == identity) { "Gateway pairing changed" }
                mutable.update { it.copy(draft = null, loading = false) }
                refresh()
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                val stale = error is GatewayException.ServerError && error.status == 409 &&
                    listOfNotNull(error.code, error.body).any { it.contains("stale", true) || it.contains("revision", true) }
                mutable.update { it.copy(loading = false, error = accessManagementError(error), conflict = stale, errorCode = accessManagementErrorCode(error)) }
            }
        }
    }
}

internal fun accessManagementError(error: Exception): String = when(error) {
    is GatewayException.Unauthorized -> "Authentication failed. Re-pair with this gateway."
    is GatewayException.Forbidden -> "This device cannot manage access levels."
    is GatewayException.ServerError -> when (accessManagementErrorCode(error)) {
        "level-name-taken" -> "An access level already uses this name. Choose another."
        "level-in-use" -> "Integrations use this level for answers. Move them to another access level before removing Answer, or restore Answer here."
        else -> "The gateway could not save these changes. Try again."
    }
    else -> error.message ?: "Could not connect to the gateway. Try again."
}

internal fun accessManagementErrorCode(error: Exception): String? {
    if (error !is GatewayException.ServerError) return null
    return error.code ?: error.body?.let { body ->
        runCatching { Json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull }.getOrNull()
    }
}
