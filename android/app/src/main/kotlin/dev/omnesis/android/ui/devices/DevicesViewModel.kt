// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.DeviceRecord
import dev.omnesis.android.transport.dto.NetworkIdentity
import dev.omnesis.android.transport.dto.PendingPairing
import dev.omnesis.android.transport.dto.TokenRecord
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.reloading
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

internal class DevicesPairRequestGate {
    private var sheetGeneration = 0L
    private var qrGeneration = 0L

    fun beginSheet(): Long = ++sheetGeneration
    fun closeSheet() {
        sheetGeneration += 1
        qrGeneration += 1
    }
    fun ownsSheet(generation: Long): Boolean = sheetGeneration == generation
    fun currentSheet(): Long = sheetGeneration
    fun beginQr(): Long = ++qrGeneration
    fun ownsQr(sheet: Long, qr: Long): Boolean = ownsSheet(sheet) && qrGeneration == qr
}

/**
 * Device-management view-model. Lists paired devices, fetches a device's tokens
 * lazily on row-expand, and drives the mutating surfaces: revoke a token, revoke
 * a device, forget a revoked device, and pair a new device (one-time code + QR).
 * Credentials with custom scopes are issued from the CLI, not from here. All
 * transport is admin-scoped (the `/admin` routes); paired apps hold admin scope.
 *
 * Mutations follow the refresh-after-mutation + last-action-wins notice pattern:
 * on success the affected list is reloaded and a green notice surfaces; on
 * failure nothing is mutated locally and a red notice surfaces.
 */
