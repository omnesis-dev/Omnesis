// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.ui.pairing.AccountCloudPairingPane
import dev.omnesis.android.ui.pairing.AccountPairingPhase
import dev.omnesis.android.ui.pairing.AccountPairingState
import dev.omnesis.android.ui.pairing.LocalPairingClock
import dev.omnesis.android.ui.pairing.PREVIEW_PAIRING_NOW
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
                CompositionLocalProvider(LocalInspectionMode provides true, LocalPairingClock provides { PREVIEW_PAIRING_NOW }) {
                    // Idle and failed are the sign-in choices, where a sign-in starts and where it ends when it fails.
                    OmnesisTheme(darkTheme = dark) { AccountCloudPairingPane(accountPairingPreviewState(phase), true, true, {}, {}, {}, {}, choosingSignIn = true) }
                }
            }
        }
    }
    @Test fun approval_and_large_text_keep_the_complete_code_visible() {
        for (dark in listOf(false, true)) for (large in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/account-pairing-approved-${if (large) "large" else "normal"}-${if (dark) "dark" else "light"}.png") {
                val density = LocalDensity.current
                CompositionLocalProvider(LocalInspectionMode provides true, LocalPairingClock provides { PREVIEW_PAIRING_NOW }, LocalDensity provides Density(density.density, if (large) 1.6f else 1f)) {
                    OmnesisTheme(darkTheme = dark) { AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Comparing).copy(approved = true), true, true, {}, {}, {}, {}) }
                }
            }
        }
    }
    /** M6: an approval from a gateway this phone verified continues by itself, with no button to press. */
    @Test fun approved_on_a_verified_gateway_connects_on_its_own() {
        for (dark in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/account-pairing-approved-continuing-${if (dark) "dark" else "light"}.png") {
                CompositionLocalProvider(LocalInspectionMode provides true, LocalPairingClock provides { PREVIEW_PAIRING_NOW }) {
                    OmnesisTheme(darkTheme = dark) {
                        AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Pairing).copy(continues = true), true, true, {}, {}, {}, {})
                    }
                }
            }
        }
    }
    @Test fun the_pairing_entry_offers_one_cloud_account_button_and_direct_pairing() {
        for (dark in listOf(false, true)) for (large in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/account-pairing-entry-${if (large) "large" else "normal"}-${if (dark) "dark" else "light"}.png") {
                pairingScreen(dark, large, PairingViewModel.State(mode = PairingViewModel.Mode.Account, googleAvailable = true, passkeyAvailable = true, account = AccountPairingState()))
            }
        }
    }

    @Test fun the_cloud_account_button_opens_the_choice_of_google_or_a_passkey() {
        for (dark in listOf(false, true)) for (large in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/account-pairing-choices-${if (large) "large" else "normal"}-${if (dark) "dark" else "light"}.png") {
                pairingScreen(dark, large, PairingViewModel.State(mode = PairingViewModel.Mode.Account, googleAvailable = true, passkeyAvailable = true, account = AccountPairingState(), choosingSignIn = true))
            }
        }
    }

    /** A build without Google's client IDs signs in with a passkey alone. */
    @Test fun a_build_without_google_offers_only_the_passkey() {
        for (dark in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/account-pairing-choices-passkey-only-${if (dark) "dark" else "light"}.png") {
                pairingScreen(dark, large = false, PairingViewModel.State(mode = PairingViewModel.Mode.Account, googleAvailable = false, passkeyAvailable = true, account = AccountPairingState(), choosingSignIn = true))
            }
        }
    }

    @Composable
    private fun pairingScreen(dark: Boolean, large: Boolean, state: PairingViewModel.State) {
        val density = LocalDensity.current
        CompositionLocalProvider(LocalInspectionMode provides true, LocalPairingClock provides { PREVIEW_PAIRING_NOW }, LocalDensity provides Density(density.density, if (large) 1.6f else 1f)) {
            OmnesisTheme(darkTheme = dark) {
                PairingContent(
                    state = state,
                    onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
                    onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
                )
            }
        }
    }
}
