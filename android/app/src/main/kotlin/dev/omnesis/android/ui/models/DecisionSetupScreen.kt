// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.BackendBrandIcon
import dev.omnesis.android.designsystem.components.MiddleEllipsisText
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.CapabilityMeta
import dev.omnesis.android.transport.dto.DecisionBackendStatus
import dev.omnesis.android.transport.dto.DecisionCalibration
import dev.omnesis.android.transport.dto.DecisionCalibrationStatus
import dev.omnesis.android.transport.dto.DecisionModelOption
import dev.omnesis.android.transport.dto.DecisionPresetView
import dev.omnesis.android.transport.dto.DecisionUrlParam
import dev.omnesis.android.transport.dto.ModelDisplay
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.dto.ResolvedAssignment
import dev.omnesis.android.ui.models.DecisionSetup.CalibrationPanel
import dev.omnesis.android.ui.models.DecisionSetup.Provider
import dev.omnesis.android.ui.models.DecisionSetup.SaveRequest
import dev.omnesis.android.ui.models.DecisionSetup.VerifyState

/** The Decision model setup's steps, one decision each. */
enum class DecisionStep { Home, Providers, Form, Consent }

/** The form's typed values; seeded for screenshots. */
data class DecisionFormValues(
    val name: String = "",
    val url: String = "",
    val apiKey: String = "",
    val model: String = "",
    val urlParams: Map<String, String> = emptyMap(),
)

/** The setup's callbacks, bundled so the Models screen passes them through in one value. */
data class DecisionActions(
    val onOpened: () -> Unit = {},
    val onSave: (SaveRequest, onSaved: () -> Unit) -> Unit = { _, _ -> },
    val onVerify: (String) -> Unit = {},
    val onProbe: (String) -> Unit = {},
    val onCalibrate: () -> Unit = {},
    val onCancelCalibration: () -> Unit = {},
    val onRemove: (key: String, clearAssignment: Boolean, onRemoved: () -> Unit) -> Unit = { _, _, _ -> },
    val onClear: () -> Unit = {},
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DecisionSetupSheet(
    cap: CapabilityMeta,
    overview: ModelsOverview,
    ui: DecisionUiState,
    actions: DecisionActions,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        DecisionSetupContent(cap = cap, overview = overview, ui = ui, actions = actions)
    }
}

/**
 * The Decision model's setup, one step at a time: the assigned model with
 * its test decision and calibration; the provider picker (configured
 * backends, servers on this machine, hosted APIs); the provider's form; and,
 * for an endpoint off the gateway host, the cloud-inference question. Save is
 * one config patch, followed by a test decision whose reason is shown as the
 * gateway words it.
 *
 * `previewStep` / `previewProvider` / `previewForm` seed the step on screen
 * so each renders deterministically in screenshots.
 */
