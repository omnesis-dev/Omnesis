// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.*
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The review screen puts a one-sided filter's items under the side that holds them, with that side's counts. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h1600dp-xxhdpi")
class AccessLevelReviewInteractionTest {
    @get:Rule val compose = createComposeRule()
    private val chat = AccessSourceInstance("chat:+15550100123", "Chat · +1 (555) 010-0123")
    private val workshop = FilterRef.item(FilterRef.MEMBERSHIP, "extra.chatId", "conversation-workshop")
    private val policy = SourceFilter(chat.id, FilterAudience("level-example", "direct"), listOf(FilterRule(listOf(workshop), "hide")), "share")
    private val boundary = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(chat.id))
    private val notes = AccessGrantRule.notes()
    private val direct = AccessGrantRule.direct(boundary).copy(filterRevision = 1, scopePolicies = listOf(policy))
    private val gateway = FakeFilterGateway(previewFor = { policy -> readyPreview(policy.sourceId, 120, 96, listOf(FilterPreviewItem(workshop, "Workshop planning", 24))) })

    private fun review(saved: List<AccessGrantRule>, edit: (AccessLevelDraft, AccessOverview) -> AccessLevelDraft) {
        val level = AccessLevelSummary("level-example", "Research assistant", 2, saved, 0)
        val overview = AccessOverview(emptyList(), listOf(chat), levels = listOf(level), sourceFilters = SourceFiltersAvailability(true))
        var draft by mutableStateOf(edit(AccessLevelDraft.opening(level, overview), overview))
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            AccessHomeContent(AccessManagementState(overview, draft), gateway, onClose = {}, onUpdate = { draft = it })
        } } }
        compose.onNodeWithText("Review changes").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("96 shared · 24 hidden").fetchSemanticsNodes().isNotEmpty() }
    }
    private fun top(text: String, index: Int = 0) = compose.onAllNodesWithText(text)[index].fetchSemanticsNode().boundsInRoot.top

    @Test fun switchingDirectOffShowsItsFilterUnderBeforeThenNotGranted() {
        review(listOf(direct, notes)) { draft, overview -> draft.enabled(AccessCapability.DIRECT, false, overview) }
        // The first Before/After pair is the Permissions change; the account's pair follows.
        val before = top("Before", 1)
        val after = top("After", 1)
        assertTrue(before < top("96 shared · 24 hidden") + 1)
        assertTrue(top("Hide matching content") < top("Workshop planning"))
        assertTrue(top("Workshop planning") < after)
        assertTrue(top(NOT_GRANTED) >= after - 1)
        compose.onNodeWithText(NOT_SHARED).assertDoesNotExist()
    }

    @Test fun switchingDirectOnShowsItsFilterUnderAfter() {
        review(listOf(notes)) { draft, _ -> draft.setRule(direct.copy(filterRevision = null)) }
        val before = top("Before", 1)
        val after = top("After", 1)
        assertTrue(before <= top(NOT_GRANTED) + 1)
        assertTrue(top(NOT_GRANTED) < after)
        assertTrue(after < top("Workshop planning"))
        assertTrue(top("96 shared · 24 hidden") < top("Workshop planning"))
    }
}
