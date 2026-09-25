// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacyPolicyDocument
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PrivacyPolicyScreenUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val policy = PrivacyPolicyDocument(
        policy = "# Privacy policy\n\nOnly approved summaries may leave Omnesis.",
        revision = "r1",
    )

    @Test
    fun policyIsRenderedReadOnlyAndPointsEditsToThePortal() {
        show(PrivacyPolicyUiState(loading = false, policy = policy))

        compose.onAllNodesWithText("Privacy policy").onFirst().performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Only approved summaries may leave Omnesis.")
            .performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText("The policy can only be edited on the web portal.")
            .performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText("Save policy").assertDoesNotExist()
        compose.onNodeWithText(
            "Allow credentials to be released with my per-request approval",
        ).assertDoesNotExist()
    }

    /** It is reached from the Policies list and from a reviewed exchange, so its leading action pops. */
    @Test
    fun theLeadingActionGoesBack() {
        var backs = 0
        show(PrivacyPolicyUiState(loading = false, policy = policy), onBack = { backs += 1 })

        compose.onNodeWithContentDescription("Back").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, backs) }
    }

    @Test
    fun theTitleIsTheFamilyNameTheRouteCarries() {
        show(PrivacyPolicyUiState(loading = false, familyName = "Everyday policy", policy = policy))

        compose.onNodeWithText("Everyday policy").assertIsDisplayed()
    }

    /** A link that names only the family id still opens; the title then says what the screen is. */
    @Test
    fun aRouteWithoutANameFallsBackToAGenericTitle() {
        show(PrivacyPolicyUiState(loading = false, policy = policy))

        compose.onNodeWithText("Policy").assertIsDisplayed()
    }

    @Test
    fun anUnreachableGatewayOffersARetryRatherThanAnEmptyDocument() {
        var retries = 0
        show(
            PrivacyPolicyUiState(loading = false, error = IllegalStateException("offline")),
            onRetry = { retries += 1 },
        )

        compose.onNodeWithText("The policy can only be edited on the web portal.")
            .assertDoesNotExist()
        compose.onNodeWithText("Retry").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, retries) }
    }

    private fun show(
        state: PrivacyPolicyUiState,
        onBack: () -> Unit = {},
        onRetry: () -> Unit = {},
    ) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyPolicyContent(state = state, onBack = onBack, onRetry = onRetry)
            }
        }
    }
}
