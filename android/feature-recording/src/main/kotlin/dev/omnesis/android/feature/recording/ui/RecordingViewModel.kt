// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording.ui

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.feature.recording.OutboxSession
import dev.omnesis.android.feature.recording.RecordingController
import dev.omnesis.android.feature.recording.RecordingFiles
import dev.omnesis.android.feature.recording.RecordingForegroundService
import dev.omnesis.android.feature.recording.RecordingOutbox
import dev.omnesis.android.feature.recording.RecordingSessionProvider
import dev.omnesis.android.feature.recording.RecordingSettings
import dev.omnesis.android.feature.recording.RecordingState
import dev.omnesis.android.feature.recording.RecordingUploadScheduler
import dev.omnesis.android.transport.GatewayException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import javax.inject.Inject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Whether the paired gateway takes recordings; bound by the app to its status probe. */
interface RecordingAvailability {
    val state: StateFlow<Availability>

    enum class Availability {
        /** Experimental mode with the recordings capability and gateway transcription on. */
        AVAILABLE,
        /** The gateway takes recordings, but the operator switched gateway transcription off. */
        TRANSCRIPTION_OFF,
        /** Not paired, not experimental, or a gateway without the capability. */
        UNAVAILABLE,
    }
}

/** One recording the phone still knows about, as the list shows it. */
data class RecentRecording(
    val id: String,
    val title: String,
    val when_: String,
    val status: Status,
) {
    sealed interface Status {
        data class Uploading(val partsLeft: Int) : Status
        data object Sent : Status
        data class Refused(val reason: String) : Status
    }
}

data class RecordingUiState(
    val availability: RecordingAvailability.Availability = RecordingAvailability.Availability.UNAVAILABLE,
    val recording: RecordingState.Active? = null,
    val elapsedMs: Long = 0,
    val title: String = "",
    val wifiOnly: Boolean = false,
    val micDenied: Boolean = false,
    /** Start was tapped and the recorder has not reported yet: the button is disabled. */
    val starting: Boolean = false,
    val recent: List<RecentRecording> = emptyList(),
    val deleteError: String? = null,
)

@HiltViewModel
class RecordingViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val controller: RecordingController,
    private val outbox: RecordingOutbox,
    private val files: RecordingFiles,
    private val settings: RecordingSettings,
    private val sessions: RecordingSessionProvider,
    availability: RecordingAvailability,
) : ViewModel() {

    private val _state = MutableStateFlow(RecordingUiState(wifiOnly = settings.wifiOnly))
    private var startTimeout: Job? = null
    val state: StateFlow<RecordingUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch { availability.state.collect { a -> _state.update { it.copy(availability = a) } } }
        viewModelScope.launch {
            controller.state.collect { s ->
                val active = s as? RecordingState.Active
                _state.update { it.copy(recording = active, starting = it.starting && active == null) }
                refreshRecent()
            }
        }
        // The elapsed clock, and the upload progress of recent recordings.
        viewModelScope.launch {
            var tick = 0
            while (isActive) {
                val active = _state.value.recording
                _state.update { it.copy(elapsedMs = active?.elapsedMs(System.currentTimeMillis()) ?: 0) }
                if (tick++ % 5 == 0) refreshRecent()
                delay(1_000)
            }
        }
        viewModelScope.launch {
            // A recording a process kill interrupted is closed, and anything
            // left from before a restart gets another upload attempt.
            controller.recoverInterrupted()
            val known = outbox.sessions().map { it.id }.toSet()
            withContext(Dispatchers.IO) { files.sweep(known) }
            RecordingUploadScheduler.enqueue(context, settings.wifiOnly)
        }
    }

    fun onTitleChange(title: String) = _state.update { it.copy(title = title.take(200)) }

    fun onMicPermission(granted: Boolean) {
        _state.update { it.copy(micDenied = !granted) }
        if (granted) start()
    }

    private fun start() {
        val current = _state.value
        if (current.starting || current.recording != null) return
        // See #863 — planned: starting while the gateway is unreachable.
        if (current.availability != RecordingAvailability.Availability.AVAILABLE) return
        RecordingForegroundService.start(context, current.title.trim().ifEmpty { null })
        _state.update { it.copy(title = "", starting = true) }
        // Recording showing in the controller's state clears `starting`; a
        // start that never shows (the microphone did not open) clears it here.
        startTimeout?.cancel()
        startTimeout = viewModelScope.launch {
            delay(START_TIMEOUT_MS)
            _state.update { it.copy(starting = false) }
        }
    }

    fun pause() = RecordingForegroundService.send(context, RecordingForegroundService.ACTION_PAUSE)

    fun resume() = RecordingForegroundService.send(context, RecordingForegroundService.ACTION_RESUME)

    fun stop() = RecordingForegroundService.send(context, RecordingForegroundService.ACTION_STOP)

    fun onWifiOnlyChange(value: Boolean) {
        settings.wifiOnly = value
        _state.update { it.copy(wifiOnly = value) }
        RecordingUploadScheduler.enqueue(context, value, replace = true)
    }

    /** Delete a recording here and on the gateway: its audio, its transcript and its document. */
    fun delete(id: String) {
        viewModelScope.launch {
            val session = outbox.sessions().firstOrNull { it.id == id } ?: return@launch
            if (session.created) {
                val gateway = sessions.gateway()
                if (gateway == null) {
                    _state.update { it.copy(deleteError = "Reconnect to the gateway to delete this recording.") }
                    return@launch
                }
                try {
                    gateway.delete(id)
                } catch (_: GatewayException.NotFound) {
                    // Already gone on the gateway.
                } catch (e: GatewayException) {
                    _state.update { it.copy(deleteError = "The recording could not be deleted. Try again.") }
                    return@launch
                }
            }
            outbox.remove(id)
            withContext(Dispatchers.IO) { files.sessionDir(id).deleteRecursively() }
            _state.update { it.copy(deleteError = null) }
            refreshRecent()
        }
    }

    fun dismissDeleteError() = _state.update { it.copy(deleteError = null) }

    private suspend fun refreshRecent() {
        val activeId = (controller.state.value as? RecordingState.Active)?.sessionId
        val recent = outbox.sessions()
            .filter { it.id != activeId }
            .sortedByDescending { it.startedAt }
            .map { it.toRecent(outbox.pendingChunks(it.id).size) }
        _state.update { it.copy(recent = recent) }
    }

    companion object {
        private const val START_TIMEOUT_MS = 5_000L
        private val WHEN = DateTimeFormatter.ofPattern("EEE d MMM, HH:mm", Locale.getDefault())

        fun OutboxSession.toRecent(partsLeft: Int, zone: ZoneId = ZoneId.systemDefault()): RecentRecording {
            val time = WHEN.withZone(zone).format(Instant.parse(startedAt))
            val status = when {
                refusal != null -> RecentRecording.Status.Refused(refusal)
                finished -> RecentRecording.Status.Sent
                else -> RecentRecording.Status.Uploading(partsLeft)
            }
            return RecentRecording(id, title ?: "Conversation", time, status)
        }
    }
}
