// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.R
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.feature.activitysegments.setup.ActivitySegmentsSetupCopy
import dev.omnesis.android.feature.appusage.setup.AppUsageSetupCopy
import dev.omnesis.android.feature.health.setup.HealthSetupCopy
import dev.omnesis.android.feature.photos.setup.PhotosSetupCopy
import dev.omnesis.android.setup.SetupStatusKind
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.flow.SetupBusy
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.ui.SetupChoosePage
import dev.omnesis.android.setup.ui.SetupChooseRowState
import dev.omnesis.android.setup.ui.SetupChooseRowUi
import dev.omnesis.android.setup.ui.SetupConnectedPage
import dev.omnesis.android.setup.ui.SetupFinishPage
import dev.omnesis.android.setup.ui.SetupFinishRowUi
import dev.omnesis.android.setup.ui.SetupProgress
import dev.omnesis.android.setup.ui.SetupStepPage
import dev.omnesis.android.setup.ui.SetupStepPageActions
import dev.omnesis.android.setup.ui.SetupStepPageUi
import dev.omnesis.android.ui.common.NotificationHealthBanner
import dev.omnesis.android.ui.phonesetup.BackgroundSyncingSetupCopy
import dev.omnesis.android.ui.phonesetup.BackgroundSyncingState
import dev.omnesis.android.ui.phonesetup.NotificationsSetupCopy
import dev.omnesis.android.ui.phonesetup.PhoneSetupSettingsSection
import dev.omnesis.android.ui.phonesetup.PhoneSetupSummary
import dev.omnesis.android.ui.phonesetup.RelayConsentStepPage
import dev.omnesis.android.ui.phonesetup.backgroundSyncingSetupCopy
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the phone setup flow's shared screens —
 * Connected, Choose, the Notifications and Background syncing pages, a
 * source's page opened on its own from Settings, Finish — and the Settings
 * rows that reopen it, each in light and dark. Each source renders the rest
 * of its step page states in its feature module. The gateway host, counts and
 * example questions are invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PhoneSetupScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/${name}_${if (dark) "dark" else "light"}.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private val noActions = SetupStepPageActions({}, {}, {}, {}, {}, {}, {})

    // --- Connected ---

    private val connected: @Composable () -> Unit = {
        SetupConnectedPage(
            gatewayHost = "gateway.example.org",
            mark = painterResource(R.drawable.omnesis_logo),
            onChooseWhatToAdd = {},
        )
    }

    @Test fun connected_light() = capture("phone_setup_connected", dark = false, connected)
    @Test fun connected_dark() = capture("phone_setup_connected", dark = true, connected)

    // --- Choose ---

    private fun choose(rows: List<SetupChooseRowUi>, selected: Int, ready: Boolean = true): @Composable () -> Unit = {
        SetupChoosePage(rows = rows, selectedCount = selected, onToggle = {}, onSetUp = {}, onSkip = {}, setUpEnabled = ready)
    }

    private val freshRows = listOf(
        SetupChooseRowUi("health", HealthSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.Selectable(false)),
        SetupChooseRowUi("activity", ActivitySegmentsSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.Selectable(false)),
        SetupChooseRowUi("photos", PhotosSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.Selectable(false)),
        SetupChooseRowUi("usage", AppUsageSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.Selectable(false)),
        SetupChooseRowUi("notifications", NotificationsSetupCopy, SetupGroup.ALSO, SetupChooseRowState.Selectable(false)),
        SetupChooseRowUi("background", BackgroundSyncingSetupCopy, SetupGroup.ALSO, SetupChooseRowState.Selectable(false)),
    )

    private val mixedRows = listOf(
        SetupChooseRowUi("health", HealthSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.Disabled("Not available on this phone")),
        SetupChooseRowUi("activity", ActivitySegmentsSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.Selectable(true)),
        SetupChooseRowUi("photos", PhotosSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.On),
        SetupChooseRowUi("usage", AppUsageSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.Selectable(true)),
        SetupChooseRowUi("notifications", NotificationsSetupCopy, SetupGroup.ALSO, SetupChooseRowState.Selectable(true)),
    )

    private val reasonRows = listOf(
        SetupChooseRowUi("health", HealthSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.Selectable(true)),
        SetupChooseRowUi("activity", ActivitySegmentsSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.Disabled("Needs Google Play services")),
        SetupChooseRowUi("photos", PhotosSetupCopy, SetupGroup.SOURCE, SetupChooseRowState.Selectable(false)),
        SetupChooseRowUi("notifications", NotificationsSetupCopy, SetupGroup.ALSO, SetupChooseRowState.Disabled("Off in Settings")),
    )

    @Test fun choose_fresh_light() = capture("phone_setup_choose_fresh", dark = false, choose(freshRows, selected = 0))
    @Test fun choose_fresh_dark() = capture("phone_setup_choose_fresh", dark = true, choose(freshRows, selected = 0))

    @Test fun choose_mixed_light() = capture("phone_setup_choose_mixed", dark = false, choose(mixedRows, selected = 3))
    @Test fun choose_mixed_dark() = capture("phone_setup_choose_mixed", dark = true, choose(mixedRows, selected = 3))

    @Test fun choose_disabled_reasons_light() = capture("phone_setup_choose_reasons", dark = false, choose(reasonRows, selected = 1))
    @Test fun choose_disabled_reasons_dark() = capture("phone_setup_choose_reasons", dark = true, choose(reasonRows, selected = 1))

    @Test fun choose_reading_the_phone_light() =
        capture("phone_setup_choose_reading", dark = false, choose(mixedRows, selected = 3, ready = false))
    @Test fun choose_reading_the_phone_dark() =
        capture("phone_setup_choose_reading", dark = true, choose(mixedRows, selected = 3, ready = false))

    // --- Notifications ---

    private fun notifications(
        outcome: SetupOutcome? = null,
        busy: SetupBusy = SetupBusy.IDLE,
    ): @Composable () -> Unit = {
        SetupStepPage(
            ui = SetupStepPageUi(
                copy = NotificationsSetupCopy,
                progress = SetupProgress(total = 3, current = 2),
                outcome = outcome,
                busy = busy,
                nextLabel = "Finish",
            ),
            actions = noActions,
        )
    }

    private fun relayPage(requesting: Boolean = false): @Composable () -> Unit = {
        RelayConsentStepPage(
            appId = "dev.example.omnesis",
            requesting = requesting,
            error = null,
            progress = SetupProgress(total = 4, current = 3),
            onAllow = {},
            onNotNow = {},
        )
    }

    @Test fun notifications_page_light() = capture("phone_setup_notifications", dark = false, notifications())
    @Test fun notifications_page_dark() = capture("phone_setup_notifications", dark = true, notifications())

    @Test fun notifications_waiting_light() =
        capture("phone_setup_notifications_waiting", dark = false, notifications(busy = SetupBusy.WAITING_FOR_SYSTEM))
    @Test fun notifications_waiting_dark() =
        capture("phone_setup_notifications_waiting", dark = true, notifications(busy = SetupBusy.WAITING_FOR_SYSTEM))

    @Test fun notifications_on_light() = capture("phone_setup_notifications_on", dark = false, notifications(SetupOutcome.On))
    @Test fun notifications_on_dark() = capture("phone_setup_notifications_on", dark = true, notifications(SetupOutcome.On))

    @Test fun relay_consent_page_light() = capture("phone_setup_relay_consent", dark = false, relayPage())
    @Test fun relay_consent_page_dark() = capture("phone_setup_relay_consent", dark = true, relayPage())

    @Test fun relay_consent_page_allowing_light() = capture("phone_setup_relay_consent_allowing", dark = false, relayPage(requesting = true))
    @Test fun relay_consent_page_allowing_dark() = capture("phone_setup_relay_consent_allowing", dark = true, relayPage(requesting = true))

    @Test fun notifications_off_light() =
        capture("phone_setup_notifications_off", dark = false, notifications(SetupOutcome.NotAllowed))
    @Test fun notifications_off_dark() =
        capture("phone_setup_notifications_off", dark = true, notifications(SetupOutcome.NotAllowed))

    // --- Background syncing ---

    private fun background(
        outcome: SetupOutcome? = null,
        sdkInt: Int = 34,
        busy: SetupBusy = SetupBusy.IDLE,
    ): @Composable () -> Unit = {
        SetupStepPage(
            ui = SetupStepPageUi(
                backgroundSyncingSetupCopy(sdkInt),
                SetupProgress(total = 4, current = 3),
                outcome,
                busy = busy,
                nextLabel = "Finish",
            ),
            actions = noActions,
        )
    }

    private val backgroundOlderAndroid = background(sdkInt = 30)
    private val backgroundOlderAndroidLimited = background(SetupOutcome.NotAllowed, sdkInt = 30)
    private val backgroundChecking = background(busy = SetupBusy.WORKING)

    @Test fun background_page_api30_light() = capture("phone_setup_background_api30", dark = false, backgroundOlderAndroid)
    @Test fun background_page_api30_dark() = capture("phone_setup_background_api30", dark = true, backgroundOlderAndroid)

    @Test fun background_still_limited_api30_light() = capture("phone_setup_background_limited_api30", dark = false, backgroundOlderAndroidLimited)
    @Test fun background_still_limited_api30_dark() = capture("phone_setup_background_limited_api30", dark = true, backgroundOlderAndroidLimited)

    @Test fun background_checking_light() = capture("phone_setup_background_checking", dark = false, backgroundChecking)
    @Test fun background_checking_dark() = capture("phone_setup_background_checking", dark = true, backgroundChecking)

    @Test fun background_page_light() = capture("phone_setup_background", dark = false, background())
    @Test fun background_page_dark() = capture("phone_setup_background", dark = true, background())

    @Test fun background_on_light() = capture("phone_setup_background_on", dark = false, background(SetupOutcome.On))
    @Test fun background_on_dark() = capture("phone_setup_background_on", dark = true, background(SetupOutcome.On))

    @Test fun background_still_limited_light() =
        capture("phone_setup_background_limited", dark = false, background(SetupOutcome.NotAllowed))
    @Test fun background_still_limited_dark() =
        capture("phone_setup_background_limited", dark = true, background(SetupOutcome.NotAllowed))

    // --- One source opened from its Settings card ---

    private fun singleSource(outcome: SetupOutcome?): @Composable () -> Unit = {
        SetupStepPage(
            ui = SetupStepPageUi(
                copy = PhotosSetupCopy,
                progress = SetupProgress(total = 1, current = 0),
                outcome = outcome,
                statusLine = SetupStatusLine.NotSyncedYet,
                nextLabel = "Done",
            ),
            actions = noActions,
        )
    }

    @Test fun single_source_page_light() = capture("phone_setup_single_source", dark = false, singleSource(null))
    @Test fun single_source_page_dark() = capture("phone_setup_single_source", dark = true, singleSource(null))

    @Test fun single_source_done_light() = capture("phone_setup_single_source_on", dark = false, singleSource(SetupOutcome.On))
    @Test fun single_source_done_dark() = capture("phone_setup_single_source_on", dark = true, singleSource(SetupOutcome.On))

    // --- Finish ---

    private val contributingRows = listOf(
        SetupFinishRowUi("health", HealthSetupCopy, SetupStatusLine("Up to date", SetupStatusKind.UP_TO_DATE)),
        SetupFinishRowUi("activity", ActivitySegmentsSetupCopy, null, note = "Sent by another device"),
        SetupFinishRowUi("photos", PhotosSetupCopy, SetupStatusLine("1,120 photos processed", SetupStatusKind.SYNCING, 0.17f)),
        SetupFinishRowUi("usage", AppUsageSetupCopy, SetupStatusLine("Needs attention", SetupStatusKind.ATTENTION)),
        SetupFinishRowUi("notifications", NotificationsSetupCopy, SetupStatusLine("On", SetupStatusKind.UP_TO_DATE)),
    )

    private val nothingRows = listOf(
        SetupFinishRowUi("health", HealthSetupCopy, null),
        SetupFinishRowUi("activity", ActivitySegmentsSetupCopy, null),
        SetupFinishRowUi("photos", PhotosSetupCopy, null),
        SetupFinishRowUi("usage", AppUsageSetupCopy, null),
    )

    private val finishContributing: @Composable () -> Unit = {
        SetupFinishPage(true, contributingRows, HealthSetupCopy.ask, painterResource(R.drawable.omnesis_logo), onStartAsking = {})
    }

    private val finishAllSet: @Composable () -> Unit = {
        SetupFinishPage(false, nothingRows, hint = null, mark = painterResource(R.drawable.omnesis_logo), onStartAsking = {})
    }

    @Test fun finish_contributing_light() = capture("phone_setup_finish_contributing", dark = false, finishContributing)
    @Test fun finish_contributing_dark() = capture("phone_setup_finish_contributing", dark = true, finishContributing)

    @Test fun finish_all_set_light() = capture("phone_setup_finish_all_set", dark = false, finishAllSet)
    @Test fun finish_all_set_dark() = capture("phone_setup_finish_all_set", dark = true, finishAllSet)

    // --- Settings ---

    private fun settingsRows(ready: Boolean, background: BackgroundSyncingState?): @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg)) {
            PhoneSetupSettingsSection(
                summary = PhoneSetupSummary(on = 2, total = 4),
                setupReady = ready,
                backgroundSyncing = background,
                onOpenSetup = {},
                onOpenBackgroundSettings = {},
            )
        }
    }

    @Test fun settings_rows_limited_light() =
        capture("phone_setup_settings_rows_limited", dark = false, settingsRows(true, BackgroundSyncingState.LIMITED))
    @Test fun settings_rows_limited_dark() =
        capture("phone_setup_settings_rows_limited", dark = true, settingsRows(true, BackgroundSyncingState.LIMITED))

    @Test fun settings_rows_on_light() =
        capture("phone_setup_settings_rows_on", dark = false, settingsRows(true, BackgroundSyncingState.ON))
    @Test fun settings_rows_on_dark() =
        capture("phone_setup_settings_rows_on", dark = true, settingsRows(true, BackgroundSyncingState.ON))

    @Test fun settings_row_without_restrictions_light() =
        capture("phone_setup_settings_row", dark = false, settingsRows(true, null))
    @Test fun settings_row_without_restrictions_dark() =
        capture("phone_setup_settings_row", dark = true, settingsRows(true, null))

    @Test fun settings_rows_pairing_without_device_light() =
        capture("phone_setup_settings_rows_no_device", dark = false, settingsRows(false, BackgroundSyncingState.LIMITED))
    @Test fun settings_rows_pairing_without_device_dark() =
        capture("phone_setup_settings_rows_no_device", dark = true, settingsRows(false, BackgroundSyncingState.LIMITED))

    private val turnOnNotifications: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg)) {
            NotificationHealthBanner(status = "not-determined", onTurnOn = {}) {}
        }
    }

    @Test fun settings_turn_on_notifications_light() = capture("settings_turn_on_notifications", dark = false, turnOnNotifications)
    @Test fun settings_turn_on_notifications_dark() = capture("settings_turn_on_notifications", dark = true, turnOnNotifications)
}
