// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.ResyncOffer
import dev.omnesis.android.transport.dto.LabFlags
import dev.omnesis.android.transport.dto.ResyncMode
import dev.omnesis.android.ui.common.Loadable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The words of the Resync sheet, which the portal and iOS print too. */
class ResyncCopyTest {
    @Test
    fun copy_names_the_source_and_matches_the_portal() {
        assertEquals("Resync Gmail", ResyncCopy.title("Gmail"))
        val inPlace = ResyncCopy.option(ResyncMode.IN_PLACE, "Gmail", brainNote = true)
        assertEquals("In place", inPlace.title)
        assertEquals(
            "Reads Gmail again and updates what is already here. Your records keep their place, " +
                "anything you deleted stays deleted, and search keeps working meanwhile.",
            inPlace.body,
        )
        assertNull(inPlace.note)
        val fromScratch = ResyncCopy.option(ResyncMode.FROM_SCRATCH, "Gmail", brainNote = false)
        assertEquals("From scratch", fromScratch.title)
        assertEquals(
            "Deletes everything indexed from Gmail, then imports it again. Search for this source " +
                "is empty until it finishes, and items you had deleted one by one come back.",
            fromScratch.body,
        )
        assertNull(fromScratch.note)
        assertEquals("Resync", ResyncCopy.confirm(ResyncMode.IN_PLACE))
        assertEquals("Delete and resync", ResyncCopy.confirm(ResyncMode.FROM_SCRATCH))
    }

    @Test
    fun brain_line_sits_under_from_scratch_only_when_asked() {
        assertEquals(
            "What the Brain built from Gmail will point at records that no longer exist.",
            ResyncCopy.option(ResyncMode.FROM_SCRATCH, "Gmail", brainNote = true).note,
        )
        assertNull(ResyncCopy.option(ResyncMode.FROM_SCRATCH, "Gmail", brainNote = false).note)
    }

    @Test
    fun footnote_needs_both_modes() {
        assertEquals(
            "In place never deletes, so it does not clear duplicate or stray records. From scratch is the tool for that.",
            ResyncCopy.footnote(ResyncMode.entries),
        )
        assertNull(ResyncCopy.footnote(listOf(ResyncMode.IN_PLACE)))
        assertNull(ResyncCopy.footnote(listOf(ResyncMode.FROM_SCRATCH)))
    }

    @Test
    fun brain_note_needs_an_experimental_gateway_with_the_brain_on() {
        assertTrue(resyncBrainNote(experimental = true, lab = LabFlags(brain = true)))
        assertFalse(resyncBrainNote(experimental = true, lab = LabFlags(brain = false, tasks = true)))
        assertFalse(resyncBrainNote(experimental = false, lab = LabFlags(brain = true)))
        assertFalse(resyncBrainNote(experimental = false, lab = LabFlags()))
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ResyncSheetUiTest {
    @get:Rule val compose = createComposeRule()

    private val brainLine = "What the Brain built from Gmail will point at records that no longer exist."

    private fun detail(offer: ResyncOffer, brainNote: Boolean = false) = SourceDetailUi(
        sourceId = "gmail:maya.reeves@example.org", label = "Gmail", accountId = "maya.reeves@example.org",
        icon = SourceIconModel(fallbackInitial = "G"), type = "gmail",
        hostDevices = listOf(SourceHostDeviceUi("dev-host-0001", "studio-desktop")),
        syncState = "synced", lastSyncAt = null, percentIndexed = null,
        progressPercent = null, progressMessage = null,
        resync = offer, resyncBrainNote = brainNote,
    )

    private fun showDetail(offer: ResyncOffer, brainNote: Boolean = false, onResync: (ResyncMode) -> Unit = {}) =
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                SourceDetailContent(
                    Loadable.Content(detail(offer, brainNote)),
                    onBack = {}, onRetry = {}, onOpenRecent = {}, onResync = onResync,
                )
            }
        }

