// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.AppVersionInfo
import dev.omnesis.android.BuildConfig
import dev.omnesis.android.delivery.PushHealthCoordinator
import dev.omnesis.android.delivery.PushHealthUiState
import dev.omnesis.android.notifications.FcmPushManager
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.flow.notificationPromptAvailable as notificationPromptAvailableFor
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.PermissionHealthEntry
import dev.omnesis.android.transport.dto.DictationStatusDto
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.common.classifyGatewayError
import dev.omnesis.android.ui.phonesetup.BackgroundSyncingState
import dev.omnesis.android.ui.phonesetup.PhoneSetupCoordinator
import dev.omnesis.android.ui.phonesetup.PhoneSetupSummary
import dev.omnesis.android.ui.phonesetup.UnusedAppRestrictionsReader
import dev.omnesis.android.ui.phonesetup.backgroundSyncingState
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val session: SessionManager,
    val appearance: AppearanceStore,
    private val catalog: SourceCatalog,
    private val pushHealthCoordinator: PushHealthCoordinator,
    private val permissionHealthCoordinator: PermissionHealthCoordinator,
    private val pushManager: FcmPushManager,
    private val phoneSetup: PhoneSetupCoordinator,
    private val restrictions: UnusedAppRestrictionsReader,
    /** What this build reports about itself, for the About section. */
    val appVersion: AppVersionInfo,
) : ViewModel() {

    /**
     * Delivery health for this phone's own sources. The same app-wide holder
     * the Sources screen reads, so a retry started on either screen is one
     * operation and both report the same thing.
     */
    val pushHealth: StateFlow<PushHealthUiState> = pushHealthCoordinator.state
    val permissionHealth: StateFlow<List<PermissionHealthEntry>> = permissionHealthCoordinator.state
    private val _notificationHealth = MutableStateFlow(pushManager.deliveryHealth())
    val notificationHealth: StateFlow<String> = _notificationHealth
    val pushConfigured: Boolean get() = pushManager.configured
    val pushPlan = session.pushPlan
    val pushRegistrationFailed = session.pushRegistrationFailed
    val pushAppId: String get() = BuildConfig.APPLICATION_ID

    private val _phoneSetupSummary = MutableStateFlow(phoneSetup.summary())

    /** How many of this phone's sources are on, for the row that reopens phone setup. */
    val phoneSetupSummary: StateFlow<PhoneSetupSummary> = _phoneSetupSummary

    /**
     * Whether the session can run phone setup: it names this device, so the
     * flow has somewhere to remember what it did. Until then its row is disabled.
     */
    val phoneSetupReady: StateFlow<Boolean> = session.state
        .map { readPhoneSetupReady() }
        .stateIn(viewModelScope, SharingStarted.Eagerly, readPhoneSetupReady())

    /** Whether Android may pause Omnesis when it goes unused; null where the phone has no such restriction. */
    val backgroundSyncing: StateFlow<BackgroundSyncingState?> = restrictions.status
        .map(::backgroundSyncingState)
        .stateIn(viewModelScope, SharingStarted.Eagerly, backgroundSyncingState(restrictions.status.value))

    /** Whether the "Turn on notifications" button may ask Android now. */
    fun notificationPromptAvailable(): Boolean = notificationPromptAvailableFor(pushManager.notificationPermissionState())

    /** Android answered the notification prompt this screen raised. */
    fun onNotificationPermissionAnswered() {
        pushManager.markNotificationPermissionPrompted()
        _notificationHealth.value = pushManager.deliveryHealth()
        viewModelScope.launch {
            session.reportNotificationHealth()
            session.retryFcmRegistration()
        }
    }

    /** The system screen for "Pause app activity if unused", when this phone has one. */
    fun backgroundSyncingIntent(): Intent? = runCatching { restrictions.manageIntent() }.getOrNull()

    init {
        pushHealthCoordinator.refresh()
        permissionHealthCoordinator.refresh()
    }

    fun retryDelivery() = pushHealthCoordinator.retry()

    fun retryPushSetup() {
        session.beginForegroundVisit()
        viewModelScope.launch { session.retryFcmRegistration() }
    }

    fun discardUndelivered() = pushHealthCoordinator.discardUndelivered()

    fun repairPermission(context: Context, sourceId: String, capabilityId: String) {
        val intended = permissionHealthCoordinator.repairIntent(context, sourceId, capabilityId) ?: return
        runCatching { context.startActivity(intended) }.onFailure {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", context.packageName, null)
            })
        }
    }

    fun openNotificationSettings(context: Context) {
        context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
    }

    fun refreshPermissions() {
        _notificationHealth.value = pushManager.deliveryHealth()
        permissionHealthCoordinator.refresh()
        _phoneSetupSummary.value = phoneSetup.summary()
        viewModelScope.launch { restrictions.refresh() }
    }

    private fun readPhoneSetupReady(): Boolean = !session.session?.pairing?.deviceId.isNullOrBlank()

    /** Display name for a source id, resolved through the catalog — never spelled out here. */
    fun sourceLabel(sourceId: String): String = catalog.label(sourceId)

    /** "412 events" / "1 event", from the provider's own unit noun. */
    fun sourceUnitLabel(sourceId: String, count: Int): String = catalog.unitLabel(sourceId, count)

    data class GatewayInfo(
        val name: String,
        val url: String,
        val deviceId: String,
        val scopes: List<String>,
        val tlsMode: PairingTlsMode = PairingTlsMode.LEGACY,
    )

    val gateway: StateFlow<GatewayInfo?> = session.state
        .map { state ->
            (state as? SessionManager.AppState.Paired)?.pairing?.let { p ->
                GatewayInfo(
                    name = p.gatewayName?.takeIf { it.isNotBlank() } ?: "Gateway",
                    url = p.url,
                    deviceId = p.deviceId ?: "—",
                    scopes = p.scopes,
                    tlsMode = p.tlsMode,
                )
            }
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    /** Live socket connection state, or a disconnected placeholder when unpaired. */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    val connection: StateFlow<ConnectionState> = session.state
        .flatMapLatest { state ->
            if (state is SessionManager.AppState.Paired) {
                session.session?.socket?.state ?: flowOf(ConnectionState.Disconnected)
            } else {
                flowOf(ConnectionState.Disconnected)
            }
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, ConnectionState.Disconnected)

    val appearanceMode = appearance.mode

    fun setAppearance(mode: AppearanceMode) = appearance.set(mode)

    /** Swap the gateway URL (LAN ↔ Tailscale ↔ IP) without re-pairing; rebuilds clients. */
    fun updateUrl(url: String): String? = runCatching {
        session.updateGatewayUrl(url.trim())
    }.fold(
        onSuccess = { null },
        onFailure = { it.message ?: "Invalid gateway URL" },
    )

    fun unpair(onComplete: () -> Unit) {
        session.unpair()
        onComplete()
    }

    /** Wipe the token and return to the pairing surface to scan a fresh code. */
    fun repair() = session.beginRepair()

    /** A gateway-dictation switch write in flight, or what it left behind. */
    private val voiceWrite = MutableStateFlow(VoiceWrite())

    /** The Voice section, or null to hide it: shown while the gateway offers the switch. */
    val voice: StateFlow<VoiceSettingsState?> = combine(
        session.dictation,
        session.state,
        voiceWrite,
    ) { dictation, appState, write ->
        voiceSettingsState(dictation, write, paired = appState is SessionManager.AppState.Paired)
    }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    /**
     * Switches gateway dictation for every paired device, then re-reads the gateway's
     * verdict. When the write landed but the re-read failed, the switch keeps the value
     * just written rather than snapping back to a status known to be out of date.
     */
    fun setTranscribeOnGateway(enabled: Boolean) {
        val current = session.session ?: return
        if (voiceWrite.value.pending != null) return
        voiceWrite.value = VoiceWrite(pending = enabled)
        viewModelScope.launch {
            try {
                current.admin.setTranscribeOnGateway(enabled)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                voiceWrite.value = VoiceWrite(error = classifyGatewayError(e))
                return@launch
            }
            voiceWrite.value = if (session.refreshStatus()) {
                VoiceWrite()
            } else {
                VoiceWrite(saved = enabled, savedOver = session.dictation.value)
            }
        }
    }
}

