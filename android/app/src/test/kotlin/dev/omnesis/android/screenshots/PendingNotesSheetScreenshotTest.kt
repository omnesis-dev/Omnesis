// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.notes.PendingNote
import dev.omnesis.android.ui.notes.PendingNotesSheet
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant

/** Local queue diagnostics, rendered with entirely invented notes. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PendingNotesSheetScreenshotTest {

    private fun capture(
        name: String,
        dark: Boolean,
        fontScale: Float = 1f,
        content: @Composable () -> Unit,
    ) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            val density = LocalDensity.current
            CompositionLocalProvider(
                LocalInspectionMode provides true,
                LocalDensity provides Density(density.density, fontScale),
            ) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private val now = Instant.parse("2026-07-13T12:00:00Z")
    private val notes = listOf(
        PendingNote(
            id = 1,
            noteId = "fictional-note-1",
            text = "Get a quote from Stellar Sound for the rehearsal space",
            capturedAt = "2026-07-13T10:42:00Z",
            surface = "android-app",
            lastAttemptAt = "2026-07-13T11:58:00Z",
            lastFailure = "Gateway unreachable",
            retryCount = 2,
        ),
        PendingNote(
            id = 2,
            noteId = "fictional-note-2",
            text = "Bring the marathon entry form to the Q4 planning session",
            capturedAt = "2026-07-12T21:30:00Z",
            surface = "android-tile",
            lastFailure = "Not paired with a gateway",
        ),
    )

    private val overflowingNotes = notes + (3L..9L).map { id ->
        notes.first().copy(
            id = id,
            noteId = "fictional-note-$id",
            text = "Review item $id in the sample project checklist",
        )
    }

    @Composable
    private fun Sheet() {
        PendingNotesSheet(notes, now, onDismiss = {}, onRetry = {}, onDiscard = {})
    }

    @Composable
    private fun OverflowingSheet() {
        PendingNotesSheet(overflowingNotes, now, onDismiss = {}, onRetry = {}, onDiscard = {})
    }

    @Test
    fun pending_notes_sheet_light() = capture("pending_notes_sheet_light", false) { Sheet() }

    @Test
    fun pending_notes_sheet_dark() = capture("pending_notes_sheet_dark", true) { Sheet() }

    @Test
    fun pending_notes_sheet_accessibility_light() =
        capture("pending_notes_sheet_accessibility_light", false, fontScale = 1.6f) { OverflowingSheet() }

    @Test
    fun pending_notes_sheet_accessibility_dark() =
        capture("pending_notes_sheet_accessibility_dark", true, fontScale = 1.6f) { OverflowingSheet() }
}
