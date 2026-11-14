// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import dev.omnesis.android.ui.devices.TailscaleJoinRequestsContent
import dev.omnesis.android.ui.devices.TailscaleJoinRequestsViewModel
import dev.omnesis.android.ui.pairing.PAIRING_CODE_USED_MESSAGE
import dev.omnesis.android.ui.pairing.PairingContent
import dev.omnesis.android.ui.pairing.PairingViewModel
import java.time.Instant
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The pairing state for an unreachable Tailscale address, and the devices waiting to join. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class TailscaleJoinScreenshotTest {
    private val now = Instant.parse("2026-11-14T18:05:00.000Z").toEpochMilli()

    private val pending = PairingViewModel.Pending(
        hostAndPort = "maya-gateway.tail1234.ts.net:7600",
        versionLabel = "TLS-pinned (V4)",
        trustKind = PairingViewModel.TrustKind.PinnedLeaf,
        fingerprint = "a".repeat(64),
        confirm = {},
        tailnet = true,
    )

    private val requests = listOf(
        TailscaleJoinRequest(
            id = "join-1", name = "maya-laptop", kind = "collector", machine = "maya-laptop", os = "macOS",
            login = "maya@example.com", requestedAt = "2026-11-14T18:00:00.000Z", expiresAt = "2026-11-14T18:10:00.000Z",
        ),
        TailscaleJoinRequest(
            id = "join-2", name = "Studio desktop", kind = "collector", machine = "studio-desktop", os = "Linux",
            login = "maya@example.com", requestedAt = "2026-11-14T18:04:30.000Z", expiresAt = "2026-11-14T18:14:30.000Z",
        ),
    )

    @Test fun pairing_tailnet_unreachable_light() = capturePairing("pairing-tailnet-unreachable-light", dark = false)
    @Test fun pairing_tailnet_unreachable_dark() = capturePairing("pairing-tailnet-unreachable-dark", dark = true)
    @Test fun pairing_tailnet_retry_error_light() =
        capturePairing("pairing-tailnet-retry-error-light", dark = false, retryError = PAIRING_CODE_USED_MESSAGE)
    @Test fun pairing_tailnet_retry_error_dark() =
        capturePairing("pairing-tailnet-retry-error-dark", dark = true, retryError = PAIRING_CODE_USED_MESSAGE)

    @Test fun tailscale_join_two_requests_light() =
        captureJoins("tailscale-join-requests-light", dark = false, TailscaleJoinRequestsViewModel.State(requests = requests, loaded = true))
    @Test fun tailscale_join_two_requests_dark() =
        captureJoins("tailscale-join-requests-dark", dark = true, TailscaleJoinRequestsViewModel.State(requests = requests, loaded = true))
    @Test fun tailscale_join_empty_light() =
        captureJoins("tailscale-join-empty-light", dark = false, TailscaleJoinRequestsViewModel.State(loaded = true))
    @Test fun tailscale_join_empty_dark() =
        captureJoins("tailscale-join-empty-dark", dark = true, TailscaleJoinRequestsViewModel.State(loaded = true))
    @Test fun tailscale_join_gone_light() = captureJoins(
        "tailscale-join-gone-light", dark = false,
        TailscaleJoinRequestsViewModel.State(requests = requests.drop(1), loaded = true, notice = "That request expired or was already decided."),
    )

    private fun capturePairing(name: String, dark: Boolean, retryError: String? = null) =
        capture(name, dark) {
            PairingContent(
                state = PairingViewModel.State(
                    mode = PairingViewModel.Mode.Scan,
                    googleAvailable = false,
                    tailnetUnreachable = PairingViewModel.TailnetUnreachable(pending, retryError),
                ),
                onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
                onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
                cloudFeatures = false,
            )
        }

    private fun captureJoins(name: String, dark: Boolean, state: TailscaleJoinRequestsViewModel.State) =
        capture(name, dark) {
            Surface { TailscaleJoinRequestsContent(state, now, onRefresh = {}, onDecide = { _, _ -> }, onDismiss = {}) }
        }

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark, content = content)
            }
        }
    }
}
