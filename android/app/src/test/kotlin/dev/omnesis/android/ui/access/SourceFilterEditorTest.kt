// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SourceFilterEditorTest {
    @get:Rule val compose = createComposeRule()
    private val original = ScopeIdentifier("phone", "+15550100123")
    private val extra = ScopeIdentifier("email", "maya@example.org")
    private val ref = ScopeRef("participant", label = "Maya", identifiers = listOf(original))
    private val policy = ScopePolicy("scope-chat:one", ScopeAudience("level-example", "answer"), listOf(ScopeRule(listOf(ref), "hide")), "share")
    private val ready = listOf(ScopeKindReadiness("participant", true))
    private val source = AccessSourceInstance("scope-chat:one", "Cedar account", scopes = SourceScopes(listOf(SourceScopeItem("participant", "changes", identifiers = listOf("phone", "email")))), scopeReadiness = ready)
    private val preview = ScopePreview(source.id, 10, 6, 4, 1, listOf(ScopePreviewItem(ref, "Maya", 3)), emptyList(), ready, listOf(ScopeIdentifierProposal(0, "Maya", listOf(extra))))
    private fun show(enabled: Boolean, result: ScopePreview = preview, changed: (ScopePolicy?) -> Unit = {}) {
        val gateway = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy) = result
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions = ScopeOptions(sourceId, "scope-chat", source.scopes!!, ready, emptyList())
        }
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme { SourceFilterEditor(source, "level-example", "answer", policy, enabled, gateway, onClose = {}, changed = changed) }
            }
        }
        compose.waitForIdle()
    }
    private fun reviewFilter() {
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Review filter").performClick()
        compose.waitForIdle()
    }
    @Test fun reopeningNeverAddsNewAddressesByItself() {
        var saved: ScopePolicy? = null
        show(true) { saved = it }
        reviewFilter()
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(listOf(original), saved!!.rules.single().match.single().identifiers)
    }
    @Test fun anExplicitAddCapturesOnlyTheOfferedAddresses() {
        var saved: ScopePolicy? = null
        show(true) { saved = it }
        reviewFilter()
        compose.onNodeWithText("Other addresses for Maya").performScrollTo().performClick()
        compose.onNodeWithText("maya@example.org").assertExists()
        compose.onNodeWithText("Add").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(listOf(original, extra), saved!!.rules.single().match.single().identifiers)
    }
    @Test fun savedRestrictionsRemainVisibleWhenAuthoringIsDisabled() {
        show(false)
        compose.onNodeWithText("Apply filter").assertDoesNotExist()
        compose.onAllNodesWithText("Close")[0].assertIsEnabled()
        compose.onNodeWithText("Add item").assertDoesNotExist()
        compose.onNodeWithText("Remove filter").assertDoesNotExist()
    }
    @Test fun sourcePreparationDisablesSaving() {
        show(true, preview.copy(readiness = listOf(ScopeKindReadiness("participant", false, reason = "backfill"))))
        reviewFilter()
        compose.onNodeWithText("Apply filter").assertIsNotEnabled()
        compose.onNodeWithText(COUNTING_MESSAGE).assertExists()
    }
    @Test fun countsStillBeingPreparedAreAskedForAgainUntilTheyArriveAndThenTheFilterCanBeApplied() {
        var previews = 0
        val preparing = preview.copy(readiness = listOf(ScopeKindReadiness("participant", false, reason = "backfill")))
        val gateway = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy): ScopePreview = if (++previews < 3) preparing else preview
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions = ScopeOptions(sourceId, "scope-chat", source.scopes!!, ready, emptyList())
        }
        // Outside inspection mode, where a render stays as first drawn, so the refresh runs as it does on a device.
        compose.setContent { OmnesisTheme { SourceFilterEditor(source, "level-example", "answer", policy, true, gateway, onClose = {}) {} } }
        reviewFilter()
        compose.onNodeWithText("Apply filter").assertIsNotEnabled()
        compose.onNodeWithText(COUNTING_MESSAGE).assertExists()
        compose.onNodeWithText("Refresh", substring = true).assertDoesNotExist()
        val asked = previews
        compose.mainClock.advanceTimeBy(ACCESS_REFRESH_INTERVAL_MILLIS + 500)
        compose.waitForIdle()
        assertEquals(asked + 1, previews)
        compose.onNodeWithText("Apply filter").assertIsNotEnabled()
        compose.mainClock.advanceTimeBy(ACCESS_REFRESH_INTERVAL_MILLIS + 500)
        compose.waitForIdle()
        compose.onNodeWithText(COUNTING_MESSAGE).assertDoesNotExist()
        compose.onNodeWithText("Apply filter").assertIsEnabled()
        val settled = previews
        compose.mainClock.advanceTimeBy(ACCESS_REFRESH_INTERVAL_MILLIS * 3)
        compose.waitForIdle()
        assertEquals(settled, previews)
    }
    @Test fun aChangedPolicyCannotBeSavedBeforeItsOwnPreviewReturns() {
        val pending = kotlinx.coroutines.CompletableDeferred<ScopePreview>()
        var calls = 0
        val gateway = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy): ScopePreview = if (++calls == 1) preview else pending.await()
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions = ScopeOptions(sourceId, "scope-chat", source.scopes!!, ready, emptyList())
        }
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme { SourceFilterEditor(source, "level-example", "answer", policy, true, gateway, onClose = {}) {} }
            }
        }
        compose.waitForIdle()
        reviewFilter()
        compose.onNodeWithText("Other addresses for Maya").performScrollTo().performClick()
        compose.onNodeWithText("Add").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Apply filter").assertIsNotEnabled()
        compose.onNodeWithText(COUNTING_MESSAGE).assertExists()
        compose.onNodeWithText("Other addresses for Maya").assertDoesNotExist()
        pending.complete(preview)
        compose.waitForIdle()
        compose.onNodeWithText("Apply filter").assertIsEnabled()
    }

    /** The approval's Data & privacy step on [page], over one filterable account that Answer and Direct both read. */
    private fun showConsent(page: AccessLevelPage, answer: Boolean = true, linked: Boolean = false, enabled: Boolean = true, saved: Boolean = false, edit: (AccessSourceInstance, AccessCapability) -> Unit = { _, _ -> }) {
        val request = AccessAuthorizationRequest(
            id = "request-example", approvalId = "approval-example", status = "pending", clientId = "client-example",
            clientName = "Fictional assistant", redirectOrigin = "https://example.com", resource = "https://gateway.example.com",
            scope = "read", expiresAt = 100_000, requiresAnswer = false,
        )
        val overview = AccessOverview(principals = emptyList(), sources = listOf(source), sourceFilters = SourceFiltersAvailability(enabled))
        val boundary = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id))
        val answerRule = AccessGrantRule.answer(boundary, AccessAnswerRelease.unreviewed())
            .copy(scopePolicies = if (saved) listOf(policy.copy(audience = ScopeAudience(NEW_ACCESS_LEVEL_ID, "answer"))) else emptyList())
        val form = AccessAuthorizationForm.initial(request, overview).editing {
            it.copy(rules = listOfNotNull(answerRule.takeIf { answer }, AccessGrantRule.direct(boundary)), directSameAsAnswer = linked, requireAnswerPolicySelection = false)
        }
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    AccessAuthorizationContent(
                        state = AccessAuthorizationUiState(request = request, overview = overview, form = form, step = AccessAuthorizationStep.DATA, dataPage = page),
                        onClose = {}, onLookup = {}, onDecide = { _, _ -> }, onEditFilter = edit, clock = { 0L },
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    @Test fun anApprovalOpensAnAccountFilterForTheCapabilityItsStepAsksAbout() {
        val calls = mutableListOf<Pair<String, AccessCapability>>()
        showConsent(AccessLevelPage.ANSWER_DATA) { source, capability -> calls += source.id to capability }
        compose.onNodeWithText("Which sources can Answer use?").assertExists()
        compose.onNodeWithContentDescription("Change Cedar account for Direct").assertDoesNotExist()
        compose.onNodeWithContentDescription("Change Cedar account for Answer").performClick()
        assertEquals(listOf(source.id to AccessCapability.ANSWER), calls)
    }

    @Test fun anApprovalWithSeparateDirectSourcesFiltersThemAsDirect() {
        val calls = mutableListOf<Pair<String, AccessCapability>>()
        showConsent(AccessLevelPage.DIRECT_CHOICE) { source, capability -> calls += source.id to capability }
        compose.onNodeWithText("Which sources can Direct read?").assertExists()
        compose.onNodeWithText("Choose different sources").assertIsSelected()
        compose.onNodeWithContentDescription("Change Cedar account for Direct").performClick()
        assertEquals(listOf(source.id to AccessCapability.DIRECT), calls)
    }

    @Test fun anApprovalWhoseDirectUsesAnswersSourcesListsThemWithoutASecondFilterEntry() {
        showConsent(AccessLevelPage.DIRECT_CHOICE, linked = true) { _, _ -> error("No filter is opened from Answer's list") }
        compose.onNodeWithText(DIRECT_SAME_AS_ANSWER_LABEL).assertIsSelected()
        compose.onNodeWithText("Cedar account").assertExists()
        compose.onNodeWithText("Change").assertDoesNotExist()
    }

    @Test fun aDirectOnlyApprovalAsksForDirectsOwnAccounts() {
        val calls = mutableListOf<AccessCapability>()
        showConsent(AccessLevelPage.DIRECT_DATA, answer = false, linked = true) { _, capability -> calls += capability }
        compose.onNodeWithText(DIRECT_SAME_AS_ANSWER_LABEL).assertDoesNotExist()
        compose.onNodeWithContentDescription("Change Cedar account for Direct").performClick()
        assertEquals(listOf(AccessCapability.DIRECT), calls)
    }

    @Test fun anApprovalOffersNoNewFilterWhileFilterEditingIsOff() {
        showConsent(AccessLevelPage.ANSWER_DATA, enabled = false) { _, _ -> error("No new filter action expected") }
        compose.onNodeWithText("Cedar account").assertExists()
        compose.onNodeWithText("Change").assertDoesNotExist()
    }

    @Test fun anApprovalKeepsTheEntryToASavedFilterAndTheAccountThatHoldsItWhileFilterEditingIsOff() {
        val calls = mutableListOf<AccessCapability>()
        showConsent(AccessLevelPage.ANSWER_DATA, enabled = false, saved = true) { _, capability -> calls += capability }
        // Unticking the account would drop a filter that cannot be put back.
        compose.onNodeWithText("Cedar account").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Change Cedar account for Answer").performClick()
        assertEquals(listOf(AccessCapability.ANSWER), calls)
    }

    @Test fun anApprovalCannotPointDirectAtAnswersSavedFilterWhileFilterEditingIsOff() {
        showConsent(AccessLevelPage.DIRECT_CHOICE, enabled = false, saved = true)
        compose.onNodeWithText(DIRECT_SAME_AS_ANSWER_LABEL).assertIsNotEnabled()
        compose.onNodeWithText("Cedar account").assertIsEnabled()
        compose.onNodeWithText("Change").assertDoesNotExist()
    }

    @Test fun readOnlySavedLevelCannotCopyFiltersOrOfferAnUnfilteredDirectEntry() {
        val boundary = AccessSourceBoundary(AccessSourceMode.ALL, emptyList())
        val rules = listOf(AccessGrantRule.answer(boundary, AccessAnswerRelease.unreviewed()).copy(scopePolicies = listOf(policy)), AccessGrantRule.direct(boundary))
        val level = AccessLevelSummary("level-example", "Research assistant", 1, rules, 1)
        val overview = AccessOverview(principals = emptyList(), sources = listOf(source), levels = listOf(level), sourceFilters = SourceFiltersAvailability(false))
        val gateway = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy): ScopePreview = error("No editor expected")
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions = ScopeOptions(sourceId, "scope-chat", source.scopes!!, ready, emptyList())
        }
        compose.setContent { OmnesisTheme {
            AccessHomeContent(AccessManagementState(overview, AccessLevelDraft.opening(level, overview)), gateway, onClose = {})
        } }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Change Direct data").performClick()
        compose.onNodeWithText(DIRECT_SAME_AS_ANSWER_LABEL).assertIsNotEnabled()
        compose.onNodeWithText("Change").assertDoesNotExist()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithContentDescription("Change Answer data").performClick()
        compose.onNodeWithText("Change").assertIsEnabled()
    }

}
