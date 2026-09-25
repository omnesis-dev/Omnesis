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
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.phonesetup.BackgroundSyncingState
import dev.omnesis.android.ui.phonesetup.PhoneSetupCoordinator
import dev.omnesis.android.ui.phonesetup.PhoneSetupSummary
import dev.omnesis.android.ui.phonesetup.UnusedAppRestrictionsReader
import dev.omnesis.android.ui.phonesetup.backgroundSyncingState
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
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
}