/** What the Voice section shows. */
data class VoiceSettingsState(
    /** The switch position: the gateway's setting, or the value being or just written. */
    val transcribeOnGateway: Boolean,
    /** A write is in flight; the switch waits for it. */
    val saving: Boolean = false,
    /** Whether a gateway is paired to write the setting to. */
    val canChange: Boolean = true,
    /**
     * Why notes still carry only the phone's transcript although the switch is on —
     * the transcriber cannot run. Null when nothing stands in the way, or while the
     * status it comes from is being rewritten.
     */
    val blockedReason: String? = null,
    /** The setting was saved but the gateway's status could not be re-read. */
    val notice: String? = null,
    /** The last write failed. */
    val error: String? = null,
)

/**
 * The switch's own write state. [saved] is a value the gateway accepted while its
 * status could not be re-read; it holds only as long as the status is still the one it
 * was saved over ([savedOver]), so the next status the gateway reports wins.
 */
internal data class VoiceWrite(
    val pending: Boolean? = null,
    val error: String? = null,
    val saved: Boolean? = null,
    val savedOver: DictationStatusDto? = null,
)

internal fun voiceSettingsState(
    dictation: DictationStatusDto?,
    write: VoiceWrite,
    paired: Boolean = true,
): VoiceSettingsState? {
    if (dictation?.visible != true) return null
    val saved = write.saved?.takeIf { write.savedOver == dictation }
    val statusCurrent = write.pending == null && saved == null
    return VoiceSettingsState(
        transcribeOnGateway = write.pending ?: saved ?: dictation.enabled,
        saving = write.pending != null,
        canChange = paired,
        blockedReason = if (statusCurrent && dictation.enabled && !dictation.modelAssigned) {
            dictation.reason?.trim()?.takeIf { it.isNotEmpty() }?.let(::asSentence) ?: "No transcriber model can run."
        } else {
            null
        },
        notice = if (saved != null) "Saved. Your gateway's status will update when it can be read." else null,
        error = write.error,
    )
}

private fun asSentence(text: String): String = if (text.last() in ".!?") text else "$text."