@Composable
fun DecisionSetupContent(
    cap: CapabilityMeta,
    overview: ModelsOverview,
    ui: DecisionUiState,
    actions: DecisionActions = DecisionActions(),
    previewStep: DecisionStep? = null,
    previewProvider: Provider? = null,
    previewForm: DecisionFormValues? = null,
    previewConsent: SaveRequest? = null,
) {
    val configured = ModelManagement.isConfigured(DecisionSetup.assignment(overview))
    var step by remember { mutableStateOf(previewStep ?: if (configured) DecisionStep.Home else DecisionStep.Providers) }
    var provider by remember { mutableStateOf(previewProvider) }
    var form by remember { mutableStateOf(previewForm ?: DecisionFormValues()) }
    var pending by remember { mutableStateOf(previewConsent) }

    fun choose(choice: Provider) {
        provider = choice
        form = DecisionFormValues(
            name = if (choice is Provider.Existing) choice.key else DecisionSetup.defaultName(DecisionSetup.presetOf(choice), overview),
            url = when (choice) {
                is Provider.Existing -> choice.backend.url
                is Provider.Preset -> choice.preset.url.takeIf { choice.preset.urlParams.isEmpty() }.orEmpty()
                Provider.Custom -> ""
            },
            model = DecisionSetup.initialModel(choice, overview),
        )
        step = DecisionStep.Form
    }

    val saved: () -> Unit = {
        pending = null
        form = DecisionFormValues()
        step = DecisionStep.Home
    }

    fun submit(request: SaveRequest) {
        val consent = DecisionSetup.consentFor(request, overview, provider?.let(DecisionSetup::presetOf))
        if (consent != null) {
            pending = request
            step = DecisionStep.Consent
        } else {
            actions.onSave(request, saved)
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        when (step) {
            DecisionStep.Home -> DecisionHomePane(
                cap = cap,
                overview = overview,
                ui = ui,
                actions = actions,
                onChange = { step = DecisionStep.Providers },
            )
            DecisionStep.Providers -> DecisionProvidersPane(
                overview = overview,
                onBack = { step = DecisionStep.Home }.takeIf { configured },
                onChoose = ::choose,
            )
            DecisionStep.Form -> provider?.let { choice ->
                DecisionFormPane(
                    provider = choice,
                    overview = overview,
                    ui = ui,
                    values = form,
                    onValuesChange = { form = it },
                    onBack = { step = DecisionStep.Providers },
                    onProbe = actions.onProbe,
                    onSubmit = ::submit,
                    onRemove = { key ->
                        val clear = DecisionSetup.assignedBackend(overview)?.key == key
                        actions.onRemove(key, clear) { step = DecisionStep.Providers }
                    },
                )
            }
            DecisionStep.Consent -> pending?.let { request ->
                val consent = DecisionSetup.consentFor(request, overview, provider?.let(DecisionSetup::presetOf))
                    ?: DecisionSetup.Consent(request.model, request.assignment.substringBefore('/'))
                DecisionConsentPane(
                    consent = consent,
                    saving = ui.saving,
                    error = ui.error,
                    onAllow = { actions.onSave(request.withConsent(), saved) },
                    onBack = { step = DecisionStep.Form },
                )
            }
        }
    }
}

// --- Step 1: the assigned model ---

@Composable
private fun DecisionHomePane(
    cap: CapabilityMeta,
    overview: ModelsOverview,
    ui: DecisionUiState,
    actions: DecisionActions,
    onChange: () -> Unit,
) {
    val c = OmTheme.colors
    Text(cap.title, style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
    Text(cap.description, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)

    val assignment = DecisionSetup.assignment(overview)
    val display = overview.assignmentDisplays[DecisionSetup.ROLE]
    val assigned = DecisionSetup.assignedBackend(overview)
    val verifyTarget = assigned?.value ?: DecisionSetup.assignedTypeSafeModel(overview)?.let { "typesafe/$it" }
    val unavailable = assignment?.available == false
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.bgSecondary, shape)
            .border(1.dp, (if (unavailable) c.warning else c.success).copy(alpha = 0.45f), shape)
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            BackendBrandIcon(key = display?.providerId?.takeIf { it.isNotBlank() } ?: "http", size = 24.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Assigned model", style = MaterialTheme.typography.labelSmall, color = c.textMuted)
                MiddleEllipsisText(
                    text = display?.modelName?.takeIf { it.isNotBlank() } ?: assignment?.model.orEmpty(),
                    style = MaterialTheme.typography.titleSmall,
                    color = c.textPrimary,
                    modifier = Modifier.fillMaxWidth(),
                )
                val where = assigned?.backend?.let(DecisionSetup::where)
                Text(
                    listOfNotNull(display?.providerLabel?.takeIf { it.isNotBlank() }, where).joinToString(" · "),
                    style = MaterialTheme.typography.labelSmall,
                    color = c.textSecondary,
                    maxLines = 1,
                )
            }
            Icon(
                if (unavailable) Icons.Default.Error else Icons.Default.CheckCircle,
                contentDescription = if (unavailable) "Model unavailable" else "Model available",
                tint = if (unavailable) c.warning else c.success,
                modifier = Modifier.size(20.dp),
            )
        }
        assignment?.reason?.takeIf { unavailable && it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = c.warning)
        }
        if (verifyTarget != null) {
            HorizontalDivider(color = c.textMuted.copy(alpha = 0.2f))
            VerifyLine(target = verifyTarget, state = ui.verify, onVerify = { actions.onVerify(verifyTarget) })
        }
    }

    if (assigned != null) {
        CalibrationSection(
            panel = DecisionSetup.calibrationPanel(assigned, ui.calibration),
            available = assignment?.available == true,
            error = ui.calibrationError,
            onCalibrate = actions.onCalibrate,
            onCancel = actions.onCancelCalibration,
        )
    }

    OutlinedButton(onClick = onChange, modifier = Modifier.fillMaxWidth()) {
        Text("Change provider or model")
    }
    TextButton(onClick = actions.onClear, modifier = Modifier.fillMaxWidth()) {
        Text("Clear assignment", color = c.danger)
    }
}

