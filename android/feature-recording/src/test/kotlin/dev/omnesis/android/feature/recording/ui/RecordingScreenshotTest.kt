// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.feature.recording.RecordingState
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the Recordings screen: ready to record,
 * starting, recording, paused, paused by a lost microphone, unavailable,
 * and the list of recordings on the phone,
 * light + dark. All fixture data is invented (privacy rule).
 *
 *   ./gradlew :feature-recording:recordRoborazziDebug   ->   feature-recording/src/test/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class RecordingScreenshotTest {

    private fun capture(name: String, dark: Boolean, state: RecordingUiState) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content(state) }
            }
        }
    }

    @Composable
    private fun content(state: RecordingUiState) {
        RecordingContent(
            state = state,
            onTitleChange = {},
            onStart = {},
            onPause = {},
            onResume = {},
            onStop = {},
            onWifiOnlyChange = {},
            onDelete = {},
            onDismissError = {},
            onOpenRecording = {},
            onRetryGatewayRecent = {},
        )
    }

    private val gatewayRecent = GatewayRecent.Loaded(
        listOf(
            GatewayRecording("g1", "Site walkthrough", "Tue 3 Mar, 10:15", "transcribing", speakers = 0, namedSpeakers = 0),
            GatewayRecording("g2", "Quarterly planning", "Fri 27 Feb, 15:30", "done", speakers = 3, namedSpeakers = 2),
            GatewayRecording("g3", "Design sync", "Wed 25 Feb, 14:00", "done", speakers = 2, namedSpeakers = 2),
            GatewayRecording("g4", "Conversation", "Mon 23 Feb, 08:45", "done", speakers = 0, namedSpeakers = 0),
        ),
    )

    private val withGateway by lazy {
        RecordingUiState(
            availability = RecordingAvailability.Availability.AVAILABLE,
            recent = recent.take(1),
            gatewayRecent = gatewayRecent,
        )
    }

    @Test fun gateway_recent_light() = capture("recording_gateway_recent_light", false, withGateway)
    @Test fun gateway_recent_dark() = capture("recording_gateway_recent_dark", true, withGateway)

    @Test fun gateway_recent_failed_light() = capture(
        "recording_gateway_recent_failed_light",
        false,
        withGateway.copy(gatewayRecent = GatewayRecent.Failed),
    )

    @Test fun speakersLineCountsNamedSpeakers() {
        val base = GatewayRecording("g", "Design sync", "Wed 25 Feb, 14:00", "done", 3, 2)
        assertEquals("2 of 3 speakers named", speakersLine(base))
        assertEquals("All 3 speakers named", speakersLine(base.copy(namedSpeakers = 3)))
        assertEquals(null, speakersLine(base.copy(speakers = 0, namedSpeakers = 0)))
        assertEquals("Transcribing", gatewayStateLine("transcribing"))
        assertEquals("Transcribed", gatewayStateLine("done"))
    }

    private val recent = listOf(
        RecentRecording("r1", "Q4 budget review", "Mon 2 Mar, 09:00", RecentRecording.Status.Uploading(3)),
        RecentRecording("r2", "Quarterly planning", "Fri 27 Feb, 15:30", RecentRecording.Status.Sent),
        RecentRecording(
            "r3",
            "Conversation",
            "Thu 26 Feb, 11:05",
            RecentRecording.Status.Refused("The gateway does not accept recordings."),
        ),
    )

    private val ready = RecordingUiState(
        availability = RecordingAvailability.Availability.AVAILABLE,
        title = "Site walkthrough",
        recent = recent,
    )

    private val recording = RecordingUiState(
        availability = RecordingAvailability.Availability.AVAILABLE,
        recording = RecordingState.Active("s1", "Site walkthrough", 0, 1L, chunks = 23),
        elapsedMs = 23 * 60_000L + 41_000L,
        recent = recent.drop(1),
    )

    @Test fun ready_light() = capture("recording_ready_light", false, ready)
    @Test fun ready_dark() = capture("recording_ready_dark", true, ready)

    @Test fun recording_light() = capture("recording_active_light", false, recording)
    @Test fun recording_dark() = capture("recording_active_dark", true, recording)

    @Test fun paused_light() = capture(
        "recording_paused_light",
        false,
        recording.copy(recording = recording.recording!!.copy(runningSinceMs = null)),
    )

    @Test fun starting_light() = capture("recording_starting_light", false, ready.copy(title = "", starting = true))
    @Test fun starting_dark() = capture("recording_starting_dark", true, ready.copy(title = "", starting = true))

    private val micLost = recording.copy(
        recording = recording.recording!!.copy(runningSinceMs = null, micLost = true),
    )

    @Test fun mic_lost_light() = capture("recording_mic_lost_light", false, micLost)
    @Test fun mic_lost_dark() = capture("recording_mic_lost_dark", true, micLost)

    @Test fun mic_denied_light() = capture(
        "recording_mic_denied_light",
        false,
        RecordingUiState(availability = RecordingAvailability.Availability.AVAILABLE, micDenied = true, wifiOnly = true),
    )

    @Test fun unavailable_light() = capture("recording_unavailable_light", false, RecordingUiState())
    @Test fun transcription_off_dark() = capture(
        "recording_transcription_off_dark",
        true,
        RecordingUiState(availability = RecordingAvailability.Availability.TRANSCRIPTION_OFF, recent = recent),
    )

    @Test fun formatsElapsedAndStatus() {
        assertEquals("0:05", formatElapsed(5_000))
        assertEquals("23:41", formatElapsed(23 * 60_000L + 41_000L))
        assertEquals("1:02:03", formatElapsed(3_723_000))
        assertEquals("Uploading, 1 part left", statusLine(RecentRecording.Status.Uploading(1)))
        assertEquals("Waiting to upload", statusLine(RecentRecording.Status.Uploading(0)))
    }
}
