// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The account chooser says, in words, whether the relay holds each gateway online, and an offline one stays choosable. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AccountGatewayChooserTest {
    @get:Rule val compose = createComposeRule()

    private val home = "00000000-0000-4000-8000-000000000001"
    private val studio = "00000000-0000-4000-8000-000000000002"

    private fun show(onChoose: (String) -> Unit = {}) = compose.setContent {
        CompositionLocalProvider(LocalInspectionMode provides true, LocalPairingClock provides { PREVIEW_PAIRING_NOW }) {
            OmnesisTheme { AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Choosing), true, true, {}, {}, onChoose, {}) }
        }
    }

    /** Everything the row's merged node announces: its text and any content description. */
    private fun announced(gatewayId: String): List<String> {
        val node = compose.onNodeWithTag("pairing.account.gateway.$gatewayId").fetchSemanticsNode()
        return node.config.getOrElse(SemanticsProperties.Text) { emptyList() }.map { it.text } +
            node.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() }
    }

    @Test fun `each gateway row says Online or Offline exactly once`() {
        show()
        val online = announced(home); val offline = announced(studio)
        assertEquals(1, online.count { it == "Online" }); assertEquals(0, online.count { it == "Offline" })
        assertEquals(1, offline.count { it == "Offline" }); assertEquals(0, offline.count { it == "Online" })
    }

    @Test fun `an offline gateway can still be chosen`() {
        val chosen = mutableListOf<String>()
        show { chosen += it }
        compose.onNodeWithTag("pairing.account.gateway.$studio").performClick()
        assertEquals(listOf(studio), chosen)
    }
}
