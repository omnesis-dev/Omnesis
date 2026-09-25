// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.access.AccessPendingBannerOffer
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.AccessPendingRequest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The main-screen banner as a screen reader meets it: the whole card is one button whose
 * label says what a tap does, and its detail line counts the requests behind the newest.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AccessPendingRequestBannerTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun the_card_is_a_button_labelled_configure_and_approve() {
        var reviews = 0
        show(AccessPendingBannerOffer(newest = request, count = 1), onReview = { reviews++ })

        compose.onNode(reviewButton and hasText(ACCESS_PENDING_BANNER_TITLE)).assertIsDisplayed().performClick()
        assertEquals(1, reviews)
    }

    @Test
    fun one_waiting_is_named_alone() {
        show(AccessPendingBannerOffer(newest = request, count = 1))
        compose.onNodeWithText("Aurora Planner · Configure & Approve").assertIsDisplayed()
    }

    @Test
    fun several_waiting_name_the_newest_and_count_the_rest() {
        show(AccessPendingBannerOffer(newest = request, count = 3))
        compose.onNodeWithText("Aurora Planner and 2 more · Configure & Approve").assertIsDisplayed()
    }

    @Test
    fun the_close_button_dismisses_without_reviewing() {
        var reviews = 0
        var dismissals = 0
        show(AccessPendingBannerOffer(newest = request, count = 1), onReview = { reviews++ }, onDismiss = { dismissals++ })

        compose.onNodeWithContentDescription(ACCESS_PENDING_BANNER_DISMISS).performClick()
        assertEquals(1, dismissals)
        assertEquals(0, reviews)
    }

    private fun show(
        offer: AccessPendingBannerOffer,
        onReview: () -> Unit = {},
        onDismiss: () -> Unit = {},
    ) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                AccessPendingRequestBanner(offer = offer, onReview = onReview, onDismiss = onDismiss)
            }
        }
    }

    private val reviewButton = SemanticsMatcher("is a button labelled Configure & Approve") { node ->
        node.config.getOrNull(SemanticsProperties.Role) == Role.Button &&
            node.config.getOrNull(SemanticsActions.OnClick)?.label == "Configure & Approve"
    }

    private val request = AccessPendingRequest(
        id = "request_example",
        clientName = "Aurora Planner",
        userCode = "ABCD-EFGH",
        createdAt = 1_782_000_200_000,
        expiresAt = 2_000_000_000_000,
    )
}
