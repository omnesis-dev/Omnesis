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
class AccessLevelFlowInteractionTest {
    @get:Rule val compose = createComposeRule()
    private val source = AccessSourceInstance("mail:reader@example.org", "Mail", sourceType = "mail")
    private val overview = AccessOverview(emptyList(), listOf(source))
    private val gateway = object : ScopeEditorGateway {
        override suspend fun preview(policy: ScopePolicy): ScopePreview = error("No filter expected")
        override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions = error("No picker expected")
    }
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
        compose.onNodeWithText("Access level name").assertDoesNotExist()
        compose.onNodeWithText("Ask Omnesis questions").performClick()
        compose.onNodeWithText("Save new notes").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Review your access level").assertExists()
        compose.onNodeWithText("Create access level").assertIsNotEnabled()
        compose.onNodeWithText("Access level name").performTextInput("Capture notes")
        compose.onNodeWithText("Create access level").assertIsEnabled().performClick()
        assertEquals(1, saved)
        compose.onNodeWithText("Which data may Answer use?").assertDoesNotExist()
    }
    @Test fun readingRequiresARealSourceChoiceBeforeItCanContinue() {
        show()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Which data may Answer use?").assertExists()
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
        compose.onNodeWithText("Release automatically").performClick()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Review changes").performClick()
        compose.onNodeWithText("Before").assertExists()
        compose.onNodeWithText("After").assertExists()
        compose.onNodeWithText("Answer data").assertDoesNotExist()
        assertEquals(0, saved)
        compose.onNodeWithText("Save changes").performClick()
        assertEquals(1, saved)
    }
    @Test fun conflictReloadRequiresAnExplicitDraftDiscardDecision() {
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)), AccessAnswerRelease.unreviewed())
        val level = AccessLevelSummary("saved-level", "Before", 7, listOf(answer), 2)
        val state = overview.copy(levels = listOf(level))
        show(AccessLevelDraft.opening(level, state).copy(name = "My unsaved name"), state, conflict = true)
        compose.onNodeWithText("Review changes").assertIsEnabled()
        compose.onNodeWithText("Reload latest…").performClick()
        assertEquals(0, reloaded)
        compose.onNodeWithText("Keep my draft").performClick()
        assertEquals(0, reloaded)
        compose.onNodeWithText("Reload latest…").performClick()
        compose.onNodeWithText("Reload latest", substring = false).performClick()
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
        compose.onNodeWithText("Reload latest…").assertExists()
    }
    @Test fun changingAnAlreadyReviewedCreateDecisionReturnsDirectlyToReview() {
        val initial = AccessLevelDraft.opening(null, overview).copy(name = "Capture notes", rules = listOf(AccessGrantRule.notes()))
        show(initial)
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithContentDescription("Change Permissions").performClick()
        compose.onNodeWithText("Back to review").performClick()
        compose.onNodeWithText("Review your access level").assertExists()
        assertEquals(0, saved)
    }
    @Test fun savingDisablesEditingAndLeavingTheDraft() {
        val initial = AccessLevelDraft.opening(null, overview).copy(name = "Capture notes", rules = listOf(AccessGrantRule.notes()))
        var saving by mutableStateOf(false)
        compose.setContent { OmnesisTheme {
            AccessHomeContent(AccessManagementState(overview, initial, loading = saving), gateway, onClose = { closed++ })
        } }
        compose.onNodeWithText("Continue").performClick()
        compose.runOnIdle { saving = true }
        compose.onNodeWithText("Access level name").assertIsNotEnabled()
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
        compose.onNodeWithText("Save new notes").performClick()
        compose.runOnIdle { catalogue = catalogue.copy(levels = listOf(level.copy(revision = 2))) }
        compose.onNodeWithText("Done").assertIsEnabled().performClick()
        compose.onNodeWithText("Review changes").assertIsEnabled().performClick()
        compose.onNodeWithText("Review your changes").assertExists()
        compose.onNodeWithText("Save changes").assertIsNotEnabled()
        assertEquals(0, saved)
    }
    @Test fun linkedReviewCorrectionVisitsSeparateDirectDataAndPersistsItsExactBoundary() {
        val scopes = SourceScopes(listOf(SourceScopeItem("label", "changes", noun = SourceScopeNoun("label", "labels"), picker = "search")))
        val ready = listOf(ScopeKindReadiness("label", true))
        val first = source.copy(scopes = scopes, scopeReadiness = ready)
        val second = AccessSourceInstance("mail:other@example.org", "Other mail", scopes = scopes, scopeReadiness = ready)
        val oldRef = ScopeRef("label", "before-label")
        val newRef = ScopeRef("label", "after-label")
        val answerPolicy = ScopePolicy(first.id, ScopeAudience("new", "answer"), listOf(ScopeRule(listOf(oldRef), "share")), "hide")
        val answer = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(first.id)), AccessAnswerRelease.unreviewed()).copy(scopePolicies = listOf(answerPolicy))
        val catalogue = overview.copy(sources = listOf(first, second), sourceFilters = SourceFiltersAvailability(true))
        var draft by mutableStateOf(AccessLevelDraft.opening(null, catalogue).copy(name = "Independent helper", rules = listOf(answer, AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList()))), requireAnswerPolicySelection = false))
        val filterGateway = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy) = ScopePreview(policy.sourceId, 6, 3, 3, 0, policy.rules.flatMap { it.match }.map { ScopePreviewItem(it, if (it == oldRef) "Project" else "Design notes", 3) }, emptyList(), ready)
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = ScopeOptions(sourceId, "mail", scopes, ready, listOf(ScopeOption(newRef, "Design notes", 3)))
        }
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(catalogue, draft), filterGateway, onClose = {}, onUpdate = { draft = it }, onSave = { saved++ })
        } } }
        repeat(5) { compose.onNodeWithText("Continue").performClick() }
        compose.onNodeWithContentDescription("Change Direct data").performScrollTo().performClick()
        compose.onNodeWithText("Choose separate data").performClick()
        compose.onNodeWithText("Back to review").performClick()
        compose.onNodeWithText("Choose Direct’s data").assertExists()
        compose.onNodeWithText("Mail", substring = false).performClick()
        compose.onNodeWithText("Other mail", substring = false).performClick()
        compose.onNodeWithContentDescription("Change Other mail for Direct").performClick()
        compose.onNodeWithText("Only matching content").performClick()
        compose.onNode(hasText("Continue") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText("Design notes", substring = false).performClick()
        compose.onNodeWithText("Review filter").performClick()
        compose.onNodeWithText("Apply filter").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Create access level").performClick()
        assertEquals(1, saved)
        val direct = draft.serializedRules.single { it.capability == AccessCapability.DIRECT }
        assertEquals(listOf(second.id), direct.sources.sourceIds)
        assertEquals(listOf(newRef), direct.scopePolicies.single().rules.single().match)
        assertEquals(ScopeAudience("new", "direct"), direct.scopePolicies.single().audience)
        assertEquals(answer.copy(filterRevision = 0), draft.serializedRules.single { it.capability == AccessCapability.ANSWER })
    }
    @Test fun addingReadingFromNotesReviewVisitsEveryNewlyRequiredDecision() {
        show(AccessLevelDraft.opening(null, overview).copy(name = "Note capture", rules = listOf(AccessGrantRule.notes())))
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithContentDescription("Change Permissions").performClick()
        compose.onNodeWithText("Ask Omnesis questions").performClick()
        compose.onNodeWithText("Read original records").performClick()
        compose.onNodeWithText("Back to review").performClick()
        compose.onNodeWithText("Which data may Answer use?").assertExists()
        compose.onNodeWithText("Mail", substring = false).performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Choose separate data").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Choose Direct’s data").assertExists()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("What about new sources?").assertExists()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("How should answers be released?").assertExists()
        compose.onNodeWithText("Release automatically").performClick()
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Review your access level").assertExists()
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
        val firstPolicy = ScopePolicy(source.id, ScopeAudience("saved-level", "direct"), listOf(ScopeRule(listOf(ScopeRef("label", "first", "Project")), "share")), "hide")
        val secondPolicy = firstPolicy.copy(sourceId = other.id, rules = listOf(ScopeRule(listOf(ScopeRef("label", "unchanged", "Outside")), "share")))
        val direct = AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id, other.id))).copy(scopePolicies = listOf(firstPolicy, secondPolicy), filterRevision = 3)
        val level = AccessLevelSummary("saved-level", "Helper", 1, listOf(direct), 0)
        val catalogue = overview.copy(sources = listOf(source, other), levels = listOf(level))
        val replacement = firstPolicy.copy(rules = listOf(ScopeRule(listOf(ScopeRef("label", "replacement", "Receipts")), "share")))
        show(AccessLevelDraft.opening(level, catalogue).setPolicy(replacement, source.id, AccessCapability.DIRECT), catalogue)
        compose.onNodeWithText("Review changes").performClick()
        compose.onNodeWithText("Other mail", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Outside", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Mail", substring = false).assertExists()
        compose.onNodeWithText("Project", substring = false).assertExists()
        compose.onNodeWithText("Receipts", substring = false).assertExists()
        compose.onNodeWithText("Inspect selection identifiers").performScrollTo().performClick()
        compose.onNodeWithText("After identifiers\nLabel: replacement", substring = false).assertExists()
    }
}
