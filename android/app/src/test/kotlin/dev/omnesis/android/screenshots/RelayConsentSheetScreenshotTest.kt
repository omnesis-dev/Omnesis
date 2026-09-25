// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.setup.ui.setupPalette
import dev.omnesis.android.ui.root.RelayConsentSheetContent
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the relay-consent bottom sheet's body — ready,
 * saving and after a failed save — in light and dark. The app id and error
 * text are invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class RelayConsentSheetScreenshotTest {
    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/${name}_${if (dark) "dark" else "light"}.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Column(Modifier.fillMaxSize().background(setupPalette.base)) { content() }
                }
            }
        }
    }

    private fun sheet(requesting: Boolean = false, error: String? = null): @Composable () -> Unit = {
        RelayConsentSheetContent(
            appId = "dev.example.omnesis",
            requesting = requesting,
            error = error,
            onAllow = {},
            onNotNow = {},
        )
    }

    private val failed = sheet(error = "Relay approval was saved, but notification setup didn’t finish. Try again.")

    @Test fun relay_consent_sheet_ready_light() = capture("relay_consent_sheet_ready", dark = false, sheet())
    @Test fun relay_consent_sheet_ready_dark() = capture("relay_consent_sheet_ready", dark = true, sheet())

    @Test fun relay_consent_sheet_requesting_light() = capture("relay_consent_sheet_requesting", dark = false, sheet(requesting = true))
    @Test fun relay_consent_sheet_requesting_dark() = capture("relay_consent_sheet_requesting", dark = true, sheet(requesting = true))

    @Test fun relay_consent_sheet_error_light() = capture("relay_consent_sheet_error", dark = false, failed)
    @Test fun relay_consent_sheet_error_dark() = capture("relay_consent_sheet_error", dark = true, failed)
}
