// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import com.github.takahirom.roborazzi.captureRoboImage
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.SearchDebugInfo
import dev.omnesis.android.transport.dto.SearchModels
import dev.omnesis.android.transport.dto.SearchQueryReport
import dev.omnesis.android.transport.dto.SearchResponse
import dev.omnesis.android.transport.dto.SearchResultItem
import dev.omnesis.android.transport.dto.SearchScoreBreakdown
import dev.omnesis.android.transport.dto.SearchStageReport
import dev.omnesis.android.transport.dto.SearchStages
import dev.omnesis.android.transport.dto.SearchTiming
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.search.SearchContent
import dev.omnesis.android.ui.search.SearchViewModel
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Pixel-parity screenshots for the Search area, matching the iOS reference fixtures
 * (`10-search-empty`, `11-search-results`, `12-search-pipeline-footer`). Renders each
 * meaningful state to a PNG via Robolectric + Roborazzi so the layout can be reviewed
 * against iOS before shipping. All fixture data is invented (privacy rule), never sourced
 * from the corpus.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SearchParityScreenshotTest {

    private val connection = ConnectionState.Connected("d1", "Studio Northstar", listOf("read", "write"))
    private val catalog = SourceCatalog()

    private fun capture(name: String, dark: Boolean, content: @androidx.compose.runtime.Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    // Result timestamps are pinned >30 days in the past on purpose: the search-row
    // meta line formats them via `SourceFormatting.formatTimeAgo`, which renders a
    // relative "Nd ago" within 30 days (wall-clock-derived → drifts daily and reddens
    // the verify lane) but a stable absolute "MMM d" beyond 30 days. Keep these dates
    // comfortably old — do NOT "freshen" them to recent dates, or the golden flakes.
    private fun results() = listOf(
        SearchResultItem(
            documentId = "doc-1", sourceId = "gmail:maya@example.com", documentType = "email",
            title = "Re: Q4 budget review", sourceCreatedAt = "2026-03-04T07:00:00Z",
            author = "Maya Reeves",
            chunkText = "Projected spend is tracking under plan for the quarter; headcount stays flat into January.",
            score = 0.91,
            scoreBreakdown = SearchScoreBreakdown(
                bm25Rank = 1, vectorRank = 3, rrfScore = 0.0312, typeBoost = 0.08, finalScore = 0.9123,
            ),
        ),
        SearchResultItem(
            documentId = "doc-2", sourceId = "files:local", documentType = "file",
            title = "marathon-training-plan.pdf", sourceCreatedAt = "2026-03-02T08:30:00Z",
            author = null,
            chunkText = "Week 6 adds a tempo run and a long run of 18 km on Sunday.",
            score = 0.74,
        ),
        SearchResultItem(
            documentId = "doc-3", sourceId = "notes:local", documentType = "note",
            title = "Studio Northstar booking", sourceCreatedAt = "2026-02-25T18:00:00Z",
            author = "Jamie Lopez",
            chunkText = "Hold the room from 14:00, confirm the deposit with the venue by Friday.",
            score = 0.55,
            scoreBreakdown = SearchScoreBreakdown(bm25Rank = 6, rrfScore = 0.0188, finalScore = 0.5502),
        ),
    )

    private fun response(items: List<SearchResultItem> = results()) = SearchResponse(
        results = items,
        models = SearchModels(
            embedding = "nomic-embed-text-v1.5.Q8_0.gguf",
        ),
        query = SearchQueryReport(
            original = "budget review",
            effectiveText = "budget review",
        ),
        timing = SearchTiming(
            totalMs = 187.0, bm25Candidates = 50, vectorCandidates = 50,
        ),
        stages = SearchStages(
            bm25 = SearchStageReport(status = "ran", durationMs = 8.0, candidates = 50),
            vector = SearchStageReport(
                status = "ran", durationMs = 92.0, candidates = 50,
                quantization = "int8", rescore = true, effectiveK = 200, embedMs = 38.0, sqlMs = 54.0,
            ),
            fusion = SearchStageReport(status = "ran", durationMs = 2.0, method = "rrf", resultCount = 30, rrfK = 60),
            boost = SearchStageReport(status = "ran", durationMs = 1.0),
        ),
        debug = SearchDebugInfo(
            modelState = SearchDebugInfo.ModelState(vector = "ready"),
            query = SearchDebugInfo.QueryLengths(inputLength = 14),
        ),
    )

    private fun resultsState() = SearchViewModel.State(
        query = "budget review",
        lastQuery = "budget review",
        hasSearched = true,
        status = SearchViewModel.Status.Results(results(), 187.0, response()),
    )

    private fun searchContent(state: SearchViewModel.State): @androidx.compose.runtime.Composable () -> Unit = {
        SearchContent(
            state = state,
            connection = connection,
            onOpenMenu = {}, onQueryChange = {}, onSearch = {}, onOpenDocument = {},
            catalog = catalog, onClear = {},
        )
    }

    @Test
    fun search_tips_dark() = capture("search_parity_tips_dark", dark = true) {
        searchContent(SearchViewModel.State())()
    }

    @Test
    fun search_tips_light() = capture("search_parity_tips_light", dark = false) {
        searchContent(SearchViewModel.State())()
    }

    @Test
    fun search_results_dark() = capture("search_parity_results_dark", dark = true) {
        searchContent(resultsState())()
    }

    @Test
    fun search_results_light() = capture("search_parity_results_light", dark = false) {
        searchContent(resultsState())()
    }

    @Test
    fun search_no_results_dark() = capture("search_parity_no_results_dark", dark = true) {
        searchContent(
            SearchViewModel.State(
                query = "zzz", lastQuery = "zzz", hasSearched = true,
                status = SearchViewModel.Status.Results(emptyList(), 12.0, response(emptyList())),
            ),
        )()
    }

    @Test
    fun search_loading_dark() = capture("search_parity_loading_dark", dark = true) {
        searchContent(
            SearchViewModel.State(
                query = "budget review", lastQuery = "budget review", hasSearched = true,
                status = SearchViewModel.Status.Loading,
            ),
        )()
    }
}
