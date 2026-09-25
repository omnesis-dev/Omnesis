// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.feature.appusage.AppUsageIntegration
import dev.omnesis.android.feature.appusage.AppUsageSessionProvider
import dev.omnesis.android.feature.appusage.AppUsageSettings
import dev.omnesis.android.feature.appusage.AppUsageSyncCoordinator
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.SourceSyncStatusReader
import dev.omnesis.android.transport.dto.SourceSyncStatus
import javax.inject.Inject
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Backs the App Usage settings section: a snapshot of [AppUsageSettings] plus
 * the current usage-access grant, manual sync runs through the live session's
 * [AppUsageSyncCoordinator] obtained via [AppUsageSessionProvider], and
 * turning App Usage off. Turning it on belongs to its phone setup page, which
 * the section opens; a usage grant this screen reads never turns it on.
 */
@HiltViewModel
class AppUsageViewModel @Inject constructor(
    private val settings: AppUsageSettings,
    private val integration: AppUsageIntegration,
    private val sessions: AppUsageSessionProvider,
    private val permissionHealth: PermissionHealthCoordinator,
    private val membership: SourceMembership,
    private val syncStatusReader: SourceSyncStatusReader,
) : ViewModel() {

    data class UiState(
        val enabled: Boolean = false,
        val hasUsageAccess: Boolean = false,
        val syncing: Boolean = false,
        /** Outcome of the most recent in-app sync; null until one ran this session. */
        val lastResult: AppUsageSyncCoordinator.SyncResult? = null,
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

    private val _state = MutableStateFlow(UiState(enabled = settings.appUsageEnabled))
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
                        it.copy(enabled = if (refused.code == "SOURCE_REMOVED") settings.appUsageEnabled else false, lastResult = null, membershipRefusal = refused.explain())
                    }
                }
            }
        }
    }

    /** Re-reads settings and the current usage-access grant. */
    fun refresh() {
        refreshAuthoritativeStatus()
        _state.update { it.copy(enabled = settings.appUsageEnabled, hasUsageAccess = integration.hasUsageAccess()) }
        permissionHealth.refresh()
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

    /**
     * Opt out: flip the setting off, cancel the background worker, and take
     * this device off the source's host list on the gateway.
     */
    fun disable() {
        settings.appUsageEnabled = false
        integration.cancelBackgroundSync()
        membership.clearRefusal(integration.sourceId)
        membership.stopContributing(integration.sourceId)
        _state.update { it.copy(enabled = false, lastResult = null) }
        viewModelScope.launch { permissionHealth.refreshSource(integration.sourceId) }
    }

    /**
     * One sync against the live session. No-op while unpaired or when a run
     * is already in flight (the coordinator coalesces anyway; the guard just
     * keeps the UI flag honest). Never registers a removed source or rejoins
     * a detached device: only the setup page's explicit enable does that.
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
                AppUsageSyncCoordinator.SyncResult.Failed(e.message ?: "sync failed", retryable = true)
            }
            _state.update { it.copy(syncing = false, lastResult = result) }
            if (result is AppUsageSyncCoordinator.SyncResult.SourceRemoved) {
                integration.cancelBackgroundSync()
                _state.update { it.copy(enabled = false) }
            }
        }
    }
}
