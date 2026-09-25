// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import com.github.takahirom.roborazzi.captureRoboImage
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.dto.ModelBehaviorSettings
import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.ModelControlDescriptor
import dev.omnesis.android.transport.dto.ModelControlInfo
import dev.omnesis.android.transport.dto.ModelDisplay
import dev.omnesis.android.transport.dto.ResolvedAssignment
import dev.omnesis.android.transport.dto.RecentModelApply
import dev.omnesis.android.transport.dto.RecentModelEntry
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.models.AddBackendForm
import dev.omnesis.android.ui.models.BackendDetailContent
import dev.omnesis.android.ui.models.BackendsContent
import dev.omnesis.android.ui.models.BackendsViewModel
import dev.omnesis.android.ui.models.ModelPickerContent
import dev.omnesis.android.ui.models.ModelBehaviorControlsSection
import dev.omnesis.android.ui.models.ModelsContent
import dev.omnesis.android.ui.models.ModelsViewModel
import dev.omnesis.android.ui.models.SetCredentialForm
import dev.omnesis.android.ui.models.sampleBackendDetailRow
import dev.omnesis.android.ui.models.sampleBackendsOverview
import dev.omnesis.android.ui.models.sampleCredentials
import dev.omnesis.android.ui.models.sampleModelsOverview
import dev.omnesis.android.ui.models.samplePresets
import dev.omnesis.android.ui.models.sampleSystemInfo
import dev.omnesis.android.ui.models.sampleVerifyStates
import dev.omnesis.android.ui.onboarding.OnboardingScreen
import dev.omnesis.android.ui.pairing.PairingConfirmationSheet
import dev.omnesis.android.ui.pairing.PairingContent
import dev.omnesis.android.ui.pairing.PairingViewModel
import dev.omnesis.android.ui.settings.AppearanceMode
import dev.omnesis.android.ui.settings.SettingsContent
import dev.omnesis.android.ui.settings.SettingsViewModel
import dev.omnesis.android.ui.settings.sampleAppVersion
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Pixel-parity snapshots for the Models / Settings / Onboarding / Pairing / Gateway-error
 * area, captured against the iOS reference fixtures (snapshots 110/111/111b/112, 50/51, 06,
 * 07). All sample data is invented per the privacy rule — never sourced from the corpus.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ModelsSettingsPairingParityScreenshotTest {

    private val connected = ConnectionState.Connected("d1", "Studio Northstar", listOf("read", "admin"))

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    /** Standalone picker previews need the surface supplied by the real ModalBottomSheet. */
    private fun capturePickerSurface(name: String, dark: Boolean, content: @Composable () -> Unit) {
        capture(name, dark) {
            Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary)) { content() }
        }
    }

    private fun captureBehavior(name: String, dark: Boolean, content: @Composable () -> Unit) {
        capturePickerSurface(name, dark) {
            Box(Modifier.fillMaxWidth().padding(OmSpacing.lg)) { content() }
        }
    }

    // --- Models (full capability management surface) ---

    @Test
    fun models_configured_dark() = capture("models_configured_dark", dark = true) {
        ModelsContent(Loadable.Content(sampleModelsOverview()), connected, onBack = {}, onRetry = {})
    }

    @Test
    fun models_configured_light() = capture("models_configured_light", dark = false) {
        ModelsContent(Loadable.Content(sampleModelsOverview()), connected, onBack = {}, onRetry = {})
    }

    @Test
    fun models_notice_dark() = capture("models_notice_dark", dark = true) {
        ModelsContent(
            Loadable.Content(sampleModelsOverview()),
            connected,
            notice = ModelsViewModel.Notice(ok = true, text = "Claude Sonnet 4.6 assigned."),
            onBack = {}, onRetry = {},
        )
    }

    @Test
    fun models_loading_dark() = capture("models_loading_dark", dark = true) {
        ModelsContent(Loadable.Loading, connected, onBack = {}, onRetry = {})
    }

    @Test
    fun models_error_dark() = capture("models_error_dark", dark = true) {
        ModelsContent(
            Loadable.Error(GatewayException.Network(Exception("offline"))),
            connected, onBack = {}, onRetry = {},
        )
    }

    // --- Model picker: backend grid (pane 1) then model list (pane 2) ---

    @Test
    fun models_picker_grid_agent_dark() = capture("models_picker_grid_agent_dark", dark = true) {
        // Pane 1: the backend grid for the Agent role (Anthropic + the northstar
        // HTTP backend) plus the Add-HTTP-backend + Clear-assignment affordances.
        val overview = sampleModelsOverview()
        val cap = overview.capabilities.first { it.role == "agent" }
        ModelPickerContent(cap = cap, overview = overview, currentlyConfigured = true)
    }

    @Test
    fun models_picker_grid_empty_light() = capture("models_picker_grid_empty_light", dark = false) {
        // Pane 1 with nothing to pick from: `pickerBackends` emits a tile for every
        // configured HTTP backend whatever the role, so the empty-backends note is
        // a no-backends-at-all state (a fresh gateway), not a per-role one. An
        // overview with no backends, no Codex, and an empty catalog reaches it.
        val overview = ModelsOverview(capabilities = sampleModelsOverview().capabilities)
        val cap = overview.capabilities.first { it.role == "ocr" }
        ModelPickerContent(cap = cap, overview = overview, currentlyConfigured = false)
    }

    @Test
    fun models_picker_list_http_dark() = capture("models_picker_list_http_dark", dark = true) {
        // Pane 2 for an HTTP backend: search field, the role-matching options, and
        // the custom-model-id field.
        val overview = sampleModelsOverview()
        val cap = overview.capabilities.first { it.role == "agent" }
        ModelPickerContent(
            cap = cap,
            overview = overview,
            currentlyConfigured = true,
            previewSelectedBackend = "northstar",
        )
    }

    private fun behaviorInfo() = ModelControlInfo(
        providerId = "openai",
        source = "models.dev",
        reasoning = true,
        controls = listOf(
            ModelControlDescriptor("reasoningEnabled", "boolean", "Reasoning"),
            ModelControlDescriptor("reasoningEffort", "enum", "Reasoning effort", listOf("low", "medium", "high", "xhigh")),
            ModelControlDescriptor("reasoningBudgetTokens", "integer", "Thinking budget", min = 128, max = 8192),
        ),
    )

    private fun behaviorSettings() = ModelBehaviorSettings(
        assignment = "northstar/reasoner-v1",
        values = ModelBehaviorValues(reasoningEnabled = true, reasoningEffort = "high", reasoningBudgetTokens = 2048),
    )

    @Test
    fun models_behavior_controls_dark() = captureBehavior("models_behavior_controls_dark", dark = true) {
        ModelBehaviorControlsSection(behaviorSettings(), behaviorInfo())
    }

    @Test
    fun models_behavior_controls_light() = captureBehavior("models_behavior_controls_light", dark = false) {
        ModelBehaviorControlsSection(behaviorSettings(), behaviorInfo())
    }

    private fun shortEffortInfo() = behaviorInfo().copy(controls = listOf(
        ModelControlDescriptor("reasoningEffort", "enum", "Reasoning effort", listOf("low", "medium", "high")),
    ))

    @Test
    fun models_behavior_short_effort_dark() = captureBehavior("models_behavior_short_effort_dark", dark = true) {
        ModelBehaviorControlsSection(
            ModelBehaviorSettings("northstar/reasoner-v1", ModelBehaviorValues(reasoningEffort = "medium")),
            shortEffortInfo(),
        )
    }

    @Test
    fun models_behavior_short_effort_light() = captureBehavior("models_behavior_short_effort_light", dark = false) {
        ModelBehaviorControlsSection(
            ModelBehaviorSettings("northstar/reasoner-v1", ModelBehaviorValues(reasoningEffort = "medium")),
            shortEffortInfo(),
        )
    }

    private fun offBehaviorInfo() = behaviorInfo().copy(controls = listOf(
        ModelControlDescriptor("reasoningEnabled", "boolean", "Reasoning"),
        ModelControlDescriptor("reasoningEffort", "enum", "Reasoning effort", listOf("low", "medium", "high")),
        ModelControlDescriptor("reasoningBudgetTokens", "integer", "Thinking budget", min = 128, max = 8192),
    ))

    @Test
    fun models_behavior_off_dark() = captureBehavior("models_behavior_off_dark", dark = true) {
        ModelBehaviorControlsSection(
            ModelBehaviorSettings("northstar/reasoner-v1", ModelBehaviorValues(reasoningEnabled = false)),
            offBehaviorInfo(),
        )
    }

    @Test
    fun models_behavior_off_light() = captureBehavior("models_behavior_off_light", dark = false) {
        ModelBehaviorControlsSection(
            ModelBehaviorSettings("northstar/reasoner-v1", ModelBehaviorValues(reasoningEnabled = false)),
            offBehaviorInfo(),
        )
    }

    private fun noBudgetEnforcementInfo() = ModelControlInfo(
        providerId = "nvidia", source = "models.dev",
        controls = listOf(ModelControlDescriptor(
            "reasoningBudgetTokens", "integer", "Reasoning token budget", min = -1, max = 8192,
        )),
    )

    @Test
    fun models_behavior_no_enforcement_dark() = captureBehavior("models_behavior_no_enforcement_dark", dark = true) {
        ModelBehaviorControlsSection(
            ModelBehaviorSettings("nvidia/reasoner-v1", ModelBehaviorValues(reasoningBudgetTokens = -1)),
            noBudgetEnforcementInfo(),
        )
    }

    @Test
    fun models_behavior_no_enforcement_light() = captureBehavior("models_behavior_no_enforcement_light", dark = false) {
        ModelBehaviorControlsSection(
            ModelBehaviorSettings("nvidia/reasoner-v1", ModelBehaviorValues(reasoningBudgetTokens = -1)),
            noBudgetEnforcementInfo(),
        )
    }

    private fun retiredBehaviorSettings() = ModelBehaviorSettings(
        assignment = "northstar/retired-reasoner",
        values = ModelBehaviorValues(reasoningEffort = "medium"),
    )

    @Test
    fun models_behavior_stale_unknown_dark() = captureBehavior("models_behavior_stale_unknown_dark", dark = true) {
        ModelBehaviorControlsSection(retiredBehaviorSettings(), null)
    }

    @Test
    fun models_behavior_stale_unknown_light() = captureBehavior("models_behavior_stale_unknown_light", dark = false) {
        ModelBehaviorControlsSection(retiredBehaviorSettings(), null)
    }

    private fun retiredEffortInfo() = behaviorInfo().copy(controls = listOf(
        ModelControlDescriptor("reasoningEffort", "enum", "Reasoning effort", listOf("low", "high")),
    ))

    @Test
    fun models_behavior_stale_effort_dark() = captureBehavior("models_behavior_stale_effort_dark", dark = true) {
        ModelBehaviorControlsSection(retiredBehaviorSettings(), retiredEffortInfo())
    }

    @Test
    fun models_behavior_stale_effort_light() = captureBehavior("models_behavior_stale_effort_light", dark = false) {
        ModelBehaviorControlsSection(retiredBehaviorSettings(), retiredEffortInfo())
    }

    private fun behaviorOverview(): ModelsOverview {
        val base = sampleModelsOverview()
        return base.copy(
            assignmentDisplays = base.assignmentDisplays +
                ("agent" to ModelDisplay("openai", "Northstar", "reasoner-v1", available = true, configured = true)),
            inference = base.inference.copy(
                assignments = base.inference.assignments + ("agent" to ResolvedAssignment("http", available = true)),
            ),
            modelControls = mapOf("northstar/reasoner-v1" to behaviorInfo()),
            modelSettings = mapOf("agent" to behaviorSettings()),
        )
    }

    private fun noControlsOverview(): ModelsOverview {
        val base = behaviorOverview()
        return base.copy(
            modelControls = emptyMap(),
            modelSettings = mapOf("agent" to ModelBehaviorSettings("northstar/reasoner-v1")),
        )
    }

    private fun recentReasoningModels() = listOf(
        RecentModelEntry(
            assignment = "openrouter/reasoner-v2",
            providerId = "openrouter",
            providerLabel = "OpenRouter",
            modelName = "Reasoner V2",
            apply = RecentModelApply(type = "assign", value = "openrouter/reasoner-v2"),
        ),
    )

    @Test
    fun models_configured_behavior_dark() = capture("models_configured_behavior_dark", dark = true) {
        ModelsContent(Loadable.Content(behaviorOverview()), connected, onBack = {}, onRetry = {})
    }

    @Test
    fun models_configured_behavior_light() = capture("models_configured_behavior_light", dark = false) {
        ModelsContent(Loadable.Content(behaviorOverview()), connected, onBack = {}, onRetry = {})
    }

    @Test
    fun models_picker_behavior_dark() = capturePickerSurface("models_picker_behavior_dark", dark = true) {
        val overview = behaviorOverview()
        ModelPickerContent(
            cap = overview.capabilities.first { it.role == "agent" },
            overview = overview,
            currentlyConfigured = true,
            recent = recentReasoningModels(),
        )
    }

    @Test
    fun models_picker_behavior_light() = capturePickerSurface("models_picker_behavior_light", dark = false) {
        val overview = behaviorOverview()
        ModelPickerContent(
            cap = overview.capabilities.first { it.role == "agent" },
            overview = overview,
            currentlyConfigured = true,
            recent = recentReasoningModels(),
        )
    }

    @Test
    fun models_picker_assigned_without_controls_dark() =
        capturePickerSurface("models_picker_assigned_without_controls_dark", dark = true) {
            val overview = noControlsOverview()
            ModelPickerContent(
                cap = overview.capabilities.first { it.role == "agent" },
                overview = overview,
                currentlyConfigured = true,
                recent = recentReasoningModels(),
            )
        }

    @Test
    fun models_picker_assigned_without_controls_light() =
        capturePickerSurface("models_picker_assigned_without_controls_light", dark = false) {
            val overview = noControlsOverview()
            ModelPickerContent(
                cap = overview.capabilities.first { it.role == "agent" },
                overview = overview,
                currentlyConfigured = true,
                recent = recentReasoningModels(),
            )
        }

    // --- Local-GGUF lifecycle: install / cancel / uninstall (pane 2, Local) ---

    @Test
    fun models_picker_local_lifecycle_dark() = capture("models_picker_local_lifecycle_dark", dark = true) {
        // The Embedder picker, Local pane: the local-model list with one model
        // installed (Use/Remove), one downloading (progress + Cancel), and one
        // available with a fit warning (Install).
        val overview = sampleModelsOverview()
        val cap = overview.capabilities.first { it.role == "embedder" }
        ModelPickerContent(
            cap = cap,
            overview = overview,
            system = sampleSystemInfo(),
            currentlyConfigured = true,
            previewSelectedBackend = "local",
        )
    }

    @Test
    fun models_picker_local_lifecycle_light() = capture("models_picker_local_lifecycle_light", dark = false) {
        val overview = sampleModelsOverview()
        val cap = overview.capabilities.first { it.role == "embedder" }
        ModelPickerContent(
            cap = cap,
            overview = overview,
            system = sampleSystemInfo(),
            currentlyConfigured = true,
            previewSelectedBackend = "local",
        )
    }

    // --- HTTP-backend management ---

    @Test
    fun backends_list_dark() = capture("backends_list_dark", dark = true) {
        BackendsContent(Loadable.Content(sampleBackendsOverview()), onBack = {}, onRetry = {})
    }

    @Test
    fun backends_list_light() = capture("backends_list_light", dark = false) {
        BackendsContent(Loadable.Content(sampleBackendsOverview()), onBack = {}, onRetry = {})
    }

    @Test
    fun backends_notice_dark() = capture("backends_notice_dark", dark = true) {
        BackendsContent(
            Loadable.Content(sampleBackendsOverview()),
            notice = BackendsViewModel.Notice(ok = true, text = "Added backend \"my-vllm\"."),
            onBack = {}, onRetry = {},
        )
    }

    @Test
    fun backends_probe_result_dark() = capture("backends_probe_result_dark", dark = true) {
        BackendsContent(
            Loadable.Content(sampleBackendsOverview()),
            probes = mapOf(
                "northstar" to BackendsViewModel.ProbeState.Ok(modelCount = 2),
                "studio-local" to BackendsViewModel.ProbeState.Fail("connection refused"),
            ),
            onBack = {}, onRetry = {},
        )
    }

    @Test
    fun backends_empty_light() = capture("backends_empty_light", dark = false) {
        BackendsContent(Loadable.Content(ModelsOverview()), onBack = {}, onRetry = {})
    }

    @Test
    fun backends_loading_dark() = capture("backends_loading_dark", dark = true) {
        BackendsContent(Loadable.Loading, onBack = {}, onRetry = {})
    }

    @Test
    fun backends_error_dark() = capture("backends_error_dark", dark = true) {
        BackendsContent(Loadable.Error(GatewayException.Network(Exception("offline"))), onBack = {}, onRetry = {})
    }

    // --- Add-backend: preset grid (step 1) then the prefilled form (step 2) ---

    @Test
    fun add_backend_grid_dark() = capture("add_backend_grid_dark", dark = true) {
        // Step 1: the provider-preset grid + the Custom card.
        AddBackendForm(presets = samplePresets())
    }

    @Test
    fun add_backend_grid_light() = capture("add_backend_grid_light", dark = false) {
        AddBackendForm(presets = samplePresets())
    }

    // --- Model-provider credentials ---

    @Test
    fun backends_with_credentials_dark() = capture("backends_with_credentials_dark", dark = true) {
        BackendsContent(
            Loadable.Content(sampleBackendsOverview()),
            credentials = sampleCredentials(),
            onBack = {}, onRetry = {},
        )
    }

    @Test
    fun backends_with_credentials_light() = capture("backends_with_credentials_light", dark = false) {
        BackendsContent(
            Loadable.Content(sampleBackendsOverview()),
            credentials = sampleCredentials(),
            onBack = {}, onRetry = {},
        )
    }

    @Test
    fun set_credential_form_dark() = capture("set_credential_form_dark", dark = true) {
        SetCredentialForm(entry = sampleCredentials()[0])
    }

    // --- Backend detail: header + behavioral capability verify ---

    @Test
    fun backend_detail_verify_idle_dark() = capture("backend_detail_verify_idle_dark", dark = true) {
        // The detail's "Verify capabilities" section in the idle state — the
        // per-(model, role) affordance before any verdict.
        BackendDetailContent(backendKey = "example-cloud", row = sampleBackendDetailRow())
    }

    @Test
    fun backend_detail_verify_states_dark() = capture("backend_detail_verify_states_dark", dark = true) {
        // All four verify states across the backend's targets: supported,
        // unsupported, in-flight, and error.
        BackendDetailContent(
            backendKey = "example-cloud",
            row = sampleBackendDetailRow(),
            verifies = sampleVerifyStates(),
        )
    }

    @Test
    fun backend_detail_verify_states_light() = capture("backend_detail_verify_states_light", dark = false) {
        BackendDetailContent(
            backendKey = "example-cloud",
            row = sampleBackendDetailRow(),
            verifies = sampleVerifyStates(),
        )
    }

    // --- Settings (refs 50 / 51) ---

    private fun sampleGateway() = SettingsViewModel.GatewayInfo(
        name = "Studio Northstar", url = "https://gateway.example.com", deviceId = "dev-abc123", scopes = listOf("read", "admin"),
    )

    @Test
    fun settings_connected_dark() = capture("settings_connected_dark", dark = true) {
        SettingsContent(
            gateway = sampleGateway(),
            connection = connected,
            mode = AppearanceMode.DARK,
            appVersion = sampleAppVersion(),
            onClose = {}, onSetAppearance = {}, onSaveUrl = { null }, onUnpair = {},
        )
    }

    @Test
    fun settings_connected_light() = capture("settings_connected_light", dark = false) {
        SettingsContent(
            gateway = sampleGateway(),
            connection = connected,
            mode = AppearanceMode.LIGHT,
            appVersion = sampleAppVersion(),
            onClose = {}, onSetAppearance = {}, onSaveUrl = { null }, onUnpair = {},
        )
    }

    @Test
    fun settings_unreachable_dark() = capture("settings_unreachable_dark", dark = true) {
        SettingsContent(
            gateway = sampleGateway().copy(url = "https://gateway.tailnet.ts.net:7600"),
            connection = ConnectionState.Failed("timeout after 5s"),
            mode = AppearanceMode.SYSTEM,
            appVersion = sampleAppVersion(),
            onClose = {}, onSetAppearance = {}, onSaveUrl = { null }, onUnpair = {},
        )
    }

    // --- Onboarding (refs 06 / 06-light) ---

    @Test
    fun onboarding_dark() = capture("onboarding_dark", dark = true) { OnboardingScreen() }

    @Test
    fun onboarding_light() = capture("onboarding_light", dark = false) { OnboardingScreen() }

    // --- Pairing (ref 07) ---

    @Test
    fun pairing_form_dark() = capture("pairing_form_dark", dark = true) {
        PairingContent(
            state = PairingViewModel.State(
                mode = PairingViewModel.Mode.Manual,
                gatewayUrl = "https://gateway.example.com",
                pairingCode = "AB-CD-EF",
            ),
            onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
            onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
        )
    }

    @Test
    fun pairing_form_error_light() = capture("pairing_form_error_light", dark = false) {
        PairingContent(
            state = PairingViewModel.State(
                mode = PairingViewModel.Mode.Manual,
                gatewayUrl = "https://gateway.example.com", pairingCode = "WRONG",
                error = "Can't reach the gateway. Make sure it's running and reachable from this device.",
            ),
            onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
            onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
        )
    }

    @Test
    fun pairing_confirm_pinned_dark() = capture("pairing_confirm_pinned_dark", dark = true) {
        PairingConfirmationSheet(
            hostAndPort = "gateway.example.com",
            versionLabel = "TLS-pinned (V3)",
            trustKind = PairingViewModel.TrustKind.PinnedLeaf,
            fingerprint = "9f1a2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
            pairing = false, onCancel = {}, onConfirm = {},
        )
    }

    @Test
    fun pairing_confirm_legacy_light() = capture("pairing_confirm_legacy_light", dark = false) {
        PairingConfirmationSheet(
            hostAndPort = "gateway.tailnet.ts.net:7600",
            versionLabel = "Legacy (V1)",
            trustKind = PairingViewModel.TrustKind.Legacy,
            fingerprint = null,
            pairing = false, onCancel = {}, onConfirm = {},
        )
    }

    @Test
    fun pairing_confirm_system_trust_light() = capture("pairing_confirm_system_trust_light", dark = false) {
        PairingConfirmationSheet(
            hostAndPort = "public-gateway.example.com",
            versionLabel = "System-trusted HTTPS (V4)",
            trustKind = PairingViewModel.TrustKind.System,
            fingerprint = null,
            pairing = false, onCancel = {}, onConfirm = {},
        )
    }

    @Test
    fun pairing_confirm_system_trust_dark() = capture("pairing_confirm_system_trust_dark", dark = true) {
        PairingConfirmationSheet(
            hostAndPort = "public-gateway.example.com",
            versionLabel = "System-trusted HTTPS (V4)",
            trustKind = PairingViewModel.TrustKind.System,
            fingerprint = null,
            pairing = false, onCancel = {}, onConfirm = {},
        )
    }

    // --- Gateway error placeholders (GatewayErrorView; all six kinds) ---

    @Test
    fun gateway_error_unreachable_dark() = capture("parity_gateway_error_unreachable_dark", dark = true) {
        GatewayErrorView("load models", GatewayException.Network(Exception("offline")), onRetry = {}, onOpenSettings = {})
    }

    @Test
    fun gateway_error_unauthorized_light() = capture("parity_gateway_error_unauthorized_light", dark = false) {
        GatewayErrorView("load models", GatewayException.Unauthorized(), onRetry = {}, onOpenSettings = {})
    }

    @Test
    fun gateway_error_forbidden_dark() = capture("parity_gateway_error_forbidden_dark", dark = true) {
        GatewayErrorView("load models", GatewayException.Forbidden(), onRetry = {}, onOpenSettings = {})
    }

    @Test
    fun gateway_error_agent_dark() = capture("parity_gateway_error_agent_dark", dark = true) {
        GatewayErrorView(
            "load models",
            GatewayException.ServerError(503, "Agent disabled. Set inference.assignments.agent in omnesis.json (e.g. \"anthropic/claude-sonnet-4-6\") to enable it."),
            onRetry = {}, onOpenSettings = {}, onOpenModels = {},
        )
    }

    @Test
    fun gateway_error_server_dark() = capture("parity_gateway_error_server_dark", dark = true) {
        GatewayErrorView(
            "load models",
            GatewayException.ServerError(500, "Service temporarily unavailable. Try again in a few seconds."),
            onRetry = {}, onOpenSettings = {},
        )
    }

    @Test
    fun gateway_error_unknown_dark() = capture("parity_gateway_error_unknown_dark", dark = true) {
        GatewayErrorView("load models", RuntimeException("Unexpected failure"), onRetry = {}, onOpenSettings = {})
    }
}
