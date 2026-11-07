// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

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
class SourceFilterFlowInteractionTest {
    @get:Rule val compose = createComposeRule()
    private val folder = ScopeRef("folder", "workspace", "Workspace")
    private val scopes = SourceScopes(listOf(SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("folder", "folders"), picker = "tree")), 3)
    private val source = AccessSourceInstance("files:reader@example.org", "Files", scopes = scopes, scopeReadiness = listOf(ScopeKindReadiness("folder", true)))
    private val policy = ScopePolicy(source.id, ScopeAudience("level-example", "direct"), listOf(ScopeRule(listOf(folder), "share")), "hide")
    private val gateway = object : ScopeEditorGateway {
        override suspend fun preview(policy: ScopePolicy) = ScopePreview(source.id, 8, 3, 5, 1, policy.rules.flatMap { it.match }.map { ScopePreviewItem(it, it.label ?: "Workspace", 3) }, emptyList(), source.scopeReadiness!!)
        override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = ScopeOptions(sourceId, "files", scopes, source.scopeReadiness!!,
            if (parentId == null) listOf(ScopeOption(folder, "Workspace", 3, hasChildren = true)) else listOf(ScopeOption(ScopeRef("folder", "design", "Design notes"), "Design notes", 2)))
    }
    private var saved: ScopePolicy? = null
    private var saves = 0
    private fun show() {
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(source, "level-example", "direct", policy, true, gateway, onClose = {}) { saved = it; saves++ }
        } } }
    }
    @Test fun browsingFoldersDoesNotSelectThemAndReviewBackRetainsSearchAndTrail() {
        show()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithContentDescription("Open Workspace").performClick()
        compose.onNodeWithText("1 selected").assertExists()
        compose.onNodeWithText("Search folders").performTextInput("Design")
        compose.onNodeWithText("Review filter").performClick()
        assertEquals(0, saves)
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithText("Design", substring = false).assertExists()
        compose.onNode(hasText("Workspace", substring = false) and hasClickAction()).assertExists()
        compose.onNodeWithText("1 selected").assertExists()
        compose.onNodeWithText("Review filter").performClick()
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(listOf(folder), saved!!.rules.single().match)
    }
    @Test fun removingRestrictionRequiresExplicitReviewAndAllContentConfirmation() {
        show()
        compose.onNodeWithText("All content", substring = false).performClick()
        compose.onNodeWithText("Continue").performClick()
        assertEquals(0, saves)
        compose.onNodeWithText("Apply filter").assertDoesNotExist()
        compose.onNodeWithText("Allow all content").assertExists()
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithText("Only matching content").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("1 selected").assertExists()
        assertEquals(0, saves)
    }
    @Test fun anAdvancedSavedRuleCanOnlyBeInspectedAndClosed() {
        val advanced = policy.copy(maxAge = "P3M")
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(source, "level-example", "direct", advanced, true, gateway, onClose = {}) { saves++ }
        } } }
        compose.onNodeWithText("Apply filter").assertDoesNotExist()
        compose.onNodeWithText("All content", substring = false).assertDoesNotExist()
        compose.onNodeWithText("Inspect saved rule details").performScrollTo().performClick()
        compose.onNodeWithText("Maximum age: P3M").assertExists()
        assertEquals(0, saves)
    }
}
