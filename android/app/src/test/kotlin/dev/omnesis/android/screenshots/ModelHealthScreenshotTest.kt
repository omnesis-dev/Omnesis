// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.ModelHealth
import dev.omnesis.android.transport.dto.ModelHealthWarning
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.home.MainMenuDrawer
import dev.omnesis.android.ui.models.ModelsContent
import dev.omnesis.android.ui.models.sampleModelsOverview
import dev.omnesis.android.ui.settings.AppearanceMode
import dev.omnesis.android.ui.settings.SettingsContent
import dev.omnesis.android.ui.settings.SettingsViewModel
import dev.omnesis.android.ui.settings.sampleAppVersion
import org.junit.Before
import org.junit.After
import java.util.Locale
import java.util.TimeZone
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ModelHealthScreenshotTest {
    private val originalLocale = Locale.getDefault()
    private val originalTimeZone = TimeZone.getDefault()
    @Before fun fixedDateFormatting() {
        Locale.setDefault(Locale.US)
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }
    @After fun restoreDateFormatting() {
        Locale.setDefault(originalLocale)
        TimeZone.setDefault(originalTimeZone)
    }

    private val connection = ConnectionState.Connected("d1", "Studio Northstar", listOf("read", "admin"))
    private val warning = ModelHealthWarning("decision", "typesafe/draft-model", 4, 1700000000000, 1700000060000,
        "quota", "The inference provider reports exhausted quota. Check billing or usage limits.")

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private fun models(dark: Boolean) = capture("model_health_models_${if (dark) "dark" else "light"}", dark) {
        val overview = sampleModelsOverview()
        ModelsContent(Loadable.Content(overview.copy(inference = overview.inference.copy(health = ModelHealth(listOf(warning))))),
            connection, onBack = {}, onRetry = {})
    }
    @Test fun models_light() = models(false)
    @Test fun models_dark() = models(true)

    private fun settings(dark: Boolean) = capture("model_health_settings_${if (dark) "dark" else "light"}", dark) {
        SettingsContent(SettingsViewModel.GatewayInfo("Studio Northstar", "https://gateway.example.com", "d1", listOf("read", "admin")),
            connection, AppearanceMode.SYSTEM, sampleAppVersion(), onClose = {}, onSetAppearance = {},
            onSaveUrl = { null }, onUnpair = {}, modelsNeedAttention = true)
    }
    @Test fun settings_light() = settings(false)
    @Test fun settings_dark() = settings(true)

    private fun menu(dark: Boolean) = capture("model_health_menu_${if (dark) "dark" else "light"}", dark) {
        MainMenuDrawer("agent", emptyList(), conversationsLoading = false, onNewConversation = {}, onNavigate = {},
            onResumeConversation = {}, onDeleteConversation = {}, onOpenSettings = {}, modelsNeedAttention = true,
            onOpenModelWarnings = {})
    }
    @Test fun menu_light() = menu(false)
    @Test fun menu_dark() = menu(true)
}
