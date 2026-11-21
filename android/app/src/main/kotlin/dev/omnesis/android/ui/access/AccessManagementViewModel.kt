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
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * [loading] is a save or, with [deleting], a deletion in flight; [refreshing] is an overview read, which
 * leaves the draft editable. [deleteError] is a refused deletion of a listed level, kept apart from a
 * refused save's [error].
 */
data class AccessManagementState(
    val overview: AccessOverview? = null, val draft: AccessLevelDraft? = null,
    val loading: Boolean = false, val error: String? = null, val conflict: Boolean = false, val errorCode: String? = null,
    val refreshing: Boolean = false, val deleting: Boolean = false, val deleteError: String? = null,
    /** The privacy policy being read over the level editor, or null while none is. */
    val policyPreview: AccessPolicyPreview? = null,
)

internal const val ACCESS_LEVEL_GONE_MESSAGE =
    "This access level is no longer available. Your changes are kept; close it to return to Access."

/** A save the gateway refused. A level deleted elsewhere reads as a conflict whose reload names the deletion. */
internal fun AccessManagementState.afterSaveFailure(error: Exception): AccessManagementState {
    if (error is GatewayException.NotFound && draft?.expectedRevision != null) {
        return copy(loading = false, error = ACCESS_LEVEL_GONE_MESSAGE, conflict = true, errorCode = null)
    }
    val stale = error is GatewayException.ServerError && error.status == 409 &&
        listOfNotNull(error.code, error.body).any { it.contains("stale", true) || it.contains("revision", true) }
    return copy(loading = false, error = accessManagementError(error), conflict = stale, errorCode = accessManagementErrorCode(error))
}

/** What a deletion the gateway refused as in use says to do; the gateway does not say which kind of user holds the level. */
internal const val ACCESS_LEVEL_IN_USE_HINT = "Move its connections and integrations off it first."

/** A deletion the gateway refused: the level stays listed and the list says what to do. */
internal fun AccessManagementState.afterDeleteFailure(error: Exception): AccessManagementState =
    copy(loading = false, deleting = false, deleteError = accessLevelDeleteError(error))

internal fun accessLevelDeleteError(error: Exception): String = when {
    accessManagementErrorCode(error) == "level-in-use" -> ACCESS_LEVEL_IN_USE_HINT
    error is GatewayException.ServerError || error is GatewayException.NotFound -> "The gateway could not delete this access level. Try again."
    else -> accessManagementError(error)
}