@Composable
private fun VerifyLine(target: String, state: VerifyState, onVerify: () -> Unit) {
    val c = OmTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            when {
                state is VerifyState.Running && state.assignment == target -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    OmSpinner(color = c.accent, modifier = Modifier.size(14.dp))
                    Text("Sending a test decision…", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                }
                state is VerifyState.Done && state.assignment == target -> Row(
                    verticalAlignment = Alignment.Top,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    val ok = state.result.ok
                    Icon(
                        if (ok) Icons.Default.Check else Icons.Outlined.WarningAmber,
                        contentDescription = null,
                        tint = if (ok) c.success else c.danger,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(
                        DecisionSetup.verifyText(state.result),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (ok) c.textPrimary else c.danger,
                        modifier = Modifier.testTag("decision-verify-result"),
                    )
                }
                else -> Text(
                    "Send one invented test decision to check the model answers.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
            }
        }
        TextButton(onClick = onVerify, enabled = !(state is VerifyState.Running && state.assignment == target)) {
            Text("Verify", color = c.accent, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun CalibrationSection(
    panel: CalibrationPanel,
    available: Boolean,
    error: String?,
    onCalibrate: () -> Unit,
    onCancel: () -> Unit,
) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(12.dp)
    val warn = panel is CalibrationPanel.Uncalibrated || panel is CalibrationPanel.Failed ||
        panel is CalibrationPanel.Cancelled
    Column(
        Modifier
            .fillMaxWidth()
            .background(if (warn) c.warning.copy(alpha = 0.08f) else c.bgSecondary, shape)
            .then(if (warn) Modifier.border(1.dp, c.warning.copy(alpha = 0.4f), shape) else Modifier)
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            if (warn) {
                Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = c.warning, modifier = Modifier.size(18.dp))
            }
            Text("Calibration", style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
        }
        when (panel) {
            CalibrationPanel.Uncalibrated -> {
                Text(DecisionSetup.UNCALIBRATED_WARNING, style = MaterialTheme.typography.bodySmall, color = c.textPrimary)
                CalibrationExplainer()
                CalibrateButton("Calibrate", available, onCalibrate)
            }
            is CalibrationPanel.Running -> {
                Text("Calibrating against Jev", style = MaterialTheme.typography.bodySmall, color = c.textPrimary)
                LinearProgressIndicator(
                    progress = { DecisionSetup.calibrationFraction(panel.status) },
                    modifier = Modifier.fillMaxWidth(),
                    color = c.accent,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        DecisionSetup.calibrationProgressText(panel.status),
                        style = MaterialTheme.typography.labelSmall,
                        color = c.textSecondary,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onCancel) { Text("Cancel", color = c.danger) }
                }
            }
            is CalibrationPanel.Calibrated -> {
                Text(
                    DecisionSetup.calibrationSummary(panel.calibration),
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textPrimary,
                )
                panel.note?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = c.warning) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onCalibrate, enabled = available) {
                        Text("Recalibrate", color = if (available) c.accent else c.textMuted)
                    }
                }
            }
            is CalibrationPanel.Failed -> {
                Text(panel.error, style = MaterialTheme.typography.bodySmall, color = c.danger)
                Text(DecisionSetup.UNCALIBRATED_WARNING, style = MaterialTheme.typography.bodySmall, color = c.textPrimary)
                CalibrateButton("Try again", available, onCalibrate)
            }
            CalibrationPanel.Cancelled -> {
                Text("Calibration cancelled.", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                Text(DecisionSetup.UNCALIBRATED_WARNING, style = MaterialTheme.typography.bodySmall, color = c.textPrimary)
                CalibrateButton("Calibrate", available, onCalibrate)
            }
        }
        error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = c.danger) }
    }
}