@HiltViewModel
class DevicesViewModel @Inject constructor(
    private val session: SessionManager,
) : ViewModel() {

    private val _devices = MutableStateFlow<Loadable<List<DeviceRecord>>>(Loadable.Loading)
    val devices = _devices.asStateFlow()

    /** Per-device token state, keyed by deviceId. Absent until the row expands. */
    private val _tokens = MutableStateFlow<Map<String, Loadable<List<TokenRecord>>>>(emptyMap())
    val tokens = _tokens.asStateFlow()

    /** This app's own device id — pins the "This device" card. */
    private val _thisDeviceId = MutableStateFlow<String?>(null)
    val thisDeviceId = _thisDeviceId.asStateFlow()

    /** Last-action-wins notice banner (green ok / red error). */
    private val _notice = MutableStateFlow<Notice?>(null)
    val notice = _notice.asStateFlow()

    /** Pair sheet state. */
    private val _pair = MutableStateFlow<PairState?>(null)
    val pair = _pair.asStateFlow()
    private val pairRequests = DevicesPairRequestGate()

    /**
     * A mutation's result. [deviceId] is the card the message belongs to: a
     * refusal is rendered inside that device's card, because the only
     * affordance that can produce one — Forget, on a revoked device — sits in
     * a collapsed group at the bottom of the list, far below a banner pinned
     * to the top of it. A message about no single card — a success, which
     * removes or rewrites the row it concerned — has none and rides the banner.
     */
    data class Notice(val ok: Boolean, val text: String, val deviceId: String? = null)

    /** State for the pair-a-device sheet. */
    data class PairState(
        /** Origin passed verbatim to the supported agent-harness connect commands. */
        val gatewayUrl: String? = null,
        val identities: List<NetworkIdentity> = emptyList(),
        val selectedHostIdx: Int = 0,
        val submitting: Boolean = false,
        val error: String? = null,
        val pending: PendingPairing? = null,
        /** The kind the pending code was minted for — gates the QR vs. code-only result. */
        val kind: String? = null,
        val qrPayload: String? = null,
        val qrError: String? = null,
        val repairTarget: DeviceRecord? = null,
    )

    init {
        load()
    }

    fun load() {
        _devices.update { it.reloading() }
        // A device list reload invalidates cached tokens — clear so a re-expand refetches.
        _tokens.update { emptyMap() }
        _thisDeviceId.update { runCatching { session.requireSession().pairing.deviceId }.getOrNull() }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.devices() }
                .fold(
                    // Newest-paired first, matching the portal's createdAt-desc order.
                    onSuccess = { list ->
                        _devices.update { Loadable.Content(list.sortedByDescending { it.pairedAt }) }
                    },
                    onFailure = { e -> _devices.update { Loadable.Error(e) } },
                )
        }
    }

    fun dismissNotice() = _notice.update { null }

    /**
     * Fetch a device's tokens the first time its row expands. Cached after, so
     * collapsing + re-expanding doesn't re-hit the gateway; [load] clears the cache.
     */
    fun loadTokens(deviceId: String) {
        if (_tokens.value.containsKey(deviceId)) return
        _tokens.update { it + (deviceId to Loadable.Loading) }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.tokens(deviceId) }
                .fold(
                    onSuccess = { list -> _tokens.update { it + (deviceId to Loadable.Content(list)) } },
                    onFailure = { e -> _tokens.update { it + (deviceId to Loadable.Error(e)) } },
                )
        }
    }

    /** Force-refetch one device's tokens after a mutation (bypasses the cache). */
    private fun reloadTokens(deviceId: String) {
        viewModelScope.launch {
            runCatching { session.requireSession().admin.tokens(deviceId) }
                .onSuccess { list -> _tokens.update { it + (deviceId to Loadable.Content(list)) } }
        }
    }

    // --- Revoke -------------------------------------------------------------

    fun revokeToken(tokenId: String, deviceId: String) {
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.revokeToken(tokenId) }
                .fold(
                    onSuccess = {
                        reloadTokens(deviceId)
                        _notice.update { Notice(true, "Token revoked.") }
                    },
                    onFailure = { e ->
                        _notice.update { Notice(false, "Revoke failed: ${gatewayMessage(e)}", deviceId) }
                    },
                )
        }
    }

    fun revokeDevice(device: DeviceRecord) {
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.revokeDevice(device.id) }
                .fold(
                    onSuccess = {
                        load()
                        _notice.update { Notice(true, "Revoked ${device.name}.") }
                    },
                    onFailure = { e ->
                        _notice.update { Notice(false, "Revoke failed: ${gatewayMessage(e)}", device.id) }
                    },
                )
        }
    }

    /**
     * Delete a revoked device's row for good. The gateway refuses while the
     * device still hosts sources; that refusal is rewritten for a phone by
     * [forgetFailure] and lands on the device's own card.
     */
    fun forgetDevice(device: DeviceRecord) {
        _notice.update { null }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.forgetDevice(device.id) }
                .fold(
                    onSuccess = {
                        load()
                        _notice.update { Notice(true, "Forgot ${device.name}.") }
                    },
                    onFailure = { e -> _notice.update { Notice(false, forgetFailure(e), device.id) } },
                )
        }
    }

    // --- Pair ---------------------------------------------------------------

    fun openPair() {
        val generation = pairRequests.beginSheet()
        val gatewayUrl = runCatching {
            session.requireSession().admin.gatewayOrigin.toString().trimEnd('/')
        }.getOrNull()
        _pair.update { PairState(gatewayUrl = gatewayUrl) }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.networkIdentities() }
                .onSuccess { ids ->
                    if (pairRequests.ownsSheet(generation)) {
                        _pair.update { it?.copy(identities = ids) }
                        if (_pair.value?.pending != null) refreshQr(generation)
                    }
                }
        }
    }

    fun openRepair(device: DeviceRecord) {
        val generation = pairRequests.beginSheet()
        val gatewayUrl = runCatching {
            session.requireSession().admin.gatewayOrigin.toString().trimEnd('/')
        }.getOrNull()
        _pair.update { PairState(gatewayUrl = gatewayUrl, repairTarget = device) }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.networkIdentities() }
                .onSuccess { ids ->
                    if (pairRequests.ownsSheet(generation)) {
                        _pair.update { it?.copy(identities = ids) }
                        if (_pair.value?.pending != null) refreshQr(generation)
                    }
                }
        }
    }

    fun closePair() {
        pairRequests.closeSheet()
        _pair.update { null }
        // A pair may have created a device — refresh the list on close.
        load()
    }

    /** The gateway grants the kind's canonical scopes; no scope set is sent. */
    fun pairDevice(kind: String) {
        if (_pair.value?.submitting != false) return
        val generation = pairRequests.currentSheet()
        val repairTarget = _pair.value?.repairTarget
        _pair.update { it?.copy(submitting = true, error = null) }
        viewModelScope.launch {
            runCatching {
                session.requireSession().admin.createPairing(kind, repairTarget?.id)
            }
                .fold(
                    onSuccess = { pending ->
                        if (!pairRequests.ownsSheet(generation)) return@fold
                        _pair.update { it?.copy(submitting = false, pending = pending, kind = kind) }
                        // Only the mobile apps consume the QR payload; a CLI/portal/
                        // collector pairs by exchanging the raw code, so don't encode one.
                        if (DeviceKindMeta.usesQr(kind)) refreshQr(generation)
                    },
                    onFailure = { e ->
                        if (!pairRequests.ownsSheet(generation)) return@fold
                        val action = if (repairTarget == null) "Pairing" else "Repair"
                        _pair.update { it?.copy(submitting = false, error = "$action failed: ${gatewayMessage(e)}") }
                    },
                )
        }
    }

    fun selectPairHost(idx: Int) {
        _pair.update { it?.copy(selectedHostIdx = idx, qrPayload = null, qrError = null) }
        val state = _pair.value ?: return
        // A host change is within the same sheet and only invalidates QR work.
        refreshQrForState(state, pairRequests.currentSheet())
    }

    /** Re-encode the QR payload for the current code + chosen host. */
    private fun refreshQr(expectedPairGeneration: Long) {
        refreshQrForState(_pair.value ?: return, expectedPairGeneration)
    }

    private fun refreshQrForState(
        state: PairState,
        expectedPairGeneration: Long,
    ) {
        val pending = state.pending ?: return
        val sheetGeneration = expectedPairGeneration
        val requestGeneration = pairRequests.beginQr()
        val pairingCode = pending.pairingCode
        val selectedHostIdx = state.selectedHostIdx
        val identities = state.identities
        val chosen = identities.getOrNull(state.selectedHostIdx.coerceIn(0, (identities.size - 1).coerceAtLeast(0)))
        if (chosen == null || chosen.address.isBlank()) {
            _pair.update { it?.copy(qrError = "no reachable address") }
            return
        }
        viewModelScope.launch {
            runCatching {
                val admin = session.requireSession().admin
                val gatewayUrl = swapHost(admin.gatewayOrigin, chosen.address)
                admin.buildPairQr(pairingCode, gatewayUrl)
            }
                .fold(
                    onSuccess = { payload ->
                        if (pairRequests.ownsQr(sheetGeneration, requestGeneration) &&
                            _pair.value?.pending?.pairingCode == pairingCode &&
                            _pair.value?.selectedHostIdx == selectedHostIdx
                        ) {
                            _pair.update { it?.copy(qrPayload = payload, qrError = null) }
                        }
                    },
                    onFailure = { e ->
                        if (pairRequests.ownsQr(sheetGeneration, requestGeneration) &&
                            _pair.value?.pending?.pairingCode == pairingCode &&
                            _pair.value?.selectedHostIdx == selectedHostIdx
                        ) {
                            _pair.update { it?.copy(qrError = gatewayMessage(e)) }
                        }
                    },
                )
        }
    }

    /**
     * The gateway refuses to delete a device that still hosts sources. Its own
     * message names the sources by id and points at a CLI command, which is
     * neither readable nor actionable on a phone: the remedy here is the
     * Sources screen. Every other refusal keeps the gateway's wording.
     */
    private fun forgetFailure(e: Throwable): String =
        if (e is GatewayException.ServerError && e.code == CODE_DEVICE_STILL_HOSTS_SOURCES) {
            "This device still hosts sources. Remove them from the Sources screen first, then forget it."
        } else {
            "Forget failed: ${gatewayMessage(e)}"
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

    private companion object {
        /**
         * The gateway's refusal code for forgetting a device that sources
         * still point at (`DELETE /admin/devices/:id?forget=true`).
         */
        const val CODE_DEVICE_STILL_HOSTS_SOURCES = "DEVICE_STILL_HOSTS_SOURCES"
    }
}
