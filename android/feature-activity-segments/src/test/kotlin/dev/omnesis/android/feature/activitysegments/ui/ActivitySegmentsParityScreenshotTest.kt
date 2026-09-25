// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsAvailability
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSyncCoordinator
import dev.omnesis.android.transport.dto.SourceSyncStatus
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the Activity Segments settings section
 * across its lifecycle (disabled hero, permanently-denied permission,
 * enabled, syncing, error, and the two GMS-unavailable states), light +
 * dark. All fixture data is invented (privacy rule), never sourced from the
 * corpus.
 *
 *   ./gradlew :feature-activity-segments:recordRoborazziDebug   ->   feature-activity-segments/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ActivitySegmentsParityScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private fun section(state: ActivitySegmentsViewModel.UiState, permanentlyDenied: Boolean = false): @Composable () -> Unit = {
        Column(
            Modifier
                .fillMaxWidth()
                .background(OmTheme.colors.bgPrimary)
                .padding(OmSpacing.lg),
        ) {
            ActivitySegmentsSettingsSectionContent(
                state = state,
                onSetUp = {},
                onSyncNow = {},
                onOpenAppSettings = {},
                onUpdatePlayServices = {},
                onDisable = {},
                permanentlyDenied = permanentlyDenied,
            )
        }
    }

    private fun enabledState() = ActivitySegmentsViewModel.UiState(
        enabled = true,
        hasPermission = true,
        availability = ActivitySegmentsAvailability.Available,
        lastResult = ActivitySegmentsSyncCoordinator.SyncResult.Success(12),
    )

    @Test
    fun settings_disabled_light() =
        capture("activity_segments_settings_disabled_light", dark = false) {
            section(ActivitySegmentsViewModel.UiState(availability = ActivitySegmentsAvailability.Available))()
        }

    @Test
    fun settings_disabled_dark() =
        capture("activity_segments_settings_disabled_dark", dark = true) {
            section(ActivitySegmentsViewModel.UiState(availability = ActivitySegmentsAvailability.Available))()
        }

    @Test
    fun settings_permanently_denied_dark() =
        capture("activity_segments_settings_permanently_denied_dark", dark = true) {
            section(ActivitySegmentsViewModel.UiState(availability = ActivitySegmentsAvailability.Available), permanentlyDenied = true)()
        }

    @Test
    fun settings_enabled_light() =
        capture("activity_segments_settings_enabled_light", dark = false) {
            section(enabledState())()
        }

    @Test
    fun settings_enabled_dark() =
        capture("activity_segments_settings_enabled_dark", dark = true) {
            section(enabledState())()
        }

    @Test
    fun settings_authoritative_success_light() =
        capture("activity_segments_settings_authoritative_success_light", dark = false) {
            section(enabledState().copy(lastResult = null, authoritativeStatus = SourceSyncStatus("android-activity-segments:local", state = "synced")))()
        }

    @Test
    fun settings_authoritative_success_dark() =
        capture("activity_segments_settings_authoritative_success_dark", dark = true) {
            section(enabledState().copy(lastResult = null, authoritativeStatus = SourceSyncStatus("android-activity-segments:local", state = "synced")))()
        }

    @Test
    fun settings_syncing_light() =
        capture("activity_segments_settings_syncing_light", dark = false) {
            section(enabledState().copy(syncing = true, lastResult = null))()
        }

    @Test
    fun settings_syncing_dark() =
        capture("activity_segments_settings_syncing_dark", dark = true) {
            section(enabledState().copy(syncing = true, lastResult = null))()
        }

    @Test
    fun settings_no_permission_dark() =
        capture("activity_segments_settings_no_permission_dark", dark = true) {
            section(enabledState().copy(hasPermission = false))()
        }

    // --- membership refusal (the gateway will not have this phone host it) ---

    /**
     * The switch is back off and the reason stands above whichever branch the
     * section renders — the opt-in hero here, the not-supported line below.
     * The copy is a full-length sentence
     * `SourceMembership.Outcome.Refused.explain()` produces, so the golden
     * covers the notice wrapping rather than a line that happens to fit.
     */
    private fun refusedState() = ActivitySegmentsViewModel.UiState(
        availability = ActivitySegmentsAvailability.Available,
        membershipRefusal =
            "Another device already syncs that source, and it takes one host at a time. " +
                "Turned it back off on this phone.",
    )

    @Test
    fun settings_membership_refused_light() =
        capture("activity_segments_settings_membership_refused_light", dark = false) {
            section(refusedState())()
        }

    @Test
    fun settings_membership_refused_dark() =
        capture("activity_segments_settings_membership_refused_dark", dark = true) {
            section(refusedState())()
        }

    @Test
    fun settings_membership_refused_not_supported_dark() =
        capture("activity_segments_settings_membership_refused_not_supported_dark", dark = true) {
            section(refusedState().copy(availability = ActivitySegmentsAvailability.NotSupported))()
        }

    @Test
    fun settings_error_dark() =
        capture("activity_segments_settings_error_dark", dark = true) {
            section(
                enabledState().copy(
                    lastResult = ActivitySegmentsSyncCoordinator.SyncResult.NeedsAttention("authentication failed — re-pair this device"),
                ),
            )()
        }

    @Test
    fun settings_play_services_not_installed_dark() =
        capture("activity_segments_settings_not_installed_dark", dark = true) {
            section(ActivitySegmentsViewModel.UiState(availability = ActivitySegmentsAvailability.NotInstalled))()
        }

    @Test
    fun settings_play_services_update_required_dark() =
        capture("activity_segments_settings_update_required_dark", dark = true) {
            section(ActivitySegmentsViewModel.UiState(availability = ActivitySegmentsAvailability.UpdateRequired))()
        }

    @Test
    fun settings_not_supported_dark() =
        capture("activity_segments_settings_not_supported_dark", dark = true) {
            section(ActivitySegmentsViewModel.UiState(availability = ActivitySegmentsAvailability.NotSupported))()
        }
}
