// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.BriefDismissReasonDto
import dev.omnesis.android.transport.dto.BriefKindDto
import dev.omnesis.android.transport.dto.BriefRecordDto
import java.time.Duration
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class BriefSheetsInteractionTest {
    @get:Rule val compose = createComposeRule()

    private val brief = BriefRecordDto(
        id = "brief-options",
        kind = BriefKindDto.INFO,
        title = "Review the launch checklist",
        description = "Two owners still need to confirm their steps.",
        createdAt = "2026-08-20T10:00:00Z",
    )

    @Test
    fun `detail options preserve iOS order and wrong callback payload`() {
        var dismissal: Pair<BriefDismissReasonDto, String?>? = null
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                BriefDetailSheet(
                    brief = brief,
                    openingThread = false,
                    onAsk = {},
                    onDismiss = { reason, until -> dismissal = reason to until },
                    onMoreOptions = {},
                    onDismissRequest = {},
                )
            }
        }

        compose.onNodeWithContentDescription("Brief options").performClick()
        val labels = listOf("Got it", "Snooze", "Not relevant", "Wrong", "Add a note…")
        val tops = labels.map { label ->
            compose.onNodeWithText(label).assertIsDisplayed().fetchSemanticsNode().boundsInRoot.top
        }
        assertEquals(tops.sorted(), tops)

        compose.onNodeWithText("Wrong").performClick()
        assertEquals(BriefDismissReasonDto.WRONG to null, dismissal)
    }

    @Test
    fun `detail snooze preset resolves from the interaction time`() {
        var dismissal: Pair<BriefDismissReasonDto, String?>? = null
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                BriefDetailSheet(
                    brief = brief,
                    openingThread = false,
                    onAsk = {},
                    onDismiss = { reason, until -> dismissal = reason to until },
                    onMoreOptions = {},
                    onDismissRequest = {},
                )
            }
        }

        compose.onNodeWithContentDescription("Brief options").performClick()
        compose.onNodeWithText("Snooze").performClick()
        val before = Instant.now()
        compose.onNodeWithText("Later today").performClick()
        val after = Instant.now()

        assertEquals(BriefDismissReasonDto.SNOOZED, dismissal?.first)
        val resolved = Instant.parse(requireNotNull(dismissal?.second))
        assertTrue(!resolved.isBefore(before.plus(Duration.ofHours(3))))
        assertTrue(!resolved.isAfter(after.plus(Duration.ofHours(3))))
    }

    @Test
    fun `dismiss form exposes lower snooze correction and confirmation controls`() {
        data class Confirmation(
            val reason: BriefDismissReasonDto,
            val feedback: String?,
            val snoozeUntil: String?,
        )
        var confirmation: Confirmation? = null
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                BriefDismissSheet(
                    brief = brief,
                    initialReason = BriefDismissReasonDto.SNOOZED,
                    onConfirm = { reason, feedback, snoozeUntil ->
                        confirmation = Confirmation(reason, feedback, snoozeUntil)
                    },
                    onDismissRequest = {},
                )
            }
        }

        compose.onNodeWithText("Pick a time").fetchSemanticsNode()
        compose.onNodeWithText("Let the agent decide").performScrollTo().performClick()
        compose.onNodeWithTag("briefDismissFeedback").performScrollTo()
            .performTextInput("The owner confirmed the revised schedule")
        compose.onNodeWithTag("briefDismissConfirm").performScrollTo().performClick()

        assertEquals(BriefDismissReasonDto.SNOOZED, confirmation?.reason)
        assertEquals("The owner confirmed the revised schedule", confirmation?.feedback)
        assertEquals(null, confirmation?.snoozeUntil)
    }
}
