// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.MergeCandidate
import dev.omnesis.android.transport.dto.MergeCandidateCounts
import dev.omnesis.android.transport.dto.MergeCandidatesResponse
import dev.omnesis.android.transport.dto.MergeRulePerson
import dev.omnesis.android.transport.dto.MergeRuleSide
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.people.MergeCandidatesContent
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Pixel-parity screenshots for the merge-candidate review queue, the Android
 * analogue of the iOS `30-merge-candidates-list`
 * / `30b-merge-candidates-empty` snapshots. Robolectric + Roborazzi. All
 * sample data is invented (privacy rule), never sourced from the corpus.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class MergeCandidatesScreenshotTest {

    private val iconFor: (String) -> SourceIconModel = { id -> SourceIconModel(fallbackInitial = id.take(1).uppercase()) }

    // A three-member cluster (one member carrying enough attributes to overflow
    // into "+N more") and a two-member pair — mirrors the iOS fixtures.
    private fun candidates() = listOf(
        MergeCandidate(
            id = "cand-1",
            clusterId = "cl-maya",
            resolvedSideA = listOf(
                MergeRulePerson(
                    "p-maya", "Maya Reeves",
                    aliases = listOf(
                        MergeRuleSide("email", "maya.reeves@example.com"),
                        MergeRuleSide("phone", "+1 (555) 010-0142"),
                        MergeRuleSide("name", "Maya Reeves"),
                    ),
                    sourceIds = listOf("gmail:a", "notes:c"),
                ),
            ),
            resolvedSideB = listOf(
                MergeRulePerson(
                    "p-maya-chat", "Maya",
                    aliases = listOf(
                        MergeRuleSide("email", "maya.r.chat@example.com"),
                        MergeRuleSide("phone", "+1 (555) 010-0143"),
                        MergeRuleSide("lid", "88120104412233"),
                        MergeRuleSide("lid", "77001920104998"),
                        MergeRuleSide("name", "Maya"),
                    ),
                    sourceIds = listOf("messages:e"),
                ),
            ),
        ),
        MergeCandidate(
            id = "cand-1b",
            clusterId = "cl-maya",
            resolvedSideA = listOf(
                MergeRulePerson(
                    "p-maya", "Maya Reeves",
                    aliases = listOf(MergeRuleSide("email", "maya.reeves@example.com")),
                    sourceIds = listOf("gmail:a"),
                ),
            ),
            resolvedSideB = listOf(
                MergeRulePerson(
                    "p-maya-work", "m.reeves",
                    aliases = listOf(
                        MergeRuleSide("email", "m.reeves@northstar.example.com"),
                        MergeRuleSide("name", "m.reeves"),
                    ),
                    sourceIds = listOf("notes:c"),
                ),
            ),
        ),
        MergeCandidate(
            id = "cand-2",
            clusterId = "cl-david",
            resolvedSideA = listOf(
                MergeRulePerson(
                    "p-david", "David Lin",
                    aliases = listOf(MergeRuleSide("email", "david.lin@example.com"), MergeRuleSide("name", "David Lin")),
                    sourceIds = listOf("gmail:a"),
                ),
            ),
            resolvedSideB = listOf(
                MergeRulePerson(
                    "p-david-work", "d.lin",
                    aliases = listOf(MergeRuleSide("email", "d.lin@stellarsound.example.com"), MergeRuleSide("name", "d.lin")),
                    sourceIds = listOf("messages:e"),
                ),
            ),
        ),
    )

    private fun capture(name: String, dark: Boolean, content: @androidx.compose.runtime.Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private fun content(state: Loadable<MergeCandidatesResponse>): @androidx.compose.runtime.Composable () -> Unit = {
        MergeCandidatesContent(state = state, onBack = {}, onRetry = {}, iconFor = iconFor)
    }

    private fun page() = MergeCandidatesResponse(
        items = candidates(),
        counts = MergeCandidateCounts(pending = 14, accepted = 12, denied = 4),
    )

    @Test
    fun merge_candidates_list_dark() =
        capture("merge_candidates_list_dark", dark = true, content = content(Loadable.Content(page())))

    @Test
    fun merge_candidates_list_light() =
        capture("merge_candidates_list_light", dark = false, content = content(Loadable.Content(page())))

    private fun pagingContent(): @androidx.compose.runtime.Composable () -> Unit = {
        MergeCandidatesContent(
            state = Loadable.Content(page().copy(items = candidates().take(1))),
            onBack = {},
            onRetry = {},
            iconFor = iconFor,
            paging = CursorPagingState(nextCursor = "next-page"),
        )
    }

    @Test
    fun merge_candidates_paging_dark() =
        capture("merge_candidates_paging_dark", dark = true, content = pagingContent())

    @Test
    fun merge_candidates_paging_light() =
        capture("merge_candidates_paging_light", dark = false, content = pagingContent())

    @Test
    fun merge_candidates_empty_dark() = capture(
        "merge_candidates_empty_dark",
        dark = true,
        content = content(Loadable.Content(MergeCandidatesResponse(counts = MergeCandidateCounts(0, 12, 4)))),
    )

    @Test
    fun merge_candidates_loading_dark() =
        capture("merge_candidates_loading_dark", dark = true, content = content(Loadable.Loading))
}
