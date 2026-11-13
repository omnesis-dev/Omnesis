// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.screenshots

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.captureScreenRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.*
import dev.omnesis.android.ui.access.*
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.document.DocumentAccessContent
import dev.omnesis.android.ui.document.DocumentFixtures
import dev.omnesis.android.ui.document.InspectorContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The access screens as a gallery: each state once in dark and once in light, over the same invented
 * example data, reached through the production screens the way an owner reaches it. Every render is
 * the whole screen, as tall as its content needs.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
class AccessGalleryScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val fixture = AccessLevelScreenshotTest
    private var dark = true

    /** Document timestamps are shown in local time; every render draws them in UTC so they read the same on any host. */
    @org.junit.Before fun utc() { java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC")) }

    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun accessHomeDark() = render("access_home", dark = true) { home() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun accessHomeLight() = render("access_home", dark = false) { home() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun accessHomeMenuDark() = render("access_home_menu", dark = true) { home(menuOpen = true) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun accessHomeMenuLight() = render("access_home_menu", dark = false) { home(menuOpen = true) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun levelPageDark() = render("level_page", dark = true) { level() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun levelPageLight() = render("level_page", dark = false) { level() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun nameDark() = render("name", dark = true) { decision("Change name") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun nameLight() = render("name", dark = false) { decision("Change name") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun permissionsDark() = render("permissions", dark = true) { decision("Change permissions") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun permissionsLight() = render("permissions", dark = false) { decision("Change permissions") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun answerDataDark() = render("answer_data", dark = true) { decision("Change Answer data") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun answerDataLight() = render("answer_data", dark = false) { decision("Change Answer data") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun directDataDark() = render("direct_data", dark = true) { decision("Change Direct data") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun directDataLight() = render("direct_data", dark = false) { decision("Change Direct data") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun directDataLinkedDark() = render("direct_data_linked", dark = true) { linkedDirectData() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun directDataLinkedLight() = render("direct_data_linked", dark = false) { linkedDirectData() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun directChoiceDark() = render("direct_choice", dark = true) { newLevel(steps = 2) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun directChoiceLight() = render("direct_choice", dark = false) { newLevel(steps = 2) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun newSourcesDark() = render("new_sources", dark = true) { decision("Change new sources") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun newSourcesLight() = render("new_sources", dark = false) { decision("Change new sources") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun releaseDark() = render("release", dark = true) { decision("Change Answer release") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun releaseLight() = render("release", dark = false) { decision("Change Answer release") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterModeDark() = render("filter_mode", dark = true) { filter() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterModeLight() = render("filter_mode", dark = false) { filter() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerFoldersDark() = render("filter_picker_folders", dark = true) { folderPicker() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerFoldersLight() = render("filter_picker_folders", dark = false) { folderPicker() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerPeopleDark() = render("filter_picker_people", dark = true) { peoplePicker() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerPeopleLight() = render("filter_picker_people", dark = false) { peoplePicker() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterReviewDark() = render("filter_review", dark = true) { filterReview(fixture.gateway) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterReviewLight() = render("filter_review", dark = false) { filterReview(fixture.gateway) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterReviewCountsDark() = render("filter_review_counts", dark = true) { filterReview(fixture.gateway, fixture.driveSource, fixture.drivePolicy) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterReviewCountsLight() = render("filter_review_counts", dark = false) { filterReview(fixture.gateway, fixture.driveSource, fixture.drivePolicy) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterNeedsResyncDark() = render("filter_needs_resync", dark = true) { stateOf(fixture.gmailSource, fixture.gmailNeedsResync) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterNeedsResyncLight() = render("filter_needs_resync", dark = false) { stateOf(fixture.gmailSource, fixture.gmailNeedsResync) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterResyncingDark() = render("filter_resyncing", dark = true) { stateOf(fixture.driveSource, mapOf(AccessLevelScreenshotTest.DRIVE_FOLDERS to fixture.driveResyncing)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterResyncingLight() = render("filter_resyncing", dark = false) { stateOf(fixture.driveSource, mapOf(AccessLevelScreenshotTest.DRIVE_FOLDERS to fixture.driveResyncing)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterCollectorBehindDark() = render("filter_collector_behind", dark = true) { treePicker(sessions, emptyList(), emptyList(), treeGatewayWith(collectorBehind)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterCollectorBehindLight() = render("filter_collector_behind", dark = false) { treePicker(sessions, emptyList(), emptyList(), treeGatewayWith(collectorBehind)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerDevicesDark() = render("filter_picker_devices", dark = true) { treePicker(sessions, emptyList(), emptyList()) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerDevicesLight() = render("filter_picker_devices", dark = false) { treePicker(sessions, emptyList(), emptyList()) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterAccountNotConnectedDark() = render("filter_account_not_connected", dark = true) { filter(disconnectedAccount(fixture.source.id, fixture.names), fixture.disconnectedGateway) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterAccountNotConnectedLight() = render("filter_account_not_connected", dark = false) { filter(disconnectedAccount(fixture.source.id, fixture.names), fixture.disconnectedGateway) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun reviewChangesDark() = render("review_changes", dark = true) { reviewChanges() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun reviewChangesLight() = render("review_changes", dark = false) { reviewChanges() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h1040dp-xxhdpi")
    fun reviewChangedFilterDark() = render("review_changed_filter", dark = true) { reviewChangedFilter() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h1040dp-xxhdpi")
    fun reviewChangedFilterLight() = render("review_changed_filter", dark = false) { reviewChangedFilter() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h1450dp-xxhdpi")
    fun reviewDirectRemovedDark() = render("review_direct_removed", dark = true) { reviewDirectRemoved() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h1450dp-xxhdpi")
    fun reviewDirectRemovedLight() = render("review_direct_removed", dark = false) { reviewDirectRemoved() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun reviewNewLevelDark() = render("review_new_level", dark = true) { newLevel(steps = 5) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun reviewNewLevelLight() = render("review_new_level", dark = false) { newLevel(steps = 5) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun levelChangedElsewhereDark() = render("level_changed_elsewhere", dark = true) { level(conflict = true) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun levelChangedElsewhereLight() = render("level_changed_elsewhere", dark = false) { level(conflict = true) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun deleteConfirmDark() = render("delete_confirm", dark = true) { deletion("Notes capture") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun deleteConfirmLight() = render("delete_confirm", dark = false) { deletion("Notes capture") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun deleteInUseDark() = render("delete_in_use", dark = true) { deletion("Research assistant") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun deleteInUseLight() = render("delete_in_use", dark = false) { deletion("Research assistant") }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h960dp-xxhdpi")
    fun approvalConnectionDark() = render("approval_connection", dark = true) { approval(AccessAuthorizationStep.CONNECTION) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h960dp-xxhdpi")
    fun approvalConnectionLight() = render("approval_connection", dark = false) { approval(AccessAuthorizationStep.CONNECTION) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun approvalPermissionsDark() = render("approval_permissions", dark = true) { approval(AccessAuthorizationStep.PERMISSIONS) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun approvalPermissionsLight() = render("approval_permissions", dark = false) { approval(AccessAuthorizationStep.PERMISSIONS) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun approvalSourcesDark() = render("approval_sources", dark = true) { approval(AccessAuthorizationStep.DATA) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun approvalSourcesLight() = render("approval_sources", dark = false) { approval(AccessAuthorizationStep.DATA) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h950dp-xxhdpi")
    fun approvalReviewDark() = render("approval_review", dark = true) { approval(AccessAuthorizationStep.REVIEW) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h950dp-xxhdpi")
    fun approvalReviewLight() = render("approval_review", dark = false) { approval(AccessAuthorizationStep.REVIEW) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h960dp-xxhdpi")
    fun approvalReviewExistingDark() = render("approval_review_existing", dark = true) { approval(AccessAuthorizationStep.REVIEW, existing = true) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h960dp-xxhdpi")
    fun approvalReviewExistingLight() = render("approval_review_existing", dark = false) { approval(AccessAuthorizationStep.REVIEW, existing = true) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun documentDetailsDark() = render("document_details", dark = true) { documentDetails() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun documentDetailsLight() = render("document_details", dark = false) { documentDetails() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h1080dp-xxhdpi")
    fun documentAccessDark() = render("document_access", dark = true) { documentAccess(Loadable.Content(DocumentFixtures.audit)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h1080dp-xxhdpi")
    fun documentAccessLight() = render("document_access", dark = false) { documentAccess(Loadable.Content(DocumentFixtures.audit)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h600dp-xxhdpi")
    fun documentAccessLoadingDark() = render("document_access_loading", dark = true) { documentAccess(Loadable.Loading) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h600dp-xxhdpi")
    fun documentAccessLoadingLight() = render("document_access_loading", dark = false) { documentAccess(Loadable.Loading) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerProjectFoldersDark() = render("filter_picker_project_folders", dark = true) { treePicker(sessions, listOf(studio, home), listOf(work.ref)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerProjectFoldersLight() = render("filter_picker_project_folders", dark = false) { treePicker(sessions, listOf(studio, home), listOf(work.ref)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterReviewProjectFoldersDark() = render("filter_review_project_folders", dark = true) { treeReview(sessions, work.ref) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterReviewProjectFoldersLight() = render("filter_review_project_folders", dark = false) { treeReview(sessions, work.ref) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerRepositoriesDark() = render("filter_picker_repositories", dark = true) { treePicker(repositories, listOf(northstar), listOf(northstar.ref)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerRepositoriesLight() = render("filter_picker_repositories", dark = false) { treePicker(repositories, listOf(northstar), listOf(northstar.ref)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterReviewRepositoriesDark() = render("filter_review_repositories", dark = true) { treeReview(repositories, northstar.ref) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterReviewRepositoriesLight() = render("filter_review_repositories", dark = false) { treeReview(repositories, northstar.ref) }

    /** Shows what [state] puts on screen and captures the screen, with any dialog or menu over it. */
    @OptIn(ExperimentalRoborazziApi::class)
    private fun render(slug: String, dark: Boolean, state: () -> Unit) {
        this.dark = dark
        state()
        compose.waitForIdle()
        captureScreenRoboImage("src/test/roborazzi/gallery_${slug}_${if (dark) "dark" else "light"}.png")
    }
    private fun show(content: @Composable () -> Unit) {
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme(darkTheme = dark) { Surface(Modifier.fillMaxSize()) { content() } } } }
        compose.waitForIdle()
    }
    private fun access(draft: AccessLevelDraft?, gateway: FilterEditorGateway = fixture.gateway, conflict: Boolean = false, menuOpen: Boolean = false, overview: AccessOverview = fixture.overview) {
        var current by mutableStateOf(draft)
        show {
            AccessHomeContent(AccessManagementState(overview, current, error = "stale-revision".takeIf { conflict }, conflict = conflict), gateway, onClose = {},
                onUpdate = { current = it }, iconFor = fixture.icons, nameFor = fixture.names, menuOpen = menuOpen)
        }
    }
    private fun saved() = AccessLevelDraft.opening(fixture.level, fixture.overview)
    private fun home(menuOpen: Boolean = false) = access(null, menuOpen = menuOpen)
    private fun level(conflict: Boolean = false) = access(saved(), conflict = conflict)
    /** A decision of the saved level, opened from the level page by its "Change". */
    private fun decision(change: String) {
        level()
        compose.onNodeWithContentDescription(change).performClick()
    }
    /** The saved level's Direct data after Direct was linked to Answer, opened again from the level page. */
    private fun linkedDirectData() {
        access(saved().withDirectSameAsAnswer(true))
        compose.onNodeWithContentDescription("Change Direct data").performClick()
    }
    /** A new level that allows what the saved level's Answer allows, with Direct using Answer's sources, [steps] steps in. */
    private fun newLevel(steps: Int) {
        val rules = fixture.level.rules.map { rule -> rule.copy(filterRevision = null, scopePolicies = rule.scopePolicies.map { it.copy(audience = FilterAudience("new", rule.capability.name.lowercase())) }) }
        access(AccessLevelDraft.opening(null, fixture.overview).copy(name = "Shared helper", rules = rules, requireAnswerPolicySelection = false))
        repeat(steps) { compose.onNodeWithText("Continue").performClick() }
    }
    private fun reviewChanges() {
        access(saved().copy(name = "Updated helper"))
        compose.onNodeWithText("Review changes").performClick()
    }
    /** The WhatsApp filter with the workshop conversation taken out and another person put in. */
    private fun reviewChangedFilter() {
        val changed = fixture.policy.copy(rules = listOf(FilterRule(listOf(fixture.maya, fixture.jamie), "hide")))
        access(saved().setPolicy(changed, fixture.source.id, AccessCapability.ANSWER))
        compose.onNodeWithText("Review changes").performClick()
    }
    /** Direct switched off on a level whose Direct read what its Answer reads, filters included. */
    private fun reviewDirectRemoved() {
        val answer = fixture.level.rules.first { it.capability == AccessCapability.ANSWER }
        val direct = AccessGrantRule.direct(answer.sources).copy(filterRevision = answer.filterRevision,
            scopePolicies = answer.scopePolicies.map { it.copy(audience = FilterAudience(fixture.level.id, "direct")) })
        val level = fixture.level.copy(rules = listOf(answer, direct))
        val overview = fixture.overview.copy(levels = listOf(level, fixture.notesLevel))
        access(AccessLevelDraft.opening(level, overview).enabled(AccessCapability.DIRECT, false, overview), overview = overview)
        compose.onNodeWithText("Review changes").performClick()
    }
    private fun deletion(level: String) {
        home()
        compose.onNode(hasText(level) and hasClickAction()).performTouchInput { longClick() }
    }
    private fun filter(account: AccessSourceInstance = fixture.source, gateway: FilterEditorGateway = fixture.gateway, policy: SourceFilter = fixture.policy) = show {
        SourceFilterEditor(account, fixture.level.id, "answer", policy, true, gateway, onClose = {}, icon = fixture.icons(account.id), nameFor = fixture.names) {}
    }
    private fun filterReview(gateway: FilterEditorGateway, account: AccessSourceInstance = fixture.source, policy: SourceFilter = fixture.policy) {
        filter(account, gateway, policy)
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Review filter").performClick()
    }
    private fun peoplePicker() = show {
        SourceFilterPicker(fixture.source, fixture.gateway, onClose = {}, initialSelection = fixture.refs, state = remember { SourceFilterPickerState(FilterRef.PEOPLE_FIELD, "phone") },
            icon = fixture.icons(fixture.source.id), nameFor = fixture.names) {}
    }
    /** The Drive filter's choices, inside the one folder it shares. */
    private fun folderPicker() = show {
        SourceFilterPicker(fixture.driveSource, fixture.gateway, onClose = {}, initialSelection = listOf(fixture.projects.ref),
            state = remember { SourceFilterPickerState(AccessLevelScreenshotTest.DRIVE_FOLDERS).apply { open(fixture.projects) } }, icon = fixture.icons(fixture.driveSource.id), nameFor = fixture.names) {}
    }
    /** An account's choices while its fields stand in [states] instead of being ready. */
    private fun stateOf(account: AccessSourceInstance, states: Map<String, FilterFieldState>) = show {
        SourceFilterPicker(account, fixture.gatewayFor(states = mapOf(account.id to states)), onClose = {}, state = remember { SourceFilterPickerState(states.keys.first()) },
            icon = fixture.icons(account.id), nameFor = fixture.names) {}
    }

    /** A tree account's choices, opened at [trail], with [selected] ticked. */
    private fun treePicker(account: AccessSourceInstance, trail: List<FilterOption>, selected: List<FilterRef>, gateway: FilterEditorGateway = treeGateway) = show {
        SourceFilterPicker(account, gateway, onClose = {}, initialSelection = selected,
            state = remember { SourceFilterPickerState(treeFields.getValue(account).field).apply { trail.forEach(::open) } }, icon = fixture.icons(account.id), nameFor = treeNames) {}
    }
    /** A tree account's filter sharing only [shared], at its review. */
    private fun treeReview(account: AccessSourceInstance, shared: FilterRef) {
        val policy = SourceFilter(account.id, FilterAudience(fixture.level.id, "answer"), listOf(FilterRule(listOf(shared), "share")), "hide")
        show { SourceFilterEditor(account, fixture.level.id, "answer", policy, true, treeGateway, onClose = {}, icon = fixture.icons(account.id), nameFor = treeNames) {} }
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Review filter").performClick()
    }

    /** The WhatsApp day's details, with its filter details and the way to who can read it. */
    private fun documentDetails() = show {
        InspectorContent(DocumentFixtures.bundle(fixture.icons(fixture.source.id)), onDone = {}, onOpenAccess = {})
    }
    /** "Who can read this?" for the WhatsApp day, in [state]. */
    private fun documentAccess(state: Loadable<DocumentAccessAudit>) = show {
        DocumentAccessContent(state, iconFor = fixture.icons, onBack = {}, onRetry = {})
    }

    /** A request from an agent the gateway has not seen, asking for Answer and Direct, nine minutes before it expires. */
    private fun approval(step: AccessAuthorizationStep, existing: Boolean = false) {
        val request = AccessAuthorizationRequest(
            id = "request_example", approvalId = "approval_example", status = "pending", clientId = "client_example", clientName = "Northstar Assistant",
            redirectOrigin = "http://127.0.0.1:10000", resource = "https://gateway.example.com/mcp", scope = "omnesis:access",
            expiresAt = REFERENCE_NOW + 540_000, requiresAnswer = false,
        )
        val fresh = AccessConnectionProposal(defaultName = "Northstar Assistant", defaultLevelName = "Northstar Assistant")
        // Picking "Research assistant" for the agent, as a proposal that matched it to that level suggests.
        val proposal = if (!existing) fresh else fresh.copy(recommended = "existing-level", match = AccessConnectionMatch("principal-0", "Aurora Planner", "client",
            fixture.level.id, fixture.overview.principals.first().grants.first()))
        val initial = AccessAuthorizationForm.initial(request, fixture.overview, proposal, nowMillis = REFERENCE_NOW)
        val form = if (existing) initial else initial.editing { it.reading(AccessCapability.ANSWER, *fixture.overview.sources.map { account -> account.id }.toTypedArray()).enabled(AccessCapability.DIRECT, true, fixture.overview) }
        show {
            AccessAuthorizationContent(
                state = AccessAuthorizationUiState(request = request, overview = fixture.overview, form = form, step = step),
                onClose = {}, onLookup = {}, onDecide = { _, _ -> }, iconFor = fixture.icons, nameFor = fixture.names, clock = { REFERENCE_NOW },
            )
        }
    }

    private companion object {
        /** The instant every approval render is drawn at, so its deadline reads the same on every recording. */
        const val REFERENCE_NOW = 1_782_000_000_000L

        // The two tree accounts: a coding agent's sessions by project folder on two devices, and repositories under
        // their owners. Fields as their providers declare them; every folder, owner and repository is invented.
        private const val PROJECT_DIR = "extra.projectDir"
        private const val REPOSITORY = "extra.repositoryId"
        private val projectField = readyField(PROJECT_DIR, FilterRef.TREE, "project folder", "project folders", picker = "tree", scope = "device",
            insideText = "Includes the project folders inside.")
        private val repositoryField = readyField(REPOSITORY, FilterRef.TREE, "repository", "repositories", picker = "tree",
            levels = listOf(FilterNoun("owner", "owners"), FilterNoun("repository", "repositories")), insideText = "Includes the repositories inside.")
        val sessions = AccessSourceInstance("claude-code:sessions", "Claude Code · Studio Mac, Travel laptop", sourceType = "claude-code", filterable = true)
        val repositories = AccessSourceInstance("github:maya-reeves", "GitHub · maya-reeves", sourceType = "github", filterable = true)
        val treeFields = mapOf(sessions to projectField, repositories to repositoryField)
        private val devices = listOf(FilterDevice("dev_studio", "Studio Mac"), FilterDevice("dev_travel", "Travel laptop"))
        /** Project folders cannot be filtered until the travel laptop's Omnesis is updated. */
        val collectorBehind = FilterFieldState(FilterFieldState.COLLECTOR_BEHIND, devices = devices.take(1), text = "Update Omnesis on Studio Mac to use these filters.")
        private fun node(id: String, label: String, short: String, count: Long, parent: String? = null, children: Boolean = false, depth: Int? = null, device: String? = null, field: String = PROJECT_DIR) =
            FilterOption(FilterRef.item(FilterRef.TREE, field, id, device), label, short, count, parentId = parent, hasChildren = children.takeIf { it }, depth = depth)
        private fun folder(path: String, count: Long, parent: String?, children: Boolean = false) =
            node(path, path, path.substringAfterLast('/'), count, parent, children, device = "dev_studio")
        val studio = node("", "Studio Mac", "Studio Mac", 46, children = true, device = "dev_studio")
        val home = folder("~", 46, null, children = true)
        val work = folder("~/work", 31, home.ref.id, children = true)
        private val sessionNodes = listOf(studio, node("", "Travel laptop", "Travel laptop", 12, children = true, device = "dev_travel"),
            node("~", "~", "~", 12, device = "dev_travel"),
            home, work, folder("~/personal", 15, home.ref.id, children = true), folder("~/scratch", 0, home.ref.id),
            folder("~/work/atlas-api", 19, work.ref.id), folder("~/work/billing-service", 12, work.ref.id), folder("~/personal/garden-notes", 15, "~/personal"))
        private fun repo(id: String, label: String, count: Long, parent: String? = null, children: Boolean = false, depth: Int) =
            node(id, label, label.substringAfterLast('/'), count, parent, children, depth, field = REPOSITORY)
        val northstar = repo("4101", "northstar-labs", 34, children = true, depth = 0)
        private val repositoryNodes = listOf(northstar, repo("4102", "maya-reeves", 8, children = true, depth = 0),
            repo("5201", "northstar-labs/atlas-api", 19, northstar.ref.id, depth = 1), repo("5202", "northstar-labs/atlas-api-docs", 6, northstar.ref.id, depth = 1),
            repo("5203", "northstar-labs/billing-service", 9, northstar.ref.id, depth = 1), repo("5204", "maya-reeves/garden-notes", 8, "4102", depth = 1))
        private val treeNodes = mapOf(sessions to sessionNodes, repositories to repositoryNodes)
        val treeNames: (String) -> String? = { id -> mapOf("claude-code" to "Claude Code", "github" to "GitHub")[id.substringBefore(':')] }
        /** The children of [parentId] in [device]'s tree; the devices themselves above a per-device tree. */
        private fun childrenOf(account: AccessSourceInstance, parentId: String?, device: String?): List<FilterOption> = treeNodes.getValue(account).filter { node ->
            if (node.ref.isDevice) parentId == null && device == null
            else !node.ref.isDevice && node.parentId == parentId && (node.ref.device == null || (device != null && node.ref.device == device))
        }
        /** A gateway over the two tree accounts, with the project folders in [state]; a share filter shares what its one item holds. */
        fun treeGatewayWith(state: FilterFieldState = FilterFieldState(FilterFieldState.READY)) = object : FilterEditorGateway {
            private fun account(id: String) = treeNodes.keys.first { it.id == id }
            override suspend fun editor(sourceId: String): FilterEditor {
                val account = account(sourceId)
                val field = treeFields.getValue(account)
                return if (account == sessions) FilterEditor(sourceId, "claude-code", devices, showDeviceLevel = true, fields = listOf(field.copy(state = state)))
                    else FilterEditor(sourceId, "github", listOf(devices.first()), fields = listOf(field))
            }
            override suspend fun preview(policy: SourceFilter): FilterPreview {
                assertProviderWirePolicy(policy)
                val nodes = treeNodes.getValue(account(policy.sourceId))
                val matched = policy.rules.flatMap { it.match }.map { ref -> nodes.first { filterRefKey(it.ref) == filterRefKey(ref) } }
                val total = nodes.filter { it.parentId == null && (it.ref.isDevice || nodes.none { other -> other.ref.isDevice }) }.sumOf { it.count!! }
                return readyPreview(policy.sourceId, total, matched.sumOf { it.count!! }, matched.map { FilterPreviewItem(it.ref, it.label, it.count!!, depth = it.depth) })
            }
            override suspend fun options(sourceId: String, field: String, query: String, parentId: String?, device: String?, cursor: String?): FilterOptions {
                val account = account(sourceId)
                return assertProviderWireOptions(FilterOptions(sourceId, field, childrenOf(account, parentId, device)), treeFields.getValue(account), sourceId)
            }
            override suspend fun identifier(type: String, value: String): FilterIdentifierCheck = error("Tree accounts take no typed addresses")
            override suspend fun resync(sourceId: String) = Unit
        }
        val treeGateway = treeGatewayWith()
    }
}