@HiltViewModel
class AccessManagementViewModel @Inject constructor(private val session: SessionManager, private val sourceCatalog: dev.omnesis.android.sources.SourceCatalog) : ViewModel() {
    private val pairingIdentity = session.requireSession().pairing.accessAuthorizationIdentity()
    private fun activeOwner() = session.requireSession().also {
        check(it.pairing.accessAuthorizationIdentity() == pairingIdentity) { "Gateway pairing changed. Reopen Access." }
    }
    private val mutable = MutableStateFlow(AccessManagementState())
    val state = mutable.asStateFlow()
    val scopeGateway: FilterEditorGateway = PairedFilterEditorGateway(session).editorSession()
    fun sourceIcon(sourceId: String) = sourceCatalog.iconModel(sourceId)
    fun sourceName(sourceId: String) = sourceCatalog.familyLabel(sourceId)
    fun refresh(reloadDraft: Boolean = false) {
        viewModelScope.launch {
            mutable.update { it.copy(refreshing = true) }
            try {
                val owner = activeOwner()
                val identity = owner.pairing.accessAuthorizationIdentity()
                val overview = owner.admin.accessOverview()
                if (reloadDraft) check(state.value.draft?.id == NEW_ACCESS_LEVEL_ID || overview.levels.any { it.id == state.value.draft?.id }) { ACCESS_LEVEL_GONE_MESSAGE }
                sourceCatalog.ensureLoaded(owner.admin)
                check(session.requireSession().pairing.accessAuthorizationIdentity() == identity) { "Gateway pairing changed" }
                mutable.update { old -> old.copy(overview = overview, refreshing = false, error = null, errorCode = if (reloadDraft) null else old.errorCode,
                    draft = if (reloadDraft) overview.levels.firstOrNull { it.id == old.draft?.id }?.let { AccessLevelDraft.opening(it, overview) } else old.draft,
                    conflict = if (reloadDraft) false else old.conflict || (old.draft?.expectedRevision != null && overview.levels.firstOrNull { it.id == old.draft.id }?.revision != old.draft.expectedRevision)) }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { mutable.update { it.copy(refreshing = false, error = accessManagementError(error, reading = true)) } }
        }
    }
    fun edit(level: AccessLevelSummary?) {
        val overview = state.value.overview ?: return
        mutable.update { it.copy(draft = AccessLevelDraft.opening(level, overview), error = null, conflict = false, errorCode = null, deleteError = null) }
    }
    fun update(draft: AccessLevelDraft) = mutable.update { if (it.loading) it else {
        val keepDependency = it.errorCode == "level-in-use" && draft.rule(AccessCapability.ANSWER) == null
        it.copy(draft = draft, error = if (it.conflict || keepDependency) it.error else null, errorCode = if (keepDependency) it.errorCode else null, deleteError = null)
    } }
    fun closeEditor() = mutable.update { if (it.loading) it else it.copy(draft = null, error = null, conflict = false, errorCode = null, deleteError = null) }
    fun dismissDeleteError() = mutable.update { it.copy(deleteError = null) }
    private var policyJob: Job? = null
    /** Reads one published policy's text for the sheet over the editor. A reply for a sheet since closed or replaced is dropped. */
    fun showPolicy(familyId: String) {
        policyJob?.cancel()
        mutable.update { it.copy(policyPreview = AccessPolicyPreview.opening(familyId, it.overview)) }
        fun settle(change: (AccessPolicyPreview) -> AccessPolicyPreview) = mutable.update { current ->
            current.policyPreview?.takeIf { it.familyId == familyId }?.let { current.copy(policyPreview = change(it)) } ?: current
        }
        policyJob = viewModelScope.launch {
            try {
                val document = activeOwner().admin.privacyPolicyFamily(familyId)
                settle { it.copy(loading = false, document = document) }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { settle { it.copy(loading = false, error = accessManagementError(error, reading = true)) } }
        }
    }
    fun dismissPolicy() {
        policyJob?.cancel(); policyJob = null
        mutable.update { it.copy(policyPreview = null) }
    }
    /** Deletes a listed level. A level already gone from the gateway counts as deleted. */
    fun delete(level: AccessLevelSummary) {
        if (state.value.loading || state.value.draft != null) return
        viewModelScope.launch {
            mutable.update { it.copy(loading = true, deleting = true, deleteError = null) }
            try {
                val owner = activeOwner()
                val identity = owner.pairing.accessAuthorizationIdentity()
                try { owner.admin.deleteAccessLevel(level.id) } catch (_: GatewayException.NotFound) { /* Deleted elsewhere. */ }
                check(session.requireSession().pairing.accessAuthorizationIdentity() == identity) { "Gateway pairing changed" }
                mutable.update { it.copy(loading = false, deleting = false) }
                refresh()
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { mutable.update { it.afterDeleteFailure(error) } }
        }
    }
    fun save() {
        val overview = state.value.overview ?: return
        val draft = state.value.draft?.takeIf { it.validFor(overview) && !state.value.loading && !state.value.conflict } ?: return
        viewModelScope.launch {
            mutable.update { it.copy(loading = true, error = null, deleteError = null) }
            try {
                val owner = activeOwner()
                val identity = owner.pairing.accessAuthorizationIdentity()
                if (draft.expectedRevision == null) owner.admin.createAccessLevel(AccessLevelCreateBody(draft.name.trim(), draft.serializedRules))
                else owner.admin.updateAccessLevel(draft.id, AccessLevelUpdateBody(draft.name.trim(), draft.serializedRules, draft.expectedRevision, draft.expectedFilterRevisions))
                check(session.requireSession().pairing.accessAuthorizationIdentity() == identity) { "Gateway pairing changed" }
                mutable.update { it.copy(draft = null, loading = false) }
                refresh()
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { mutable.update { it.afterSaveFailure(error) } }
        }
    }
}

/** [reading] words a failed overview, preview or choices read; otherwise the failure is a refused save. */
internal fun accessManagementError(error: Exception, reading: Boolean = false): String {
    val generic = if (reading) "The gateway could not load this. Try again." else "The gateway could not save these changes. Try again."
    return when (error) {
        is GatewayException.Unauthorized -> "Authentication failed. Re-pair with this gateway."
        is GatewayException.Forbidden -> "This device cannot manage access levels."
        is GatewayException.NotFound -> if (reading) "This is no longer available on the gateway. Close and reopen Access." else generic
        is GatewayException.ServerError -> when (accessManagementErrorCode(error)) {
            "level-name-taken" -> LEVEL_NAME_TAKEN_MESSAGE
            "level-in-use" -> "Integrations use this level for answers. Move them to another access level before removing Answer, or restore Answer here."
            // A refused save names why in the gateway's sentence when it has one.
            "invalid-selection" -> if (reading) generic else error.userMessage ?: "These permissions cannot be saved as chosen. A saved source filter must stay with a source this access level allows."
            else -> generic
        }
        else -> error.message ?: "Could not connect to the gateway. Try again."
    }
}

internal fun accessManagementErrorCode(error: Exception): String? {
    if (error !is GatewayException.ServerError) return null
    return error.code ?: error.body?.let { body ->
        if (body in setOf("level-in-use", "level-name-taken", "invalid-selection")) return@let body
        runCatching { Json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull }.getOrNull()
    }
}
