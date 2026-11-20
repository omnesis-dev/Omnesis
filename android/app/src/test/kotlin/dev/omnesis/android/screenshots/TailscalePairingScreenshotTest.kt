// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.ui.pairing.PAIRING_CODE_USED_MESSAGE
import dev.omnesis.android.ui.pairing.PairingContent
import dev.omnesis.android.ui.pairing.PairingViewModel
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The pairing state for an unreachable Tailscale address. The devices waiting to join are in [DeviceApprovalsScreenshotTest]. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class TailscalePairingScreenshotTest {
    private val pending = PairingViewModel.Pending(
        hostAndPort = "maya-gateway.tail1234.ts.net:7600",
        versionLabel = "TLS-pinned (V4)",
        trustKind = PairingViewModel.TrustKind.PinnedLeaf,
        fingerprint = "a".repeat(64),
        confirm = {},
        tailnet = true,
    )

    @Test fun pairing_tailnet_unreachable_light() = capturePairing("pairing-tailnet-unreachable-light", dark = false)
    @Test fun pairing_tailnet_unreachable_dark() = capturePairing("pairing-tailnet-unreachable-dark", dark = true)
    @Test fun pairing_tailnet_retry_error_light() =
        capturePairing("pairing-tailnet-retry-error-light", dark = false, retryError = PAIRING_CODE_USED_MESSAGE)
    @Test fun pairing_tailnet_retry_error_dark() =
        capturePairing("pairing-tailnet-retry-error-dark", dark = true, retryError = PAIRING_CODE_USED_MESSAGE)

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
            )
        }

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark, content = content)
            }
        }
    }
}
