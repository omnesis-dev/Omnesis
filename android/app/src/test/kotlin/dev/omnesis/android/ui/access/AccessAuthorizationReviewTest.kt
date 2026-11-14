// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The approval's final review states a level's capabilities once: a new level on its Permissions row, among
 * the decisions this approval made; an existing level on its own row, with no decisions taken apart under it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
class AccessAuthorizationReviewTest {
    @get:Rule val compose = createComposeRule()
    private val source = AccessSourceInstance("mail:reader@example.org", "Mail · reader@example.org")
    private val rules = listOf(
        AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id)), AccessAnswerRelease.unreviewed()),
        AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(source.id))),
    )
    private val level = AccessLevelSummary("level-example", "Research assistant", 1, rules, 1)
    private val overview = AccessOverview(emptyList(), listOf(source), levels = listOf(level))
    private val request = AccessAuthorizationRequest(
        id = "request_example", approvalId = "approval_example", status = "pending", clientId = "client_example", clientName = "Northstar Assistant",
        redirectOrigin = "http://127.0.0.1:10000", resource = "https://gateway.example.com/mcp", scope = "omnesis:access", expiresAt = Long.MAX_VALUE, requiresAnswer = false,
    )
    private val proposal = AccessConnectionProposal(defaultName = "Northstar Assistant", defaultLevelName = "Northstar Assistant")
    private val pills = hasContentDescription("Answer and Direct allowed, Notes not allowed")

    private fun show(form: AccessAuthorizationForm) = compose.setContent {
        CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme { ReviewStep(request, overview, form) } }
    }

    @Test fun aNewLevelShowsItsPillsOnlyOnItsPermissionsRow() {
        val initial = AccessAuthorizationForm.initial(request, overview, proposal, nowMillis = 0)
        show(initial.editing { it.reading(AccessCapability.ANSWER, source.id).enabled(AccessCapability.DIRECT, true, overview) })
        compose.onNodeWithText("Northstar Assistant (new)").assertExists()
        compose.onNodeWithText("Permissions").assertExists()
        compose.onAllNodes(pills).assertCountEquals(1)
    }

    @Test fun anExistingLevelShowsItsPillsOnItsOwnRowAndItsDecisionsReadOnly() {
        val initial = AccessAuthorizationForm.initial(request, overview, proposal, nowMillis = 0)
        show(initial.copy(connection = initial.connection!!.copy(levelId = level.id)))
        compose.onNodeWithText("Research assistant").assertExists()
        compose.onAllNodes(pills).assertCountEquals(1)
        compose.onNodeWithText("Permissions").assertDoesNotExist()
        compose.onNodeWithText("Answer data").assertExists()
        compose.onNodeWithText("Answer release").assertExists()
        compose.onNodeWithText("No privacy review").assertExists()
        compose.onNodeWithContentDescription("Change Answer data").assertDoesNotExist()
    }
}
