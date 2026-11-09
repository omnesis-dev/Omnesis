// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.ui.pairing.AccountCloudPairingPane
import dev.omnesis.android.ui.pairing.AccountPairingPhase
import dev.omnesis.android.ui.pairing.AccountPairingState
import dev.omnesis.android.ui.pairing.PairingContent
import dev.omnesis.android.ui.pairing.PairingViewModel
import dev.omnesis.android.ui.pairing.accountPairingPreviewState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AccountCloudPairingScreenshotTest {
    @Test fun all_account_states_light_and_dark() {
        for (phase in AccountPairingPhase.entries) for (dark in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/account-pairing-${phase.name.lowercase()}-${if (dark) "dark" else "light"}.png") {
                CompositionLocalProvider(LocalInspectionMode provides true) {
                    OmnesisTheme(darkTheme = dark) { AccountCloudPairingPane(accountPairingPreviewState(phase), true, true, {}, {}, {}, {}) }
                }
            }
        }
    }
    @Test fun approval_and_large_text_keep_the_complete_code_visible() {
        for (dark in listOf(false, true)) for (large in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/account-pairing-approved-${if (large) "large" else "normal"}-${if (dark) "dark" else "light"}.png") {
                val density = LocalDensity.current
                CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density.density, if (large) 1.6f else 1f)) {
                    OmnesisTheme(darkTheme = dark) { AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Comparing).copy(approved = true), true, true, {}, {}, {}, {}) }
                }
            }
        }
    }
    @Test fun the_pairing_entry_offers_the_omnesis_account_and_direct_pairing() {
        for (dark in listOf(false, true)) for (large in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/account-pairing-entry-${if (large) "large" else "normal"}-${if (dark) "dark" else "light"}.png") {
                val density = LocalDensity.current
                CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density.density, if (large) 1.6f else 1f)) {
                    OmnesisTheme(darkTheme = dark) {
                        PairingContent(
                            state = PairingViewModel.State(mode = PairingViewModel.Mode.Google, googleAvailable = true, account = AccountPairingState(), passkeyAvailable = true),
                            onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
                            onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
                            cloudFeatures = true,
                        )
                    }
                }
            }
        }
    }
}
