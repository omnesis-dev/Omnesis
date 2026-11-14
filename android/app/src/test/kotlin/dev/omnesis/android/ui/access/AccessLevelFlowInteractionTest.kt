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
class AccessLevelFlowInteractionTest {
    @get:Rule val compose = createComposeRule()
    private val source = AccessSourceInstance("mail:reader@example.org", "Mail", sourceType = "mail")
    private val overview = AccessOverview(emptyList(), listOf(source))
    private val gateway = FakeFilterGateway()
    private var saved = 0
    private var closed = 0
    private var reloaded = 0
    private fun show(initial: AccessLevelDraft = AccessLevelDraft.opening(null, overview), catalogue: AccessOverview = overview, conflict: Boolean = false) {
        var draft by mutableStateOf(initial)
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft, error = if (conflict) "stale-revision" else null, conflict = conflict), gateway,
                onClose = { closed++ }, onUpdate = { draft = it }, onSave = { saved++ }, onReload = { reloaded++ })
        } } }
    }
    @Test fun notesOnlyGoesDirectlyToReviewAndCannotSaveBeforeNaming() {
        show()
        compose.onNodeWithContentDescription("Access level name").assertDoesNotExist()
        compose.onNodeWithText("Answer").performClick()
        compose.onNodeWithText("Notes").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Ready to create this access level?").assertExists()
        compose.onNodeWithText("Create access level").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Access level name").performTextInput("Capture notes")
        compose.onNodeWithText("Create access level").assertIsEnabled().performClick()
        assertEquals(1, saved)
        compose.onNodeWithText("Which sources can Answer use?").assertDoesNotExist()
    }
    @Test fun readingRequiresARealSourceChoiceBeforeItCanContinue() {
        show()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Which sources can Answer use?").assertExists()
        compose.onNodeWithText("Continue").assertIsNotEnabled()
        compose.onNodeWithText("Mail").performClick()
        compose.onNodeWithText("Continue").assertIsEnabled().performClick()
        compose.onNodeWithText("What about new sources?").assertExists()
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithText("All content").assertExists()
        assertEquals(0, saved)
    }
    @Test fun targetedEditReviewsOnlyItsChangedReleaseAndSavesOnlyAtTheEnd() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)), AccessAnswerRelease.reviewed("policy-example"))
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(answer), 2)
        val state = overview.copy(levels = listOf(level), policyFamilies = listOf(AccessPolicyFamilySummary("policy-example", "Default privacy", "1")))
        show(AccessLevelDraft.opening(level, state), state)
        compose.onNodeWithText("Save changes").assertDoesNotExist()
        compose.onNodeWithContentDescription("Change Answer release").performClick()
        compose.onNodeWithText("Release without privacy review").performClick()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Review changes").performClick()
        compose.onNodeWithText("Before").assertExists()
        compose.onNodeWithText("After").assertExists()
        compose.onNodeWithContentDescription("Change Answer data").assertDoesNotExist()
        compose.onNodeWithText("2 connections").assertExists()
        assertEquals(0, saved)
        compose.onNodeWithText("Save changes").performClick()
        assertEquals(1, saved)
    }
    @Test fun cancellingADecisionRestoresItsDraftAndKeepsEarlierDecisions() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)), AccessAnswerRelease.unreviewed())
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(answer), 2)
        val catalogue = overview.copy(levels = listOf(level))
        var draft by mutableStateOf(AccessLevelDraft.opening(level, catalogue))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft), gateway, onClose = { closed++ }, onUpdate = { draft = it })
        } } }
        compose.onNodeWithContentDescription("Change permissions").performClick()
        compose.onNodeWithText("Notes").performClick()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithContentDescription("Change permissions").performClick()
        compose.onNodeWithText("Direct").performClick()
        compose.runOnIdle { assertNotNull(draft.rule(AccessCapability.DIRECT)) }
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Discard these changes?").assertDoesNotExist()
        compose.onNodeWithText("Review changes").assertIsEnabled()
        compose.runOnIdle {
            assertNull(draft.rule(AccessCapability.DIRECT))
            assertNotNull(draft.rule(AccessCapability.NOTES))
        }
        assertEquals(0, closed)
    }
    @Test fun deletingAnUnusedLevelFromTheListAsksForConfirmationFirst() {
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(AccessGrantRule.notes()), 0)
        val catalogue = overview.copy(levels = listOf(level))
        val deleted = mutableListOf<AccessLevelSummary>()
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue), gateway, onClose = {}, onDelete = { deleted += it })
        } } }
        compose.onNodeWithText("Delete “Project helper”?").assertDoesNotExist()
        compose.onNodeWithText("Project helper").performTouchInput { longClick() }
        compose.onNodeWithText("Delete “Project helper”?").assertExists()
        assertTrue(deleted.isEmpty())
        compose.onNodeWithText("Delete").performClick()
        assertEquals(listOf(level), deleted)
        compose.onNodeWithText("Delete “Project helper”?").assertDoesNotExist()
    }
    @Test fun aLevelInUseCannotBeDeletedAndSaysWhatToMoveFirst() {
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(AccessGrantRule.notes()), 1, listOf(AccessLevelDevice("device-example", "Kitchen speaker", "integration")))
        val catalogue = overview.copy(levels = listOf(level))
        var deleted = 0
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue), gateway, onClose = {}, onDelete = { deleted++ })
        } } }
        compose.onNodeWithText("Project helper").performTouchInput { longClick() }
        compose.onNodeWithText("This access level is still in use").assertExists()
        compose.onNodeWithText("Move its connections and integrations off it first.").assertExists()
        compose.onNodeWithText("Delete “Project helper”?").assertDoesNotExist()
        compose.onNodeWithText("OK").performClick()
        assertEquals(0, deleted)
    }
    @Test fun aDeletionTheGatewayRefusesIsExplainedOnTheListUntilDismissed() {
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(AccessGrantRule.notes()), 0)
        val catalogue = overview.copy(levels = listOf(level))
        var dismissed = 0
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, deleteError = accessLevelDeleteError(dev.omnesis.android.transport.GatewayException.ServerError(409, "level-in-use"))), gateway, onClose = {}, onDismissDeleteError = { dismissed++ })
        } } }
        compose.onNodeWithText("This access level is still in use").assertExists()
        compose.onNodeWithText("Move its connections and integrations off it first.").assertExists()
        compose.onNodeWithText("OK").performClick()
        assertEquals(1, dismissed)
    }
    @Test fun theLevelPageHoldsOnlyEditingDecisions() {
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(AccessGrantRule.notes()), 0)
        val catalogue = overview.copy(levels = listOf(level))
        var draft by mutableStateOf(AccessLevelDraft.opening(level, catalogue))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft), gateway, onClose = { closed++ }, onUpdate = { draft = it })
        } } }
        compose.onNodeWithText("Delete access level", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Cancel").assertDoesNotExist()
        compose.onNodeWithContentDescription("Change name").performClick()
        compose.onNodeWithText("What should this access level be called?").assertExists()
        compose.onNodeWithText("Back").assertDoesNotExist()
        compose.onNodeWithContentDescription("Access level name").performTextReplacement("Renamed helper")
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { assertEquals("Project helper", draft.name) }
        compose.onNodeWithContentDescription("Change name").performClick()
        compose.onNodeWithContentDescription("Access level name").performTextReplacement("Renamed helper")
        compose.onNodeWithText("Done").performClick()
        compose.runOnIdle { assertEquals("Renamed helper", draft.name) }
        compose.onNodeWithText("Review changes").assertIsEnabled()
        assertEquals(0, closed)
    }
    @Test fun anUnavailableAccountCanBeTakenOutOfTheBoundary() {
        val retired = "mail:retired@example.org"
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id, retired)), AccessAnswerRelease.unreviewed())
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(answer), 0)
        val catalogue = overview.copy(levels = listOf(level))
        var draft by mutableStateOf(AccessLevelDraft.opening(level, catalogue))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft), gateway, onClose = {}, onUpdate = { draft = it })
        } } }
        compose.onNodeWithContentDescription("Change Answer data").performClick()
        compose.onNodeWithText("no longer connected").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf(source.id), draft.rule(AccessCapability.ANSWER)!!.sources.sourceIds) }
        compose.onNodeWithText("no longer connected").assertDoesNotExist()
        compose.onNodeWithText("Done").assertIsEnabled()
    }
    @Test fun aConflictOffersOneReloadThatNamesTheDraftItDiscards() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)), AccessAnswerRelease.unreviewed())
        val level = AccessLevelSummary("saved-level", "Before", 7, listOf(answer), 2)
        val state = overview.copy(levels = listOf(level))
        show(AccessLevelDraft.opening(level, state).copy(name = "My unsaved name"), state, conflict = true)
        compose.onNodeWithText("Review changes").assertIsEnabled()
        compose.onNodeWithText(ACCESS_LEVEL_CONFLICT_MESSAGE).assertExists()
        assertEquals(0, reloaded)
        compose.onNodeWithText("Load the latest version and discard my changes").performClick()
        assertEquals(1, reloaded)
    }
    @Test fun retryCannotSaveChangesAfterLeavingTheReview() {
        val level = AccessLevelSummary("saved-level", "Before", 1, listOf(AccessGrantRule.notes()), 0)
        val catalogue = overview.copy(levels = listOf(level))
        var draft by mutableStateOf(AccessLevelDraft.opening(level, catalogue).copy(name = "After"))
        compose.setContent { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft, error = "Save failed. Try again."), gateway,
                onClose = {}, onUpdate = { draft = it }, onSave = { saved++ })
        } }
        compose.onNodeWithText("Retry save").assertDoesNotExist()
        compose.onNodeWithText("Review changes").performClick()
        compose.onNodeWithText("Retry save").assertIsEnabled()
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithContentDescription("Change permissions").performClick()
        compose.onNodeWithText("Retry save").assertDoesNotExist()
        assertEquals(0, saved)
    }
    @Test fun remoteRevisionChangeKeepsTheDraftAndRequiresExplicitReload() {
        val level = AccessLevelSummary("saved-level", "Before", 1, listOf(AccessGrantRule.notes()), 0)
        var catalogue by mutableStateOf(overview.copy(levels = listOf(level)))
        val draft = AccessLevelDraft.opening(level, catalogue).copy(name = "My unsaved name")
        compose.setContent { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft), gateway, onClose = {})
        } }
        compose.runOnIdle { catalogue = catalogue.copy(levels = listOf(level.copy(name = "Remote name", revision = 2))) }
        compose.onNodeWithText("Review changes").assertIsEnabled()
        compose.onAllNodesWithText("My unsaved name")[0].assertExists()
        compose.onNodeWithText("Load the latest version and discard my changes").assertExists()
    }
    @Test fun changingAnAlreadyReviewedCreateDecisionReturnsDirectlyToReview() {
        val initial = AccessLevelDraft.opening(null, overview).copy(name = "Capture notes", rules = listOf(AccessGrantRule.notes()))
        show(initial)
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithContentDescription("Change permissions").performClick()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Ready to create this access level?").assertExists()
        assertEquals(0, saved)
    }
    @Test fun theWizardPageSurvivesAConfigurationChange() {
        var draft by mutableStateOf(AccessLevelDraft.opening(null, overview))
        val restoration = StateRestorationTester(compose)
        restoration.setContent { OmnesisTheme {
            AccessHomeContent(AccessManagementState(overview, draft), gateway, onClose = {}, onUpdate = { draft = it })
        } }
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Which sources can Answer use?").assertExists()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("Which sources can Answer use?").assertExists()
        compose.onNodeWithText("What should this connection be allowed to do?").assertDoesNotExist()
    }
    @Test fun anOverviewRefreshNeitherReadsAsSavingNorLocksTheDraft() {
        compose.setContent { OmnesisTheme {
            AccessHomeContent(AccessManagementState(overview, AccessLevelDraft.opening(null, overview), refreshing = true), gateway, onClose = {})
        } }
        compose.onNodeWithText("Saving…").assertDoesNotExist()
        compose.onNodeWithText("Continue").assertIsEnabled()
    }
    @Test fun aDeselectedFilteredSourceKeepsItsFilterInTheDraftWithoutBlockingTheDecision() {
        val filtered = SourceFilter(source.id, FilterAudience("saved-level", "answer"), listOf(FilterRule(listOf(FilterRef.person("Maya Reeves", listOf(FilterIdentifier("email", "maya@example.org")))), "share")), "hide")
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), AccessAnswerRelease.unreviewed()).copy(filterRevision = 2, scopePolicies = listOf(filtered))
        val other = AccessSourceInstance("notes:reader@example.org", "Notes", sourceType = "notes")
        val level = AccessLevelSummary("saved-level", "Before", 1, listOf(answer), 0)
        val catalogue = AccessOverview(emptyList(), listOf(source, other), levels = listOf(level), sourceFilters = SourceFiltersAvailability(true))
        show(AccessLevelDraft.opening(level, catalogue), catalogue)
        compose.onNodeWithContentDescription("Change Answer data").performClick()
        compose.onNodeWithText("Mail").performClick()
        compose.onNodeWithText("Not shared · saved filter kept").assertExists()
        compose.onNodeWithText("Done").assertIsEnabled()
        compose.onNodeWithText("Mail").performClick()
        compose.onNodeWithText("Not shared · saved filter kept").assertDoesNotExist()
        compose.onNodeWithText("Share matching content · 1 item").assertExists()
        compose.onNodeWithText("Done").assertIsEnabled()
    }
    @Test fun savingDisablesEditingAndLeavingTheDraft() {
        val initial = AccessLevelDraft.opening(null, overview).copy(name = "Capture notes", rules = listOf(AccessGrantRule.notes()))
        var saving by mutableStateOf(false)
        compose.setContent { OmnesisTheme {
            AccessHomeContent(AccessManagementState(overview, initial, loading = saving), gateway, onClose = { closed++ })
        } }
        compose.onNodeWithText("Continue").performClick()
        compose.runOnIdle { saving = true }
        compose.onNodeWithContentDescription("Access level name").assertIsNotEnabled()
        compose.onNodeWithText("Back").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").assertIsNotEnabled()
        compose.onNodeWithText("Create access level").assertIsNotEnabled()
        assertEquals(0, closed)
    }
    @Test fun aStaleDraftCanFinishItsQuestionAndReviewButCannotSave() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)), AccessAnswerRelease.unreviewed())
        val level = AccessLevelSummary("saved-level", "Before", 1, listOf(answer), 0)
        var catalogue by mutableStateOf(overview.copy(levels = listOf(level)))
        var draft by mutableStateOf(AccessLevelDraft.opening(level, catalogue))
        compose.setContent { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft), gateway, onClose = {}, onUpdate = { draft = it }, onSave = { saved++ })
        } }
        compose.onNodeWithContentDescription("Change permissions").performClick()
        compose.onNodeWithText("Notes").performClick()
        compose.runOnIdle { catalogue = catalogue.copy(levels = listOf(level.copy(revision = 2))) }
        compose.onNodeWithText("Done").assertIsEnabled().performClick()
        compose.onNodeWithText("Review changes").assertIsEnabled().performClick()
        compose.onNodeWithText("Review your changes").assertExists()
        compose.onNodeWithText("Save changes").assertIsNotEnabled()
        assertEquals(0, saved)
    }
    @Test fun directReuseListsAnswerAccountsWithoutChangingTheDecision() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)), AccessAnswerRelease.unreviewed())
        val initial = AccessLevelDraft.opening(null, overview).copy(rules = listOf(answer, AccessGrantRule.direct(answer.sources)), directSameAsAnswer = true)
        show(initial)
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Which sources can Direct read?").assertExists()
        compose.onNodeWithText(DIRECT_SAME_AS_ANSWER_LABEL).assertIsSelected()
        compose.onNodeWithText("Mail", substring = false).assertExists()
        compose.onNodeWithText("reader@example.org").assertExists()
        compose.onNodeWithContentDescription("Change Mail for Direct").assertDoesNotExist()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Answer and Direct", substring = false).assertExists()
        assertEquals(0, saved)
    }
    @Test fun aSavedLevelsDirectDataSwitchesBetweenItsOwnListAndAnswersFrozenList() {
        val other = AccessSourceInstance("mail:other@example.org", "Other mail", sourceType = "mail")
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id, other.id)), AccessAnswerRelease.unreviewed())
        val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)))
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(answer, direct), 0)
        val catalogue = overview.copy(sources = listOf(source, other), levels = listOf(level))
        var draft by mutableStateOf(AccessLevelDraft.opening(level, catalogue))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft), gateway, onClose = {}, onUpdate = { draft = it })
        } } }
        compose.onNodeWithContentDescription("Change Direct data").performClick()
        compose.onNodeWithText(DIRECT_LINKED_NOTE).assertDoesNotExist()
        compose.onNodeWithText(DIRECT_OWN_LIST_LABEL).assertDoesNotExist()
        compose.onNodeWithText("Other mail").assertIsOff().assertIsEnabled()
        compose.onNodeWithText(DIRECT_SAME_AS_ANSWER_LABEL).performClick()
        // Linked, Direct shows Answer's accounts as they stand and cannot change them here.
        compose.onNodeWithText(DIRECT_LINKED_NOTE).assertExists()
        compose.onNodeWithText(DIRECT_SAME_AS_ANSWER_LABEL).assertDoesNotExist()
        compose.onNodeWithText("Other mail").assertIsOn().assertIsNotEnabled()
        compose.onNodeWithContentDescription("Search sources").assertDoesNotExist()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Same sources and filters as Answer").assertExists()
        compose.runOnIdle { assertEquals(answer.sources, draft.serializedRules.single { it.capability == AccessCapability.DIRECT }.sources) }
        // Opened again it is still linked; leaving the link restores the list this edit had, and Cancel puts the link back.
        compose.onNodeWithContentDescription("Change Direct data").performClick()
        compose.onNodeWithText(DIRECT_OWN_LIST_LABEL).performClick()
        compose.onNodeWithText(DIRECT_LINKED_NOTE).assertDoesNotExist()
        compose.onNodeWithText("Other mail").assertIsOff().assertIsEnabled()
        compose.onNodeWithText(DIRECT_SAME_AS_ANSWER_LABEL).assertExists()
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { assertTrue(draft.directLinked) }
    }
    @Test fun switchingDirectOnWhileEditingShowsItLinkedToAnswerNext() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)), AccessAnswerRelease.unreviewed())
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(answer), 0)
        val catalogue = overview.copy(levels = listOf(level))
        var draft by mutableStateOf(AccessLevelDraft.opening(level, catalogue))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft), gateway, onClose = {}, onUpdate = { draft = it })
        } } }
        compose.onNodeWithContentDescription("Change permissions").performClick()
        compose.onNodeWithText("Direct").performClick()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Which sources can Direct read?").assertExists()
        compose.onNodeWithText(DIRECT_LINKED_NOTE).assertExists()
        compose.onNodeWithText(DIRECT_OWN_LIST_LABEL).assertExists()
        compose.onNodeWithText(DIRECT_SAME_AS_ANSWER_LABEL).assertDoesNotExist()
        compose.runOnIdle { assertTrue(draft.directLinked) }
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("What would you like to change?").assertExists()
        compose.runOnIdle { assertNull(draft.rule(AccessCapability.DIRECT)) }
    }
    @Test fun switchingAnswerOnWhileEditingKeepsDirectsOwnAccounts() {
        val other = AccessSourceInstance("mail:other@example.org", "Other mail", sourceType = "mail")
        val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(other.id)))
        val level = AccessLevelSummary("saved-level", "Project helper", 7, listOf(direct), 0)
        val catalogue = overview.copy(sources = listOf(source, other), levels = listOf(level))
        val opened = AccessLevelDraft.opening(level, catalogue)
        val withAnswer = opened.enabled(AccessCapability.ANSWER, true, catalogue)
        assertFalse(withAnswer.directLinked)
        assertEquals(direct.sources, withAnswer.serializedRules.single { it.capability == AccessCapability.DIRECT }.sources)
    }
    @Test fun linkedReviewCorrectionChoosesSeparateDirectDataAndPersistsItsExactBoundary() {
        val labels = readyField("extra.labelIds", FilterRef.MEMBERSHIP, "label", "labels")
        val first = source.copy(filterable = true)
        val second = AccessSourceInstance("mail:other@example.org", "Other mail", filterable = true)
        val oldRef = FilterRef.item(FilterRef.MEMBERSHIP, "extra.labelIds", "before-label")
        val newRef = FilterRef.item(FilterRef.MEMBERSHIP, "extra.labelIds", "after-label")
        val answerPolicy = SourceFilter(first.id, FilterAudience("new", "answer"), listOf(FilterRule(listOf(oldRef), "share")), "hide")
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(first.id)), AccessAnswerRelease.unreviewed()).copy(scopePolicies = listOf(answerPolicy))
        val catalogue = overview.copy(sources = listOf(first, second), sourceFilters = SourceFiltersAvailability(true))
        var draft by mutableStateOf(AccessLevelDraft.opening(null, catalogue).copy(name = "Independent helper", rules = listOf(answer, AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList()))), requireAnswerPolicySelection = false))
        val filterGateway = FakeFilterGateway(
            editorFor = { FilterEditor(it, "mail", fields = listOf(labels)) },
            optionsFor = { FilterOptions(it.sourceId, it.field, listOf(FilterOption(newRef, "Design notes", "Design notes", 3))) },
            previewFor = { policy -> readyPreview(policy.sourceId, 6, 3, policy.rules.flatMap { it.match }.map { FilterPreviewItem(it, if (it == oldRef) "Project" else "Design notes", 3) }) },
        )
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft), filterGateway, onClose = {}, onUpdate = { draft = it }, onSave = { saved++ })
        } } }
        repeat(5) { compose.onNodeWithText("Continue").performClick() }
        compose.onNodeWithContentDescription("Change Direct data").performScrollTo().performClick()
        compose.onNodeWithText("Choose different sources").performClick()
        compose.onNodeWithText("Mail", substring = false).performClick()
        compose.onNodeWithText("Not shared · saved filter kept").assertExists()
        compose.onNodeWithContentDescription("Change Mail for Direct").performClick()
        compose.onNodeWithText("All content", substring = false).performClick()
        compose.onNode(hasText("Done") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText("Not shared · saved filter kept").assertDoesNotExist()
        compose.onNodeWithText("Other mail", substring = false).performClick()
        compose.onNodeWithContentDescription("Change Other mail for Direct").performClick()
        compose.onNodeWithText("Only matching content").performClick()
        compose.onNode(hasText("Continue") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText("Design notes", substring = false).performClick()
        compose.onNodeWithText("Review filter").performClick()
        compose.onNodeWithText("Apply filter").performClick()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Create access level").performClick()
        assertEquals(1, saved)
        val direct = draft.serializedRules.single { it.capability == AccessCapability.DIRECT }
        assertEquals(listOf(second.id), direct.sources.sourceIds)
        assertEquals(listOf(newRef), direct.scopePolicies.single().rules.single().match)
        assertEquals(FilterAudience("new", "direct"), direct.scopePolicies.single().audience)
        assertEquals(answer.copy(filterRevision = 0), draft.serializedRules.single { it.capability == AccessCapability.ANSWER })
    }
    @Test fun addingReadingFromNotesReviewVisitsEveryNewlyRequiredDecision() {
        show(AccessLevelDraft.opening(null, overview).copy(name = "Note capture", rules = listOf(AccessGrantRule.notes())))
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithContentDescription("Change permissions").performClick()
        compose.onNodeWithText("Answer").performClick()
        compose.onNodeWithText("Direct").performClick()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Which sources can Answer use?").assertExists()
        compose.onNodeWithText("Mail", substring = false).performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Which sources can Direct read?").assertExists()
        compose.onNodeWithText("Choose different sources").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("What about new sources?").assertExists()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("How should answers be released?").assertExists()
        compose.onNodeWithText("Release without privacy review").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Ready to create this access level?").assertExists()
        assertEquals(0, saved)
    }
    @Test fun integrationDependencyOffersRestoringTheOriginalAnswerInsteadOfGenericRetry() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)), AccessAnswerRelease.unreviewed())
        val level = AccessLevelSummary("saved-level", "Before", 1, listOf(answer, AccessGrantRule.notes()), 0)
        val catalogue = overview.copy(levels = listOf(level))
        var draft by mutableStateOf(AccessLevelDraft.opening(level, catalogue).copy(rules = listOf(AccessGrantRule.notes())))
        compose.setContent { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft, error = "Move integrations to another access level or restore Answer.", errorCode = "level-in-use"), gateway,
                onClose = {}, onUpdate = { draft = it }, onSave = { saved++ })
        } }
        compose.onNodeWithText("Review changes").performClick()
        compose.onNodeWithText("Save changes").assertIsNotEnabled()
        compose.onNodeWithText("Retry save", substring = false).assertDoesNotExist()
        compose.onNodeWithText("Restore Answer").performClick()
        assertEquals(answer, draft.rule(AccessCapability.ANSWER))
        assertEquals(0, saved)
    }
    @Test fun aSameCountPolicyReplacementShowsOnlyTheChangedAccountInPrimaryReview() {
        val other = AccessSourceInstance("mail:other@example.org", "Other mail")
        val firstPolicy = SourceFilter(source.id, FilterAudience("saved-level", "direct"), listOf(FilterRule(listOf(FilterRef.item(FilterRef.MEMBERSHIP, "extra.labelIds", "first")), "share")), "hide")
        val secondPolicy = firstPolicy.copy(sourceId = other.id, rules = listOf(FilterRule(listOf(FilterRef.item(FilterRef.MEMBERSHIP, "extra.labelIds", "unchanged")), "share")))
        val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id, other.id))).copy(scopePolicies = listOf(firstPolicy, secondPolicy), filterRevision = 3)
        val level = AccessLevelSummary("saved-level", "Helper", 1, listOf(direct), 0)
        val catalogue = overview.copy(sources = listOf(source, other), levels = listOf(level))
        val replacement = firstPolicy.copy(rules = listOf(FilterRule(listOf(FilterRef.item(FilterRef.MEMBERSHIP, "extra.labelIds", "replacement")), "share")))
        val reader = FakeFilterGateway(previewFor = { policy ->
            readyPreview(policy.sourceId, 3, 1, policy.rules.flatMap { it.match }.map { ref ->
                FilterPreviewItem(ref, when (ref.id) { "first" -> "Project"; "replacement" -> "Receipts"; else -> "Outside" }, 1)
            })
        })
        var draft by mutableStateOf(AccessLevelDraft.opening(level, catalogue).setPolicy(replacement, source.id, AccessCapability.DIRECT))
        compose.setContent { OmnesisTheme { AccessHomeContent(AccessManagementState(catalogue, draft), reader, onClose = {}, onUpdate = { draft = it }) } }
        compose.onNodeWithText("Review changes").performClick()
        compose.onNodeWithText("Other mail", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Outside", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Mail · reader@example.org", substring = false).assertExists()
        compose.onNodeWithText("Project", substring = false).assertExists()
        compose.onNodeWithText("Removed").assertExists()
        compose.onNodeWithText("Receipts", substring = false).assertExists()
        compose.onNodeWithText("Added").assertExists()
    }
}
