// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SourceFilterPagingInteractionTest {
    @get:Rule val compose = createComposeRule()
    private val folders = readyField("extra.folderId", FilterRef.TREE, "folder", "folders", picker = "tree", insideText = "Includes the folders inside.")
    private val people = peopleField("email")
    private val source = AccessSourceInstance("files:viewer@example.org", "Files", filterable = true)
    private val initial = SourceFilter(source.id, FilterAudience("saved", "direct"), listOf(FilterRule(listOf(FilterRef.item(FilterRef.TREE, "extra.folderId", "folder-1")), "share")), "hide")
    private val navigation = SourceFilterPickerState("extra.folderId")
    private var reads = 0
    private var failedSecondPage = false
    private var previews = 0
    private var applied: SourceFilter? = null
    private val gateway = FakeFilterGateway(
        editorFor = { FilterEditor(it, "files", fields = listOf(folders, people)) },
        previewFor = { policy ->
            previews++
            readyPreview(source.id, 65, 2, policy.rules.flatMap { it.match }.map { FilterPreviewItem(it, it.label ?: "Folder ${it.id!!.substringAfterLast('-')}", 1) })
        },
        optionsFor = { request ->
            reads++
            if (request.cursor != null && !failedSecondPage) { failedSecondPage = true; error("Temporary choices failure") }
            val range = if (request.cursor == null) 1..50 else 51..65
            val field = if (request.field == folders.field) folders else people
            FilterOptions(request.sourceId, request.field, range.map { index ->
                val label = if (field == folders) "Folder $index" else "Person $index"
                FilterOption(if (field == people) FilterRef.person(label, listOf(FilterIdentifier("email", "reader$index@example.org")))
                    else FilterRef.item(FilterRef.TREE, folders.field, "${request.parentId ?: "root"}-$index"), label, label, 1, hasChildren = field == folders)
            }, nextCursor = if (request.cursor == null) "page-two" else null).also { assertProviderWireOptions(it, field, source.id) }
        },
    )
    private fun show() {
        var open by mutableStateOf(true)
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            if (open) SourceFilterEditor(source, "saved", "direct", initial, true, gateway, onClose = { open = false }, navigation = navigation) { applied = it }
            else TextButton(onClick = { open = true }) { Text("Reopen filter") }
        } } }
        compose.onNodeWithText("Continue").performClick()
    }
    private fun scrollTo(text: String) = compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(text, substring = false))
    private fun anchor(): Pair<Int, Int> = navigation.listState.let { it.firstVisibleItemIndex to it.firstVisibleItemScrollOffset }

    @Test fun realSecondPageAndViewportSurviveReviewQueryKindTrailAndCloseReopen() {
        show()
        scrollTo("Load more")
        compose.onNodeWithText("Load more").performClick()
        compose.onNodeWithText("Try again").performClick()
        scrollTo("Folder 58")
        compose.onNodeWithText("Folder 58", substring = false).performClick()
        lateinit var position: Pair<Int, Int>
        compose.runOnIdle { position = anchor(); assertEquals(65, navigation.options!!.items.size); assertNull(navigation.options!!.nextCursor) }
        compose.onNodeWithText("Review filter").performClick()
        compose.onNodeWithText("Back", substring = false).performClick()
        compose.runOnIdle { assertEquals(position, anchor()); assertEquals(3, reads) }
        compose.onNodeWithContentDescription("Search folders").performTextInput("new")
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Search folders").performTextClearance()
        compose.runOnIdle { assertEquals(position, anchor()); assertEquals(65, navigation.options!!.items.size) }
        compose.onNodeWithText("People", substring = false).performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Folders", substring = false).performClick()
        compose.runOnIdle { assertEquals(position, anchor()); assertEquals(65, navigation.options!!.items.size) }
        compose.onNodeWithContentDescription("Open Folder 58").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("All folders", substring = false).performClick()
        compose.runOnIdle { assertEquals(position, anchor()); assertEquals(65, navigation.options!!.items.size) }
        compose.onNodeWithText("Cancel", substring = false).performClick()
        compose.onNodeWithText("Reopen filter").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.runOnIdle { assertEquals(position, anchor()); assertEquals(65, navigation.options!!.items.size) }
        // Canceled selections are not a navigation hint and must not leak into the new editor.
        compose.onNodeWithText("1 selected").assertExists()
        val beforeReview = previews
        compose.onNodeWithText("Review filter").performClick()
        compose.waitForIdle()
        compose.runOnIdle { assertTrue(previews > beforeReview); assertNull(applied) }
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(initial, applied)
    }
}
