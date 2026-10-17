// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.TaskDocumentDto
import dev.omnesis.android.transport.dto.TaskDto
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The task details sheet driven as a person drives it: its documents each under the icon their
 * own source resolves to, opening on tap, and History, Cancel, Save and removing the deadline
 * still doing what they say. All fixture data is invented.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class TaskEditorContentTest {

    @get:Rule val compose = createComposeRule()

    private val today = LocalDate.of(2026, 10, 14)

    private val documents = listOf(
        TaskDocumentDto("d_charge", "Stellar Sound — -12.99 GBP", "bank:current"),
        TaskDocumentDto("d_reply", "Re: Availability next week", "mail:inbox"),
        TaskDocumentDto("d_note", "", "notes:local"),
    )

    private val task = TaskDto(
        id = "t_speakers",
        title = "Call Stellar Sound about the speakers",
        accepted = true,
        scheduledFor = "2026-10-14",
        dueDay = "2026-10-16",
        documents = documents,
    )

    private val iconsAskedFor = mutableListOf<String>()
    private var opened: TaskDocumentDto? = null
    private var histories = 0
    private var cancels = 0
    private var saved: TaskEditorDraft? = null

    private fun show(withDocuments: Boolean = true) {
        compose.setContent {
            OmnesisTheme(darkTheme = true) {
                TaskEditorContent(
                    initial = TaskEditorDraft.from(task, today),
                    onCancel = { cancels++ },
                    onSave = { saved = it },
                    onHistory = { histories++ },
                    documents = if (withDocuments) task.documents else emptyList(),
                    iconFor = { sourceId ->
                        iconsAskedFor += sourceId
                        SourceIconModel()
                    },
                    onOpenDocument = { opened = it },
                )
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun each_document_is_listed_under_its_own_sources_icon() {
        show()
        compose.onNodeWithText("DOCUMENTS").assertIsDisplayed()
        compose.onAllNodesWithTag("tasks.editor.document", useUnmergedTree = true).assertCountEquals(3)
        compose.onNodeWithText("Stellar Sound — -12.99 GBP").assertIsDisplayed()
        compose.onNodeWithText("Untitled document").assertIsDisplayed()
        assertEquals(listOf("bank:current", "mail:inbox", "notes:local"), iconsAskedFor.distinct())
    }

    @Test
    fun tapping_a_document_opens_it() {
        show()
        compose.onNodeWithText("Re: Availability next week").performClick()
        assertEquals("d_reply", opened?.id)
    }

    @Test
    fun a_task_without_documents_shows_no_documents_section() {
        show(withDocuments = false)
        compose.onAllNodesWithTag("tasks.editor.document", useUnmergedTree = true).assertCountEquals(0)
        assertTrue(compose.onAllNodesWithText("DOCUMENTS").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun history_cancel_and_save_still_work() {
        show()
        compose.onNodeWithText("History").performClick()
        assertEquals(1, histories)

        compose.onNodeWithText("Cancel").performClick()
        assertEquals(1, cancels)
        assertNull(saved)

        compose.onNodeWithContentDescription("Title").performTextReplacement("Call Stellar Sound before Friday")
        compose.onNodeWithText("Save").performClick()
        assertEquals("Call Stellar Sound before Friday", saved?.title)
    }

    @Test
    fun removing_the_deadline_clears_it_from_what_is_saved() {
        show()
        compose.onNodeWithContentDescription("Remove deadline").performClick()
        compose.onNodeWithText("No deadline").assertIsDisplayed()
        compose.onNodeWithText("Save").performClick()
        assertNull(saved?.deadline)
    }
}
