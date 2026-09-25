// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import com.github.takahirom.roborazzi.captureRoboImage
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.ui.onboarding.OnboardingScreen
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders Compose screens to PNGs off-emulator (Robolectric + Roborazzi). This is
 * the Android analogue of the iOS preview/snapshot self-critique loop: every screen
 * gets captured in light and dark so the result can be reviewed before shipping.
 *
 * Record/refresh with:  ./gradlew :app:recordRoborazziDebug
 * PNGs land in:         app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class OnboardingScreenshotTest {

    @Test
    fun onboarding_light() {
        captureRoboImage(filePath = "src/test/roborazzi/onboarding_light.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = false) { OnboardingScreen() }
            }
        }
    }

    @Test
    fun onboarding_dark() {
        captureRoboImage(filePath = "src/test/roborazzi/onboarding_dark.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = true) { OnboardingScreen() }
            }
        }
    }
}
