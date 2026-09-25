// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.feature.health.HealthCategory
import dev.omnesis.android.feature.health.HealthIntegration
import dev.omnesis.android.feature.health.HealthSessionProvider
import dev.omnesis.android.feature.health.HealthSettings
import dev.omnesis.android.feature.health.HealthSyncCoordinator
import dev.omnesis.android.feature.health.HealthTypeCatalog
import dev.omnesis.android.feature.health.enabledHealthTypePermissions
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.feature.health.di.HealthConnectStatusReader
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.HealthConnectFeatures
import javax.inject.Inject
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.SourceSyncStatusReader
import dev.omnesis.android.transport.dto.SourceSyncStatus

/**
 * Backs the Health Connect settings section. State is a snapshot of
 * [HealthSettings] plus the on-device provider status; sync runs go through
 * the live session's [HealthSyncCoordinator] obtained via
 * [HealthSessionProvider], and turning it off cancels the background worker
 * through [HealthIntegration]. Turning it on belongs to its phone setup page,
 * which the section opens.
 */
@HiltViewModel
class HealthViewModel @Inject constructor(
    private val settings: HealthSettings,
    private val integration: HealthIntegration,
    private val status: HealthConnectStatusReader,
    private val sessions: HealthSessionProvider,
    private val permissionHealth: PermissionHealthCoordinator,
    private val membership: SourceMembership,
    private val syncStatusReader: SourceSyncStatusReader,
) : ViewModel() {

    data class UiState(
        val availability: HealthConnectAvailability = HealthConnectAvailability.NotSupported,
        val enabled: Boolean = false,
        val enabledCategories: Set<HealthCategory> = HealthCategory.entries.toSet(),
        /** Granted permissions out of [totalPermissions] (the full consent ask). */
        val grantedPermissions: Int = 0,
        val totalPermissions: Int = HealthTypeCatalog.allPermissionsToRequest.size,
        val grantedTypePermissions: Int = 0,
        val totalTypePermissions: Int = HealthTypeCatalog.perTypeReadPermissions.size,
        val backgroundAccessGranted: Boolean = false,
        val historyAccessGranted: Boolean = false,
        val backgroundAccessSupported: Boolean = false,
        val historyAccessSupported: Boolean = false,
        val syncing: Boolean = false,
        /** Outcome of the most recent in-app sync; null until one ran this session. */
        val lastResult: HealthSyncCoordinator.SyncResult? = null,
        /** Gateway-owned status, including background and remotely requested runs. */
        val authoritativeStatus: SourceSyncStatus? = null,
        /**
         * Why the gateway will not have this phone host the source. Set when a
         * membership resume is refused for good — the switch is put back off
         * at the same time, since the phone contributes nothing either way.
         */
        val membershipRefusal: String? = null,
        val membershipPending: String? = null,
    )

    private val _state = MutableStateFlow(
        UiState(
            enabled = settings.healthConnectEnabled,
            enabledCategories = settings.enabledCategories,
            totalPermissions = permissionsToRequest(settings.enabledCategories).size,
            totalTypePermissions = enabledHealthTypePermissions(settings, status::featureAvailable).size,
        ),
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        // Ahead of refresh(): viewModelScope dispatches on Main.immediate and
        // a StateFlow hands a new collector its current value, so a refusal
        // that already stands is in state before refresh() reads it.
        observeMembershipRefusals()
        observeAuthoritativeStatus()
        refresh()
    }

    /**
     * The refusal notice this screen shows.
     *
     * Putting the switch back off and stopping the background work is not
     * this screen's job — MembershipRefusalCoordinator does that whether or
     * not a screen is open — so all that is left here is to say why. The
     * refusal stands until the user asks again, so a screen opened long
     * afterwards still explains the switch it finds off, and clearing the
     * refusal clears the notice with it.
     */
    private fun observeMembershipRefusals() {
        viewModelScope.launch {
            membership.pending.collect { pending ->
                val op = pending.firstOrNull { it.sourceId == integration.sourceId }
                _state.update { it.copy(membershipPending = op?.intent?.pendingMessage()) }
            }
        }
        viewModelScope.launch {
            membership.refusals.collect { bySource ->
                val refused = bySource[integration.sourceId]
                _state.update {
                    if (refused == null) {
                        it.copy(membershipRefusal = null)
                    } else {
                        it.copy(enabled = if (refused.code == "SOURCE_REMOVED") settings.healthConnectEnabled else false, lastResult = null, membershipRefusal = refused.explain())
                    }
                }
            }
        }
    }

    /** Re-reads settings synchronously and the provider status (availability + grants) async. */
    fun refresh() {
        refreshAuthoritativeStatus()
        _state.update {
            it.copy(
                enabled = settings.healthConnectEnabled,
                enabledCategories = settings.enabledCategories,
            )
        }
        viewModelScope.launch {
            val availability = status.availability()
            val granted = status.grantedPermissions()
            val enabledTypePermissions = enabledHealthTypePermissions(settings, status::featureAvailable)
            val requestedPermissions = permissionsToRequest(settings.enabledCategories)
            _state.update {
                it.copy(
                    availability = availability,
                    grantedPermissions = (granted intersect requestedPermissions).size,
                    totalPermissions = requestedPermissions.size,
                    grantedTypePermissions = (granted intersect enabledTypePermissions).size,
                    totalTypePermissions = enabledTypePermissions.size,
                    backgroundAccessGranted = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in granted,
                    historyAccessGranted = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY in granted,
                    backgroundAccessSupported = status.featureAvailable(
                        HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND,
                    ),
                    historyAccessSupported = status.featureAvailable(
                        HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY,
                    ),
                )
            }
        }
        permissionHealth.refresh()
    }

    private fun observeAuthoritativeStatus() {
        viewModelScope.launch {
            try {
                syncStatusReader.observe(integration.sourceId).collect { status ->
                    _state.update {
                        it.copy(
                            authoritativeStatus = status,
                            lastResult = null,
                        )
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Keep the last useful status when the gateway is temporarily unreachable.
            }
        }
    }

    private fun refreshAuthoritativeStatus() {
        viewModelScope.launch {
            try {
                syncStatusReader.read(integration.sourceId)?.let { status ->
                    _state.update { it.copy(authoritativeStatus = status, lastResult = null) }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Preserve the last useful status until a later resume or socket event.
            }
        }
    }

    /**
     * Opt out: flip the setting off, cancel the background worker, and take
     * this device off the source's host list on the gateway.
     */
    fun disable() {
        settings.healthConnectEnabled = false
        integration.cancelBackgroundSync()
        membership.clearRefusal(integration.sourceId)
        membership.stopContributing(integration.sourceId)
        _state.update { it.copy(enabled = false, lastResult = null) }
        viewModelScope.launch { permissionHealth.refreshSource(integration.sourceId) }
    }

    fun toggleCategory(category: HealthCategory, enabled: Boolean) {
        settings.setCategory(category, enabled)
        refresh()
    }

    /** Consent set supported by this phone's installed Health Connect module. */
    fun permissionsToRequest(categories: Set<HealthCategory>): Set<String> =
        HealthTypeCatalog.permissionsToRequest(categories, status::featureAvailable)

    /**
     * One drain against the live session. No-op while unpaired
     * or when a run is already in flight (the coordinator coalesces anyway;
     * the guard just keeps the UI flag honest). Never registers a removed
     * source or rejoins a detached device: only the setup page's explicit
     * enable does that.
     */
    fun syncNow() {
        val coordinator = sessions.coordinator() ?: return
        if (_state.value.syncing) return
        _state.update { it.copy(syncing = true) }
        viewModelScope.launch {
            val result = try {
                coordinator.syncNow()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Surface unexpected failures through the same result channel.
                HealthSyncCoordinator.SyncResult.Failed(e.message ?: "sync failed", retryable = true)
            }
            _state.update { it.copy(syncing = false, lastResult = result) }
            if (result is HealthSyncCoordinator.SyncResult.SourceRemoved) {
                // The source was removed in Omnesis — the coordinator already
                // flipped the setting off; stop the background worker and
                // reflect the disabled state in the UI.
                integration.cancelBackgroundSync()
                _state.update { it.copy(enabled = false) }
            }
        }
    }
}
