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
    fun filterCountingDark() = render("filter_counting", dark = true) { filterReview(fixture.gatewayFor(counted = false)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterCountingLight() = render("filter_counting", dark = false) { filterReview(fixture.gatewayFor(counted = false)) }
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
    @Test @Config(sdk = [34], qualifiers = "w393dp-h1400dp-xxhdpi")
    fun reviewDirectRemovedDark() = render("review_direct_removed", dark = true) { reviewDirectRemoved() }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h1400dp-xxhdpi")
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
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerProjectFoldersDark() = render("filter_picker_project_folders", dark = true) { treePicker(sessions, listOf(home), listOf(work.ref)) }
    @Test @Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi")
    fun filterPickerProjectFoldersLight() = render("filter_picker_project_folders", dark = false) { treePicker(sessions, listOf(home), listOf(work.ref)) }
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
    private fun access(draft: AccessLevelDraft?, gateway: ScopeEditorGateway = fixture.gateway, conflict: Boolean = false, menuOpen: Boolean = false, overview: AccessOverview = fixture.overview) {
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
        val rules = fixture.level.rules.map { rule -> rule.copy(filterRevision = null, scopePolicies = rule.scopePolicies.map { it.copy(audience = ScopeAudience("new", rule.capability.name.lowercase())) }) }
        access(AccessLevelDraft.opening(null, fixture.overview).copy(name = "Shared helper", rules = rules, requireAnswerPolicySelection = false))
        repeat(steps) { compose.onNodeWithText("Continue").performClick() }
    }
    private fun reviewChanges() {
        access(saved().copy(name = "Updated helper"))
        compose.onNodeWithText("Review changes").performClick()
    }
    /** The WhatsApp filter with the workshop conversation taken out and another person put in. */
    private fun reviewChangedFilter() {
        val changed = fixture.policy.copy(rules = listOf(ScopeRule(listOf(fixture.maya, fixture.jamie), "hide")))
        access(saved().setPolicy(changed, fixture.source.id, AccessCapability.ANSWER))
        compose.onNodeWithText("Review changes").performClick()
    }
    /** Direct switched off on a level whose Direct read what its Answer reads, filters included. */
    private fun reviewDirectRemoved() {
        val answer = fixture.level.rules.first { it.capability == AccessCapability.ANSWER }
        val direct = AccessGrantRule.direct(answer.sources).copy(filterRevision = answer.filterRevision,
            scopePolicies = answer.scopePolicies.map { it.copy(audience = ScopeAudience(fixture.level.id, "direct")) })
        val level = fixture.level.copy(rules = listOf(answer, direct))
        val overview = fixture.overview.copy(levels = listOf(level, fixture.notesLevel))
        access(AccessLevelDraft.opening(level, overview).enabled(AccessCapability.DIRECT, false, overview), overview = overview)
        compose.onNodeWithText("Review changes").performClick()
    }
    private fun deletion(level: String) {
        home()
        compose.onNode(hasText(level) and hasClickAction()).performTouchInput { longClick() }
    }
    private fun filter(account: AccessSourceInstance = fixture.source, gateway: ScopeEditorGateway = fixture.gateway) = show {
        SourceFilterEditor(account, fixture.level.id, "answer", fixture.policy, true, gateway, onClose = {}, icon = fixture.icons(account.id), nameFor = fixture.names) {}
    }
    private fun filterReview(gateway: ScopeEditorGateway) {
        filter(gateway = gateway)
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Review filter").performClick()
    }
    private fun peoplePicker() = show {
        SourceFilterPicker(fixture.source, fixture.gateway, onClose = {}, initialSelection = fixture.refs, state = remember { SourceFilterPickerState("participant", "phone") },
            icon = fixture.icons(fixture.source.id), nameFor = fixture.names) {}
    }
    /** The Drive filter's choices, inside the one folder it shares. */
    private fun folderPicker() = show {
        SourceFilterPicker(fixture.driveSource, fixture.gateway, onClose = {}, initialSelection = listOf(fixture.projects.ref),
            state = remember { SourceFilterPickerState("folder", "").apply { open(fixture.projects) } }, icon = fixture.icons(fixture.driveSource.id), nameFor = fixture.names) {}
    }

    /** A tree account's choices, opened at [trail], with [selected] ticked. */
    private fun treePicker(account: AccessSourceInstance, trail: List<ScopeOption>, selected: List<ScopeRef>) = show {
        SourceFilterPicker(account, treeGateway, onClose = {}, initialSelection = selected,
            state = remember { SourceFilterPickerState("folder", "").apply { trail.forEach(::open) } }, icon = fixture.icons(account.id), nameFor = treeNames) {}
    }
    /** A tree account's filter sharing only [shared], at its review. */
    private fun treeReview(account: AccessSourceInstance, shared: ScopeRef) {
        val policy = ScopePolicy(account.id, ScopeAudience(fixture.level.id, "answer"), listOf(ScopeRule(listOf(shared), "share")), "hide")
        show { SourceFilterEditor(account, fixture.level.id, "answer", policy, true, treeGateway, onClose = {}, icon = fixture.icons(account.id), nameFor = treeNames) {} }
        compose.onNodeWithText("Continue").performClick()
        compose.onNodeWithText("Review filter").performClick()
    }

    /** A request from an agent the gateway has not seen, asking for Answer and Direct, nine minutes before it expires. */
    private fun approval(step: AccessAuthorizationStep) {
        val request = AccessAuthorizationRequest(
            id = "request_example", approvalId = "approval_example", status = "pending", clientId = "client_example", clientName = "Northstar Assistant",
            redirectOrigin = "http://127.0.0.1:10000", resource = "https://gateway.example.com/mcp", scope = "omnesis:access",
            expiresAt = REFERENCE_NOW + 540_000, requiresAnswer = false,
        )
        val proposal = AccessConnectionProposal(defaultName = "Northstar Assistant", defaultLevelName = "Northstar Assistant")
        val initial = AccessAuthorizationForm.initial(request, fixture.overview, proposal, nowMillis = REFERENCE_NOW)
        val form = initial.editing { it.reading(AccessCapability.ANSWER, *fixture.overview.sources.map { account -> account.id }.toTypedArray()).enabled(AccessCapability.DIRECT, true, fixture.overview) }
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

        // The two tree accounts: a coding agent's sessions by project folder, and repositories under their owners.
        // Contracts as their providers declare them; every folder, owner and repository is invented.
        private val projectFolderContract = SourceScopes(listOf(SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("project folder", "project folders"), picker = "tree")), revision = 1)
        private val repositoryContract = SourceScopes(listOf(SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("repository or owner", "repositories and owners"), picker = "tree",
            levels = listOf(SourceScopeNoun("owner", "owners"), SourceScopeNoun("repository", "repositories")))), revision = 1)
        private val treeReady = listOf(ScopeKindReadiness("folder", true))
        val sessions = AccessSourceInstance("claude-code:studio-laptop", "Claude Code Sessions · studio-laptop", sourceType = "claude-code", scopes = projectFolderContract, scopeReadiness = treeReady)
        val repositories = AccessSourceInstance("github:maya-reeves", "GitHub · maya-reeves", sourceType = "github", scopes = repositoryContract, scopeReadiness = treeReady)
        private fun node(id: String, label: String, count: Long, parent: String? = null, children: Boolean = false, depth: Int? = null) =
            ScopeOption(ScopeRef("folder", id), label, count, parentId = parent, hasChildren = children, depth = depth)
        val home = node("dir:home", "~", 46, children = true)
        val work = node("dir:work", "~/work", 31, parent = home.ref.id, children = true)
        private val folderNodes = listOf(home, work, node("dir:personal", "~/personal", 15, parent = home.ref.id, children = true),
            node("dir:atlas-api", "~/work/atlas-api", 19, parent = work.ref.id), node("dir:billing-service", "~/work/billing-service", 12, parent = work.ref.id),
            node("dir:garden-notes", "~/personal/garden-notes", 15, parent = "dir:personal"))
        val northstar = node("owner:4101", "northstar-labs", 34, children = true, depth = 0)
        private val repositoryNodes = listOf(northstar, node("owner:4102", "maya-reeves", 8, children = true, depth = 0),
            node("repo:5201", "northstar-labs/atlas-api", 19, parent = northstar.ref.id, depth = 1), node("repo:5202", "northstar-labs/atlas-api-docs", 6, parent = northstar.ref.id, depth = 1),
            node("repo:5203", "northstar-labs/billing-service", 9, parent = northstar.ref.id, depth = 1), node("repo:5204", "maya-reeves/garden-notes", 8, parent = "owner:4102", depth = 1))
        private val treeNodes = mapOf(sessions to folderNodes, repositories to repositoryNodes)
        val treeNames: (String) -> String? = { id -> mapOf("claude-code" to "Claude Code Sessions", "github" to "GitHub")[id.substringBefore(':')] }
        /** A gateway over the two tree accounts; a share filter shares what its one item holds. */
        val treeGateway = object : ScopeEditorGateway {
            private fun account(id: String) = treeNodes.keys.first { it.id == id }
            override suspend fun preview(policy: ScopePolicy): ScopePreview {
                assertProviderWirePolicy(policy)
                val account = account(policy.sourceId)
                val nodes = treeNodes.getValue(account)
                val matched = policy.rules.flatMap { it.match }.map { ref -> nodes.first { it.ref == ref } }
                val total = nodes.filter { it.parentId == null }.sumOf { it.count }
                val shared = matched.sumOf { it.count }
                return ScopePreview(account.id, total, shared, total - shared, 0, matched.map { ScopePreviewItem(it.ref, it.label, it.count, it.parentId, depth = it.depth) },
                    listOf(ScopePreviewSample("visible", "Atlas API rate limits", true, false), ScopePreviewSample("hidden", "Garden notes layout", false, false)), treeReady)
            }
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions {
                val account = account(sourceId)
                return assertProviderWireOptions(ScopeOptions(account.id, account.sourceType!!, account.scopes!!, treeReady, treeNodes.getValue(account).filter { it.parentId == parentId }), account, kind)
            }
        }
    }
}
