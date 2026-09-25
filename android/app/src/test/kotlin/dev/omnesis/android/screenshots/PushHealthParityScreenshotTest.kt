// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.PushHealth
import dev.omnesis.android.transport.PushHealthSnapshot
import dev.omnesis.android.transport.QueuedBacklog
import dev.omnesis.android.transport.RetryOutcome
import dev.omnesis.android.transport.SetAside
import dev.omnesis.android.transport.SkippedPush
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.common.DiscardUndeliveredDialog
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.PushHealthBanner
import dev.omnesis.android.ui.common.RetryStatusLine
import dev.omnesis.android.ui.sources.SourceRowUi
import dev.omnesis.android.ui.sources.SourcesContent
import dev.omnesis.android.ui.sources.SourcesOverview
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Every visual state of the delivery-health banner — the surface that says
 * this phone's data is not reaching Omnesis. All sample data is invented
 * (privacy rule); the two source ids here belong to device-hosted sources, and
 * every name and unit noun is resolved through the stubs below exactly as the
 * real screens resolve them through the source catalog.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/src/test/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PushHealthParityScreenshotTest {

    private val hourMillis = 60L * 60 * 1000

    private val labels: (String) -> String = { id ->
        when (id) {
            ACTIVITY -> "Activity Segments"
            PHOTOS -> "Photos"
            else -> "Health Connect"
        }
    }

    private val units: (String, Int) -> String = { id, count ->
        val plural = if (id == PHOTOS) "photos" else "events"
        val noun = if (count == 1) plural.removeSuffix("s") else plural
        "$count $noun"
    }

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    /** The banner on the page background both call sites give it. */
    private fun captureBanner(
        name: String,
        dark: Boolean,
        snapshot: PushHealthSnapshot,
        retryPhase: PushHealth.RetryPhase = PushHealth.RetryPhase.Idle,
    ) = capture(name, dark) {
        Column(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary)) {
            PushHealthBanner(
                snapshot = snapshot,
                retryPhase = retryPhase,
                labelForSourceId = labels,
                unitLabelForSourceId = units,
                onRetry = {},
                onDiscardUndelivered = {},
                modifier = Modifier.padding(OmSpacing.lg),
            )
        }
    }

    // --- Sample states (invented) ---

    private fun blockedOne() = PushHealthSnapshot(blockedSourceIds = listOf(PHOTOS))

    private fun blockedSeveral() = PushHealthSnapshot(blockedSourceIds = listOf(ACTIVITY, PHOTOS))

    private fun backlog() = PushHealthSnapshot(
        queued = listOf(QueuedBacklog(ACTIVITY, 412, 72 * hourMillis)),
    )

    private fun undelivered() = PushHealthSnapshot(
        setAside = listOf(SetAside(ACTIVITY, 128)),
        skipped = listOf(
            SkippedPush(PHOTOS, "42 photos in the backfill pass, added after 2 Jan 2026, 09:00", 6, 0),
        ),
    )

    private fun skippedOnly() = PushHealthSnapshot(
        skipped = listOf(SkippedPush(PHOTOS, "1 photo in the screenshots pass", 6, 0)),
    )

    private fun setAsideOnly() = PushHealthSnapshot(setAside = listOf(SetAside(ACTIVITY, 1)))

    /**
     * A blocked source with a queue stale enough to raise the backlog row on
     * its own. It stays away: a blocked source's rows sit at the head of its
     * queue and age without bound, so a second alarm whose retry cannot help
     * would only train the user to ignore both.
     */
    private fun blockedAndUndelivered() = PushHealthSnapshot(
        blockedSourceIds = listOf(PHOTOS),
        queued = listOf(QueuedBacklog(ACTIVITY, 900, 96 * hourMillis)),
        setAside = listOf(SetAside(ACTIVITY, 41)),
    )

    private fun everything() = PushHealthSnapshot(
        queued = listOf(QueuedBacklog(ACTIVITY, 9, 12 * hourMillis)),
        setAside = listOf(SetAside(ACTIVITY, 2)),
        skipped = listOf(SkippedPush(PHOTOS, "8 photos in the recent pass", 6, 0)),
    )

    // --- Banner states ---

    @Test
    fun push_health_blocked_one_dark() = captureBanner("push_health_blocked_one_dark", true, blockedOne())

    @Test
    fun push_health_blocked_one_light() = captureBanner("push_health_blocked_one_light", false, blockedOne())

    @Test
    fun push_health_blocked_several_dark() =
        captureBanner("push_health_blocked_several_dark", true, blockedSeveral())

    @Test
    fun push_health_blocked_several_light() =
        captureBanner("push_health_blocked_several_light", false, blockedSeveral())

    @Test
    fun push_health_backlog_dark() = captureBanner("push_health_backlog_dark", true, backlog())

    @Test
    fun push_health_backlog_light() = captureBanner("push_health_backlog_light", false, backlog())

    @Test
    fun push_health_backlog_retrying_dark() = captureBanner(
        "push_health_backlog_retrying_dark",
        true,
        backlog(),
        PushHealth.RetryPhase.Running,
    )

    @Test
    fun push_health_backlog_retrying_light() = captureBanner(
        "push_health_backlog_retrying_light",
        false,
        backlog(),
        PushHealth.RetryPhase.Running,
    )

    @Test
    fun push_health_backlog_reported_dark() = captureBanner(
        "push_health_backlog_reported_dark",
        true,
        backlog(),
        PushHealth.RetryPhase.Reported(RetryOutcome.REFUSED),
    )

    @Test
    fun push_health_backlog_reported_light() = captureBanner(
        "push_health_backlog_reported_light",
        false,
        backlog(),
        PushHealth.RetryPhase.Reported(RetryOutcome.REFUSED),
    )

    @Test
    fun push_health_undelivered_dark() = captureBanner("push_health_undelivered_dark", true, undelivered())

    @Test
    fun push_health_undelivered_light() = captureBanner("push_health_undelivered_light", false, undelivered())

    @Test
    fun push_health_skipped_only_dark() = captureBanner("push_health_skipped_only_dark", true, skippedOnly())

    @Test
    fun push_health_set_aside_singular_dark() =
        captureBanner("push_health_set_aside_singular_dark", true, setAsideOnly())

    @Test
    fun push_health_blocked_and_undelivered_dark() =
        captureBanner("push_health_blocked_and_undelivered_dark", true, blockedAndUndelivered())

    @Test
    fun push_health_blocked_and_undelivered_light() =
        captureBanner("push_health_blocked_and_undelivered_light", false, blockedAndUndelivered())

    @Test
    fun push_health_everything_dark() = captureBanner("push_health_everything_dark", true, everything())

    @Test
    fun push_health_everything_light() = captureBanner("push_health_everything_light", false, everything())

    // --- The retry messages, side by side ---

    private fun retryOutcomes(name: String, dark: Boolean) = capture(name, dark) {
        Column(
            Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
        ) {
            RetryOutcome.entries.forEach { RetryStatusLine(it) }
        }
    }

    @Test
    fun push_health_retry_outcomes_dark() = retryOutcomes("push_health_retry_outcomes_dark", true)

    @Test
    fun push_health_retry_outcomes_light() = retryOutcomes("push_health_retry_outcomes_light", false)

    // --- The discard confirmation ---

    private fun discardDialog(name: String, dark: Boolean, snapshot: PushHealthSnapshot) = capture(name, dark) {
        Column(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary)) {
            DiscardUndeliveredDialog(
                setAside = snapshot.setAside,
                skippedCount = snapshot.skipped.size,
                unitLabelForSourceId = units,
                onConfirm = {},
                onDismiss = {},
            )
        }
    }

    @Test
    fun push_health_discard_dialog_dark() =
        discardDialog("push_health_discard_dialog_dark", true, undelivered())

    @Test
    fun push_health_discard_dialog_light() =
        discardDialog("push_health_discard_dialog_light", false, undelivered())

    /** Nothing is retained, so the dialog promises only that the record goes. */
    @Test
    fun push_health_discard_dialog_markers_only_dark() =
        discardDialog("push_health_discard_dialog_markers_only_dark", true, skippedOnly())

    // --- In place, above the source list ---

    private fun sourcesWithBanner(name: String, dark: Boolean) = capture(name, dark) {
        SourcesContent(
            state = Loadable.Content(
                SourcesContent(
                    overview = SourcesOverview(
                        sourceCount = 2, totalDocs = 4_210, totalChunks = 12_800, diskSize = "180 MB",
                        embeddingModel = "nomic-embed-text-v1.5.Q8_0.gguf", indexLabel = "Up to date",
                        enabled = true, totalIndexed = 4_210, diskBytes = 180_000_000L,
                    ),
                    sources = listOf(
                        SourceRowUi(
                            sourceId = ACTIVITY, label = "Activity Segments", accountId = "local",
                            icon = SourceIconModel(fallbackInitial = "A"), countLabel = "96 days",
                            syncState = "synced", percentIndexed = 100.0, hostDevice = "Pixel",
                            lastActivity = null, progressPercent = null, progressMessage = null,
                            paused = false, count = 96, unit = "days", activityAgo = "4m ago",
                        ),
                        SourceRowUi(
                            sourceId = PHOTOS, label = "Photos", accountId = "local",
                            icon = SourceIconModel(fallbackInitial = "P"), countLabel = "4,114 photos",
                            syncState = "synced", percentIndexed = 100.0, hostDevice = "Pixel",
                            lastActivity = null, progressPercent = null, progressMessage = null,
                            paused = false, count = 4_114, unit = "photos", activityAgo = "1h ago",
                        ),
                    ),
                ),
            ),
            connection = ConnectionState.Connected("d1", "Studio Northstar", listOf("read", "write")),
            onOpenMenu = {},
            onRetry = {},
            onOpenSource = {},
            deliveryBanner = {
                PushHealthBanner(
                    snapshot = everything(),
                    retryPhase = PushHealth.RetryPhase.Reported(RetryOutcome.UNREACHABLE),
                    labelForSourceId = labels,
                    unitLabelForSourceId = units,
                    onRetry = {},
                    onDiscardUndelivered = {},
                    modifier = Modifier.padding(horizontal = OmSpacing.lg).padding(top = OmSpacing.md),
                )
            },
        )
    }

    @Test
    fun sources_with_delivery_banner_dark() = sourcesWithBanner("sources_with_delivery_banner_dark", true)

    @Test
    fun sources_with_delivery_banner_light() = sourcesWithBanner("sources_with_delivery_banner_light", false)

    private companion object {
        const val ACTIVITY = "android-activity-segments:local"
        const val PHOTOS = "photos:local"
    }
}
