// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.DecisionProbeResult
import dev.omnesis.android.transport.dto.DecisionVerifyResult
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.models.DecisionFormValues
import dev.omnesis.android.ui.models.DecisionSetup
import dev.omnesis.android.ui.models.DecisionSetupContent
import dev.omnesis.android.ui.models.DecisionStep
import dev.omnesis.android.ui.models.DecisionUiState
import dev.omnesis.android.ui.models.ModelsContent
import dev.omnesis.android.ui.models.ProbeState
import dev.omnesis.android.ui.models.ProbeTarget
import dev.omnesis.android.ui.models.sampleDecisionOverview
import dev.omnesis.android.ui.models.sampleDecisionPresets
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Decision model's setup: the capability card, the assigned model with
 * its test decision answered and refused, the provider picker (a backend serving decisions, a chat backend that can add
 * them with its key, TypeSafe, providers to add), the forms — a local
 * backend, decisions added to a chat backend, a provider with both APIs, a
 * decision-only provider with URL values, TypeSafe, another server — and the
 * cloud-inference question. All sample data is invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DecisionModelScreenshotTest {

    private val connected = ConnectionState.Connected("d1", "Studio Northstar", listOf("read", "admin"))

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary)) { content() }
                }
            }
        }
    }

    private fun decisionCap(overview: ModelsOverview) = overview.capabilities.first { it.role == "decision" }

    private fun preset(id: String) = sampleDecisionPresets().first { it.id == id }

    private fun setup(
        name: String,
        dark: Boolean,
        overview: ModelsOverview = sampleDecisionOverview(),
        ui: DecisionUiState = DecisionUiState(),
        step: DecisionStep,
        provider: DecisionSetup.Provider? = null,
        form: DecisionFormValues? = null,
        consent: DecisionSetup.SaveRequest? = null,
    ) = capture(name, dark) {
        DecisionSetupContent(
            cap = decisionCap(overview),
            overview = overview,
            ui = ui,
            previewStep = step,
            previewProvider = provider,
            previewForm = form,
            previewConsent = consent,
        )
    }

    // --- The capability list ---

    @Test fun decision_card_dark() = capture("decision_card_dark", dark = true) {
        ModelsContent(Loadable.Content(sampleDecisionOverview()), connected, onBack = {}, onRetry = {})
    }

    @Test fun decision_card_light() = capture("decision_card_light", dark = false) {
        ModelsContent(Loadable.Content(sampleDecisionOverview()), connected, onBack = {}, onRetry = {})
    }

    // --- The assigned model ---

    private val verified = DecisionUiState(
        verify = DecisionSetup.VerifyState.Done("ollaya/kev", DecisionVerifyResult(ok = true, answeredBy = "kev", latencyMs = 240)),
    )

    @Test fun decision_home_verified_dark() = setup("decision_home_verified_dark", dark = true, ui = verified, step = DecisionStep.Home)

    @Test fun decision_home_verified_light() = setup("decision_home_verified_light", dark = false, ui = verified, step = DecisionStep.Home)

    private val refused = DecisionUiState(
        verify = DecisionSetup.VerifyState.Done(
            "ollaya/kev",
            DecisionVerifyResult(
                ok = false,
                reason = "Nothing answered at http://127.0.0.1:11435/v1/systemone. Is the server running? (fetch failed)",
            ),
        ),
    )

    @Test fun decision_home_refused_dark() = setup("decision_home_refused_dark", dark = true, ui = refused, step = DecisionStep.Home)

    @Test fun decision_home_refused_light() = setup("decision_home_refused_light", dark = false, ui = refused, step = DecisionStep.Home)

    // --- The provider picker ---

    @Test fun decision_providers_dark() = setup("decision_providers_dark", dark = true, step = DecisionStep.Providers)

    @Test fun decision_providers_light() = setup("decision_providers_light", dark = false, step = DecisionStep.Providers)

    // --- The forms ---

    private fun yours() = DecisionSetup.providerGroups(sampleDecisionOverview()).yours

    private fun existingOllaya() = yours().filterIsInstance<DecisionSetup.Provider.Existing>().single()

    private fun enableFireworks() = yours().filterIsInstance<DecisionSetup.Provider.Enable>().single()

    private val probed = DecisionUiState(
        probes = mapOf(
            ProbeTarget.Saved("ollaya").id to
                ProbeState.Done(DecisionProbeResult(ok = true, models = listOf("kev", "nimble:9b"), listed = true)),
        ),
    )

    @Test fun decision_form_local_dark() = setup(
        "decision_form_local_dark",
        dark = true,
        ui = probed,
        step = DecisionStep.Form,
        provider = existingOllaya(),
        form = DecisionFormValues(name = "ollaya", url = "http://127.0.0.1:11435/v1/systemone", model = "kev"),
    )

    @Test fun decision_form_local_light() = setup(
        "decision_form_local_light",
        dark = false,
        ui = probed,
        step = DecisionStep.Form,
        provider = existingOllaya(),
        form = DecisionFormValues(name = "ollaya", url = "http://127.0.0.1:11435/v1/systemone", model = "kev"),
    )

    private fun enableForm(name: String, dark: Boolean) = setup(
        name,
        dark = dark,
        step = DecisionStep.Form,
        provider = enableFireworks(),
        form = DecisionFormValues(
            name = "fireworks",
            url = "https://api.fireworks.ai/inference/v1/systemone",
            model = "accounts/fireworks/models/rune",
        ),
    )

    @Test fun decision_form_enable_dark() = enableForm("decision_form_enable_dark", dark = true)

    @Test fun decision_form_enable_light() = enableForm("decision_form_enable_light", dark = false)

    private fun bothApisForm(name: String, dark: Boolean) = setup(
        name,
        dark = dark,
        step = DecisionStep.Form,
        provider = DecisionSetup.Provider.Preset(preset("openrouter")),
        form = DecisionFormValues(name = "openrouter", url = "https://openrouter.ai/api/v1/systemone", model = "liquid/d1.1"),
    )

    @Test fun decision_form_both_apis_dark() = bothApisForm("decision_form_both_apis_dark", dark = true)

    @Test fun decision_form_both_apis_light() = bothApisForm("decision_form_both_apis_light", dark = false)

    private val cloudflareForm = DecisionFormValues(
        name = "cloudflare",
        apiKey = "example-key-0001",
        model = "@cf/cloudflare/clef-flash",
        urlParams = mapOf("account" to "0123456789abcdef0123456789abcdef"),
    )

    @Test fun decision_form_cloud_params_dark() = setup(
        "decision_form_cloud_params_dark",
        dark = true,
        step = DecisionStep.Form,
        provider = DecisionSetup.Provider.Preset(preset("cloudflare")),
        form = cloudflareForm,
    )

    @Test fun decision_form_cloud_params_light() = setup(
        "decision_form_cloud_params_light",
        dark = false,
        step = DecisionStep.Form,
        provider = DecisionSetup.Provider.Preset(preset("cloudflare")),
        form = cloudflareForm,
    )

    private fun typesafeForm(name: String, dark: Boolean) = setup(
        name,
        dark = dark,
        ui = DecisionUiState(typesafeKey = DecisionSetup.KeyState.Stored),
        step = DecisionStep.Form,
        provider = DecisionSetup.Provider.Preset(preset("typesafe")),
        form = DecisionFormValues(model = "jev-1.14.0"),
    )

    @Test fun decision_form_typesafe_dark() = typesafeForm("decision_form_typesafe_dark", dark = true)

    @Test fun decision_form_typesafe_light() = typesafeForm("decision_form_typesafe_light", dark = false)

    private fun customForm(name: String, dark: Boolean) = setup(
        name,
        dark = dark,
        step = DecisionStep.Form,
        provider = DecisionSetup.Provider.Custom,
        form = DecisionFormValues(name = "decision-server", url = "http://192.0.2.10:8080/v1/systemone"),
    )

    @Test fun decision_form_custom_dark() = customForm("decision_form_custom_dark", dark = true)

    @Test fun decision_form_custom_light() = customForm("decision_form_custom_light", dark = false)

    // --- The cloud-inference question ---

    private fun cloudflareSave() = DecisionSetup.newBackendSave(
        "cloudflare", preset("cloudflare"),
        "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run",
        "example-key-0001", "@cf/cloudflare/clef-flash",
    )

    @Test fun decision_consent_dark() = setup(
        "decision_consent_dark",
        dark = true,
        step = DecisionStep.Consent,
        provider = DecisionSetup.Provider.Preset(preset("cloudflare")),
        consent = cloudflareSave(),
    )

    @Test fun decision_consent_light() = setup(
        "decision_consent_light",
        dark = false,
        step = DecisionStep.Consent,
        provider = DecisionSetup.Provider.Preset(preset("cloudflare")),
        consent = cloudflareSave(),
    )
}
