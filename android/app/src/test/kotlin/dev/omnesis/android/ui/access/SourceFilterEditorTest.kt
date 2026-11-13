// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.compose.runtime.*
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.hasProgressBarRangeInfo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
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
import androidx.compose.ui.test.assertCountEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SourceFilterEditorTest {
    @get:Rule val compose = createComposeRule()
    private val original = FilterIdentifier("phone", "+15550100123")
    private val ref = FilterRef.person("Maya", listOf(original))
    private val chats = readyField("extra.chatId", FilterRef.MEMBERSHIP, "chat", "chats")
    private val people = peopleField("phone", "email")
    private val policy = SourceFilter("scope-chat:one", FilterAudience("level-example", "answer"), listOf(FilterRule(listOf(ref), "hide")), "share")
    private val source = AccessSourceInstance("scope-chat:one", "Cedar account", filterable = true)
    private val preview = readyPreview(source.id, 10, 6, listOf(FilterPreviewItem(ref, "Maya", 3)), unmatchedText = "1 record can't be matched to a person and stay hidden.")
    private fun editorWith(vararg fields: FilterEditorField) = FilterEditor(source.id, "scope-chat", fields = fields.toList())
    private fun gatewayOf(previewFor: suspend (SourceFilter) -> FilterPreview = { preview }, editor: FilterEditor = editorWith(people)) =
        FakeFilterGateway(editorFor = { editor }, previewFor = previewFor)
    private fun show(enabled: Boolean, gateway: FilterEditorGateway = gatewayOf(), frozen: Boolean = true, changed: (SourceFilter?) -> Unit = {}) {
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides frozen) {
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
    @Test fun applyingKeepsTheSavedEntryAsItIs() {
        var saved: SourceFilter? = null
        show(true) { saved = it }
        reviewFilter()
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(listOf(original), saved!!.rules.single().match.single().identifiers)
    }
    @Test fun savedFiltersRemainVisibleWhenAuthoringIsDisabled() {
        show(false)
        compose.onNodeWithText("Apply filter").assertDoesNotExist()
        compose.onAllNodesWithText("Close")[0].assertIsEnabled()
        compose.onNodeWithText("Add item").assertDoesNotExist()
        compose.onNodeWithText("Remove filter").assertDoesNotExist()
    }
    @Test fun theReviewStatesTheGatewaysSentencesForRecordsKeptHiddenOnlyWhenThereAreAny() {
        show(true)
        reviewFilter()
        compose.onNodeWithText("1 record can't be matched to a person and stay hidden.").performScrollTo().assertExists()
        compose.onNodeWithText("older items", substring = true).assertDoesNotExist()
        compose.onNodeWithText("still syncing", substring = true).assertDoesNotExist()
        compose.onNodeWithText("couldn", substring = true).assertDoesNotExist()
    }
    @Test fun countsStillBeingWorkedOutNeverHoldUpApplyingAndArriveByThemselves() {
        var previews = 0
        var saved: SourceFilter? = null
        // Outside inspection mode, where a render stays as first drawn, so asking again runs as it does on a device.
        show(true, gatewayOf(previewFor = { if (++previews < 3) pendingPreview(1_000) else preview }), frozen = false) { saved = it }
        reviewFilter()
        compose.onNodeWithText(COUNTING_MESSAGE).assertExists()
        compose.onNodeWithText("Apply filter").assertIsEnabled()
        compose.onNodeWithText("Refresh", substring = true).assertDoesNotExist()
        val asked = previews
        compose.mainClock.advanceTimeBy(1_500)
        compose.waitForIdle()
        assertEquals(asked + 1, previews)
        compose.mainClock.advanceTimeBy(1_500)
        compose.waitForIdle()
        compose.onNodeWithText(COUNTING_MESSAGE).assertDoesNotExist()
        compose.onNodeWithText("shared").assertExists()
        val settled = previews
        compose.mainClock.advanceTimeBy(ACCESS_REFRESH_INTERVAL_MILLIS * 3)
        compose.waitForIdle()
        assertEquals(settled, previews)
        compose.onNodeWithText("Apply filter").performClick()
        assertEquals(policy.rules, saved!!.rules)
    }
    @Test fun aFieldThatNeedsAResyncShowsTheGatewaysSentenceAndItsResyncStartsTheResync() {
        val needs = FilterFieldState(FilterFieldState.NEEDS_RESYNC, cost = "This reads about 75,000 messages a day.",
            text = "Chat filters need Cedar to be resynced. Your chats stay searchable meanwhile. This reads about 75,000 messages a day.")
        val resyncing = FilterFieldState(FilterFieldState.RESYNCING, processed = 212, total = 900, text = "Resyncing Cedar: 212 of about 900.")
        var current = needs
        val gateway = FakeFilterGateway(editorFor = { editorWith(chats.copy(state = current), people) })
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterPicker(source, gateway, onClose = {}, state = remember { SourceFilterPickerState("extra.chatId") }, nameFor = { "Cedar" }) {}
        } } }
        compose.waitForIdle()
        compose.onNodeWithText(needs.text!!).assertExists()
        compose.onNodeWithContentDescription("Search chats").assertDoesNotExist()
        current = resyncing
        compose.onNodeWithText("Resync Cedar").performClick()
        compose.waitForIdle()
        assertEquals(listOf(source.id), gateway.resynced)
        compose.onNodeWithText("Resyncing Cedar: 212 of about 900.").assertExists()
        compose.onNodeWithText("Resync Cedar").assertDoesNotExist()
        compose.onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo(212f / 900f, 0f..1f))).assertExists()
        // The other field of the account stays usable meanwhile.
        compose.onNodeWithText("People").performClick()
        compose.onNodeWithContentDescription("Search people").assertExists()
    }
    @Test fun fieldsWaitingOnTheSameResyncAreStatedOnceNamingThemAll() {
        val needs = { name: String -> FilterFieldState(FilterFieldState.NEEDS_RESYNC, text = "$name filters need Cedar to be resynced. Your chats stay searchable meanwhile.") }
        val gateway = FakeFilterGateway(editorFor = {
            editorWith(chats.copy(state = needs("Chat")), people.copy(state = needs("People"))).copy(resync = FilterEditorResync(FilterFieldState.NEEDS_RESYNC,
                listOf(chats.field, people.field), "Chat and people filters need Cedar to be resynced. Your chats stay searchable meanwhile."))
        })
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterPicker(source, gateway, onClose = {}, nameFor = { "Cedar" }) {}
        } } }
        compose.waitForIdle()
        compose.onNodeWithText("Chat and people filters need Cedar to be resynced. Your chats stay searchable meanwhile.").assertExists()
        compose.onAllNodesWithText("Resync Cedar").assertCountEquals(1)
        compose.onNodeWithText("Chats").assertDoesNotExist()
        compose.onNodeWithContentDescription("Search people").assertDoesNotExist()
        compose.onNodeWithText("Resync Cedar").performClick()
        compose.waitForIdle()
        assertEquals(listOf(source.id), gateway.resynced)
        compose.onNodeWithText("Resyncing Cedar…").assertExists()
    }
    @Test fun aFieldWaitingForItsListOrAnUpdateSaysSoAndOffersNothingToPress() {
        val states = listOf(
            FilterFieldState(FilterFieldState.LIST_PENDING, text = "Waiting for Cedar to send its list of chats."),
            FilterFieldState(FilterFieldState.COLLECTOR_BEHIND, devices = listOf(FilterDevice("dev_studio", "Studio Mac")), text = "Update Omnesis on Studio Mac to use these filters."),
            FilterFieldState(FilterFieldState.GATEWAY_BEHIND, text = "Update this Omnesis gateway to use these filters."),
            FilterFieldState("a-later-state"),
        )
        var current by mutableStateOf(states.first())
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            key(current) { SourceFilterPicker(source, FakeFilterGateway(editorFor = { editorWith(chats.copy(state = current)) }), onClose = {}, nameFor = { "Cedar" }) {} }
        } } }
        states.forEach { state ->
            current = state
            compose.waitForIdle()
            compose.onNodeWithText(state.text ?: FIELD_UNAVAILABLE_MESSAGE).assertExists()
            compose.onNodeWithText("Resync", substring = true).assertDoesNotExist()
        }
    }
    @Test fun aTypedAddressIsReadByTheGatewayAndItsRefusalShownAsItSays() {
        val refusal = "Enter a valid phone number. Include the international country code."
        var picked: List<FilterRef>? = null
        val gateway = FakeFilterGateway(editorFor = { editorWith(people) }, identifierFor = { type, value ->
            if (value.startsWith("+44")) FilterIdentifierCheck(error = refusal) else FilterIdentifierCheck(FilterIdentifier(type, "+15550100142"))
        })
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SourceFilterPicker(source, gateway, onClose = {}) { picked = it }
        } } }
        compose.waitForIdle()
        compose.onNodeWithText("Add an email or phone number").performClick()
        compose.onNodeWithContentDescription("Phone number").performTextInput("+44 (0)7700 900123")
        compose.onNodeWithText("Add").performClick()
        compose.waitForIdle()
        compose.onNodeWithText(refusal).assertExists()
        compose.onNodeWithContentDescription("Phone number").performTextClearance()
        compose.onNodeWithContentDescription("Phone number").performTextInput("00 1 (555) 010-0142")
        compose.onNodeWithText("Add").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("1 selected").assertExists()
        compose.onNodeWithText("Review filter").performClick()
        assertEquals(listOf(FilterRef.person("+15550100142", listOf(FilterIdentifier("phone", "+15550100142")))), picked)
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
            .copy(scopePolicies = if (saved) listOf(policy.copy(audience = FilterAudience(NEW_ACCESS_LEVEL_ID, "answer"))) else emptyList())
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
        val gateway = FakeFilterGateway()
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
