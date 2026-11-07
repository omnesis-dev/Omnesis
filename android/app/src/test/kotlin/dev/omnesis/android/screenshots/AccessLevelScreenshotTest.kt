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
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
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
        SourceFilterPicker(driveSource, gateway, onClose = {}) {}
    }
    @Test fun preparingCollectorDark() = capture("scope_filter_preparing_dark", true) { preparing() }
    @Composable private fun preparing() {
        val preparing = readiness.map { it.copy(ready = false, reason = "backfill", message = "Preparing source filter facts", processed = 120, pending = 30,
            behindCollectors = listOf(ScopeBehindCollector("fixture-device", "Example laptop"))) }
        SourceFilterPicker(source.copy(scopeReadiness = preparing), gatewayFor(preview.copy(readiness = preparing)), onClose = {}, initialSelection = refs) {}

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
        // Actual provider-declared contracts; all account/content values invented from scratch.
        internal val contract = SourceScopes(listOf(
            SourceScopeItem("conversation", "fixed", noun = SourceScopeNoun("conversation", "conversations"), picker = "search"),
            SourceScopeItem("participant", "changes", identifiers = listOf("phone")),
        ), revision = 2)
        internal val readiness = contract.items.map { ScopeKindReadiness(it.kind, true) }
        internal val source = AccessSourceInstance("whatsapp-messages:+15550100123", "WhatsApp · +1 (555) 010-0123", sourceType = "whatsapp-messages", scopes = contract, scopeReadiness = readiness)
        private val folderContract = SourceScopes(listOf(SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("folder", "folders"), picker = "tree")), revision = 3)
        internal val driveSource = AccessSourceInstance("google-drive:reader@example.org", "Google Drive · reader@example.org", sourceType = "google-drive", scopes = folderContract, scopeReadiness = listOf(ScopeKindReadiness("folder", true)))
        private val mailContract = SourceScopes(listOf(SourceScopeItem("participant", "fixed", identifiers = listOf("email", "domain")), SourceScopeItem("label", "changes", noun = SourceScopeNoun("label", "labels"), picker = "search")), revision = 2)
        internal val gmailSource = AccessSourceInstance("gmail:reader@example.org", "Gmail · reader@example.org", sourceType = "gmail", scopes = mailContract, scopeReadiness = mailContract.items.map { ScopeKindReadiness(it.kind, true) })
        internal val refs = listOf(ScopeRef("conversation", "conversation-example"), ScopeRef("participant", label = "Maya Reeves", identifiers = listOf(ScopeIdentifier("phone", "+15550100142"))))
        internal val policy = ScopePolicy(source.id, ScopeAudience("scope-level", "answer"), listOf(ScopeRule(refs, "hide")), "share")
        private val preview = ScopePreview(source.id, 120, 83, 37, 4,
            listOf(ScopePreviewItem(refs[0], "Workshop planning", 24), ScopePreviewItem(refs[1], "Maya Reeves", 17)),
            listOf(ScopePreviewSample("visible", "Walking group", true, false), ScopePreviewSample("hidden", "Workshop planning", false, false), ScopePreviewSample("unknown", "Unresolved group members", false, true)), readiness)
        internal val boundary = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id, driveSource.id, gmailSource.id))
        internal val level = AccessLevelSummary("scope-level", "Research assistant", 4, listOf(AccessGrantRule.answer(boundary, AccessAnswerRelease.unreviewed()).copy(filterRevision = 3, scopePolicies = listOf(policy)), AccessGrantRule.direct(boundary)), 2)
        internal val overview = AccessOverview(emptyList(), listOf(gmailSource, source, driveSource), levels = listOf(level), sourceFilters = SourceFiltersAvailability(true))
        private fun gatewayFor(result: ScopePreview) = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy) = result.copy(sourceId = policy.sourceId).also { assertProviderWirePolicy(policy); it.items.forEach { item -> assertProviderWireRef(item.ref) } }
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions {
                val chosen = overview.sources.first { it.id == sourceId }
                val options = when (kind) {
                    "folder" -> listOf(ScopeOption(ScopeRef("folder", "workspace"), "Workspace", 18, hasChildren = true), ScopeOption(ScopeRef("folder", "archive"), "Archive", 9))
                    "label" -> listOf(ScopeOption(ScopeRef("label", "Label_41"), "Project", 12))
                    else -> refs.filter { it.kind == kind }.map { ref -> ScopeOption(ref, if (ref.kind == "conversation") "Workshop planning" else "Maya Reeves", 24) }
                }.filter { query.isBlank() || it.label.contains(query, ignoreCase = true) }
                return assertProviderWireOptions(ScopeOptions(chosen.id, chosen.sourceType!!, chosen.scopes!!, if (chosen.id == result.sourceId) result.readiness else chosen.scopeReadiness!!, options))
            }
        }
        internal val gateway = gatewayFor(preview)
    }
}
