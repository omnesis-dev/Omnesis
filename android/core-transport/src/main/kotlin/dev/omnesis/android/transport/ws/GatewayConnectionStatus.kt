// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.ws

/**
 * What to tell the user about the device socket: wording only, so the copy rules can be tested
 * without rendering. Losing the internet must never read like a broken pairing. Temporary states
 * say that recovery is automatic, and advice about pairing appears only for a credential or
 * certificate refusal, or when a usable network has not reached the gateway for long enough that
 * the address itself is a likely cause.
 */
data class GatewayConnectionStatus(
    val title: String,
    val tone: Tone,
    val explanation: String? = null,
    val diagnostic: String? = null,
) {
    enum class Tone { SUCCESS, PROGRESS, WAITING, WARNING }

    companion object {
        /**
         * About half a minute of backoff on one network, long enough for a network that has just
         * come back to have settled.
         */
        const val SUSTAINED_FAILURE_ATTEMPTS = 6

        fun of(state: DeviceSocket.ConnectionState): GatewayConnectionStatus = when (state) {
            DeviceSocket.ConnectionState.Disconnected,
            DeviceSocket.ConnectionState.Connecting,
            DeviceSocket.ConnectionState.Authenticating,
            -> GatewayConnectionStatus("Connecting…", Tone.PROGRESS)

            is DeviceSocket.ConnectionState.Connected -> GatewayConnectionStatus("Connected", Tone.SUCCESS)
            is DeviceSocket.ConnectionState.Reconnecting -> reconnecting(state)
            is DeviceSocket.ConnectionState.Failed -> failed(state)
        }

        private fun reconnecting(state: DeviceSocket.ConnectionState.Reconnecting): GatewayConnectionStatus {
            if (state.network == DeviceSocket.NetworkAvailability.UNAVAILABLE) {
                return GatewayConnectionStatus(
                    title = "Waiting for network",
                    tone = Tone.WAITING,
                    explanation = "This phone is offline. Omnesis will reconnect automatically when the network returns.",
                    diagnostic = state.lastError,
                )
            }
            val base = "The gateway can't be reached right now. Omnesis keeps trying automatically."
            val advice = " Check that the gateway is running. Away from home, connect Tailscale on this phone and " +
                "the gateway. If this pairing uses a home-network address, re-pair using the gateway's Tailscale hostname."
            return GatewayConnectionStatus(
                title = "Reconnecting to gateway",
                tone = Tone.PROGRESS,
                explanation = if (state.failedAttemptsOnNetwork >= SUSTAINED_FAILURE_ATTEMPTS) base + advice else base,
                diagnostic = state.lastError,
            )
        }

        private fun failed(state: DeviceSocket.ConnectionState.Failed): GatewayConnectionStatus = when (state.kind) {
            DeviceSocket.FailureKind.AUTHENTICATION -> GatewayConnectionStatus(
                title = "Authentication failed",
                tone = Tone.WARNING,
                explanation = "The gateway rejected this device's pairing. Re-pair from Settings to continue.",
                diagnostic = state.message,
            )

            DeviceSocket.FailureKind.CERTIFICATE -> GatewayConnectionStatus(
                title = "Gateway certificate problem",
                tone = Tone.WARNING,
                explanation = "This phone refused the connection because the gateway's certificate didn't verify. " +
                    "A Wi-Fi sign-in page can cause this until you finish signing in. If the gateway's address or " +
                    "certificate changed, re-pair using a new QR code.",
                diagnostic = state.message,
            )

            DeviceSocket.FailureKind.INCOMPATIBLE -> GatewayConnectionStatus(
                title = "App and gateway don't match",
                tone = Tone.WARNING,
                explanation = "Update the app or the gateway so that both speak the same protocol.",
                diagnostic = state.message,
            )
        }
    }
}
