// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.RecentModelEntry
import dev.omnesis.android.transport.dto.SystemInfo
import dev.omnesis.android.ui.common.Loadable
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Model-management view-model. Loads the full `/admin/models` overview (+
 * `/admin/system-info` for the fit badge) and drives the per-capability
 * assignment surface plus the local-GGUF lifecycle: assign a model to a role (a
 * catalog model via `activate`, or an HTTP-backend model via
 * `PATCH /admin/config`), clear a role, install a local model (start a
 * gateway-side download), cancel an in-flight download, and uninstall a
 * downloaded model. Adding HTTP backends + provider credentials live on the
 * Backends screen.
 *
 * Mutations follow the refresh-after-mutation + last-action-wins notice pattern:
 * on success the overview is reloaded and a green notice surfaces; on failure
 * nothing is mutated locally and a red notice surfaces. While a download is in
 * flight the overview is polled every second so the progress bar advances.
 */
@HiltViewModel
class ModelsViewModel @Inject constructor(
    private val session: SessionManager,
) : ViewModel() {

    private val _state = MutableStateFlow<Loadable<ModelsOverview>>(Loadable.Loading)
    val state = _state.asStateFlow()

    /** Host capacity snapshot for the local-model fit badge (null = no badge). */
    private val _system = MutableStateFlow<SystemInfo?>(null)
    val system = _system.asStateFlow()

    /** Last-action-wins notice banner (green ok / red error). */
    private val _notice = MutableStateFlow<Notice?>(null)
    val notice = _notice.asStateFlow()

    /** Autosave feedback remains visible inside the open model picker. */
    private val _behaviorError = MutableStateFlow<BehaviorFeedback?>(null)
    val behaviorError = _behaviorError.asStateFlow()
    private val _behaviorStatus = MutableStateFlow<BehaviorFeedback?>(null)
    val behaviorStatus = _behaviorStatus.asStateFlow()
    private val _behaviorEpoch = MutableStateFlow(0)
    val behaviorEpoch = _behaviorEpoch.asStateFlow()

    /** True while an assign/clear/lifecycle op is in flight (disables affordances). */
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()

    /** The capability whose picker sheet is open (null = closed). */
    private val _picker = MutableStateFlow<String?>(null)
    val picker = _picker.asStateFlow()

    /**
     * "Recently used" entries for the open picker capability (empty = hide
     * the section). Fetched when the picker opens; a failure (including an
     * older gateway without the route) just leaves it empty — the backend
     * grid below still works.
     */
    private val _recent = MutableStateFlow<List<RecentModelEntry>>(emptyList())
    val recent = _recent.asStateFlow()

    private val _logos = MutableStateFlow<Map<String, String>>(emptyMap())
    val logos = _logos.asStateFlow()

    /** Active download-progress poll loop, cancelled when nothing is downloading. */
    private var pollJob: Job? = null
    private val behaviorBaseline = BehaviorSaveBaseline()
    private var overviewGeneration = 0L
    private val overviewReader: BehaviorOverviewReader by lazy(LazyThreadSafetyMode.NONE) {
        BehaviorOverviewReader(
            generation = { overviewGeneration },
            fetch = { session.requireSession().admin.modelOverview() },
        )
    }

    private val behaviorSaves: BehaviorSaveQueue by lazy(LazyThreadSafetyMode.NONE) {
        BehaviorSaveQueue(
            scope = viewModelScope,
            write = { request ->
                val expected = behaviorBaseline.expected(request)
                    ?: error("The assigned model changed; refresh its settings before editing")
                session.requireSession().admin.saveModelBehavior(
                    request.role, request.assignment, request.values, expectedValues = expected,
                )
            },
            onResult = { request, error ->
                if (error is GatewayException.ServerError && error.status == 409) {
                    behaviorSaves.discard(request.role)
                    conflicts.mark(request.role)
                    val message = refreshBehaviorConflict(request.role)
                        ?: "Reasoning settings changed elsewhere. Refreshing current settings…"
                    _behaviorError.update { BehaviorFeedback(request.role, message) }
                    _behaviorStatus.update { null }
                    _notice.update { Notice(false, message) }
                } else if (error != null) {
                    val message = "Save failed: ${gatewayMessage(error)}"
                    _behaviorError.update { BehaviorFeedback(request.role, message) }
                    _behaviorStatus.update { null }
                    _notice.update { Notice(false, message) }
                } else {
                    behaviorBaseline.acknowledge(request)
                    overviewGeneration++
                    if (!behaviorSaves.hasUnsent) {
                        runCatching { overviewReader.read() }.fold(
                            onSuccess = { fresh ->
                                if (!behaviorSaves.hasUnsent) {
                                    behaviorBaseline.replace(fresh.modelSettings)
                                    _behaviorError.update { null }
                                    _state.update { Loadable.Content(fresh) }
                                    scheduleDownloadPoll(fresh)
                                    loadLogos(fresh)
                                    _behaviorStatus.update { BehaviorFeedback(request.role, "Saved") }
                                    _notice.update { null }
                                }
                            },
                            onFailure = { refreshError ->
                                _behaviorError.update { BehaviorFeedback(request.role,
                                    "Saved, but refresh failed: ${gatewayMessage(refreshError)}") }
                                _behaviorStatus.update { null }
                            },
                        )
                    }
                }
            },
        )
    }

    data class Notice(val ok: Boolean, val text: String)
    data class BehaviorFeedback(val role: String, val text: String)

    init {
        load()
    }

    fun load() {
        _state.update { Loadable.Loading }
        viewModelScope.launch {
            runCatching { overviewReader.read() }.fold(
                onSuccess = { overview ->
                    if (!behaviorSaves.hasWork) {
                        behaviorBaseline.replace(overview.modelSettings)
                        if (conflicts.hasBlockedRoles) {
                            conflicts.clear()
                            _behaviorEpoch.update { it + 1 }
                            _behaviorError.update { null }
                            _behaviorStatus.update { null }
                        }
                    }
                    _picker.value?.let { role ->
                        overview.recentModels[role]?.let { entries -> _recent.update { entries } }
                    }
                    _state.update { Loadable.Content(overview) }
                    scheduleDownloadPoll(overview)
                    loadLogos(overview)
                },
                onFailure = { e -> _state.update { Loadable.Error(e) } },
            )
            // The fit badge is best-effort: a failed system-info fetch just omits
            // the warnings, it doesn't fail the screen.
            if (_system.value == null) {
                runCatching { session.requireSession().admin.systemInfo() }
                    .onSuccess { info -> _system.update { info } }
            }
        }
    }

    /** Start a gateway-side GGUF download for [id], then reload + poll progress. */
    fun install(id: String) = runLifecycle("Downloading $id…") {
        session.requireSession().admin.installModel(id)
    }

    /** Cancel the in-flight download for [id], then reload. */
    fun cancelDownload(id: String) = runLifecycle("Cancelled $id.") {
        session.requireSession().admin.cancelModelDownload(id)
    }

    /** Uninstall a downloaded local model, then reload. */
    fun uninstall(id: String) = runLifecycle("Removed $id.") {
        session.requireSession().admin.uninstallModel(id)
    }

    /**
     * Run a local-model lifecycle mutation, keeping the picker open (so progress
     * stays visible), reloading the overview, and surfacing [okText] / the error
     * in the shared notice banner.
     */
    private fun runLifecycle(okText: String, op: suspend () -> Unit) {
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching { op() }.fold(
                onSuccess = {
                    overviewGeneration++
                    load()
                    _notice.update { Notice(true, okText) }
                },
                onFailure = { e -> _notice.update { Notice(false, "Failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /**
     * While any GGUF download is in flight, re-fetch the overview every second so
     * the progress bar advances and a completed/cancelled download flips the row
     * back. Mirrors the portal's `useVisiblePoll(refresh, 1000, …)`.
     */
    private fun scheduleDownloadPoll(overview: ModelsOverview) {
        pollJob?.cancel()
        pollJob = null
        if (overview.activeDownloads.isEmpty()) return
        pollJob = viewModelScope.launch {
            while (isActive) {
                delay(1000)
                val fresh = runCatching { overviewReader.read() }.getOrNull() ?: continue
                if (!behaviorSaves.hasWork) {
                    val previousSettings = (_state.value as? Loadable.Content)?.value?.modelSettings
                    behaviorBaseline.replace(fresh.modelSettings)
                    if (conflicts.hasBlockedRoles) {
                        conflicts.clear()
                        _behaviorError.update { null }
                        _behaviorStatus.update { null }
                        _behaviorEpoch.update { it + 1 }
                    } else if (previousSettings != fresh.modelSettings) {
                        _behaviorEpoch.update { it + 1 }
                    }
                }
                _state.update { Loadable.Content(fresh) }
                if (fresh.activeDownloads.isEmpty()) return@launch
            }
        }
    }

    override fun onCleared() {
        pollJob?.cancel()
        super.onCleared()
    }

    fun dismissNotice() = _notice.update { null }

    fun openPicker(role: String) {
        _picker.update { role }
        val embedded = (_state.value as? Loadable.Content)?.value?.recentModels?.get(role)
        _recent.update { embedded.orEmpty() }
        if (conflicts.isBlocked(role)) viewModelScope.launch {
            refreshBehaviorConflict(role)?.let { message ->
                _behaviorError.update { BehaviorFeedback(role, message) }
                _behaviorStatus.update { null }
                _notice.update { Notice(false, message) }
            }
        }
        if (embedded == null) refreshRecent(role) else loadRecentLogos(embedded)
    }

    fun closePicker() {
        _picker.update { null }
        _recent.update { emptyList() }
    }

    /** Autosave controls through a serial last-unsent-choice queue. */
    fun saveBehavior(role: String, assignment: String, values: ModelBehaviorValues) {
        if (!prepareBehaviorWrite(role, assignment)) return
        behaviorSaves.submit(BehaviorSaveRequest(role, assignment, values))
    }

    /** Debounce numeric typing in view-model scope so closing the sheet never drops a valid edit. */
    fun saveBudgetBehavior(role: String, assignment: String, values: ModelBehaviorValues?) {
        if (values == null) {
            behaviorSaves.submitBudget(role, null)
            _behaviorStatus.update { it?.takeUnless { feedback -> feedback.role == role } }
            return
        }
        if (!prepareBehaviorWrite(role, assignment)) return
        behaviorSaves.submitBudget(role, BehaviorSaveRequest(role, assignment, values))
    }

    private fun prepareBehaviorWrite(role: String, assignment: String): Boolean {
        if (conflicts.isBlocked(role)) {
            _behaviorError.update { BehaviorFeedback(role,
                "Reasoning settings changed elsewhere. Refresh the model settings before editing.") }
            return false
        }
        val active = (_state.value as? Loadable.Content)?.value?.modelSettings?.get(role)?.assignment
        if (active != null && active != assignment) {
            _behaviorError.update { BehaviorFeedback(role,
                "The assigned model changed. Reopen its settings before editing.") }
            _behaviorStatus.update { null }
            return false
        }
        _notice.update { null }
        _behaviorError.update { null }
        _behaviorStatus.update { BehaviorFeedback(role, "Saving…") }
        return true
    }

    private val conflicts: BehaviorConflictRecovery by lazy(LazyThreadSafetyMode.NONE) {
        BehaviorConflictRecovery(
            fetch = { overviewReader.read() },
            applyFresh = { role, overview ->
                behaviorBaseline.replace(overview.modelSettings,
                    preserveRoles = behaviorSaves.protectedRoles - role)
                _state.update { Loadable.Content(overview) }
                scheduleDownloadPoll(overview)
                loadLogos(overview)
                _behaviorEpoch.update { it + 1 }
            },
        )
    }

    /** A failed conflict refresh keeps this role blocked until reopening retries successfully. */
    private suspend fun refreshBehaviorConflict(role: String): String? {
        return conflicts.refresh(role)?.fold(
                onSuccess = {
                    "Reasoning settings changed elsewhere. The current settings are refreshed; choose again."
                },
                onFailure = { refreshError ->
                    "Reasoning settings changed elsewhere, but refresh failed: ${gatewayMessage(refreshError)}. Reopen its model settings to retry."
                },
            )
    }

    private fun loadLogos(overview: ModelsOverview) {
        viewModelScope.launch {
            runCatching {
                val ids = ProviderLogoLoader.providers(overview)
                val loaded = ProviderLogoLoader.load(session.requireSession().admin, ids, _logos.value, overview)
                _logos.update { it + loaded }
            }
        }
    }

    /** Assign a model to a capability, then reload so the new state shows. */
    fun assign(role: String, option: ModelManagement.PickerOption) {
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching {
                val admin = session.requireSession().admin
                when (val apply = option.apply) {
                    is ModelManagement.Apply.Activate -> admin.activateModel(
                        apply.catalogId,
                        apply.catalogRole,
                        apply.capabilityRole,
                    )
                    is ModelManagement.Apply.Assign -> admin.assignCapability(role, apply.value)
                }
            }.fold(
                onSuccess = {
                    overviewGeneration++
                    load()
                    refreshRecent(role)
                    session.refreshStatus()
                    _notice.update { Notice(true, "${option.label} assigned.") }
                },
                onFailure = { e -> _notice.update { Notice(false, "Assign failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /** Reload history after opening the picker and after an assignment changes it. */
    private fun refreshRecent(role: String) {
        viewModelScope.launch {
            val entries = ModelManagement.loadRecent(session.requireSession().admin, role)
            if (_picker.value != role) return@launch
            _recent.update { entries }
            loadRecentLogos(entries)
        }
    }

    private fun loadRecentLogos(entries: List<RecentModelEntry>) {
        viewModelScope.launch {
            runCatching {
                val ids = entries.map { it.providerId }.filter { it.isNotBlank() }.toSet()
                val loaded = ProviderLogoLoader.load(session.requireSession().admin, ids, _logos.value)
                _logos.update { it + loaded }
            }
        }
    }

    /**
     * Add (or replace) an HTTP backend from the model picker's add affordance,
     * probe it so its model list populates, then reload the overview so the new
     * backend appears in the picker grid. Mirrors `BackendsViewModel.add` (the
     * picker stays open so the new backend tile shows immediately).
     */
    fun addBackend(name: String, url: String, apiKey: String?, apiPathPrefix: String?) {
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
                    overviewGeneration++
                    load()
                    _notice.update { Notice(true, "Added backend \"$name\".") }
                },
                onFailure = { e -> _notice.update { Notice(false, "Add failed: ${gatewayMessage(e)}") } },
            )
            _busy.update { false }
        }
    }

    /** Disable a capability (PATCH with a null assignment), then reload. */
    fun clear(role: String) {
        closePicker()
        _busy.update { true }
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.assignCapability(role, null) }.fold(
                onSuccess = {
                    overviewGeneration++
                    load()
                    session.refreshStatus()
                    _notice.update { Notice(true, "Cleared.") }
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
