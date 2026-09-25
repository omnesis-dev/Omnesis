// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.components.DELETE_DOCUMENT_EXPLANATION
import dev.omnesis.android.designsystem.components.DeleteDocumentDialog
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The delete prompt keeps the copy/for-good choice. Generated Notes day
 * documents never reach it — they offer Manage notes instead. Uses
 * entirely invented documents.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeleteDocumentDialogTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun delete_prompt_keeps_the_copy_choice() {
        compose.setContent {
            OmnesisTheme(darkTheme = true) {
                DeleteDocumentDialog(
                    title = "Delete?",
                    onDismiss = {},
                    onDelete = {},
                )
            }
        }

        compose.onNodeWithText("Delete for good").assertIsDisplayed()
        compose.onNodeWithText("Delete this copy").assertIsDisplayed()
        compose.onNodeWithText(DELETE_DOCUMENT_EXPLANATION, substring = true).assertIsDisplayed()
    }
}
