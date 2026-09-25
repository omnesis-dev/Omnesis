// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import dev.omnesis.android.transport.dto.PrivacyAnswerComparison
import dev.omnesis.android.transport.dto.PrivacyAnswerDiffLine
import dev.omnesis.android.transport.dto.PrivacyAnswerDiffOp
import dev.omnesis.android.transport.dto.PrivacyAnswerDiffSpan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** What the comparison says out loud, and what it says instead of a diff. */
class PrivacyAnswerDiffTest {

    @Test
    fun everyLineAnnouncesWhichSideItIsOnBeforeItsText() {
        assertEquals(
            "Unchanged: The review is planned.",
            answerDiffLineDescription(
                PrivacyAnswerDiffLine(PrivacyAnswerDiffOp.EQUAL, "The review is planned.", null),
            ),
        )
        assertEquals(
            "Removed from the draft: It starts at 10:00.",
            answerDiffLineDescription(
                PrivacyAnswerDiffLine(PrivacyAnswerDiffOp.REMOVED, "It starts at 10:00.", null),
            ),
        )
        assertEquals(
            "Added in the shared answer: It starts.",
            answerDiffLineDescription(
                PrivacyAnswerDiffLine(PrivacyAnswerDiffOp.ADDED, "It starts.", null),
            ),
        )
    }

    @Test
    fun anEditedLineAlsoAnnouncesTheRunsThatChanged() {
        val removed = PrivacyAnswerDiffLine(
            op = PrivacyAnswerDiffOp.REMOVED,
            text = "It starts at 10:00.",
            spans = listOf(
                PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.EQUAL, "It starts"),
                PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.REMOVED, " at 10:00"),
                PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.EQUAL, "."),
            ),
        )
        assertEquals(
            "Removed from the draft: It starts at 10:00. Changed: at 10:00",
            answerDiffLineDescription(removed),
        )
        // A line carrying no punctuation of its own still reads as two
        // sentences rather than one run-on.
        assertEquals(
            "Removed from the draft: Room details follow. Changed: follow",
            answerDiffLineDescription(
                removed.copy(
                    text = "Room details follow",
                    spans = listOf(
                        PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.EQUAL, "Room details"),
                        PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.REMOVED, " follow"),
                    ),
                ),
            ),
        )
    }

    @Test
    fun aWhitespaceOnlyChangeIsStillHeardAsAChange() {
        // The two lines read alike, so announcing their text alone would say the
        // same thing twice about a pair that is not the same.
        val removed = PrivacyAnswerDiffLine(
            op = PrivacyAnswerDiffOp.REMOVED,
            text = "Two  spaces",
            spans = listOf(
                PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.EQUAL, "Two"),
                PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.REMOVED, "  "),
                PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.EQUAL, "spaces"),
            ),
        )
        val added = PrivacyAnswerDiffLine(
            op = PrivacyAnswerDiffOp.ADDED,
            text = "Two spaces",
            spans = listOf(
                PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.EQUAL, "Two"),
                PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.ADDED, " "),
                PrivacyAnswerDiffSpan(PrivacyAnswerDiffOp.EQUAL, "spaces"),
            ),
        )
        assertEquals(
            "Removed from the draft: Two  spaces. Changed: spacing",
            answerDiffLineDescription(removed),
        )
        assertEquals(
            "Added in the shared answer: Two spaces. Changed: spacing",
            answerDiffLineDescription(added),
        )
        assertNotEquals(answerDiffLineDescription(removed), answerDiffLineDescription(added))
    }

    @Test
    fun aLineWithNothingToReadAnnouncesItsShapeInstead() {
        assertEquals(
            "Added in the shared answer: blank line",
            answerDiffLineDescription(PrivacyAnswerDiffLine(PrivacyAnswerDiffOp.ADDED, "", null)),
        )
        assertEquals(
            "Removed from the draft: spacing only",
            answerDiffLineDescription(PrivacyAnswerDiffLine(PrivacyAnswerDiffOp.REMOVED, "   ", null)),
        )
    }

    @Test
    fun neitherUncomparedReasonReadsAsAFindingAboutTheAnswer() {
        val dissimilar = noDiffNote(PrivacyAnswerComparison.NoDiff.Reason.DISSIMILAR)
        val tooLarge = noDiffNote(PrivacyAnswerComparison.NoDiff.Reason.TOO_LARGE)
        assertNotEquals(dissimilar, tooLarge)
        listOf(dissimilar, tooLarge).forEach { note ->
            assertTrue(note, note.contains("no line-by-line comparison"))
            // Nothing here may assert what the answer said or that it was rewritten.
            listOf("rewritten", "rewrote", "sensitive", "private", "leak").forEach { word ->
                assertFalse("$note names $word", note.lowercase().contains(word))
            }
        }
    }

    @Test
    fun onlyALineByLineComparisonStandsInForTheStepsOwnText() {
        // The other two kinds carry no released text of their own, so the step
        // must keep printing what it has.
        assertTrue(
            answerComparisonReplacesStepText(
                PrivacyAnswerComparison.Diff(
                    listOf(PrivacyAnswerDiffLine(PrivacyAnswerDiffOp.EQUAL, "Kept.", null)),
                ),
            ),
        )
        assertFalse(answerComparisonReplacesStepText(PrivacyAnswerComparison.Identical))
        assertFalse(
            answerComparisonReplacesStepText(
                PrivacyAnswerComparison.NoDiff(PrivacyAnswerComparison.NoDiff.Reason.DISSIMILAR),
            ),
        )
        assertFalse(answerComparisonReplacesStepText(null))
    }
}
