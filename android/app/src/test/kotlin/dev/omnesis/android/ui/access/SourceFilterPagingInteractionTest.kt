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
    private val scopes = SourceScopes(listOf(
        SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("folder", "folders"), picker = "tree"),
        SourceScopeItem("participant", "identity", noun = SourceScopeNoun("person", "people")),
    ), 3)
    private val readiness = listOf(ScopeKindReadiness("folder", true), ScopeKindReadiness("participant", true))
    private val source = AccessSourceInstance("files:viewer@example.org", "Files", scopes = scopes, scopeReadiness = readiness)
    private val initial = ScopePolicy(source.id, ScopeAudience("saved", "direct"), listOf(ScopeRule(listOf(ScopeRef("folder", "folder-1")), "share")), "hide")
    private val navigation = SourceFilterPickerState("folder", "")
    private var reads = 0
    private var failedSecondPage = false
    private var previews = 0
    private var applied: ScopePolicy? = null
    private val gateway = object : ScopeEditorGateway {
        override suspend fun preview(policy: ScopePolicy): ScopePreview {
            assertProviderWirePolicy(policy)
            previews++
            return ScopePreview(source.id, 65, 2, 63, 1, policy.rules.flatMap { it.match }.map { ScopePreviewItem(it, it.label ?: "Folder ${it.id!!.substringAfterLast('-')}", 1) }, emptyList(), readiness)
        }
        override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions {
            reads++
            if (cursor != null && !failedSecondPage) { failedSecondPage = true; error("Temporary choices failure") }
            val range = if (cursor == null) 1..50 else 51..65
            return ScopeOptions(sourceId, "files", scopes, readiness, range.map { index ->
                val label = if (kind == "folder") "Folder $index" else "Person $index"
                ScopeOption(if (kind == "participant") ScopeRef(kind, label = label, identifiers = listOf(ScopeIdentifier("email", "reader$index@example.org"))) else ScopeRef(kind, "${parentId ?: "root"}-$index"), label, 1, hasChildren = kind == "folder")
            }, nextCursor = if (cursor == null) "page-two" else null).also { assertProviderWireOptions(it) }
        }
    }
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
        compose.onNodeWithText("Retry choices").performClick()
        scrollTo("Folder 58")
        compose.onNodeWithText("Folder 58", substring = false).performClick()
        lateinit var position: Pair<Int, Int>
        compose.runOnIdle { position = anchor(); assertEquals(65, navigation.options!!.items.size); assertNull(navigation.options!!.nextCursor) }
        compose.onNodeWithText("Review filter").performClick()
        compose.onNodeWithText("Back", substring = false).performClick()
        compose.runOnIdle { assertEquals(position, anchor()); assertEquals(3, reads) }
        compose.onNodeWithText("Search folders").performTextInput("new")
        compose.waitForIdle()
        compose.onNodeWithText("Search folders").performTextClearance()
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
        compose.onNodeWithText("Refresh", substring = false).performClick()
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(50, navigation.options!!.items.size); assertEquals("page-two", navigation.options!!.nextCursor) }
        val beforeReview = previews
        compose.onNodeWithText("Review filter").performClick()
        compose.waitForIdle()
        compose.runOnIdle { assertTrue(previews > beforeReview); assertNull(applied) }
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(initial, applied)
    }
}
