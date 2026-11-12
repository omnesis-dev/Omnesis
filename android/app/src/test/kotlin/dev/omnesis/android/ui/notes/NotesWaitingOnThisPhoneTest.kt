// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.notes

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.notes.PendingNote
import dev.omnesis.android.transport.dto.NoteEntryDto
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Notes screen names the notes still waiting on this phone, whatever the gateway returned. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class NotesWaitingOnThisPhoneTest {
    @get:Rule
    val compose = createComposeRule()

    private val older = PendingNote(1, "pending-1", "Ask the plumber about the kitchen tap.", "2026-03-04T08:15:00Z", "android-tile")
    private val newer = PendingNote(2, "pending-2", "The spare bike key is in the blue tin.", "2026-03-04T08:40:00Z", "android-app")
    private val synced = NoteEntryDto(
        id = "note-1",
        capturedAt = "2026-03-03T09:00:00Z",
        receivedAt = "2026-03-03T09:00:01Z",
        updatedAt = "2026-03-03T09:00:01Z",
        day = "2026-03-03",
        text = "Book the dentist for next month.",
        surface = "android-app",
    )

    private var opened = 0

    private fun show(state: NotesHistoryState, pending: List<PendingNote>) {
        compose.setContent {
            // Inspection mode holds the loading spinner still, so the screen settles.
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = false) {
                    NotesHistoryContent(
                        state, {}, {}, {}, {}, {}, {}, {}, {}, {},
                        pendingNotes = pending,
                        onOpenPendingNotes = { opened += 1 },
                    )
                }
            }
        }
    }

    @Test
    fun an_unreachable_gateway_still_shows_the_notes_waiting_here() {
        show(NotesHistoryState(loading = false, error = IOException("Offline")), listOf(older, newer))

        compose.onNodeWithText("2 notes waiting on this phone").assertIsDisplayed()
        compose.onNodeWithText(newer.text).assertIsDisplayed()
        // The failed load is still reported, under them.
        compose.onNodeWithText("Retry", substring = true).assertIsDisplayed()
    }

    @Test
    fun tapping_the_waiting_notes_opens_them() {
        show(NotesHistoryState(loading = false, error = IOException("Offline")), listOf(older))

        compose.onNodeWithText("1 note waiting on this phone").performClick()

        compose.runOnIdle { assertEquals(1, opened) }
    }

    @Test
    fun waiting_notes_are_named_while_the_history_loads() {
        show(NotesHistoryState(loading = true), listOf(older))
        compose.onNodeWithText("1 note waiting on this phone").assertIsDisplayed()
    }

    @Test
    fun waiting_notes_are_named_above_an_empty_history() {
        show(NotesHistoryState(loading = false), listOf(older))
        compose.onNodeWithText("1 note waiting on this phone").assertIsDisplayed()
        compose.onNodeWithText("No notes yet").assertIsDisplayed()
    }

    @Test
    fun waiting_notes_are_named_above_synced_notes() {
        show(NotesHistoryState(listOf(synced), loading = false), listOf(older))
        compose.onNodeWithText("1 note waiting on this phone").assertIsDisplayed()
        compose.onNodeWithText(synced.text).assertIsDisplayed()
    }

    @Test
    fun nothing_waiting_shows_no_banner() {
        show(NotesHistoryState(listOf(synced), loading = false), emptyList())
        compose.onNodeWithText("waiting on this phone", substring = true).assertDoesNotExist()
    }
}
