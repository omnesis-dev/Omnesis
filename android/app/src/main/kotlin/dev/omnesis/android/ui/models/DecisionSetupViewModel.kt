// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.BackendConfig
import dev.omnesis.android.transport.dto.DecisionCalibrationStatus
import dev.omnesis.android.transport.dto.DecisionProbeBody
import dev.omnesis.android.transport.dto.DecisionProbeResult
import dev.omnesis.android.transport.dto.DecisionVerifyResult
import dev.omnesis.android.transport.dto.ModelCredentialEntry
import dev.omnesis.android.ui.models.DecisionSetup.KeyState
import dev.omnesis.android.ui.models.DecisionSetup.SaveRequest
import dev.omnesis.android.ui.models.DecisionSetup.VerifyState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** What the Decision model's setup sheet shows besides the overview. */
data class DecisionUiState(
    val verify: VerifyState = VerifyState.Idle,
    /** Model listings by [ProbeTarget.id]. */
    val probes: Map<String, ProbeState> = emptyMap(),
    /** The gateway's calibration job, once read. */
    val calibration: DecisionCalibrationStatus? = null,
    /** Why starting, cancelling or following a calibration failed. */
    val calibrationError: String? = null,
    val saving: Boolean = false,
    /** Why the last save or removal failed. */
    val error: String? = null,
    /** Whether a TypeSafe key is stored on the gateway (a blank key field then keeps it). */
    val typesafeKey: KeyState = KeyState.Missing,
)

sealed interface ProbeState {
    data object Running : ProbeState
    data class Done(val result: DecisionProbeResult) : ProbeState
}

/** A decision server whose installed models the form lists. */
sealed interface ProbeTarget {
    /** The key its listing is kept under in [DecisionUiState.probes]. */
    val id: String

    /** A saved backend's decision API. */
    data class Saved(val key: String) : ProbeTarget {
        override val id: String get() = "backend:$key"
    }

    /** A server the form describes but has not saved. */
    data class Unsaved(val body: DecisionProbeBody) : ProbeTarget {
        override val id: String get() = "url:${body.url}"
    }
}

/** The admin routes the Decision setup calls; a seam so the view-model is tested without a gateway. */
internal interface DecisionGateway {
    suspend fun modelCredentials(): List<ModelCredentialEntry>
    suspend fun setTypeSafeKey(apiKey: String)
    suspend fun saveBackend(key: String, config: BackendConfig, model: String, enableRemote: Boolean)
    suspend fun assignTypeSafe(model: String, enableRemote: Boolean)
    suspend fun disableDecision(key: String, clearAssignment: Boolean)
    suspend fun removeBackend(key: String, clearAssignment: Boolean)
    suspend fun probe(target: ProbeTarget): DecisionProbeResult
    suspend fun verifyBackend(key: String, model: String): DecisionVerifyResult
    suspend fun verifyTypeSafe(model: String): DecisionVerifyResult
    suspend fun calibration(): DecisionCalibrationStatus
    suspend fun startCalibration(): DecisionCalibrationStatus
    suspend fun cancelCalibration(): DecisionCalibrationStatus
}

private class SessionDecisionGateway(private val session: SessionManager) : DecisionGateway {
    private fun admin() = session.requireSession().admin
    override suspend fun modelCredentials() = admin().modelCredentials()
    override suspend fun setTypeSafeKey(apiKey: String) =
        admin().setModelCredentials(DecisionSetup.TYPESAFE_KEY, mapOf("apiKey" to apiKey))
    override suspend fun saveBackend(key: String, config: BackendConfig, model: String, enableRemote: Boolean) =
        admin().saveBackend(key, config, model, enableRemote)
    override suspend fun assignTypeSafe(model: String, enableRemote: Boolean) =
        admin().assignTypeSafeDecision(model, enableRemote)
    override suspend fun disableDecision(key: String, clearAssignment: Boolean) =
        admin().disableBackendDecision(key, clearAssignment)
    override suspend fun removeBackend(key: String, clearAssignment: Boolean) =
        admin().removeBackend(key, clearAssignment)
    override suspend fun probe(target: ProbeTarget) = when (target) {
        is ProbeTarget.Saved -> admin().probeBackendDecision(target.key)
        is ProbeTarget.Unsaved -> admin().probeDecisionServer(target.body)
    }
    override suspend fun verifyBackend(key: String, model: String) = admin().verifyBackendDecision(key, model)
    override suspend fun verifyTypeSafe(model: String) = admin().verifyTypeSafeDecision(model)
    override suspend fun calibration() = admin().decisionCalibration()
    override suspend fun startCalibration() = admin().startDecisionCalibration()
    override suspend fun cancelCalibration() = admin().cancelDecisionCalibration()
}

