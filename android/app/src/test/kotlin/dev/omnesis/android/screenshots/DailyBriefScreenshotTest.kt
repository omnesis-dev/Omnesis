// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.DailyBriefItemsDto
import dev.omnesis.android.ui.agent.AgentContent
import dev.omnesis.android.ui.agent.AgentCoordinator
import dev.omnesis.android.ui.agent.AgentTurnBuilder
import dev.omnesis.android.ui.agent.DailyBriefContext
import dev.omnesis.android.ui.agent.DailyBriefFixtures
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.RobolectricTestRunner

/**
 * The Morning brief conversation: today's brief under its separator and header with what it was
 * based on, and earlier days folded to one line each. All sample data is invented.
 *
 *   ./gradlew :app:recordRoborazziPlayDebug   ->   app/src/test/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DailyBriefScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    @Composable
    private fun Conversation(days: Int = 3, pages: List<DailyBriefItemsDto> = DailyBriefFixtures.pages) {
        val (origin, messages) = DailyBriefFixtures.conversation(days)
        AgentContent(
            state = AgentCoordinator.UiState(
                hasClient = true,
                sessionId = DailyBriefFixtures.CONVERSATION_ID,
                title = "Morning brief",
                conversationOrigin = origin,
                chat = AgentTurnBuilder.stateFrom(messages, breakBefore = AgentTurnBuilder.briefTurnBreaks(origin, 0)),
            ),
            catalog = SourceCatalog(),
            onOpenMenu = {},
            onSend = { _, _ -> },
            onStop = {},
            onRetry = {},
            onNewConversation = {},
            onFlushEphemeral = {},
            onOpenDocument = {},
            dailyBrief = DailyBriefContext(
                now = { DailyBriefFixtures.now },
                zone = { DailyBriefFixtures.zone },
                preloaded = pages,
            ),
        )
    }

    /** Today open with its sources and tasks; the composer speaks to the brief. */
    @Test
    fun daily_brief_today_dark() = capture("daily_brief_today_dark", dark = true) { Conversation(days = 2) }

    @Test
    fun daily_brief_today_light() = capture("daily_brief_today_light", dark = false) { Conversation(days = 2) }

    /** Scrolled to the earlier days: each folded to its separator and one line. */
    @Test
    fun daily_brief_earlier_folded_dark() = capture("daily_brief_earlier_folded_dark", dark = true) {
        FoldedHistory()
    }

    @Test
    fun daily_brief_earlier_folded_light() = capture("daily_brief_earlier_folded_light", dark = false) {
        FoldedHistory()
    }

    /**
     * Three earlier days folded above a latest day whose items have not arrived yet, short
     * enough that the history shows above it.
     */
    @Composable
    private fun FoldedHistory() = Conversation(
        days = 4,
        pages = DailyBriefFixtures.pages.filterNot { it.day == "2026-10-14" } +
            DailyBriefFixtures.earlier("2026-10-11", 4),
    )
}
