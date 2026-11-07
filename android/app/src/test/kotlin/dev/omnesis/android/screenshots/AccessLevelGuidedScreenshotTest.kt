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
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.*
import dev.omnesis.android.ui.access.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Real navigation through production Compose, using invented provider-shaped responses. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AccessLevelGuidedScreenshotTest {
    @get:Rule val compose = createComposeRule()
    private val fixture = AccessLevelScreenshotTest
    private fun mount(dark: Boolean, initial: AccessLevelDraft) {
        var draft by mutableStateOf(initial)
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme(darkTheme = dark) {
            Surface(Modifier.fillMaxSize()) { AccessHomeContent(AccessManagementState(fixture.overview, draft), fixture.gateway, onClose = {}, onUpdate = { draft = it }) }
        } } }
    }
    private fun snap(name: String, dark: Boolean) {
        compose.waitForIdle()
        val dialogs = compose.onAllNodes(isDialog())
        val path = "src/test/roborazzi/scope_guided_${name}_${if (dark) "dark" else "light"}.png"
        if (dialogs.fetchSemanticsNodes().isNotEmpty()) dialogs.onLast().captureRoboImage(path) else compose.onRoot().captureRoboImage(path)
    }
    @Test fun notesReviewLight() = notesReview(false)
    @Test fun notesReviewDark() = notesReview(true)
    private fun notesReview(dark: Boolean) {
        mount(dark, AccessLevelDraft.opening(null, fixture.overview).copy(rules = listOf(AccessGrantRule.notes()), name = "Note capture"))
        compose.onNodeWithText("Continue").performClick(); snap("notes_review", dark)
    }
    @Test fun changedReleaseReviewLight() = changedReleaseReview(false)
    @Test fun changedReleaseReviewDark() = changedReleaseReview(true)
    private fun changedReleaseReview(dark: Boolean) {
        mount(dark, AccessLevelDraft.opening(fixture.level, fixture.overview).copy(name = "Updated helper"))
        compose.onNodeWithText("Review changes").performClick(); snap("changed_review", dark)
    }
    @Test fun savedAccountNamesLight() = savedAccountNames(false)
    @Test fun savedAccountNamesDark() = savedAccountNames(true)
    private fun savedAccountNames(dark: Boolean) {
        mount(dark, AccessLevelDraft.opening(fixture.level, fixture.overview))
        compose.onNodeWithContentDescription("Change Answer data").performClick(); snap("saved_accounts", dark)
    }
    @Test fun matchingFilterReviewLight() = matchingFilterReview(false)
    @Test fun matchingFilterReviewDark() = matchingFilterReview(true)
    private fun matchingFilterReview(dark: Boolean) {
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme(darkTheme = dark) {
            Surface(Modifier.fillMaxSize()) { SourceFilterEditor(fixture.source, fixture.level.id, "answer", fixture.policy, true, fixture.gateway, onClose = {}) {} }
        } } }
        compose.onNodeWithText("Continue").performClick(); compose.onNodeWithText("Review filter").performClick(); snap("filter_review", dark)
    }
    @Test fun linkedReviewLight() = linkedReview(false)
    @Test fun linkedReviewDark() = linkedReview(true)
    private fun linkedReview(dark: Boolean) {
        val rules = fixture.level.rules.map { rule -> rule.copy(scopePolicies = rule.scopePolicies.map { it.copy(audience = ScopeAudience("new", rule.capability.name.lowercase())) }) }
        mount(dark, AccessLevelDraft.opening(null, fixture.overview).copy(name = "Shared helper", rules = rules, requireAnswerPolicySelection = false))
        repeat(5) { compose.onNodeWithText("Continue").performClick() }; snap("linked_review", dark)
    }
}