@Composable
private fun CalibrationExplainer() {
    Text(
        DecisionSetup.CALIBRATION_EXPLAINER,
        style = MaterialTheme.typography.labelSmall,
        color = OmTheme.colors.textSecondary,
    )
}

@Composable
private fun CalibrateButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = OmTheme.colors
    Button(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
    ) {
        Text(label, fontWeight = FontWeight.SemiBold)
    }
}

// --- Step 2: the provider ---

@Composable
private fun DecisionProvidersPane(
    overview: ModelsOverview,
    onBack: (() -> Unit)?,
    onChoose: (Provider) -> Unit,
) {
    val c = OmTheme.colors
    if (onBack != null) BackRow(onBack)
    Text("Choose a provider", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
    Text(
        "Run a decision model on the gateway host, or use a hosted API.",
        style = MaterialTheme.typography.bodySmall,
        color = c.textSecondary,
    )
    val groups = DecisionSetup.providerGroups(overview)
    if (groups.existing.isNotEmpty()) {
        FlatSection("Your backends") {
            groups.existing.forEach { ProviderRow(it, overview, onChoose) }
        }
    }
    FlatSection("Local") {
        groups.local.forEach { ProviderRow(it, overview, onChoose) }
    }
    if (groups.cloud.isNotEmpty()) {
        FlatSection("Cloud") {
            groups.cloud.forEach { ProviderRow(it, overview, onChoose) }
        }
    }
}

@Composable
private fun ProviderRow(provider: Provider, overview: ModelsOverview, onChoose: (Provider) -> Unit) {
    val c = OmTheme.colors
    val current = DecisionSetup.isCurrent(provider, overview)
    val subtitle = when (provider) {
        is Provider.Existing -> listOfNotNull(provider.preset?.name, DecisionSetup.where(provider.backend)).joinToString(" · ")
        is Provider.Preset -> if (provider.preset.isLocal) {
            DecisionSetup.localPlace(provider.preset.url)
        } else {
            val count = provider.preset.models.size
            "$count model${if (count == 1) "" else "s"}"
        }
        Provider.Custom -> "Any System One server, by URL"
    }
    Row(
        Modifier
            .fillMaxWidth()
            .testTag("decision-provider-${(provider as? Provider.Existing)?.key ?: DecisionSetup.brandId(provider)}")
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .clickable { onChoose(provider) }
            .padding(horizontal = OmSpacing.md, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        BackendBrandIcon(key = DecisionSetup.brandId(provider), size = 22.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    provider.title,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    maxLines = 1,
                )
                if ((provider as? Provider.Preset)?.preset?.isTypeSafe == true) Pill("REFERENCE", c.accent)
            }
            MiddleEllipsisText(
                text = subtitle,
                style = MaterialTheme.typography.labelSmall,
                color = c.textMuted,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (current) {
            Icon(Icons.Default.CheckCircle, contentDescription = "Current", tint = c.success, modifier = Modifier.size(18.dp))
        } else {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(16.dp))
        }
    }
}

// --- Step 3: the provider's form ---

@Composable
private fun DecisionFormPane(
    provider: Provider,
    overview: ModelsOverview,
    ui: DecisionUiState,
    values: DecisionFormValues,
    onValuesChange: (DecisionFormValues) -> Unit,
    onBack: () -> Unit,
    onProbe: (String) -> Unit,
    onSubmit: (SaveRequest) -> Unit,
    onRemove: (String) -> Unit,
) {
    val c = OmTheme.colors
    val preset = DecisionSetup.presetOf(provider)
    val existing = provider as? Provider.Existing
    val typesafe = preset?.isTypeSafe == true && existing == null
    // A new backend from a preset whose URL has `{param}` placeholders asks for each value.
    val paramsPreset = preset?.takeIf { existing == null && it.urlParams.isNotEmpty() }
    val askParams = paramsPreset != null
    val askUrl = !typesafe && !askParams && (preset == null || preset.isLocal)
    val keyRequired = DecisionSetup.keyRequired(provider, overview, ui.typesafeKey)
    val keyStored = DecisionSetup.keyStored(provider, overview, ui.typesafeKey)
    val keyUnknown = (DecisionSetup.typesafeKeyFor(overview, ui.typesafeKey) as? DecisionSetup.KeyState.Unknown)
        ?.takeIf { typesafe }
    var confirmRemove by remember { mutableStateOf(false) }

    if (existing != null && DecisionSetup.canProbe(provider)) {
        LaunchedEffect(existing.key) { onProbe(existing.key) }
    }

    BackRow(onBack)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        BackendBrandIcon(key = DecisionSetup.brandId(provider), size = 28.dp)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(provider.title, style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
            Text(
                when {
                    existing != null -> listOfNotNull(preset?.name, DecisionSetup.where(existing.backend)).joinToString(" · ")
                    preset == null -> "A server you run"
                    preset.isLocal -> DecisionSetup.localPlace(preset.url)
                    else -> "Hosted API"
                },
                style = MaterialTheme.typography.labelSmall,
                color = c.textMuted,
            )
        }
    }
    preset?.note?.takeIf { existing == null && it.isNotBlank() }?.let {
        Text(it, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
    }

    val nameError = if (existing == null && !typesafe) {
        values.name.takeIf { it.isNotEmpty() }?.let { DecisionSetup.nameError(it, overview) }
    } else {
        null
    }
    if (existing == null && !typesafe) {
        Field("Name", "my-decision-server", values.name, { onValuesChange(values.copy(name = it)) }, error = nameError,
            hint = "How the assignment names this backend.")
    }

    val filled = paramsPreset?.let { DecisionSetup.fillUrl(it, values.urlParams) }
    if (paramsPreset != null) {
        paramsPreset.urlParams.forEach { param ->
            Field(
                param.label,
                param.placeholder,
                values.urlParams[param.key].orEmpty(),
                { onValuesChange(values.copy(urlParams = values.urlParams + (param.key to it))) },
            )
        }
        (filled as? DecisionSetup.FilledUrl.Ok)?.let {
            MiddleEllipsisText(
                text = it.url,
                style = MaterialTheme.typography.labelSmall,
                color = c.textMuted,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
    if (askUrl) {
        Field(
            "URL",
            preset?.url ?: "http://127.0.0.1:8080/v1/systemone",
            values.url,
            { onValuesChange(values.copy(url = it)) },
            hint = "The server's decision endpoint.",
        )
    }

    val showKey = typesafe || keyRequired || keyStored || preset == null || preset.isLocal || preset.keyRequired
    if (showKey) {
        val label = if (keyRequired) "API key" else "API key (optional)"
        val placeholder = when {
            keyStored -> "Saved · leave blank to keep it"
            keyRequired -> "Paste your key"
            keyUnknown != null -> "Leave blank to keep a saved key"
            else -> "Leave blank for a server without a key"
        }
        Field(label, placeholder, values.apiKey, { onValuesChange(values.copy(apiKey = it)) }, password = true)
        keyUnknown?.let {
            Text(
                "Could not check for a saved TypeSafe key: ${it.reason}",
                style = MaterialTheme.typography.labelSmall,
                color = c.warning,
            )
        }
        existing?.backend?.apiKeySecretError?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = c.warning)
        }
        val keyLink = preset?.keyUrl?.takeIf { it.isNotBlank() }
        if (preset != null && keyLink != null) {
            val uriHandler = LocalUriHandler.current
            Text(
                "Get a ${preset.name} key",
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = c.accent,
                modifier = Modifier.clickable { runCatching { uriHandler.openUri(keyLink) } },
            )
        }
    }

    val probe = existing?.let { ui.probes[it.key] }
    val probed = ((probe as? ProbeState.Done)?.result?.models).orEmpty()
    ModelField(
        value = values.model,
        suggestions = DecisionSetup.modelSuggestions(preset, probed),
        probe = probe,
        onValueChange = { onValuesChange(values.copy(model = it)) },
    )

    ui.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.danger) }

    val url = when {
        askParams -> (filled as? DecisionSetup.FilledUrl.Ok)?.url
        askUrl -> values.url.trim().takeIf { it.startsWith("http://") || it.startsWith("https://") }
        existing != null -> existing.backend.url
        else -> preset?.url
    }
    val canSave = !ui.saving && values.model.isNotBlank() && nameError == null &&
        (typesafe || existing != null || values.name.isNotBlank()) &&
        (typesafe || url != null) && (!keyRequired || values.apiKey.isNotBlank())
    Button(
        onClick = {
            val request = if (typesafe) {
                SaveRequest.TypeSafe(model = values.model.trim(), apiKey = values.apiKey.trim().ifEmpty { null })
            } else {
                if (existing != null) {
                    DecisionSetup.existingBackendSave(existing, url.orEmpty(), values.apiKey, values.model)
                } else {
                    DecisionSetup.newBackendSave(values.name, preset, url.orEmpty(), values.apiKey, values.model)
                }
            }
            onSubmit(request)
        },
        enabled = canSave,
        modifier = Modifier.fillMaxWidth().height(48.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
    ) {
        if (ui.saving) OmSpinner(color = Color.White, modifier = Modifier.size(16.dp))
        else Text("Save and verify", fontWeight = FontWeight.SemiBold)
    }

    if (existing != null) {
        TextButton(onClick = { confirmRemove = true }, enabled = !ui.saving, modifier = Modifier.fillMaxWidth()) {
            Text("Remove this backend", color = c.danger)
        }
    }
    if (confirmRemove && existing != null) {
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            title = { Text("Remove ${existing.key}?") },
            text = {
                Text(
                    if (DecisionSetup.assignedBackend(overview)?.key == existing.key) {
                        "The Decision model uses this backend, so it will be turned off. Its stored key and calibrations are deleted."
                    } else {
                        "Its stored key and calibrations are deleted."
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmRemove = false
                    onRemove(existing.key)
                }) { Text("Remove", color = c.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text("Cancel") } },
            containerColor = c.bgSecondary,
        )
    }
}

/** The model id: free text, with the provider's and the server's models offered below. */
@Composable
private fun ModelField(
    value: String,
    suggestions: List<DecisionSetup.ModelSuggestion>,
    probe: ProbeState?,
    onValueChange: (String) -> Unit,
) {
    val c = OmTheme.colors
    Field("Model", suggestions.firstOrNull()?.option?.id ?: "model-id", value, onValueChange)
    when (probe) {
        ProbeState.Running -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OmSpinner(color = c.accent, modifier = Modifier.size(12.dp))
            Text("Listing the server's models…", style = MaterialTheme.typography.labelSmall, color = c.textSecondary)
        }
        is ProbeState.Done -> when {
            !probe.result.ok -> Text(
                probe.result.reason ?: "The server did not list its models.",
                style = MaterialTheme.typography.labelSmall,
                color = c.warning,
            )
            probe.result.listed && probe.result.models.isEmpty() ->
                Text("The server lists no models yet.", style = MaterialTheme.typography.labelSmall, color = c.textSecondary)
            else -> Unit
        }
        null -> Unit
    }
    val query = value.trim()
    // A picked suggestion keeps the whole list on screen, so another can be picked instead.
    val picked = suggestions.any { it.option.id == query }
    val shown = suggestions.filter { query.isEmpty() || picked || it.option.id.contains(query, ignoreCase = true) }
    if (shown.isEmpty()) return
    Column(
        Modifier.fillMaxWidth().background(c.bgSecondary, RoundedCornerShape(12.dp)),
    ) {
        shown.take(MAX_SUGGESTIONS).forEachIndexed { index, suggestion ->
            if (index > 0) HorizontalDivider(color = c.textMuted.copy(alpha = 0.15f))
            val selected = suggestion.option.id == query
            Row(
                Modifier
                    .fillMaxWidth()
                    .testTag("decision-model-${suggestion.option.id}")
                    .clickable { onValueChange(suggestion.option.id) }
                    .padding(horizontal = OmSpacing.md, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    MiddleEllipsisText(
                        text = suggestion.option.id,
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.textPrimary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    val hint = DecisionSetup.modelHint(suggestion.option)
                    if (hint.isNotEmpty()) {
                        Text(hint, style = MaterialTheme.typography.labelSmall, color = c.textMuted, maxLines = 1)
                    }
                }
                if (suggestion.installed) Pill("ON SERVER", c.success)
                if (selected) Icon(Icons.Default.Check, contentDescription = "Selected", tint = c.accent, modifier = Modifier.size(16.dp))
            }
        }
        if (shown.size > MAX_SUGGESTIONS) {
            Text(
                "${shown.size - MAX_SUGGESTIONS} more · type to narrow the list",
                style = MaterialTheme.typography.labelSmall,
                color = c.textMuted,
                modifier = Modifier.padding(horizontal = OmSpacing.md, vertical = 8.dp),
            )
        }
    }
}

private const val MAX_SUGGESTIONS = 6

// --- Step 4: the cloud-inference question ---

@Composable
private fun DecisionConsentPane(
    consent: DecisionSetup.Consent,
    saving: Boolean,
    error: String?,
    onAllow: () -> Unit,
    onBack: () -> Unit,
) {
    val c = OmTheme.colors
    BackRow(onBack)
    Text("Enable cloud inference?", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
    DecisionSetup.consentBody(consent).forEach {
        Text(it, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
    }
    error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.danger) }
    Button(
        onClick = onAllow,
        enabled = !saving,
        modifier = Modifier.fillMaxWidth().height(48.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
    ) {
        if (saving) OmSpinner(color = Color.White, modifier = Modifier.size(16.dp))
        else Text("Enable cloud inference and save", fontWeight = FontWeight.SemiBold)
    }
    TextButton(onClick = onBack, enabled = !saving, modifier = Modifier.fillMaxWidth()) {
        Text("Not now", color = c.textSecondary)
    }
}

// --- Shared pieces ---

@Composable
private fun BackRow(onBack: () -> Unit) {
    val c = OmTheme.colors
    Row(
        Modifier.clickable(onClick = onBack),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = null, tint = c.accent, modifier = Modifier.size(16.dp))
        Text("Back", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.accent)
    }
}

@Composable
private fun Pill(text: String, color: Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp, letterSpacing = 0.5.sp),
        fontWeight = FontWeight.SemiBold,
        color = color,
        modifier = Modifier
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(50))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

