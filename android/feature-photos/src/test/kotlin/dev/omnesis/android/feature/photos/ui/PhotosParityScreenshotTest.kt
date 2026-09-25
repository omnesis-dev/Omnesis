// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.ui

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
import dev.omnesis.android.feature.photos.PhotosSyncCoordinator
import dev.omnesis.android.transport.dto.SourceSyncStatus
import dev.omnesis.android.feature.photos.PhotosAccess
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the Photos settings section across its
 * lifecycle (disabled hero, permanently-denied permission, enabled, syncing,
 * membership refused, error), light + dark. All fixture data is invented
 * (privacy rule), never sourced from the corpus.
 *
 *   ./gradlew :feature-photos:recordRoborazziDebug   ->   feature-photos/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PhotosParityScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private fun section(state: PhotosViewModel.UiState, permanentlyDenied: Boolean = false): @Composable () -> Unit = {
        Column(
            Modifier
                .fillMaxWidth()
                .background(OmTheme.colors.bgPrimary)
                .padding(OmSpacing.lg),
        ) {
            PhotosSettingsSectionContent(
                state = state,
                onSetUp = {},
                onSyncNow = {},
                onOpenAppSettings = {},
                onDisable = {},
                permanentlyDenied = permanentlyDenied,
            )
        }
    }

    private fun enabledState() = PhotosViewModel.UiState(
        enabled = true,
        access = PhotosAccess.FULL,
        hasPermission = true,
        lastResult = PhotosSyncCoordinator.SyncResult.Success(42),
    )

    @Test
    fun settings_disabled_light() =
        capture("photos_settings_disabled_light", dark = false) {
            section(PhotosViewModel.UiState())()
        }

    @Test
    fun settings_disabled_dark() =
        capture("photos_settings_disabled_dark", dark = true) {
            section(PhotosViewModel.UiState())()
        }

    @Test
    fun settings_permanently_denied_dark() =
        capture("photos_settings_permanently_denied_dark", dark = true) {
            section(PhotosViewModel.UiState(), permanentlyDenied = true)()
        }

    @Test
    fun settings_enabled_light() =
        capture("photos_settings_enabled_light", dark = false) {
            section(enabledState())()
        }

    @Test
    fun settings_enabled_dark() =
        capture("photos_settings_enabled_dark", dark = true) {
            section(enabledState())()
        }

    @Test
    fun settings_limited_light() =
        capture("photos_settings_limited_light", dark = false) {
            section(enabledState().copy(access = PhotosAccess.LIMITED))()
        }

    @Test
    fun settings_limited_dark() =
        capture("photos_settings_limited_dark", dark = true) {
            section(enabledState().copy(access = PhotosAccess.LIMITED))()
        }

    @Test
    fun settings_syncing_dark() =
        capture("photos_settings_syncing_dark", dark = true) {
            section(enabledState().copy(
                syncing = true,
                lastResult = null,
                authoritativeStatus = SourceSyncStatus(
                    sourceId = "photos:local",
                    state = "error",
                    errorMessage = "An older run failed",
                ),
            ))()
        }

    @Test
    fun settings_authoritative_success_light() =
        capture("photos_settings_authoritative_success_light", dark = false) {
            section(enabledState().copy(
                lastResult = null,
                authoritativeStatus = SourceSyncStatus(
                    sourceId = "photos:local",
                    state = "synced",
                ),
            ))()
        }

    @Test
    fun settings_authoritative_success_dark() =
        capture("photos_settings_authoritative_success_dark", dark = true) {
            section(enabledState().copy(
                lastResult = null,
                authoritativeStatus = SourceSyncStatus(sourceId = "photos:local", state = "synced"),
            ))()
        }

    @Test
    fun settings_authoritative_syncing_light() =
        capture("photos_settings_authoritative_syncing_light", dark = false) {
            section(enabledState().copy(
                lastResult = null,
                authoritativeStatus = SourceSyncStatus(
                    sourceId = "photos:local",
                    state = "syncing",
                    progress = SourceSyncStatus.Progress(message = "Processing recent photos"),
                ),
            ))()
        }

    @Test
    fun settings_authoritative_syncing_dark() =
        capture("photos_settings_authoritative_syncing_dark", dark = true) {
            section(enabledState().copy(
                lastResult = null,
                authoritativeStatus = SourceSyncStatus(
                    sourceId = "photos:local",
                    state = "syncing",
                    progress = SourceSyncStatus.Progress(message = "Processing recent photos"),
                ),
            ))()
        }

    @Test
    fun settings_authoritative_error_dark() =
        capture("photos_settings_authoritative_error_dark", dark = true) {
            section(enabledState().copy(
                lastResult = null,
                authoritativeStatus = SourceSyncStatus(
                    sourceId = "photos:local",
                    state = "error",
                    errorMessage = "Photo access is required",
                ),
            ))()
        }

    @Test
    fun settings_authoritative_error_light() =
        capture("photos_settings_authoritative_error_light", dark = false) {
            section(enabledState().copy(
                lastResult = null,
                authoritativeStatus = SourceSyncStatus(
                    sourceId = "photos:local",
                    state = "error",
                    errorMessage = "Photo access is required",
                ),
            ))()
        }

    @Test
    fun settings_no_permission_dark() =
        capture("photos_settings_no_permission_dark", dark = true) {
            section(enabledState().copy(access = PhotosAccess.DENIED, hasPermission = false))()
        }

    // --- membership refusal (the gateway will not have this phone host it) ---

    /**
     * The switch is back off and the reason stands above whichever card the
     * disabled branch renders — the opt-in hero here, the permanently-denied
     * card below. The copy is a full-length sentence
     * `SourceMembership.Outcome.Refused.explain()` produces, so the golden
     * covers the notice wrapping rather than a line that happens to fit.
     */
    private fun refusedState() = PhotosViewModel.UiState(
        membershipRefusal =
            "Another device already syncs that source, and it takes one host at a time. " +
                "Turned it back off on this phone.",
    )

    @Test
    fun settings_membership_refused_light() =
        capture("photos_settings_membership_refused_light", dark = false) {
            section(refusedState())()
        }

    @Test
    fun settings_membership_refused_dark() =
        capture("photos_settings_membership_refused_dark", dark = true) {
            section(refusedState())()
        }

    @Test
    fun settings_membership_refused_permanently_denied_dark() =
        capture("photos_settings_membership_refused_permanently_denied_dark", dark = true) {
            section(refusedState(), permanentlyDenied = true)()
        }

    @Test
    fun settings_error_dark() =
        capture("photos_settings_error_dark", dark = true) {
            section(
                enabledState().copy(
                    lastResult = PhotosSyncCoordinator.SyncResult.NeedsAttention("authentication failed — re-pair this device"),
                ),
            )()
        }
}
