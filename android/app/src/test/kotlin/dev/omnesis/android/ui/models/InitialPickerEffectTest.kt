// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class InitialPickerEffectTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `background agent request opens once across unrelated recompositions`() {
        val recomposition = mutableIntStateOf(0)
        val requestedRole = mutableStateOf<String?>("background-agent")
        val opened = mutableListOf<String>()
        var consumed = 0

        compose.setContent {
            recomposition.intValue
            InitialPickerEffect(
                role = requestedRole.value,
                onOpen = { opened += it },
                onConsumed = {
                    consumed += 1
                    requestedRole.value = null
                },
            )
        }
        compose.waitForIdle()
        compose.runOnIdle { recomposition.intValue += 1 }
        compose.waitForIdle()

        assertEquals(listOf("background-agent"), opened)
        assertEquals(1, consumed)
    }
}
