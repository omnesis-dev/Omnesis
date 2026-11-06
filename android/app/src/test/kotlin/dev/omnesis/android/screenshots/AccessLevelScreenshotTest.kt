// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.screenshots

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Density
import androidx.compose.material3.Surface
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.*
import dev.omnesis.android.ui.access.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h1600dp-xxhdpi")
class AccessLevelScreenshotTest {
    @Test fun homeLight() = capture("scope_access_home_light", false) { home() }
    @Test fun homeDark() = capture("scope_access_home_dark", true) { home() }
    @Test fun levelLight() = capture("scope_access_level_light", false) { home(AccessLevelDraft.opening(level, overview)) }
    @Test fun levelDark() = capture("scope_access_level_dark", true) { home(AccessLevelDraft.opening(level, overview)) }
    @Test fun newLevelLight() = capture("scope_access_new_light", false) { home(AccessLevelDraft.opening(null, overview)) }
    @Test fun newLevelDark() = capture("scope_access_new_dark", true) { home(AccessLevelDraft.opening(null, overview)) }
    @Test fun staleConflictLight() = capture("scope_access_stale_light", false) {
        AccessHomeContent(AccessManagementState(overview, AccessLevelDraft.opening(level, overview), error = "stale-revision", conflict = true), gateway, onClose = {})
    }
    @Test fun staleConflictDark() = capture("scope_access_stale_dark", true) {
        AccessHomeContent(AccessManagementState(overview, AccessLevelDraft.opening(level, overview), error = "stale-revision", conflict = true), gateway, onClose = {})
    }
    @Test fun filterDisabledLight() = capture("scope_filter_disabled_light", false) { filter(false) }
    @Test fun filterAccessibleDark() = capture("scope_filter_accessible_dark", true, 1.6f) { filter(true) }
    @Test fun folderPickerDark() = capture("scope_folder_picker_dark", true) { folderPicker() }
    @Test fun preparingCollectorLight() = capture("scope_filter_preparing_light", false) { preparing() }
    @Test fun filterLight() = capture("scope_filter_light", false) { filter(true) }
    @Test fun filterDark() = capture("scope_filter_dark", true) { filter(true) }
    @Test fun filterDisabledDark() = capture("scope_filter_disabled_dark", true) { filter(false) }
    @Test fun filterAccessible() = capture("scope_filter_accessible", false, 1.6f) { filter(true) }
    @Test fun folderPickerLight() = capture("scope_folder_picker_light", false) { folderPicker() }
    @Composable private fun folderPicker() {
        SourceFilterPicker(source.copy(scopes = SourceScopes(listOf(SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("folder", "folders"), picker = "tree")))), gateway, onClose = {}) {}
    }
    @Test fun preparingCollectorDark() = capture("scope_filter_preparing_dark", true) { preparing() }
    @Composable private fun preparing() {
        val preparing = listOf(ScopeKindReadiness("participant", false, message = "Preparing participant filters", processed = 120, pending = 30,
            behindCollectors = listOf(ScopeBehindCollector("fixture-device", "Cedar laptop"))))
        SourceFilterEditor(source.copy(scopeReadiness = preparing), "scope-level", "answer", policy, true,
            gatewayFor(preview.copy(readiness = preparing)), onClose = {}, initialPreview = preview.copy(readiness = preparing)) {}
    }
    @Composable private fun home(draft: AccessLevelDraft? = null) {
        AccessHomeContent(AccessManagementState(overview, draft), gateway, onClose = {})
    }
    @Composable private fun filter(enabled: Boolean) {
        SourceFilterEditor(source, "scope-level", "answer", policy, enabled, gateway, onClose = {}, initialPreview = preview) {}
    }
    private fun capture(name: String, dark: Boolean, fontScale: Float = 1f, content: @Composable () -> Unit) {
        RuntimeEnvironment.setFontScale(fontScale)
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density.density, fontScale)) {
                OmnesisTheme(darkTheme = dark) { Surface(Modifier.fillMaxSize()) { content() } }
            }
        }
    }
    companion object {
        private val contract = SourceScopes(listOf(SourceScopeItem("conversation", "fixed", noun = SourceScopeNoun("conversation", "conversations"), picker = "search"),
            SourceScopeItem("participant", "changes", identifiers = listOf("phone", "email")), SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("folder", "folders"), picker = "tree")))
        private val readiness = listOf("conversation", "participant", "folder").map { ScopeKindReadiness(it, true) }
        private val source = AccessSourceInstance("scope-chat:example", "Cedar account", scopes = contract, scopeReadiness = readiness)
        private val refs = listOf(ScopeRef("conversation", "cedar-planning"), ScopeRef("participant", label = "Maya Reeves", identifiers = listOf(ScopeIdentifier("phone", "+15550100123"))))
        private val policy = ScopePolicy(source.id, ScopeAudience("scope-level", "answer"), listOf(ScopeRule(refs, "hide")), "share")
        private val preview = ScopePreview(source.id, 120, 83, 37, 4,
            listOf(ScopePreviewItem(refs[0], "Cedar planning", 24), ScopePreviewItem(refs[1], "Maya Reeves", 17)),
            listOf(ScopePreviewSample("visible", "Workshop planning", true, false), ScopePreviewSample("hidden", "Cedar planning", false, false), ScopePreviewSample("unknown", "Unresolved group members", false, true)), readiness,
            listOf(ScopeIdentifierProposal(1, "Maya Reeves", listOf(ScopeIdentifier("email", "maya@example.org")))))
        private val boundary = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id))
        private val level = AccessLevelSummary("scope-level", "Research assistant", 4, listOf(AccessGrantRule.answer(boundary, AccessAnswerRelease.unreviewed()).copy(filterRevision = 3, scopePolicies = listOf(policy)), AccessGrantRule.direct(boundary)), 2)
        private val overview = AccessOverview(emptyList(), listOf(source), levels = listOf(level), sourceFilters = SourceFiltersAvailability(true))
        private fun gatewayFor(result: ScopePreview) = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy) = result
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = ScopeOptions(source.id, "scope-chat", contract, readiness,
                if (kind == "folder") listOf(ScopeOption(ScopeRef("folder", "cedar"), "Cedar", 18, hasChildren = true), ScopeOption(ScopeRef("folder", "archive"), "Archive", 9))
                else refs.mapIndexed { i, ref -> ScopeOption(ref, if (i == 0) "Cedar planning" else "Maya Reeves", 24) })
        }
        private val gateway = gatewayFor(preview)
    }
}
