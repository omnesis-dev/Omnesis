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
    private val folder = FilterRef.item(FilterRef.TREE, "extra.folderId", "workspace")
    private val folders = readyField("extra.folderId", FilterRef.TREE, "folder", "folders", picker = "tree", insideText = "Includes the folders inside.")
    private val source = AccessSourceInstance("files:reader@example.org", "Files", filterable = true)
    private val policy = SourceFilter(source.id, FilterAudience("level-example", "direct"), listOf(FilterRule(listOf(folder), "share")), "hide")
    private val editor = FilterEditor(source.id, "files", fields = listOf(folders))
    private fun listing(request: FilterOptionsRequest) = FilterOptions(request.sourceId, request.field,
        if (request.parentId == null) listOf(FilterOption(folder, "Workspace", "Workspace", 3, hasChildren = true))
        else listOf(FilterOption(FilterRef.item(FilterRef.TREE, folders.field, "design"), "Workspace/Design notes", "Design notes", 2, parentId = "workspace")))
    private val gateway = FakeFilterGateway(
        editorFor = { editor }, optionsFor = { listing(it) },
        previewFor = { readyPreview(source.id, 8, 3, it.rules.flatMap { rule -> rule.match }.map { ref -> FilterPreviewItem(ref, "Workspace", 3) }) },
    )
    private var saved: SourceFilter? = null
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
        compose.onNodeWithText(DISCONNECTED_FILTER_NOTE).assertExists()
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
        val unknown = object : FilterEditorGateway {
            private fun gone(): Nothing = throw dev.omnesis.android.transport.GatewayException.NotFound("source-not-found")
            override suspend fun editor(sourceId: String): FilterEditor = gone()
            override suspend fun preview(policy: SourceFilter): FilterPreview = gone()
            override suspend fun options(sourceId: String, field: String, query: String, parentId: String?, device: String?, cursor: String?): FilterOptions = gone()
            override suspend fun identifier(type: String, value: String): FilterIdentifierCheck = gone()
            override suspend fun resync(sourceId: String) = gone()
        }
        val person = FilterRef.person("Maya Reeves", listOf(FilterIdentifier("email", "maya@example.org")))
        val both = policy.copy(rules = listOf(FilterRule(listOf(folder, person), "share")))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(disconnectedAccount(source.id) { "Files" }, "level-example", "direct", both, true, unknown, onClose = {}) { saved = it; saves++ }
        } } }
        compose.onNodeWithText("Saved selection").assertExists()
        compose.onNodeWithText(NAME_UNAVAILABLE).assertExists()
        compose.onNodeWithText("Maya Reeves").assertExists()
        compose.onNodeWithText("Result").assertDoesNotExist()
        compose.onNodeWithContentDescription("Remove Saved selection").performClick()
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(listOf(person), saved!!.rules.single().match)
    }
    @Test fun aFilterOnAFieldTheAccountNoLongerOffersCanStillBeRemoved() {
        val labelsOnly = FakeFilterGateway(editorFor = { FilterEditor(source.id, "files", fields = listOf(readyField("extra.labelIds", FilterRef.MEMBERSHIP, "label", "labels"))) })
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(source, "level-example", "direct", policy, true, labelsOnly, onClose = {}) { saved = it; saves++ }
        } } }
        compose.waitForIdle()
        compose.onNodeWithText("This account no longer offers some of these filters. You can remove its saved entries.").assertExists()
        compose.onNodeWithText("Choose matching content").assertDoesNotExist()
        compose.onNodeWithContentDescription("Remove Saved selection").performClick()
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(1, saves)
        assertNull(saved)
    }
    @Test fun aSavedFilterOfAnotherShapeCanOnlyBeReadAndClosedWithoutAskingForAPreview() {
        var previews = 0
        val reader = FakeFilterGateway(editorFor = { editor }, optionsFor = { listing(it) }, previewFor = { previews++; error("The gateway previews only authorable filters") })
        val other = policy.copy(rules = listOf(FilterRule(listOf(folder), "share"), FilterRule(listOf(folder), "hide")))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(source, "level-example", "direct", other, true, reader, onClose = {}) { saves++ }
        } } }
        compose.waitForIdle()
        assertEquals(0, previews)
        compose.onNodeWithText("Apply filter").assertDoesNotExist()
        compose.onNodeWithText("All content", substring = false).assertDoesNotExist()
        compose.onNodeWithText("Saved rules").assertExists()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText(COUNTING_MESSAGE).assertDoesNotExist()
        assertEquals(0, saves)
    }
    @Test fun countsThatCannotBeReadSaySoAndNeverReadAsAFailedSave() {
        val reader = FakeFilterGateway(editorFor = { editor }, optionsFor = { listing(it) },
            previewFor = { throw dev.omnesis.android.transport.GatewayException.ServerError(503, "unavailable") })
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(source, "level-example", "direct", policy, true, reader, onClose = {}) { saves++ }
        } } }
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Review filter").performClick()
        compose.waitForIdle()
        compose.onNodeWithText(COUNTS_UNAVAILABLE_MESSAGE).assertExists()
        compose.onNodeWithText("The gateway could not save these changes. Try again.").assertDoesNotExist()
        compose.onNodeWithText("Apply filter").assertIsEnabled()
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
        assertEquals(listOf(FilterRule(listOf(folder), "hide")), saved!!.rules)
        assertEquals("share", saved!!.otherwise)
    }
    @Test fun openingADecisionLeavesASavedSelectionAndItsRevisionAsTheyWere() {
        val savedPolicy = policy.copy(rules = listOf(FilterRule(listOf(folder), "share")))
        val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id))).copy(scopePolicies = listOf(savedPolicy), filterRevision = 4)
        val level = AccessLevelSummary("level-example", "File helper", 1, listOf(direct), 0)
        val overview = AccessOverview(emptyList(), listOf(source), levels = listOf(level), sourceFilters = SourceFiltersAvailability(true))
        var draft by mutableStateOf(AccessLevelDraft.opening(level, overview))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(overview, draft), gateway, onClose = {}, onUpdate = { draft = it })
        } } }
        compose.onNodeWithContentDescription("Change Direct data").performClick()
        compose.onNodeWithText("Share matching content · 1 item").assertExists()
        assertEquals(savedPolicy, draft.rule(AccessCapability.DIRECT)!!.scopePolicies.single())
        assertEquals(4, draft.expectedFilterRevisions["direct"])
    }
    @Test fun savedNamesFromOtherFieldsAppearWithoutChangingTabsOrApplyingTheFilter() {
        val labelRef = FilterRef.item(FilterRef.MEMBERSHIP, "extra.labelIds", "project-label")
        val person = FilterRef.person("reader@example.org", listOf(FilterIdentifier("email", "reader@example.org")))
        val mail = AccessSourceInstance("gmail:reader@example.org", "Gmail", filterable = true)
        val saved = SourceFilter(mail.id, FilterAudience("level-example", "answer"), listOf(FilterRule(listOf(labelRef, person), "share")), "hide")
        val pending = kotlinx.coroutines.CompletableDeferred<FilterPreview>()
        val reader = FakeFilterGateway(
            editorFor = { FilterEditor(mail.id, "gmail", fields = listOf(peopleField("email", "domain"), readyField("extra.labelIds", FilterRef.MEMBERSHIP, "label", "labels"))) },
            previewFor = { pending.await() },
        )
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterEditor(mail, "level-example", "answer", saved, true, reader, onClose = {}) { saves++ }
        } } }
        compose.onNodeWithText("Continue").performClick()
        pending.complete(readyPreview(mail.id, 4, 2, listOf(FilterPreviewItem(labelRef, "Project", 2))))
        compose.waitForIdle()
        compose.onNodeWithText("View selected").performClick()
        compose.onNodeWithText("Project").assertExists()
        compose.onNodeWithText("Label").assertExists()
        compose.onNodeWithText("reader@example.org").assertExists()
        assertEquals(0, saves)
        assertEquals(listOf(labelRef, person), saved.rules.single().match)
    }
    @Test fun aRenamedSavedFolderStaysCheckedAndCanBeRemovedWithoutDuplication() {
        val before = folder
        val renamed = folder
        var selection: List<FilterRef>? = null
        val reader = FakeFilterGateway(editorFor = { editor }, optionsFor = { FilterOptions(it.sourceId, it.field, listOf(FilterOption(renamed, "Renamed folder", "Renamed folder", 3))) })
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
        var selection: List<FilterRef>? = null
        val reader = FakeFilterGateway(editorFor = { editor }, optionsFor = { FilterOptions(it.sourceId, it.field, listOf(FilterOption(first, "Workspace", "Workspace", 3), FilterOption(second, "Workspace", "Workspace", 3))) })
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