/**
 * Drives the Decision model's setup: one config patch per save, then a test
 * decision; listing a local or custom server's models; taking decision models
 * away from a backend; and the calibration job. The
 * screen follows a running calibration through [followCalibration] while it
 * is visible. A config change is announced on [changes] so the Models screen
 * reloads its overview in place.
 */
@HiltViewModel
class DecisionSetupViewModel internal constructor(
    private val gateway: DecisionGateway,
    private val pollIntervalMs: Long,
) : ViewModel() {

    @Inject constructor(session: SessionManager) : this(SessionDecisionGateway(session), CALIBRATION_POLL_MS)

    private val _state = MutableStateFlow(DecisionUiState())
    val state: StateFlow<DecisionUiState> = _state.asStateFlow()

    private val _changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val changes: SharedFlow<Unit> = _changes.asSharedFlow()

    /** The setup sheet opened: read the TypeSafe key state and the calibration job. */
    fun opened() {
        _state.update { it.copy(error = null, calibrationError = null, verify = VerifyState.Idle) }
        viewModelScope.launch {
            val key = runCatching { gateway.modelCredentials() }.fold(
                onSuccess = { entries ->
                    if (entries.firstOrNull { it.fileKey == DecisionSetup.TYPESAFE_KEY }?.configured == true) KeyState.Stored
                    else KeyState.Missing
                },
                onFailure = { e -> KeyState.Unknown(gatewayMessage(e)) },
            )
            _state.update { it.copy(typesafeKey = key) }
        }
        refreshCalibration()
    }

    /**
     * Save, then verify. A TypeSafe key typed in the form goes to its
     * credential first, so the assignment that follows can use it.
     */
    fun save(request: SaveRequest, onSaved: () -> Unit) {
        if (_state.value.saving) return
        _state.update { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            val outcome = runCatching {
                when (request) {
                    is SaveRequest.Backend ->
                        gateway.saveBackend(request.key, request.config, request.model, request.enableRemote)
                    is SaveRequest.TypeSafe -> {
                        request.apiKey?.trim()?.takeIf { it.isNotEmpty() }?.let { key ->
                            gateway.setTypeSafeKey(key)
                            _state.update { it.copy(typesafeKey = KeyState.Stored) }
                        }
                        gateway.assignTypeSafe(request.model, request.enableRemote)
                    }
                }
            }
            _state.update { it.copy(saving = false, error = outcome.exceptionOrNull()?.let { e -> gatewayMessage(e) }) }
            if (outcome.isSuccess) {
                _changes.tryEmit(Unit)
                onSaved()
                verify(request.assignment)
                refreshCalibration()
            }
        }
    }

    /** Send one test decision to [assignment] (`<backend>/<model>` or `typesafe/<model>`). */
    fun verify(assignment: String) {
        val key = assignment.substringBefore('/')
        val model = assignment.substringAfter('/', missingDelimiterValue = "")
        if (key.isBlank() || model.isBlank()) return
        _state.update { it.copy(verify = VerifyState.Running(assignment)) }
        viewModelScope.launch {
            val result = runCatching {
                if (key == DecisionSetup.TYPESAFE_KEY) gateway.verifyTypeSafe(model) else gateway.verifyBackend(key, model)
            }.getOrElse { e -> DecisionVerifyResult(ok = false, reason = gatewayMessage(e)) }
            _state.update { current ->
                // A newer verify (another model) owns the line.
                if ((current.verify as? VerifyState.Running)?.assignment != assignment) current
                else current.copy(verify = VerifyState.Done(assignment, result))
            }
        }
    }

    /** List the models a local or custom server has, for the form's suggestions. */
    fun probe(target: ProbeTarget) {
        if (_state.value.probes[target.id] == ProbeState.Running) return
        _state.update { it.copy(probes = it.probes + (target.id to ProbeState.Running)) }
        viewModelScope.launch {
            val result = runCatching { gateway.probe(target) }
                .getOrElse { e -> DecisionProbeResult(ok = false, reason = gatewayMessage(e)) }
            _state.update { it.copy(probes = it.probes + (target.id to ProbeState.Done(result))) }
        }
    }

    /**
     * Take decision models away from a backend: remove its decision API, or
     * the whole backend when it serves nothing else, clearing the Decision
     * model in the same write when it was assigned there.
     */
    fun remove(removal: DecisionSetup.Removal, onRemoved: () -> Unit) {
        if (_state.value.saving) return
        _state.update { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            val outcome = runCatching {
                if (removal.wholeBackend) gateway.removeBackend(removal.key, removal.clearAssignment)
                else gateway.disableDecision(removal.key, removal.clearAssignment)
            }
            val probeId = ProbeTarget.Saved(removal.key).id
            _state.update {
                it.copy(
                    saving = false,
                    error = outcome.exceptionOrNull()?.let { e -> gatewayMessage(e) },
                    probes = if (outcome.isSuccess) it.probes - probeId else it.probes,
                    verify = if (outcome.isSuccess && removal.clearAssignment) VerifyState.Idle else it.verify,
                )
            }
            if (outcome.isSuccess) {
                _changes.tryEmit(Unit)
                onRemoved()
            }
        }
    }

    /** Start calibrating the assigned model; the gateway's refusal is shown as it words it. */
    fun startCalibration() {
        _state.update { it.copy(calibrationError = null) }
        viewModelScope.launch {
            runCatching { gateway.startCalibration() }.fold(
                onSuccess = { status -> _state.update { it.copy(calibration = status) } },
                onFailure = { e ->
                    _state.update { it.copy(calibrationError = gatewayMessage(e)) }
                    // A 409 means a run is already going: show it.
                    refreshCalibration()
                },
            )
        }
    }

    fun cancelCalibration() {
        _state.update { it.copy(calibrationError = null) }
        viewModelScope.launch {
            runCatching { gateway.cancelCalibration() }.fold(
                onSuccess = { status -> _state.update { it.copy(calibration = status) } },
                onFailure = { e -> _state.update { it.copy(calibrationError = gatewayMessage(e)) } },
            )
        }
    }

    /** Read the calibration job once. Older gateways have no job, which leaves the state as it was. */
    fun refreshCalibration() {
        viewModelScope.launch {
            runCatching { gateway.calibration() }.onSuccess(::applyCalibration)
        }
    }

    /**
     * Follow a running calibration: read its status every poll interval until
     * it stops running, or until [MAX_POLL_FAILURES] reads in a row fail — then
     * the last failure is shown. The screen calls this while it is started, so
     * nothing polls in the background.
     */
    suspend fun followCalibration() {
        var failures = 0
        while (_state.value.calibration?.running == true) {
            delay(pollIntervalMs)
            val read = try {
                Result.success(gateway.calibration())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
            read.fold(
                onSuccess = { status ->
                    failures = 0
                    applyCalibration(status)
                    // A finished run stored its calibration in the config.
                    if (status.state == "done") _changes.tryEmit(Unit)
                },
                onFailure = { e ->
                    failures += 1
                    if (failures >= MAX_POLL_FAILURES) {
                        _state.update {
                            it.copy(calibrationError = "Could not read the calibration's progress: ${gatewayMessage(e)}")
                        }
                        return
                    }
                },
            )
        }
    }

    private fun applyCalibration(status: DecisionCalibrationStatus) {
        // While a run is going, an earlier start or read failure no longer applies.
        _state.update { it.copy(calibration = status, calibrationError = if (status.running) null else it.calibrationError) }
    }

    internal companion object {
        const val CALIBRATION_POLL_MS = 2_000L
        const val MAX_POLL_FAILURES = 3
    }
}
