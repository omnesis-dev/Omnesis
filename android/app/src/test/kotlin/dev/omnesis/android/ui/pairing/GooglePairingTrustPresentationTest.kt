// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class GooglePairingTrustPresentationTest {
    @get:Rule val compose = createComposeRule()

    @Test fun public_key_confirmation_explains_renewal_without_relabeling_legacy_certificate_pins() {
        val kind = mutableStateOf(PairingViewModel.TrustKind.PinnedKey)
        val pairing = mutableStateOf(false)
        var confirms = 0
        var cancels = 0
        compose.setContent {
            OmnesisTheme {
                PairingConfirmationSheet(
                    hostAndPort = "synthetic.gateway.example",
                    versionLabel = "Verified gateway public key (V4)",
                    trustKind = kind.value,
                    fingerprint = if (kind.value in listOf(PairingViewModel.TrustKind.PinnedKey, PairingViewModel.TrustKind.PinnedLeaf)) "ab".repeat(32) else null,
                    pairing = pairing.value,
                    onCancel = { cancels++ }, onConfirm = { confirms++ }, modifier = Modifier.fillMaxSize(),
                )
            }
        }
        compose.onNodeWithText("PUBLIC KEY FINGERPRINT").assertExists()
        compose.onNodeWithText("Certificate renewals using this key remain trusted.", substring = true).assertExists()
        compose.onNodeWithTag("pairing.confirm").assertIsEnabled().performClick()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(1, confirms); assertEquals(1, cancels)
        compose.runOnIdle { pairing.value = true }
        compose.onNodeWithTag("pairing.confirm").assertIsNotEnabled()
        compose.runOnIdle { kind.value = PairingViewModel.TrustKind.PinnedLeaf }
        compose.onNodeWithText("FINGERPRINT").assertExists()
        compose.onNodeWithText("PUBLIC KEY FINGERPRINT").assertDoesNotExist()
        compose.onNodeWithText("Certificate renewals using this key remain trusted.", substring = true).assertDoesNotExist()
        compose.runOnIdle { kind.value = PairingViewModel.TrustKind.System }
        compose.onNodeWithText("TLS TRUST").assertExists()
        compose.onNodeWithText("System WebPKI").assertExists()
        compose.runOnIdle { kind.value = PairingViewModel.TrustKind.Legacy }
        compose.onNodeWithText("Not pinned (legacy payload)").assertExists()
    }
}
