// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.components.STOP_CONTRIBUTING_LABEL
import dev.omnesis.android.designsystem.components.StopContributingRow
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.SourceMembership
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SourceRemovalUiTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun cancel_leaves_no_durable_detach_but_confirm_queues_it_offline() = runTest {
        val store = mutableMapOf<String, String>()
        val outbox = MembershipOutbox(
            read = { store[it] },
            write = { key, value -> if (value == null) store.remove(key) else store[key] = value },
        )
        val membership = SourceMembership(admin = { null }, deviceId = { "dev-phone" }, outbox = outbox, scope = this)
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                StopContributingRow(onConfirm = { membership.stopContributing("notes:local") })
            }
        }
        compose.onNodeWithText(STOP_CONTRIBUTING_LABEL).performClick()
        compose.onNodeWithText("Cancel").performClick()
        assertTrue(outbox.pending().isEmpty())
        compose.onNodeWithText(STOP_CONTRIBUTING_LABEL).performClick()
        compose.onNodeWithText("Stop").performClick()
        assertTrue(outbox.pending().single().sourceId == "notes:local")
    }

    @Test
    fun removed_source_has_no_stale_mutating_actions() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                SourceDetailContent(
                    dev.omnesis.android.ui.common.Loadable.Error(SourceNoLongerAvailable()), {}, {}, {},
                )
            }
        }
        compose.onNodeWithText("Source removed").assertExists()
        compose.onNodeWithText("Sync now").assertDoesNotExist()
        compose.onNodeWithText("Remove whole source").assertDoesNotExist()
    }

    @Test
    fun whole_source_removal_requires_confirmation_and_cancel_does_nothing() {
        var removed = false
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                RemoveSourceDialog("Notes", onConfirm = { removed = true }, onDismiss = {})
            }
        }
        compose.onNodeWithText("Remove Notes from all devices?").assertExists()
        compose.onNodeWithText("Cancel").performClick()
        assertTrue(!removed)
        compose.onNodeWithText("Remove whole source").performClick()
        assertTrue(removed)
    }
}
