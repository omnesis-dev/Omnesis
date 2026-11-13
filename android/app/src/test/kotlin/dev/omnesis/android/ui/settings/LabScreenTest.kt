// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.LabFeature
import dev.omnesis.android.transport.dto.LabSnapshot
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LabScreenTest {
    @get:Rule val compose = createComposeRule()
    private val snapshot = LabSnapshot(true, listOf(
        LabFeature("brain", "Brain", "Background processing", false),
        LabFeature("tasks", "Tasks", "Your personal task journal", true),
    ))

    @Test fun toggles_send_the_feature_id_and_new_value() {
        val changes = mutableListOf<Pair<String, Boolean>>()
        compose.setContent {
            OmnesisTheme { LabContent(LabUiState(snapshot, loading = false), {}, {}, { id, enabled -> changes += id to enabled }) }
        }
        compose.onNodeWithContentDescription("Enable Brain").assertIsOff().performClick()
        compose.onNodeWithContentDescription("Enable Tasks").assertIsOn().performClick()
        assertEquals(listOf("brain" to true, "tasks" to false), changes)
    }

    @Test fun in_flight_mutation_prevents_overlapping_toggle_writes() {
        compose.setContent {
            OmnesisTheme { LabContent(LabUiState(snapshot, loading = false, saving = "brain"), {}, {}, { _, _ -> }) }
        }
        compose.onNodeWithContentDescription("Enable Brain").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Enable Tasks").assertIsNotEnabled()
    }
}
