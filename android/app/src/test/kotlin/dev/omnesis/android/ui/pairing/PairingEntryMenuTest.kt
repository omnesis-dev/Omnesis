// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The pairing entry is one menu of the three ways to pair. Each row is tapped on the real screen
 * over the real view model, and the screen it leads to is checked.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PairingEntryMenuTest {
    @get:Rule val compose = createComposeRule()

    private var clients = 0
    private val vm = PairingViewModel(
        session = { error("only a confirmed pairing reaches the session") },
        accountPorts = AccountPairingPorts(
            acquireGoogle = { _, _ -> error("provider") },
            acquirePasskey = { _, _ -> error("provider") },
            createClient = { clients++; error("relay unreachable") },
            applyPairing = { error("session") },
        ),
        googleAvailable = true,
        passkeyAvailable = true,
    )

    private val rows = listOf("pairing.entry.scan", "pairing.entry.manual", "pairing.entry.cloudAccount")

    private fun show() = compose.setContent { OmnesisTheme { PairingScreen(onBack = {}, vm = vm) } }

    private fun exists(tag: String) = compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()

    @Test fun `the entry lists the three ways to pair in one menu under one line for all of them`() {
        show()
        compose.onNodeWithText(PAIRING_ENTRY_DETAIL).assertIsDisplayed()
        val titles = listOf("Scan the gateway's QR code", "Enter code manually", "Sign in with cloud account")
        val bounds = rows.zip(titles).map { (tag, title) ->
            compose.onNodeWithTag(tag).assertIsDisplayed().assertTextEquals(title)
            compose.onNodeWithTag(tag).getBoundsInRoot()
        }
        assertTrue("rows are in order", bounds[0].top < bounds[1].top && bounds[1].top < bounds[2].top)
        for (row in bounds.drop(1)) {
            assertEquals("every way to pair is a row of the same menu", bounds[0].left, row.left)
            assertEquals("every way to pair is a row of the same menu", bounds[0].right, row.right)
        }
        for (gone in listOf("Pair directly", "Use a pairing code from your gateway. No account needed.")) {
            assertEquals(gone, 0, compose.onAllNodes(hasText(gone)).fetchSemanticsNodes().size)
        }
    }

    @Test fun `the scan row opens the scanner and Back returns to the menu`() {
        show()
        compose.onNodeWithTag("pairing.entry.scan").performClick()
        compose.waitForIdle()
        assertEquals(PairingViewModel.Mode.Scan, vm.state.value.mode)
        assertTrue("the scanner offers its manual fallback", exists("pairing.manual"))
        assertFalse(exists("pairing.entry.scan"))
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithTag("pairing.entry.scan").assertIsDisplayed()
        assertEquals(0, clients)
    }

    @Test fun `the manual row opens the code form and Back returns to the menu`() {
        show()
        compose.onNodeWithTag("pairing.entry.manual").performClick()
        compose.waitForIdle()
        assertEquals(PairingViewModel.Mode.Manual, vm.state.value.mode)
        assertTrue("the code form is shown", exists("pairing.pasteJSON.field"))
        assertFalse(exists("pairing.entry.manual"))
        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithTag("pairing.entry.manual").assertIsDisplayed()
        assertEquals(0, clients)
    }

    @Test fun `the cloud account row opens the choice of Google or a passkey and Back returns to the menu`() {
        show()
        compose.onNodeWithTag("pairing.entry.cloudAccount").performClick()
        compose.waitForIdle()
        assertTrue(vm.state.value.choosingSignIn)
        compose.onNodeWithText(SIGN_IN_CHOICES_DETAIL).assertIsDisplayed()
        compose.onNodeWithTag("pairing.entry.google").assertIsDisplayed()
        compose.onNodeWithTag("pairing.entry.passkey").assertIsDisplayed()
        for (tag in rows) assertFalse(tag, exists(tag))
        compose.onNodeWithText("Back").performClick()
        for (tag in rows) compose.onNodeWithTag(tag).assertIsDisplayed()
        assertFalse(vm.state.value.choosingSignIn)
        assertEquals("nothing was started", 0, clients)
    }
}