    private fun showSheet(brainNote: Boolean = false, onConfirm: (ResyncMode) -> Unit = {}, onCancel: () -> Unit = {}) =
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                ResyncSheetBody("Gmail", ResyncOffer.Choice(ResyncMode.entries), brainNote, onConfirm, onCancel)
            }
        }

    @Test
    fun sheet_opens_on_in_place_and_confirming_deletes_nothing() {
        val confirmed = mutableListOf<ResyncMode>()
        showSheet(onConfirm = { confirmed += it })
        compose.onNodeWithText("Resync Gmail").assertExists()
        compose.onNode(hasText("In place")).assertIsSelected()
        compose.onNode(hasText("From scratch")).assertIsNotSelected()
        compose.onNodeWithText(ResyncCopy.FOOTNOTE).assertExists()
        compose.onNodeWithText("Delete and resync").assertDoesNotExist()
        compose.onNodeWithText("Resync").performScrollTo().performClick()
        assertEquals(listOf(ResyncMode.IN_PLACE), confirmed)
    }

    @Test
    fun choosing_from_scratch_turns_the_confirmation_into_a_delete() {
        val confirmed = mutableListOf<ResyncMode>()
        showSheet(onConfirm = { confirmed += it })
        compose.onNode(hasText("From scratch")).performClick()
        compose.onNode(hasText("From scratch")).assertIsSelected()
        compose.onNodeWithText("Resync").assertDoesNotExist()
        compose.onNodeWithText("Delete and resync").performScrollTo().performClick()
        assertEquals(listOf(ResyncMode.FROM_SCRATCH), confirmed)
    }

    @Test
    fun cancel_confirms_nothing() {
        val confirmed = mutableListOf<ResyncMode>()
        var cancelled = false
        showSheet(onConfirm = { confirmed += it }, onCancel = { cancelled = true })
        compose.onNode(hasText("From scratch")).performClick()
        compose.onNodeWithText("Cancel").performScrollTo().performClick()
        assertTrue(cancelled)
        assertTrue(confirmed.isEmpty())
    }

    @Test
    fun brain_line_shows_only_when_the_gateway_runs_the_brain() {
        showSheet(brainNote = true)
        compose.onNodeWithText(brainLine, substring = true).assertExists()
    }

    @Test
    fun brain_line_is_absent_otherwise() {
        showSheet(brainNote = false)
        compose.onNodeWithText(brainLine, substring = true).assertDoesNotExist()
    }

    @Test
    fun detail_opens_the_sheet_and_resyncs_in_the_chosen_mode() {
        val resynced = mutableListOf<ResyncMode>()
        showDetail(ResyncOffer.Choice(ResyncMode.entries), onResync = { resynced += it })
        compose.onNodeWithText("Resync").performClick()
        compose.onNodeWithText("Resync Gmail").assertExists()
        compose.onNodeWithText("Resync this source?").assertDoesNotExist()
        // Inside the sheet's own window the controls are driven through their click
        // actions: under Robolectric the sheet is not laid out where a touch would land.
        compose.onNode(hasText("From scratch")).performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("Delete and resync").performSemanticsAction(SemanticsActions.OnClick)
        assertEquals(listOf(ResyncMode.FROM_SCRATCH), resynced)
    }

    @Test
    fun older_gateway_keeps_the_plain_confirmation_and_offers_no_in_place() {
        val resynced = mutableListOf<ResyncMode>()
        showDetail(ResyncOffer.WipeOnly, onResync = { resynced += it })
        compose.onNodeWithText("Resync").performClick()
        compose.onNodeWithText("Resync this source?").assertExists()
        compose.onNodeWithText(
            "All ingested documents for this source will be deleted and re-fetched from scratch. Large sources can take a while.",
        ).assertExists()
        compose.onNode(hasText("In place")).assertDoesNotExist()
        compose.onNode(hasText("Resync") and hasAnyAncestor(isDialog())).performClick()
        assertEquals(listOf(ResyncMode.FROM_SCRATCH), resynced)
    }

    @Test
    fun source_that_cannot_be_resynced_has_no_resync_action() {
        showDetail(ResyncOffer.Unavailable)
        compose.onNodeWithText("Sync now").assertExists()
        compose.onNodeWithText("Resync").assertDoesNotExist()
    }
}
