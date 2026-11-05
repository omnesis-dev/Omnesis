// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class GoogleCloudPairingPaneTest {
    @get:Rule val compose = createComposeRule()
    private val code = "A1B2-C3D4-E5F6-0718-293A"

    @Test fun requester_controls_deliver_real_callbacks_and_keep_pairing_and_cancel_gates() {
        val state = mutableStateOf(googlePairingPreviewState(PairingViewModel.GooglePhase.Idle))
        var signIns = 0
        var comparisons = 0
        var pairs = 0
        var cancellations = 0
        compose.setContent {
            OmnesisTheme {
                content(state.value, onCancel = { cancellations++ }, onSignIn = { signIns++ },
                    onCompare = { comparisons++; state.value = state.value.copy(googleCompared = true, googlePhase = PairingViewModel.GooglePhase.Waiting) },
                    onPair = { pairs++ })
            }
        }
        compose.onNodeWithText("Sign in with Google").performScrollTo()
        compose.onNodeWithTag("google.signIn.mark", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Sign in with Google").performClick()
        assertEquals(1, signIns)
        compose.runOnIdle { state.value = googlePairingPreviewState(PairingViewModel.GooglePhase.Comparing) }
        compose.onNodeWithText("gateway.example.test").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(code).performScrollTo().assertTextEquals(code)
        compose.onNodeWithTag("pairing.google.pair").assertDoesNotExist()
        compose.onNodeWithTag("pairing.google.confirmCode").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(1, comparisons)
        compose.onNodeWithTag("pairing.google.confirmCode").assertDoesNotExist()
        compose.onNodeWithText("Waiting for approval on your gateway…").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("pairing.google.pair").assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(googlePhase = PairingViewModel.GooglePhase.Ready) }
        compose.onNodeWithTag("pairing.google.pair").performScrollTo().assertIsEnabled().performClick()
        assertEquals(1, pairs)
        compose.runOnIdle { state.value = state.value.copy(googlePhase = PairingViewModel.GooglePhase.Pairing) }
        compose.onNodeWithTag("pairing.google.pair").assertDoesNotExist()
        compose.onNodeWithText("Cancel").assertIsNotEnabled()
        assertEquals(0, cancellations)
        compose.runOnIdle { state.value = googlePairingPreviewState(PairingViewModel.GooglePhase.Failed) }
        compose.onNodeWithText("Try Google sign-in again").performScrollTo().performClick()
        assertEquals(2, signIns)
        compose.onNodeWithText("Cancel").assertIsEnabled().performClick()
        assertEquals(1, cancellations)
    }

    @Test fun every_requester_phase_and_both_error_messages_are_visible_without_provider_network() {
        val state = mutableStateOf(googlePairingPreviewState(PairingViewModel.GooglePhase.Idle))
        compose.setContent { OmnesisTheme { GoogleCloudPairingPane(state.value, {}, {}, {}) } }
        val messages = listOf(
            PairingViewModel.GooglePhase.Idle to "Sign in with Google",
            PairingViewModel.GooglePhase.SigningIn to "Complete sign-in with the Google account picker.",
            PairingViewModel.GooglePhase.Finding to "Finding your gateway…",
            PairingViewModel.GooglePhase.Comparing to "Compare the code before continuing.",
            PairingViewModel.GooglePhase.Waiting to "Waiting for approval on your gateway…",
            PairingViewModel.GooglePhase.Ready to "Code compared and gateway approved.",
            PairingViewModel.GooglePhase.Pairing to "Pairing…",
            PairingViewModel.GooglePhase.Failed to "Could not pair securely. Check the gateway and try again, or scan its QR code.",
        )
        for ((phase, message) in messages) {
            compose.runOnIdle { state.value = googlePairingPreviewState(phase) }
            compose.onNodeWithText(message).performScrollTo().assertIsDisplayed()
        }
        compose.runOnIdle { state.value = state.value.copy(error = null) }
        compose.onNodeWithText("Pairing did not complete.").performScrollTo().assertIsDisplayed()
    }

    @Test fun large_text_preserves_every_complete_code_group_and_returns_to_normal_code_layout() {
        val fontScale = mutableStateOf(2f)
        val state = mutableStateOf(googlePairingPreviewState(PairingViewModel.GooglePhase.Ready))
        compose.setContent {
            val density = LocalDensity.current.density
            CompositionLocalProvider(LocalDensity provides Density(density, fontScale = fontScale.value)) {
                OmnesisTheme { GoogleCloudPairingPane(state.value, {}, {}, {}) }
            }
        }
        for (group in code.split('-')) compose.onNodeWithText(group).performScrollTo().assertTextEquals(group)
        compose.onNodeWithText(code).assertDoesNotExist()
        compose.onNodeWithTag("pairing.google.pair").performScrollTo().assertIsEnabled()
        compose.runOnIdle { fontScale.value = 1f; state.value = googlePairingPreviewState(PairingViewModel.GooglePhase.Comparing) }
        compose.onNodeWithText(code).performScrollTo().assertTextEquals(code)
        compose.onNodeWithTag("pairing.google.confirmCode").performScrollTo().assertIsEnabled()
    }

    @Composable private fun content(state: PairingViewModel.State, onCancel: () -> Unit,
                                    onSignIn: () -> Unit, onCompare: () -> Unit, onPair: () -> Unit) {
        PairingContent(state = state, onBack = onCancel, onShowScanner = {}, onShowManual = {}, onQrCode = {},
            onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
            onGoogleSignIn = onSignIn, onGoogleCompare = onCompare, onGooglePair = onPair)
    }
}
