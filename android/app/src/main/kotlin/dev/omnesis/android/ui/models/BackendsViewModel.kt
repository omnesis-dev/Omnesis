// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.CodexLoginFlow
import dev.omnesis.android.transport.dto.ModelCredentialEntry
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.ui.common.Loadable
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * HTTP-backend + model-provider-credential management view-model. Loads the
 * `/admin/models` overview for its `inference.backends` map and the
 * `/admin/model-credentials` registry, and drives both surfaces:
 * - backends: add (PATCH /admin/config), remove (PATCH with an explicit null),
 *   Test/re-probe (POST /admin/inference/backends/:key/probe).
 * - credentials: set (POST /admin/model-credentials/:fileKey), clear (DELETE).
 *
 * Mutations follow the established refresh-after-mutation + last-action-wins
 * notice pattern. The per-backend Test result is tracked separately from the
 * add/remove/credential notice so a probe and a mutation don't clobber each
 * other. Local-GGUF lifecycle remains a separate surface (a later iteration).
 */
@HiltViewModel
class BackendsViewModel @Inject constructor(
    private val session: SessionManager,
) : ViewModel() {

    private val _state = MutableStateFlow<Loadable<ModelsOverview>>(Loadable.Loading)
    val state = _state.asStateFlow()

    /** Model-provider credential rows (e.g. the Anthropic API key). */
    private val _credentials = MutableStateFlow<List<ModelCredentialEntry>>(emptyList())
    val credentials = _credentials.asStateFlow()

    private val _logos = MutableStateFlow<Map<String, String>>(emptyMap())
    val logos = _logos.asStateFlow()

    /** Last-action-wins add/remove/credential notice (green ok / red error). */
    private val _notice = MutableStateFlow<Notice?>(null)
    val notice = _notice.asStateFlow()

    /** True while a mutation is in flight (disables affordances). */
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()

    /** Per-backend Test/probe state, keyed by backend key. */
    private val _probes = MutableStateFlow<Map<String, ProbeState>>(emptyMap())
    val probes = _probes.asStateFlow()

    /** Per-(backend, model, role) verify state, keyed by `VerifyTarget.id`. */
    private val _verifies = MutableStateFlow<Map<String, VerifyState>>(emptyMap())
    val verifies = _verifies.asStateFlow()

    /** Active Codex device-login flow, if one has been started from this screen. */
    private val _codexLoginFlow = MutableStateFlow<CodexLoginFlow?>(null)
    val codexLoginFlow = _codexLoginFlow.asStateFlow()

    data class Notice(val ok: Boolean, val text: String)

    /** The state of a backend's Test button + its inline result line. */
    sealed interface ProbeState {
        data object Probing : ProbeState
        data class Ok(val modelCount: Int) : ProbeState
        /** Host answered, but its model list couldn't be fetched. Usable with a
         *  manually-assigned model id; carries the probe reason (e.g. "HTTP 500"). */
        data class Reachable(val reason: String) : ProbeState
        data class Fail(val reason: String) : ProbeState
    }

    /** The state of one (model, role) Verify affordance + its inline result. */
    sealed interface VerifyState {
        data object Verifying : VerifyState

        /** Behavioral verdict: supported true/false + the gateway's detail line. */
        data class Verdict(val supported: Boolean, val detail: String) : VerifyState

        /** The verify request itself failed (network, auth, 4xx/5xx). */
        data class Error(val reason: String) : VerifyState
    }

    init {
        load()
    }

    fun load() {
        _state.update { Loadable.Loading }
        viewModelScope.launch {
            runCatching {
                val admin = session.requireSession().admin
                // Load both in parallel — the credentials list is small (one row
                // per provider) and independent of the models overview.
                val overviewTask = async { admin.modelOverview() }
                val credsTask = async { admin.modelCredentials() }
                overviewTask.await() to credsTask.await()
            }.fold(
                onSuccess = { (overview, creds) ->
                    _credentials.update { creds }
                    _state.update { Loadable.Content(overview) }
                    viewModelScope.launch {
                        runCatching {
                            val ids = ProviderLogoLoader.providers(overview) + creds.map { it.providerType }
                            val loaded = ProviderLogoLoader.load(session.requireSession().admin, ids, _logos.value, overview)
                            _logos.update { it + loaded }
                        }
                    }
                },
                onFailure = { e -> _state.update { Loadable.Error(e) } },
            )
        }
    }

    fun dismissNotice() = _notice.update { null }

    /** Add (or replace) an HTTP backend, then reload + probe so it populates. */
    fun add(name: String, url: String, apiKey: String?, apiPathPrefix: String?) {
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching {
                val admin = session.requireSession().admin
                admin.addHttpBackend(name, url, apiKey, apiPathPrefix)
                // Probe immediately so reachability + the model list show.
                runCatching { admin.probeBackend(name) }
            }.fold(
                onSuccess = {
                    load()
                    _notice.update { Notice(true, "Added backend \"$name\".") }
                },
                onFailure = { e -> _notice.update { Notice(false, "Add failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /** Remove an HTTP backend, then reload. */
    fun remove(key: String) {
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.removeHttpBackend(key) }.fold(
                onSuccess = {
                    _probes.update { it - key }
                    // Drop any verdicts for the removed backend's (model, role) pairs.
                    _verifies.update { v -> v.filterKeys { !it.startsWith("$key/") } }
                    load()
                    _notice.update { Notice(true, "Removed backend \"$key\".") }
                },
                onFailure = { e -> _notice.update { Notice(false, "Remove failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /** Re-probe one backend; the result shows inline on its row. */
    fun probe(key: String) {
        _probes.update { it + (key to ProbeState.Probing) }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.probeBackend(key) }.fold(
                onSuccess = { result ->
                    val next = when {
                        result.status == "ok" -> ProbeState.Ok(result.models.size)
                        result.status == "reachable" ->
                            ProbeState.Reachable(result.reason?.ifBlank { null } ?: "no model list")
                        else -> ProbeState.Fail(result.reason?.ifBlank { null } ?: "unreachable")
                    }
                    _probes.update { it + (key to next) }
                    // Reachability/model-list may have changed — refresh the row.
                    load()
                },
                onFailure = { e -> _probes.update { it + (key to ProbeState.Fail(gatewayMessage(e))) } },
            )
        }
    }

    /** Refresh Codex login/model status. */
    fun refreshCodex() {
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.refreshCodexBackend() }.fold(
                onSuccess = { status ->
                    load()
                    _notice.update {
                        if (status.status == "ok") {
                            Notice(true, "Codex model list refreshed.")
                        } else {
                            Notice(false, status.reason?.ifBlank { null } ?: "Codex is not reachable.")
                        }
                    }
                },
                onFailure = { e -> _notice.update { Notice(false, "Codex refresh failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /** Start Codex's OpenAI device-login flow. */
    fun startCodexLogin() {
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.startCodexLogin() }.fold(
                onSuccess = { flow ->
                    _codexLoginFlow.update { flow }
                    _notice.update { Notice(true, "Codex login started.") }
                },
                onFailure = { e -> _notice.update { Notice(false, "Codex login failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /** Check the active device-login process and refresh Codex status. */
    fun checkCodexLogin() {
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching {
                val admin = session.requireSession().admin
                val flow = admin.getCodexLogin()
                val status = admin.refreshCodexBackend()
                flow to status
            }.fold(
                onSuccess = { (flow, status) ->
                    _codexLoginFlow.update { flow }
                    load()
                    _notice.update {
                        if (status.loggedIn) {
                            Notice(true, "Codex is logged in.")
                        } else {
                            Notice(false, status.reason?.ifBlank { null } ?: "Codex login is not complete yet.")
                        }
                    }
                },
                onFailure = { e -> _notice.update { Notice(false, "Codex check failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /** Cancel any active Codex device-login flow. */
    fun cancelCodexLogin() {
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.cancelCodexLogin() }.fold(
                onSuccess = { result ->
                    _codexLoginFlow.update { result.flow }
                    _notice.update {
                        Notice(true, if (result.canceled) "Codex login canceled." else "No active Codex login.")
                    }
                },
                onFailure = { e -> _notice.update { Notice(false, "Cancel failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /** Remove/log out Codex and clear Codex assignments. */
    fun removeCodex() {
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.removeCodexBackend() }.fold(
                onSuccess = {
                    _codexLoginFlow.update { null }
                    load()
                    _notice.update { Notice(true, "Removed Codex backend.") }
                },
                onFailure = { e -> _notice.update { Notice(false, "Remove failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /**
     * Behaviorally verify one (model, role) on a backend; the verdict shows
     * inline on its row. Never mutates config, so no reload. `force` bypasses the
     * gateway's verdict cache (the Re-verify affordance).
     */
    fun verify(target: ModelManagement.VerifyTarget, force: Boolean) {
        _verifies.update { it + (target.id to VerifyState.Verifying) }
        viewModelScope.launch {
            runCatching {
                session.requireSession().admin.verifyModel(
                    key = target.backendKey,
                    model = target.model,
                    role = target.role,
                    force = force,
                )
            }.fold(
                onSuccess = { verdict ->
                    _verifies.update {
                        it + (target.id to VerifyState.Verdict(verdict.supported, verdict.detail))
                    }
                },
                onFailure = { e ->
                    _verifies.update { it + (target.id to VerifyState.Error(gatewayMessage(e))) }
                },
            )
        }
    }

    /** Write a provider's credentials (field map), then reload. */
    fun setCredentials(fileKey: String, fields: Map<String, String>) {
        val providerName = _credentials.value.firstOrNull { it.fileKey == fileKey }?.providerName ?: fileKey
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.setModelCredentials(fileKey, fields) }.fold(
                onSuccess = {
                    load()
                    _notice.update { Notice(true, "Saved $providerName credentials.") }
                },
                onFailure = { e -> _notice.update { Notice(false, "Save failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /** Clear a provider's credentials, then reload. */
    fun clearCredentials(fileKey: String) {
        val providerName = _credentials.value.firstOrNull { it.fileKey == fileKey }?.providerName ?: fileKey
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.clearModelCredentials(fileKey) }.fold(
                onSuccess = {
                    load()
                    _notice.update { Notice(true, "Cleared $providerName credentials.") }
                },
                onFailure = { e -> _notice.update { Notice(false, "Clear failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    private fun gatewayMessage(e: Throwable): String = when (e) {
        is GatewayException.Unauthorized -> "not authorized"
        is GatewayException.Forbidden -> "this device lacks admin scope"
        is GatewayException.NotFound -> "no longer exists"
        is GatewayException.ServerError -> e.body?.ifBlank { null } ?: "server error"
        is GatewayException.Network -> "network error"
        is GatewayException.Decoding -> "could not read the response"
        else -> e.message ?: "unknown error"
    }
}