// --- previews / screenshot sample data (invented) ---

internal fun sampleDecisionPresets() = listOf(
    DecisionPresetView(
        id = "ollaya", name = "Ollaya", kind = "local", url = "http://127.0.0.1:11435/v1/systemone",
        note = "Runs open decision models on this machine. Pull a model with `ollaya pull <model>` first.",
        models = listOf(DecisionModelOption("kev", source = "preset"), DecisionModelOption("laya", source = "preset"), DecisionModelOption("d1", source = "preset")),
    ),
    DecisionPresetView(
        id = "ollama", name = "Ollama", kind = "local", url = "http://127.0.0.1:11434/v1/systemone",
        note = "Ollama 0.40 or later serves decision models. Pull a model with `ollama pull <model>` first.",
        models = listOf(DecisionModelOption("d3:4b", source = "preset"), DecisionModelOption("tev1:4b", source = "preset")),
    ),
    DecisionPresetView(
        id = "openrouter", name = "OpenRouter", kind = "cloud", url = "https://openrouter.ai/api/v1/systemone", modelsDevId = "openrouter",
        keyRequired = true, keyUrl = "https://openrouter.ai/keys", note = "One key for most hosted decision models.",
        models = listOf(
            DecisionModelOption("typesafe/jev-1.14", contextTokens = 32_000, inputCostPerMillion = 0.1, source = "models.dev"),
            DecisionModelOption("liquid/d1.1", contextTokens = 128_000, inputCostPerMillion = 0.02, source = "models.dev"),
        ),
    ),
    DecisionPresetView(
        id = "typesafe", name = "TypeSafe", kind = "cloud", url = "https://api.typesafe.ai/v1/systemone",
        keyRequired = true, builtIn = "typesafe", keyUrl = "https://console.typesafe.ai/keys",
        note = "Jev, the model every decision threshold was tuned on.",
        models = listOf(DecisionModelOption("jev-1.14.0", source = "preset"), DecisionModelOption("jev-1.13.0", source = "preset")),
    ),
    DecisionPresetView(
        id = "cloudflare", name = "Cloudflare Workers AI", kind = "cloud", modelsDevId = "cloudflare-workers-ai",
        url = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run", protocol = "workers-ai",
        keyRequired = true, keyUrl = "https://dash.cloudflare.com/profile/api-tokens",
        note = "Workers AI shortens long text to fit Clef's context without saying so.",
        urlParams = listOf(DecisionUrlParam("account", "Account ID", "0123456789abcdef0123456789abcdef")),
        models = listOf(
            DecisionModelOption("@cf/cloudflare/clef-flash", contextTokens = 128_000, inputCostPerMillion = 0.011, source = "preset"),
            DecisionModelOption("@cf/cloudflare/clef", contextTokens = 128_000, source = "preset"),
        ),
    ),
    DecisionPresetView(
        id = "perplexity", name = "Perplexity", kind = "cloud", url = "https://api.perplexity.ai/v1/decisions",
        keyRequired = true, keyUrl = "https://www.perplexity.ai/account/api/keys",
        models = listOf(DecisionModelOption("pplx-decider-flash-v1.2", source = "preset"), DecisionModelOption("pplx-decider-v1.2", source = "preset")),
    ),
)

