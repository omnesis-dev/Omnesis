// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.MergeRule
import dev.omnesis.android.transport.dto.MergeRulePerson
import dev.omnesis.android.transport.dto.MergeRuleSide
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.people.MergeIdentity
import dev.omnesis.android.ui.people.MergeRulesContent
import dev.omnesis.android.ui.people.MergeTriggerFilter
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Pixel-parity screenshots for the read-only merge-rules viewer, the Android
 * analogue of the iOS `29-merge-rules-list` /
 * `29b-merge-rules-empty` snapshots. Robolectric + Roborazzi. All sample data
 * is invented (privacy rule), never sourced from the corpus.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class MergeRulesScreenshotTest {

    private val iconFor: (String) -> SourceIconModel = { id -> SourceIconModel(fallbackInitial = id.take(1).uppercase()) }

    // Relative timestamps render against the wall clock, so anchor fixtures to "now" minus an
    // offset to reproduce the "1h ago" / "2d ago" phrasing (parity with the iOS fixtures).
    private fun ago(amount: Long, unit: ChronoUnit): String = Instant.now().minus(amount, unit).toString()

    private fun capture(name: String, dark: Boolean, content: @androidx.compose.runtime.Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    // A user single-pair rule, a system single-pair rule, and a two-rule
    // cluster merge (three identities) — mirrors the iOS fixtures.
    private fun rules() = listOf(
        MergeRule(
            id = "r-user",
            kind = "user",
            sideA = MergeRuleSide("email", "maya.reeves@example.com"),
            sideB = MergeRuleSide("phone", "+1 (555) 010-0042"),
            winnerSide = "a",
            reason = "same person, work + mobile",
            createdAt = ago(1, ChronoUnit.HOURS),
            resolvedSideA = listOf(
                MergeRulePerson(
                    "p-maya", "Maya Reeves",
                    aliases = listOf(MergeRuleSide("email", "maya.reeves@example.com")),
                    sourceIds = listOf("gmail:a", "notes:c"),
                ),
            ),
            resolvedSideB = listOf(
                MergeRulePerson("p-maya-ph", "Maya (mobile)", sourceIds = listOf("messages:e"), mergedIntoCanonicalName = "Maya Reeves"),
            ),
        ),
        MergeRule(
            id = "r-system",
            kind = "system",
            sideA = MergeRuleSide("name", "Jamie Lopez"),
            sideB = MergeRuleSide("email", "jamie.lopez@example.org"),
            winnerSide = "b",
            reason = "exact-name auto-detect",
            createdAt = ago(2, ChronoUnit.DAYS),
            resolvedSideA = listOf(
                MergeRulePerson("p-jamie-n", "Jamie Lopez", sourceIds = listOf("files:b"), mergedIntoCanonicalName = "jamie.lopez@example.org"),
            ),
            resolvedSideB = listOf(
                MergeRulePerson(
                    "p-jamie", "jamie.lopez@example.org",
                    aliases = listOf(MergeRuleSide("email", "jamie.lopez@example.org")),
                    sourceIds = listOf("gmail:a", "messages:e"),
                ),
            ),
        ),
        MergeRule(
            id = "c-a", kind = "user", groupId = "grp", createdAt = ago(5, ChronoUnit.MINUTES),
            sideA = MergeRuleSide("email", "david.lin@example.com"),
            sideB = MergeRuleSide("name", "David Lin"),
            winnerSide = "a",
            resolvedSideA = listOf(
                MergeRulePerson("p-david", "David Lin", aliases = listOf(MergeRuleSide("email", "david.lin@example.com")), sourceIds = listOf("gmail:a")),
            ),
            resolvedSideB = listOf(MergeRulePerson("p-david-n", "d.lin", sourceIds = listOf("messages:e"), mergedIntoCanonicalName = "David Lin")),
        ),
        MergeRule(
            id = "c-b", kind = "user", groupId = "grp", createdAt = ago(5, ChronoUnit.MINUTES),
            sideA = MergeRuleSide("email", "david.lin@example.com"),
            sideB = MergeRuleSide("email", "d.lin@stellarsound.example.com"),
            winnerSide = "a",
            resolvedSideA = listOf(
                MergeRulePerson("p-david", "David Lin", aliases = listOf(MergeRuleSide("email", "david.lin@example.com")), sourceIds = listOf("gmail:a")),
            ),
            resolvedSideB = listOf(MergeRulePerson("p-david-alt", "d.lin (work)", sourceIds = listOf("imap:w"), mergedIntoCanonicalName = "David Lin")),
        ),
    )

    private fun content(state: Loadable<List<MergeRule>>): @androidx.compose.runtime.Composable () -> Unit = {
        val grouped = when (state) {
            is Loadable.Content -> Loadable.Content(
                MergeIdentity.build(state.value, MergeTriggerFilter.ALL, ""),
            )
            is Loadable.Error -> Loadable.Error(state.throwable)
            Loadable.Loading -> Loadable.Loading
        }
        MergeRulesContent(state = grouped, onBack = {}, onRetry = {}, iconFor = iconFor)
    }

    @Test
    fun merge_rules_list_dark() = capture("merge_rules_list_dark", dark = true, content = content(Loadable.Content(rules())))

    @Test
    fun merge_rules_list_light() = capture("merge_rules_list_light", dark = false, content = content(Loadable.Content(rules())))

    private fun pagingContent(): @androidx.compose.runtime.Composable () -> Unit = {
        MergeRulesContent(
            state = Loadable.Content(
                MergeIdentity.build(rules().take(1), MergeTriggerFilter.ALL, ""),
            ),
            onBack = {},
            onRetry = {},
            iconFor = iconFor,
            paging = CursorPagingState(nextCursor = "next-page"),
        )
    }

    @Test
    fun merge_rules_paging_dark() =
        capture("merge_rules_paging_dark", dark = true, content = pagingContent())

    @Test
    fun merge_rules_paging_light() =
        capture("merge_rules_paging_light", dark = false, content = pagingContent())

    @Test
    fun merge_rules_empty_dark() = capture("merge_rules_empty_dark", dark = true, content = content(Loadable.Content(emptyList())))

    private fun noMatchContent(): @androidx.compose.runtime.Composable () -> Unit = {
        MergeRulesContent(
            state = Loadable.Content(emptyList()),
            query = "fictional no match",
            onBack = {},
            onRetry = {},
            onQueryChange = {},
            iconFor = iconFor,
        )
    }

    @Test
    fun merge_rules_no_match_dark() =
        capture("merge_rules_no_match_dark", dark = true, content = noMatchContent())

    @Test
    fun merge_rules_no_match_light() =
        capture("merge_rules_no_match_light", dark = false, content = noMatchContent())

    @Test
    fun merge_rules_loading_dark() = capture("merge_rules_loading_dark", dark = true, content = content(Loadable.Loading))
}
