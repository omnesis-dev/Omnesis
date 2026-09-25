// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.pairing.PairingPayload
import dev.omnesis.android.session.SessionManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.net.URI
import javax.inject.Inject

@HiltViewModel
class PairingViewModel @Inject constructor(
    private val session: SessionManager,
) : ViewModel() {

    /** Which pairing affordance is on screen. Scanner-first, mirroring iOS `PairingView`. */
    enum class Mode { Scan, Manual }
    enum class TrustKind { System, PinnedLeaf, Legacy }

    /**
     * A decoded payload awaiting explicit user confirmation. Mirrors the iOS
     * `PairingConfirmationSheet`: we surface host + fingerprint and require a "Pair" tap
     * before any token is persisted — a malicious QR can't silently steer the app at a
     * hostile gateway. [confirm] re-runs the exchange through [SessionManager].
     */
    data class Pending(
        val hostAndPort: String,
        val versionLabel: String,
        val trustKind: TrustKind,
        /** lowercase hex SHA-256, or null for a legacy (V1/V2) payload with no pinning. */
        val fingerprint: String?,
        /** Closure that performs the actual pair when the user confirms. */
        val confirm: suspend SessionManager.() -> Unit,
    )

    data class State(
        val mode: Mode = Mode.Scan,
        val gatewayUrl: String = "",
        val pairingCode: String = "",
        val fingerprint: String = "",
        val showAdvanced: Boolean = false,
        val isPairing: Boolean = false,
        val error: String? = null,
        val pending: Pending? = null,
    ) {
        val canSubmit: Boolean get() = gatewayUrl.isNotBlank() && pairingCode.isNotBlank() && !isPairing
    }

    private val _state = MutableStateFlow(State())
    val state = _state.asStateFlow()

    fun showScanner() = _state.update { it.copy(mode = Mode.Scan, error = null) }
    fun showManualEntry() = _state.update { it.copy(mode = Mode.Manual, error = null) }

    fun onUrlChange(v: String) = _state.update { it.copy(gatewayUrl = v, error = null) }
    fun onCodeChange(v: String) = _state.update { it.copy(pairingCode = v, error = null) }
    fun onFingerprintChange(v: String) = _state.update { it.copy(fingerprint = v, error = null) }
    fun toggleAdvanced() = _state.update { it.copy(showAdvanced = !it.showAdvanced) }

    /**
     * Manual entry path (V2/V3) — builds the exchange from the typed fields and stages a
     * confirmation gate. Manual entry carries no scanned fingerprint unless the user typed
     * one in the advanced field, so it maps to the legacy "no fingerprint" confirm copy.
     */
    fun pair() {
        val s = _state.value
        if (!s.canSubmit) return
        val gatewayUrl = s.gatewayUrl.trim()
        val pairingCode = s.pairingCode.trim()
        val fingerprint = s.fingerprint.trim().ifBlank { null }?.lowercase()
        _state.update {
            it.copy(
                error = null,
                pending = Pending(
                    hostAndPort = hostAndPort(gatewayUrl),
                    versionLabel = if (fingerprint != null) "TLS-pinned HTTPS (V3)" else "HTTPS (V2)",
                    trustKind = if (fingerprint != null) TrustKind.PinnedLeaf else TrustKind.Legacy,
                    fingerprint = fingerprint,
                    confirm = { pairManually(gatewayUrl, pairingCode, fingerprint) },
                ),
            )
        }
    }

    /**
     * Camera / paste path: decode the raw QR string and stage a confirmation gate. The decode
     * also validates scheme + fingerprint shape; a decode failure falls back to the manual
     * form so the user can still pair after a bad scan. On confirm we exchange via the existing
     * [SessionManager.pairFromQr] so the payload follows the same path as a live scan.
     */
    fun pairFromQr(raw: String) {
        if (_state.value.isPairing || _state.value.pending != null) return
        val payload = runCatching { PairingPayload.decode(raw) }.getOrElse { e ->
            _state.update { it.copy(mode = Mode.Manual, error = pairingErrorMessage(e, gatewayHost = null)) }
            return
        }
        _state.update {
            it.copy(
                error = null,
                pending = Pending(
                    hostAndPort = hostAndPort(payloadUrl(payload)),
                    versionLabel = versionLabel(payload),
                    trustKind = payloadTrustKind(payload),
                    fingerprint = payloadFingerprint(payload),
                    confirm = { pairFromQr(raw) },
                ),
            )
        }
    }

    /** Dismiss the confirmation sheet without pairing. */
    fun cancelPending() = _state.update { it.copy(pending = null) }

    /**
     * Run the staged exchange after the user eyeballs host + fingerprint and taps "Pair". On
     * success SessionManager flips to Paired and RootScreen swaps this screen out; on failure
     * the manual form says in plain words what went wrong (see [pairingErrorMessage]).
     */
    fun confirmPending() {
        val pending = _state.value.pending ?: return
        if (_state.value.isPairing) return
        _state.update { it.copy(isPairing = true, error = null) }
        viewModelScope.launch {
            runCatching {
                pending.confirm(session)
            }.onFailure { e ->
                _state.update {
                    it.copy(
                        mode = Mode.Manual,
                        isPairing = false,
                        pending = null,
                        error = pairingErrorMessage(e, gatewayHost = pending.hostAndPort),
                    )
                }
            }
        }
    }

    private fun payloadUrl(payload: PairingPayload): String = when (payload) {
        is PairingPayload.V4 -> payload.gatewayUrl
        is PairingPayload.V3 -> payload.gatewayUrl
        is PairingPayload.V2 -> payload.gatewayUrl
        is PairingPayload.V1 -> payload.url
    }

    private fun payloadFingerprint(payload: PairingPayload): String? = when (payload) {
        is PairingPayload.V4 -> when (val tls = payload.tls) {
            PairingPayload.V4Tls.System -> null
            is PairingPayload.V4Tls.PinnedLeaf -> tls.fingerprint.lowercase()
        }
        is PairingPayload.V3 -> payload.fingerprint.lowercase()
        is PairingPayload.V2, is PairingPayload.V1 -> null
    }

    private fun versionLabel(payload: PairingPayload): String = when (payload) {
        is PairingPayload.V4 -> when (payload.tls) {
            PairingPayload.V4Tls.System -> "System-trusted HTTPS (V4)"
            is PairingPayload.V4Tls.PinnedLeaf -> "TLS-pinned (V4)"
        }
        is PairingPayload.V3 -> "TLS-pinned HTTPS (V3)"
        is PairingPayload.V2 -> "HTTPS (V2)"
        is PairingPayload.V1 -> "Legacy HTTPS token (V1)"
    }

    private fun payloadTrustKind(payload: PairingPayload): TrustKind = when (payload) {
        is PairingPayload.V4 -> when (payload.tls) {
            PairingPayload.V4Tls.System -> TrustKind.System
            is PairingPayload.V4Tls.PinnedLeaf -> TrustKind.PinnedLeaf
        }
        is PairingPayload.V3 -> TrustKind.PinnedLeaf
        is PairingPayload.V2, is PairingPayload.V1 -> TrustKind.Legacy
    }

    /** Render `host:port` from a URL string for the confirmation card, falling back to raw. */
    private fun hostAndPort(urlString: String): String {
        val uri = runCatching { URI(urlString) }.getOrNull() ?: return urlString
        val host = uri.host ?: return urlString
        return if (uri.port != -1) "$host:${uri.port}" else host
    }
}
