// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
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
                OmnesisTheme { SourceFilterEditor(source, "level-example", "answer", policy, enabled, gateway, onClose = {}, initialPreview = result, changed = changed) }
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
        compose.onNodeWithText("Other known identifiers").performScrollTo().performClick()
        compose.onNodeWithText("Add these identifiers").performScrollTo().performClick()
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
                OmnesisTheme { SourceFilterEditor(source, "level-example", "answer", policy, true, gateway, onClose = {}, initialPreview = preview) {} }
            }
        }
        compose.waitForIdle()
        reviewFilter()
        compose.onNodeWithText("Other known identifiers").performScrollTo().performClick()
        compose.onNodeWithText("Add these identifiers").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Apply filter").assertIsNotEnabled()
        compose.onNodeWithText("Add these identifiers").assertDoesNotExist()
        pending.complete(preview)
        compose.waitForIdle()
        compose.onNodeWithText("Apply filter").assertIsEnabled()
    }

    private fun showConsent(answer: Boolean, linked: Boolean, enabled: Boolean = true, saved: Boolean = false, edit: (AccessSourceInstance, String) -> Unit) {
        val request = AccessAuthorizationRequest(
            id = "request-example", approvalId = "approval-example", status = "pending", clientId = "client-example",
            clientName = "Fictional assistant", redirectOrigin = "https://example.com", resource = "https://gateway.example.com",
            scope = "read", expiresAt = 100_000, requiresAnswer = false,
        )
        val overview = AccessOverview(principals = emptyList(), sources = listOf(source), sourceFilters = SourceFiltersAvailability(enabled))
        val selection = AccessSourceSelectionState(allowedSourceIds = setOf(source.id))
        val form = AccessAuthorizationForm.initial(request, overview).copy(
            answerEnabled = answer, directEnabled = true, linkedSources = linked,
            answerSources = selection, directSources = selection, answerRelease = AccessAnswerReleaseChoice.UNREVIEWED,
            scopePolicies = if (saved) mapOf("answer" to listOf(policy)) else emptyMap(),
        )
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    AccessAuthorizationContent(
                        state = AccessAuthorizationUiState(request = request, overview = overview, form = form, step = AccessAuthorizationStep.DATA),
                        onClose = {}, onLookup = {}, onDecide = { _, _ -> }, onEditFilter = edit, clock = { 0L },
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    @Test @Config(sdk = [34], qualifiers = "w411dp-h2200dp-xxhdpi")
    fun consentFilterActionsIdentifyAndDispatchTheirIndependentCapability() {
        val calls = mutableListOf<Pair<String, String>>()
        showConsent(answer = true, linked = false) { source, capability -> calls += source.id to capability }
        compose.onNodeWithText("Filter Cedar account for Answer").performClick()
        compose.onNodeWithText("Filter Cedar account for Direct").performClick()
        assertEquals(listOf(source.id to "answer", source.id to "direct"), calls)
    }

    @Test @Config(sdk = [34], qualifiers = "w411dp-h2200dp-xxhdpi")
    fun linkedConsentFilterActionNamesBothCapabilities() {
        val calls = mutableListOf<String>()
        showConsent(answer = true, linked = true) { _, capability -> calls += capability }
        compose.onNodeWithText("Filter Cedar account for Answer and Direct").performClick()
        compose.onNodeWithText("Filter Cedar account for Direct").assertDoesNotExist()
        assertEquals(listOf("answer"), calls)
    }

    @Test @Config(sdk = [34], qualifiers = "w411dp-h2200dp-xxhdpi")
    fun directOnlyConsentStillOffersItsOwnFilterAction() {
        val calls = mutableListOf<String>()
        showConsent(answer = false, linked = true) { _, capability -> calls += capability }
        compose.onNodeWithText("Filter Cedar account for Direct").performClick()
        compose.onNodeWithText("Filter Cedar account for Answer").assertDoesNotExist()
        assertEquals(listOf("direct"), calls)
    }

    @Test @Config(sdk = [34], qualifiers = "w411dp-h2200dp-xxhdpi")
    fun disabledAuthoringDoesNotOfferFiltersForAnUnfilteredConsent() {
        showConsent(answer = true, linked = false, enabled = false) { _, _ -> error("No new filter action expected") }
        compose.onNodeWithText("Filter Cedar account for Answer").assertDoesNotExist()
        compose.onNodeWithText("Filter Cedar account for Direct").assertDoesNotExist()
    }

    @Test @Config(sdk = [34], qualifiers = "w411dp-h2200dp-xxhdpi")
    fun disabledAuthoringRetainsOnlyTheSavedCapabilityFilterEntry() {
        val calls = mutableListOf<String>()
        showConsent(answer = true, linked = false, enabled = false, saved = true) { _, capability -> calls += capability }
        compose.onNodeWithText("Filter Cedar account for Answer").performClick()
        compose.onNodeWithText("Filter Cedar account for Direct").assertDoesNotExist()
        assertEquals(listOf("answer"), calls)
    }

    @Test @Config(sdk = [34], qualifiers = "w411dp-h2200dp-xxhdpi")
    fun readOnlyConsentDisablesRelinkAndOnlyBoundaryActionsThatRemoveSavedFilters() {
        showConsent(answer = true, linked = false, enabled = false, saved = true) { _, _ -> }
        compose.onNodeWithText("Allow the same sources for Answer and Direct").assertIsNotEnabled()
        compose.onAllNodesWithText("Block all")[0].assertIsNotEnabled()
        compose.onAllNodesWithText("Block all")[1].assertIsEnabled()
        compose.onAllNodesWithText("Cedar account")[0].assertIsNotEnabled()
        compose.onAllNodesWithText("Cedar account")[1].assertIsEnabled()
    }

    @Test @Config(sdk = [34], qualifiers = "w411dp-h2200dp-xxhdpi")
    fun readOnlySavedLevelCannotCopyFiltersOrOfferAnUnfilteredDirectEntry() {
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
        compose.onNodeWithText("Copy Answer’s data once").assertIsNotEnabled()
        compose.onNodeWithText("Change").assertDoesNotExist()
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithContentDescription("Change Answer data").performClick()
        compose.onNodeWithText("Change").assertIsEnabled()
    }

}
