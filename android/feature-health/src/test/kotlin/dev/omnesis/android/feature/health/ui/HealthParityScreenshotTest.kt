// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.components.StopContributingDialog
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.feature.health.HealthCategory
import dev.omnesis.android.feature.health.HealthSyncCoordinator
import dev.omnesis.android.transport.dto.SourceNotice
import dev.omnesis.android.transport.dto.SourceSyncStatus
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the Health Connect settings section across its lifecycle
 * (disabled hero, enabled with toggles, syncing, error), light + dark. All
 * fixture data is invented (privacy rule), never sourced from the corpus.
 *
 *   ./gradlew :feature-health:recordRoborazziDebug   ->   feature-health/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class HealthParityScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    // --- settings section ---

    private fun section(state: HealthViewModel.UiState): @Composable () -> Unit = {
        Column(
            Modifier
                .fillMaxWidth()
                .background(OmTheme.colors.bgPrimary)
                .padding(OmSpacing.lg),
        ) {
            HealthSettingsSectionContent(
                state = state,
                onSetUp = {},
                onSyncNow = {},
                onRequestPermissions = {},
                onToggleCategory = { _, _ -> },
                onDisable = {},
            )
        }
    }

    private fun enabledState() = HealthViewModel.UiState(
        availability = HealthConnectAvailability.Available,
        enabled = true,
        enabledCategories = HealthCategory.entries.toSet() - HealthCategory.NUTRITION,
        grantedPermissions = 24,
        grantedTypePermissions = 22,
        totalTypePermissions = 22,
        backgroundAccessGranted = true,
        historyAccessGranted = true,
        backgroundAccessSupported = true,
        historyAccessSupported = true,
        lastResult = HealthSyncCoordinator.SyncResult.Success(1184),
    )

    private fun unavailableState(availability: HealthConnectAvailability) = enabledState().copy(
        availability = availability,
        grantedPermissions = 0,
        grantedTypePermissions = 0,
        backgroundAccessGranted = false,
        historyAccessGranted = false,
        backgroundAccessSupported = false,
        historyAccessSupported = false,
        lastResult = null,
    )

    @Test
    fun settings_disabled_light() =
        capture("health_settings_disabled_light", dark = false) {
            section(HealthViewModel.UiState())()
        }

    @Test
    fun settings_disabled_dark() =
        capture("health_settings_disabled_dark", dark = true) {
            section(HealthViewModel.UiState())()
        }

    @Test
    fun settings_enabled_light() =
        capture("health_settings_enabled_light", dark = false) {
            section(enabledState())()
        }

    @Test
    fun settings_enabled_dark() =
        capture("health_settings_enabled_dark", dark = true) {
            section(enabledState())()
        }

    @Test
    fun settings_authoritative_success_light() =
        capture("health_settings_authoritative_success_light", dark = false) {
            section(enabledState().copy(lastResult = null, authoritativeStatus = SourceSyncStatus("health-connect:local", state = "synced")))()
        }

    @Test
    fun settings_authoritative_success_dark() =
        capture("health_settings_authoritative_success_dark", dark = true) {
            section(enabledState().copy(lastResult = null, authoritativeStatus = SourceSyncStatus("health-connect:local", state = "synced")))()
        }

    // A failing run: the status line keeps the last-sync wording and the gateway's
    // notice sits beside it as a control, never as text in the line. No lastSyncAt, so
    // the golden does not age with a relative "Last synced …" time.
    private fun failingStatus() = SourceSyncStatus(
        "health-connect:local",
        state = "needs-auth",
        errorMessage = "needs reauth: access was withdrawn",
        notices = listOf(
            SourceNotice(
                kind = "needs-auth", severity = "error", title = "Needs sign-in",
                detail = "Health access was withdrawn on this phone.",
            ),
        ),
    )

    @Test
    fun settings_authoritative_notice_light() =
        capture("health_settings_authoritative_notice_light", dark = false) {
            section(enabledState().copy(lastResult = null, authoritativeStatus = failingStatus()))()
        }

    @Test
    fun settings_authoritative_notice_dark() =
        capture("health_settings_authoritative_notice_dark", dark = true) {
            section(enabledState().copy(lastResult = null, authoritativeStatus = failingStatus()))()
        }

    @Test
    fun settings_partial_permissions_light() =
        capture("health_settings_partial_permissions_light", dark = false) {
            section(enabledState().copy(grantedTypePermissions = 18, backgroundAccessGranted = false, historyAccessGranted = false))()
        }

    @Test
    fun settings_partial_permissions_dark() =
        capture("health_settings_partial_permissions_dark", dark = true) {
            section(enabledState().copy(grantedTypePermissions = 18, backgroundAccessGranted = false, historyAccessGranted = false))()
        }

    @Test
    fun settings_syncing_light() =
        capture("health_settings_syncing_light", dark = false) {
            section(enabledState().copy(syncing = true, lastResult = null))()
        }

    @Test
    fun settings_syncing_dark() =
        capture("health_settings_syncing_dark", dark = true) {
            section(enabledState().copy(syncing = true, lastResult = null))()
        }

    @Test
    fun settings_error_dark() =
        capture("health_settings_error_dark", dark = true) {
            section(
                enabledState().copy(
                    lastResult = HealthSyncCoordinator.SyncResult.NeedsAttention("authentication failed — re-pair this device"),
                ),
            )()
        }

    @Test
    fun settings_incomplete_light() = incompleteSync(dark = false)

    @Test
    fun settings_incomplete_dark() = incompleteSync(dark = true)

    private fun incompleteSync(dark: Boolean) =
        capture("health_settings_incomplete_${if (dark) "dark" else "light"}", dark = dark) {
            section(
                enabledState().copy(
                    lastResult = HealthSyncCoordinator.SyncResult.Failed(
                        "Health Connect could not read: Weight. " +
                            "Successfully read data was saved. Try syncing again.",
                        retryable = true,
                    ),
                ),
            )()
        }

    @Test
    fun settings_not_installed_dark() =
        capture("health_settings_not_installed_dark", dark = true) {
            section(unavailableState(HealthConnectAvailability.NotInstalled))()
        }

    @Test
    fun settings_not_installed_light() =
        capture("health_settings_not_installed_light", dark = false) {
            section(unavailableState(HealthConnectAvailability.NotInstalled))()
        }

    @Test
    fun settings_not_supported_dark() =
        capture("health_settings_not_supported_dark", dark = true) {
            section(unavailableState(HealthConnectAvailability.NotSupported))()
        }

    @Test
    fun settings_not_supported_light() =
        capture("health_settings_not_supported_light", dark = false) {
            section(unavailableState(HealthConnectAvailability.NotSupported))()
        }

    // --- membership refusal (the gateway will not have this phone host it) ---

    /**
     * The switch is back off and the reason stands above the opt-in card. The
     * copy is a full-length sentence `SourceMembership.Outcome.Refused.explain()`
     * produces, so the golden covers the notice wrapping rather than a line
     * that happens to fit.
     */
    private fun refusedState() = HealthViewModel.UiState(
        availability = HealthConnectAvailability.Available,
        membershipRefusal =
            "Another device already syncs that source, and it takes one host at a time. " +
                "Turned it back off on this phone.",
    )

    @Test
    fun settings_membership_refused_light() =
        capture("health_settings_membership_refused_light", dark = false) {
            section(refusedState())()
        }

    @Test
    fun settings_membership_refused_dark() =
        capture("health_settings_membership_refused_dark", dark = true) {
            section(refusedState())()
        }

    // --- stop-contributing confirmation (shared by every phone-hosted source) ---

    @Test
    fun settings_stop_contributing_confirm_light() =
        capture("health_settings_stop_contributing_confirm_light", dark = false) {
            StopContributingDialog(onConfirm = {}, onDismiss = {})
        }

    @Test
    fun settings_stop_contributing_confirm_dark() =
        capture("health_settings_stop_contributing_confirm_dark", dark = true) {
            StopContributingDialog(onConfirm = {}, onDismiss = {})
        }

    @Test
    fun settings_stop_contributing_partition_confirm_light() =
        capture("health_settings_stop_contributing_partition_confirm_light", dark = false) {
            StopContributingDialog(onConfirm = {}, onDismiss = {})
        }

    @Test
    fun settings_stop_contributing_partition_confirm_dark() =
        capture("health_settings_stop_contributing_partition_confirm_dark", dark = true) {
            StopContributingDialog(onConfirm = {}, onDismiss = {})
        }
}
