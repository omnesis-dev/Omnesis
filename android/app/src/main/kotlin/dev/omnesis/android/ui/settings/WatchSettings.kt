// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.WatchCaptureStatusDto
import dev.omnesis.android.wear.OnDeviceFileTranscriber
import dev.omnesis.android.wear.WatchLink
import dev.omnesis.android.wear.WearGateway
import dev.omnesis.android.wear.WearRelay
import dev.omnesis.android.wear.watchLink
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What the Watch section shows. */
data class WatchSettingsState(
    val link: WatchLink,
    /** The decision-gate switch, or null when the paired gateway offers no such setting. */
    val decisionGate: DecisionGate? = null,
    /** The control that lets this phone transcribe watch recordings itself, when one is needed. */
    val transcription: Transcription = Transcription.None,
    val error: String? = null,
) {
    data class DecisionGate(
        /** The switch position: the gateway's setting, or the value being or just written. */
        val enabled: Boolean,
        /** A write is in flight; the switch waits for it. */
        val saving: Boolean = false,
        val canChange: Boolean = true,
        /** The setting is on but no decision model is assigned, so the watch still shows Ask and Tell. */
        val needsDecisionModel: Boolean = false,
    )

    sealed interface Transcription {
        /** Nothing to offer: the phone can transcribe and nothing is waiting, or it never can. */
        data object None : Transcription

        /** On-device transcription needs the microphone permission the recognizer requires. */
        data class NeedsMicrophone(val denied: Boolean = false) : Transcription

        /** Recordings are kept on this phone waiting to be processed again. */
        data class Waiting(val recordings: Int) : Transcription
    }
}

/** The decision-gate switch's own write state; the same shape as the Voice switch's. */
internal data class WatchGateWrite(
    val pending: Boolean? = null,
    val failed: Boolean = false,
    /** A value the gateway accepted while its status could not be re-read, and the status it was saved over. */
    val saved: Boolean? = null,
    val savedOver: WatchCaptureStatusDto? = null,
)

/** What this phone reports about itself for the Watch section; null [link] hides the section. */
internal data class WatchLocalState(
    val link: WatchLink? = null,
    val transcription: OnDeviceFileTranscriber.Availability = OnDeviceFileTranscriber.Availability.READY,
    val waitingRecordings: Int = 0,
    val microphoneDenied: Boolean = false,
)

internal const val WATCH_SETTING_SAVE_FAILED =
    "Couldn't save the watch setting. Try again when your gateway is reachable."

internal fun watchSettingsState(
    local: WatchLocalState,
    capture: WatchCaptureStatusDto?,
    write: WatchGateWrite,
    paired: Boolean,
): WatchSettingsState? {
    val link = local.link ?: return null
    val saved = write.saved?.takeIf { write.savedOver == capture }
    val statusCurrent = write.pending == null && saved == null
    return WatchSettingsState(
        link = link,
        decisionGate = capture?.takeIf { it.supported }?.let {
            WatchSettingsState.DecisionGate(
                enabled = write.pending ?: saved ?: it.enabled,
                saving = write.pending != null,
                canChange = paired,
                needsDecisionModel = statusCurrent && it.enabled && !it.active,
            )
        },
        transcription = when {
            local.transcription == OnDeviceFileTranscriber.Availability.NEEDS_MICROPHONE ->
                WatchSettingsState.Transcription.NeedsMicrophone(local.microphoneDenied)
            local.waitingRecordings > 0 -> WatchSettingsState.Transcription.Waiting(local.waitingRecordings)
            else -> WatchSettingsState.Transcription.None
        },
        error = WATCH_SETTING_SAVE_FAILED.takeIf { write.failed },
    )
}

@HiltViewModel
class WatchSettingsViewModel @Inject constructor(
    private val session: SessionManager,
    private val gateway: WearGateway,
    private val relay: WearRelay,
    private val transcriber: OnDeviceFileTranscriber,
) : ViewModel() {
    private val local = MutableStateFlow(WatchLocalState())
    private val write = MutableStateFlow(WatchGateWrite())

    /** The Watch section, or null to hide it: shown where the phone has a Wearable Data Layer. */
    val state: StateFlow<WatchSettingsState?> = combine(
        local,
        session.watchRelayStatus,
        write,
        session.state,
    ) { local, status, write, appState ->
        watchSettingsState(local, status?.capture, write, paired = appState is SessionManager.AppState.Paired)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    init {
        refresh()
    }

    /** Re-reads what the phone knows about the watch; run when the screen comes back into view. */
    fun refresh() {
        viewModelScope.launch {
            val link = if (gateway.available()) readLink() else null
            local.update {
                it.copy(
                    link = link,
                    transcription = transcriber.availability(),
                    waitingRecordings = relay.waitingRecordings(),
                )
            }
        }
    }

    private suspend fun readLink(): WatchLink = try {
        gateway.watchLink()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        WatchLink.NoWatch
    }

    /**
     * Switches the watch's decision gate for every watch relayed through this gateway, then
     * re-reads the gateway's verdict. When the write landed but the re-read failed, the switch
     * keeps the value just written rather than snapping back to a status known to be out of date.
     */
    fun setDecisionGate(enabled: Boolean) {
        val current = session.session ?: return
        if (write.value.pending != null) return
        write.value = WatchGateWrite(pending = enabled)
        viewModelScope.launch {
            try {
                current.admin.setWatchDecisionGate(enabled)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                write.value = WatchGateWrite(failed = true)
                return@launch
            }
            write.value = if (session.refreshStatus()) {
                WatchGateWrite()
            } else {
                WatchGateWrite(saved = enabled, savedOver = session.watchRelayStatus.value?.capture)
            }
        }
    }

    /** Android answered the microphone prompt the section raised. */
    fun onMicrophoneAnswered(granted: Boolean) {
        local.update { it.copy(microphoneDenied = !granted) }
        if (granted) relay.retryRecordings()
        refresh()
    }

    /** Runs the recordings kept on this phone again. */
    fun retryRecordings() {
        relay.retryRecordings()
        refresh()
    }
}