/** A stored calibration of the sample `kev` model, fitted on an invented date. */
internal fun sampleDecisionCalibration() = DecisionCalibration(
    reference = "jev-worth/email-worth-v1/jev-1.13.0",
    fittedAt = "2026-11-08T10:00:00Z",
    samples = 296,
    agreement = 0.91,
    agreementBefore = 0.78,
    keeps = 0.95,
    keepsBefore = 0.81,
    skips = 0.88,
    skipsBefore = 0.9,
)

/**
 * The sample overview with decision presets, the Decision model on a local
 * Ollaya server's `kev`, calibrated or not.
 */
internal fun sampleDecisionOverview(calibrated: Boolean = false): ModelsOverview {
    val base = sampleModelsOverview()
    val backend = DecisionBackendStatus(
        preset = "ollaya",
        url = "http://127.0.0.1:11435/v1/systemone",
        onHost = true,
        calibrations = if (calibrated) mapOf("kev" to sampleDecisionCalibration()) else emptyMap(),
    )
    return base.copy(
        decisionPresets = sampleDecisionPresets(),
        assignmentDisplays = base.assignmentDisplays +
            (DecisionSetup.ROLE to ModelDisplay("ollaya", "Ollaya", "kev", available = true, configured = true)),
        inference = base.inference.copy(
            decisionBackends = mapOf("ollaya" to backend),
            assignments = base.inference.assignments + (
                DecisionSetup.ROLE to ResolvedAssignment(
                    "decision", available = true, model = "kev", backendKey = "ollaya",
                    preset = "ollaya", calibrated = calibrated, hasApiKey = false,
                )
            ),
        ),
    )
}

/** A calibration two fifths of the way through the sample reference set. */
internal fun sampleRunningCalibration() = DecisionCalibrationStatus(
    state = "running", assignment = "ollaya/kev", done = 120, total = 296, failed = 2,
    startedAt = "2026-11-10T09:00:00Z",
)
