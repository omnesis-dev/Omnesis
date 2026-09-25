// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.setup

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
import dev.omnesis.android.feature.health.HealthCategory
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.setup.SetupStatusKind
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.flow.SetupBusy
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.ui.SetupProgress
import dev.omnesis.android.setup.ui.SetupStepPage
import dev.omnesis.android.setup.ui.SetupStepPageActions
import dev.omnesis.android.setup.ui.SetupStepPageUi
import dev.omnesis.android.setup.ui.SetupWhatsSentDisclosure
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the Health Connect page of the phone setup
 * flow — the disclosure with its interactive categories, the page with no
 * category selected, the busy agreement, and each outcome Health Connect can
 * end in — plus the "What's sent" disclosure on its Settings card, each in
 * light and dark. Counts and messages are invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class HealthSetupScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/${name}_${if (dark) "dark" else "light"}.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private val noActions = SetupStepPageActions({}, {}, {}, {}, {}, {}, {})

    private val someCategories = HealthCategory.entries.toSet() - HealthCategory.CYCLE - HealthCategory.NUTRITION

    private fun page(
        outcome: SetupOutcome? = null,
        busy: SetupBusy = SetupBusy.IDLE,
        statusLine: SetupStatusLine? = null,
        categories: Set<HealthCategory> = someCategories,
    ): @Composable () -> Unit = {
        SetupStepPage(
            ui = SetupStepPageUi(
                copy = HealthSetupCopy,
                progress = SetupProgress(total = 4, current = 0),
                outcome = outcome,
                busy = busy,
                primaryEnabled = categories.isNotEmpty(),
                statusLine = statusLine,
                fineNote = if (categories.isEmpty()) HEALTH_NO_CATEGORY_NOTE else null,
            ),
            actions = noActions,
            extraSection = { HealthCategoryChips(categories) { _, _ -> } },
        )
    }

    private val noCategory = page(categories = emptySet())
    private val waiting = page(busy = SetupBusy.WAITING_FOR_SYSTEM)
    private val on = page(SetupOutcome.On, statusLine = SetupStatusLine("1,284 records processed", SetupStatusKind.SYNCING, 0.42f))
    private val partial = page(SetupOutcome.Partial, statusLine = SetupStatusLine("Syncing…", SetupStatusKind.SYNCING, 0.1f))
    private val notInstalled = page(healthSetupUnavailable(HealthConnectAvailability.NotInstalled))
    private val updateRequired = page(healthSetupUnavailable(HealthConnectAvailability.UpdateRequired))
    private val failed = page(SetupOutcome.Failed("Your gateway didn't answer. Try again."))

    private val disclosure: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg)) {
            SetupWhatsSentDisclosure(HealthSetupCopy, initiallyExpanded = true)
        }
    }

    @Test fun setup_page_light() = capture("health_setup_page", dark = false, page())
    @Test fun setup_page_dark() = capture("health_setup_page", dark = true, page())

    @Test fun setup_no_category_light() = capture("health_setup_no_category", dark = false, noCategory)
    @Test fun setup_no_category_dark() = capture("health_setup_no_category", dark = true, noCategory)

    @Test fun setup_waiting_light() = capture("health_setup_waiting", dark = false, waiting)
    @Test fun setup_waiting_dark() = capture("health_setup_waiting", dark = true, waiting)

    @Test fun setup_on_light() = capture("health_setup_on", dark = false, on)
    @Test fun setup_on_dark() = capture("health_setup_on", dark = true, on)

    @Test fun setup_partial_light() = capture("health_setup_partial", dark = false, partial)
    @Test fun setup_partial_dark() = capture("health_setup_partial", dark = true, partial)

    @Test fun setup_not_allowed_light() = capture("health_setup_not_allowed", dark = false, page(SetupOutcome.NotAllowed))
    @Test fun setup_not_allowed_dark() = capture("health_setup_not_allowed", dark = true, page(SetupOutcome.NotAllowed))

    @Test fun setup_not_installed_light() = capture("health_setup_not_installed", dark = false, notInstalled)
    @Test fun setup_not_installed_dark() = capture("health_setup_not_installed", dark = true, notInstalled)

    @Test fun setup_update_required_light() = capture("health_setup_update_required", dark = false, updateRequired)
    @Test fun setup_update_required_dark() = capture("health_setup_update_required", dark = true, updateRequired)

    @Test fun setup_failed_light() = capture("health_setup_failed", dark = false, failed)
    @Test fun setup_failed_dark() = capture("health_setup_failed", dark = true, failed)

    @Test fun settings_whats_sent_light() = capture("health_settings_whats_sent", dark = false, disclosure)
    @Test fun settings_whats_sent_dark() = capture("health_settings_whats_sent", dark = true, disclosure)
}
