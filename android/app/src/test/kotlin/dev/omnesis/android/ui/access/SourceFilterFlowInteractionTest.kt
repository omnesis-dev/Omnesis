// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
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
    private val folder = ScopeRef("folder", "workspace")
    private val scopes = SourceScopes(listOf(SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("folder", "folders"), picker = "tree")), 3)
    private val source = AccessSourceInstance("files:reader@example.org", "Files", scopes = scopes, scopeReadiness = listOf(ScopeKindReadiness("folder", true)))
    private val policy = ScopePolicy(source.id, ScopeAudience("level-example", "direct"), listOf(ScopeRule(listOf(folder), "share")), "hide")
    private val gateway = object : ScopeEditorGateway {
        override suspend fun preview(policy: ScopePolicy) = ScopePreview(source.id, 8, 3, 5, 1, policy.rules.flatMap { it.match }.map { ScopePreviewItem(it, it.label ?: "Workspace", 3) }, emptyList(), source.scopeReadiness!!).also { assertProviderWirePolicy(policy) }
        override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = ScopeOptions(sourceId, "files", scopes, source.scopeReadiness!!,
            if (parentId == null) listOf(ScopeOption(folder, "Workspace", 3, hasChildren = true)) else listOf(ScopeOption(ScopeRef("folder", "design"), "Design notes", 2)))
    }
    private var saved: ScopePolicy? = null
    private var saves = 0
    private fun show() {
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(source, "level-example", "direct", policy, true, gateway, onClose = {}) { it?.let(::assertProviderWirePolicy); saved = it; saves++ }
        } } }
    }
    @Test fun browsingFoldersDoesNotSelectThemAndReviewBackRetainsSearchAndTrail() {
        show()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithContentDescription("Open Workspace").performClick()
        compose.onNodeWithText("1 selected").assertExists()
        compose.onNodeWithContentDescription("Search folders").performTextInput("Design")
        compose.onNodeWithText("Review filter").performClick()
        assertEquals(0, saves)
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithText("Design", substring = false).assertExists()
        compose.onNodeWithContentDescription("Current location: Workspace").assertExists()
        compose.onNode(hasText("All folders", substring = false) and hasClickAction()).assertExists()
        compose.onNodeWithText("1 selected").assertExists()
        compose.onNodeWithText("Review filter").performClick()
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(listOf(folder), saved!!.rules.single().match)
    }
    @Test fun allContentRemovesTheFilterFromTheFirstStepAndAnyOtherChoiceContinues() {
        show()
        compose.onNodeWithText("Only matching content").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("1 selected").assertExists()
        assertEquals(0, saves)
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithText("All content", substring = false).performClick()
        compose.onNodeWithText("Continue").assertDoesNotExist()
        compose.onNodeWithText("Done").performClick()
        assertEquals(1, saves)
        assertNull(saved)
    }
    @Test fun aFilterOnAnAccountNoLongerConnectedCanBeKeptOrTrimmedButNotAddedTo() {
        var closes = 0
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(disconnectedAccount(source.id) { "Files" }, "level-example", "direct", policy, true, gateway, onClose = { closes++ }) { saved = it; saves++ }
        } } }
        compose.onNodeWithText("Files · no longer connected").assertExists()
        compose.onNodeWithText("This account is no longer connected. Saved filters can be removed but not added.").assertExists()
        compose.onNodeWithText("What should be shared?").assertDoesNotExist()
        compose.onNodeWithText("Apply filter").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(1, closes)
        assertEquals(0, saves)
        compose.onNodeWithContentDescription("Remove Workspace").performClick()
        compose.onNodeWithText("Apply filter").assertIsEnabled().performClick()
        assertEquals(1, saves)
        assertNull(saved)
    }
    @Test fun aSavedItemWhoseNameCannotBeLoadedIsShownAsASavedSelectionOfItsKind() {
        val unknown = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy): ScopePreview = throw dev.omnesis.android.transport.GatewayException.NotFound("source-not-found")
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions = throw dev.omnesis.android.transport.GatewayException.NotFound("source-not-found")
        }
        val person = ScopeRef("participant", label = "Maya Reeves", identifiers = listOf(ScopeIdentifier("email", "maya@example.org")))
        val both = policy.copy(rules = listOf(ScopeRule(listOf(folder, person), "share")))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(disconnectedAccount(source.id) { "Files" }, "level-example", "direct", both, true, unknown, onClose = {}) { saved = it; saves++ }
        } } }
        compose.onNodeWithText("Saved folder selection").assertExists()
        compose.onNodeWithText(NAME_UNAVAILABLE).assertExists()
        compose.onNodeWithText("Maya Reeves").assertExists()
        compose.onNodeWithText("Result").assertDoesNotExist()
        compose.onNodeWithContentDescription("Remove Saved folder selection").performClick()
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(listOf(person), saved!!.rules.single().match)
    }
    @Test fun aFilterOfAKindItsSourceNoLongerDeclaresCanStillBeRemoved() {
        val undeclared = source.copy(scopes = SourceScopes(listOf(SourceScopeItem("label", "changes", noun = SourceScopeNoun("label", "labels"), picker = "search")), 4), scopeReadiness = listOf(ScopeKindReadiness("label", true)))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(undeclared, "level-example", "direct", policy, true, gateway, onClose = {}) { saved = it; saves++ }
        } } }
        compose.onNodeWithText("This account no longer offers some of these filters. Saved filters can be removed but not added.").assertExists()
        compose.onNodeWithText("Choose matching content").assertDoesNotExist()
        compose.onNodeWithContentDescription("Remove Workspace").performClick()
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(1, saves)
        assertNull(saved)
    }
    @Test fun anAdvancedSavedRuleCanOnlyBeReadAndClosed() {
        val advanced = policy.copy(maxAge = "P3M")
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(source, "level-example", "direct", advanced, true, gateway, onClose = {}) { saves++ }
        } } }
        compose.onNodeWithText("Apply filter").assertDoesNotExist()
        compose.onNodeWithText("All content", substring = false).assertDoesNotExist()
        compose.onNodeWithText("Saved rules").assertExists()
        compose.onNodeWithText("Maximum age: P3M").assertExists()
        assertEquals(0, saves)
    }
    @Test fun anAdvancedSavedRuleIsShownWithoutAskingForAPreview() {
        var previews = 0
        val reader = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy): ScopePreview { previews++; throw IllegalStateException("The gateway previews only authorable filters") }
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = gateway.options(sourceId, kind, query, parentId, cursor)
        }
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(source, "level-example", "direct", policy.copy(maxAge = "P3M"), true, reader, onClose = {}) { saves++ }
        } } }
        compose.waitForIdle()
        assertEquals(0, previews)
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText(COUNTING_MESSAGE).assertDoesNotExist()
        compose.onNodeWithText("Saved rules").assertExists()
    }
    @Test fun aFailedPreviewIsNotWordedAsAFailedSave() {
        val reader = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy): ScopePreview = throw dev.omnesis.android.transport.GatewayException.ServerError(503, "unavailable")
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = gateway.options(sourceId, kind, query, parentId, cursor)
        }
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(source, "level-example", "direct", policy, false, reader, onClose = {}) { saves++ }
        } } }
        compose.waitForIdle()
        compose.onNodeWithText("The gateway could not load this. Try again.").assertExists()
        compose.onNodeWithText("The gateway could not save these changes. Try again.").assertDoesNotExist()
    }
    @Test fun anInProgressFilterSurvivesAConfigurationChange() {
        val restoration = StateRestorationTester(compose)
        restoration.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(source, "level-example", "direct", policy, true, gateway, onClose = {}) { saved = it; saves++ }
        } } }
        compose.onNodeWithText("Everything except matching content").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Review filter").performClick()
        compose.onNodeWithText("Review this filter").assertExists()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("Review this filter").assertExists()
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(listOf(ScopeRule(listOf(folder), "hide")), saved!!.rules)
        assertEquals("share", saved!!.otherwise)
    }
    @Test fun openingADecisionLeavesASavedSelectionAndItsRevisionAsTheyWere() {
        val savedPolicy = policy.copy(rules = listOf(ScopeRule(listOf(folder), "share")))
        val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id))).copy(scopePolicies = listOf(savedPolicy), filterRevision = 4)
        val level = AccessLevelSummary("level-example", "File helper", 1, listOf(direct), 0)
        val overview = AccessOverview(emptyList(), listOf(source), levels = listOf(level), sourceFilters = SourceFiltersAvailability(true))
        var draft by mutableStateOf(AccessLevelDraft.opening(level, overview))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(overview, draft), gateway, onClose = {}, onUpdate = { draft = it })
        } } }
        compose.onNodeWithContentDescription("Change Direct data").performClick()
        compose.onNodeWithText("Only 1 selected match").assertExists()
        assertEquals(savedPolicy, draft.rule(AccessCapability.DIRECT)!!.scopePolicies.single())
        assertEquals(4, draft.expectedFilterRevisions["direct"])
    }
    @Test fun savedNamesFromOtherKindsAppearWithoutChangingTabsOrApplyingTheFilter() {
        val labelRef = ScopeRef("label", "project-label")
        val person = ScopeRef("participant", label = "reader@example.org", identifiers = listOf(ScopeIdentifier("email", "reader@example.org")))
        val contract = SourceScopes(listOf(SourceScopeItem("participant", "fixed", identifiers = listOf("email", "domain")), SourceScopeItem("label", "changes", noun = SourceScopeNoun("label", "labels"), picker = "search")), 2)
        val readiness = contract.items.map { ScopeKindReadiness(it.kind, true) }
        val mail = AccessSourceInstance("gmail:reader@example.org", "Gmail", scopes = contract, scopeReadiness = readiness)
        val saved = ScopePolicy(mail.id, ScopeAudience("level-example", "answer"), listOf(ScopeRule(listOf(labelRef, person), "share")), "hide")
        val pending = kotlinx.coroutines.CompletableDeferred<ScopePreview>()
        val reader = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy) = pending.await()
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = ScopeOptions(sourceId, "gmail", contract, readiness, emptyList())
        }
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(mail, "level-example", "answer", saved, true, reader, onClose = {}) { saves++ }
        } } }
        compose.onNodeWithText("Continue").performClick()
        pending.complete(ScopePreview(mail.id, 4, 2, 2, 0, listOf(ScopePreviewItem(labelRef, "Project", 2)), emptyList(), readiness))
        compose.waitForIdle()
        compose.onNodeWithText("View selected").performClick()
        compose.onNodeWithText("Project").assertExists()
        compose.onNodeWithText("reader@example.org").assertExists()
        assertEquals(0, saves)
        assertEquals(listOf(labelRef, person), saved.rules.single().match)
    }
    @Test fun aRenamedSavedFolderStaysCheckedAndCanBeRemovedWithoutDuplication() {
        val before = folder
        val renamed = folder
        var selection: List<ScopeRef>? = null
        val reader = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy) = gateway.preview(policy)
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = ScopeOptions(sourceId, "files", scopes, source.scopeReadiness!!, listOf(ScopeOption(renamed, "Renamed folder", 3)))
        }
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterPicker(source, reader, onClose = {}, initialSelection = listOf(before)) { selection = it }
        } } }
        compose.onNode(hasText("Renamed folder") and isToggleable()).assertIsOn().performClick()
        compose.onNodeWithText("0 selected").assertExists()
        compose.onNodeWithText("Review filter").assertIsNotEnabled()
        compose.onNode(hasText("Renamed folder") and isToggleable()).performClick()
        compose.onNodeWithText("1 selected").assertExists()
        compose.onNodeWithText("Review filter").performClick()
        assertEquals(listOf(before), selection)
    }
    @Test fun equalFolderNamesWithDifferentIdsRemainIndependentSelections() {
        val first = folder
        val second = first.copy(id = "workspace-copy")
        var selection: List<ScopeRef>? = null
        val reader = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy) = gateway.preview(policy)
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = ScopeOptions(sourceId, "files", scopes, source.scopeReadiness!!, listOf(ScopeOption(first, "Workspace", 3), ScopeOption(second, "Workspace", 3)))
        }
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterPicker(source, reader, onClose = {}, initialSelection = listOf(first)) { selection = it }
        } } }
        compose.onAllNodes(isToggleable())[0].assertIsOn()
        compose.onAllNodes(isToggleable())[1].assertIsOff().performClick()
        compose.onNodeWithText("2 selected").assertExists()
        compose.onNodeWithText("Review filter").performClick()
        assertEquals(listOf(first, second), selection)
    }
}
