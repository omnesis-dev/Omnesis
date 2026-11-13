// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.LabSnapshot
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.ui.settings.LabContent
import dev.omnesis.android.ui.settings.LabUiState
import kotlinx.serialization.decodeFromString
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h1100dp-xxhdpi")
class LabScreenshotTest {
    private fun catalogue() = OmnesisJson.decodeFromString<LabSnapshot>(
        requireNotNull(javaClass.classLoader!!.getResource("lab-catalog.json")).readText(),
    )

    private fun capture(name: String, dark: Boolean, state: LabUiState) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { LabContent(state, {}, {}, { _, _ -> }) }
            }
        }
    }

    @Test fun lab_disabled_light() = capture("lab-disabled-light", false, LabUiState(catalogue(), loading = false))
    @Test fun lab_disabled_dark() = capture("lab-disabled-dark", true, LabUiState(catalogue(), loading = false))
    @Test fun lab_enabled_light() = capture("lab-enabled-light", false, LabUiState(catalogue().let { it.copy(features = it.features.map { feature -> feature.copy(enabled = true) }) }, loading = false))
    @Test fun lab_saving_dark() = capture("lab-saving-dark", true, LabUiState(catalogue(), loading = false, saving = "brain"))
    @Test fun lab_loading_light() = capture("lab-loading-light", false, LabUiState())
    @Test fun lab_loading_dark() = capture("lab-loading-dark", true, LabUiState())
    @Test fun lab_error_light() = capture("lab-error-light", false, LabUiState(loading = false, error = "Couldn't load Omnesis Lab. Try again."))
    @Test fun lab_error_dark() = capture("lab-error-dark", true, LabUiState(loading = false, error = "Couldn't load Omnesis Lab. Try again."))
}
