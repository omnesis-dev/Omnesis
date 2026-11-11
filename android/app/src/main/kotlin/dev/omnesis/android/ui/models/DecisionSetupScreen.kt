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
import dev.omnesis.android.transport.dto.BackendDecisionStatus
import dev.omnesis.android.transport.dto.BackendStatus
import dev.omnesis.android.transport.dto.CapabilityMeta
import dev.omnesis.android.transport.dto.DecisionModelOption
import dev.omnesis.android.transport.dto.DecisionProbeBody
import dev.omnesis.android.transport.dto.DecisionUrlParam
import dev.omnesis.android.transport.dto.ModelDisplay
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.dto.ProviderDecisionPreset
import dev.omnesis.android.transport.dto.ProviderPreset
import dev.omnesis.android.transport.dto.ResolvedAssignment
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
    val onProbe: (ProbeTarget) -> Unit = {},
    val onRemove: (DecisionSetup.Removal, onRemoved: () -> Unit) -> Unit = { _, _ -> },
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
 * its test decision; the provider picker (the operator's
 * backends, TypeSafe built in, providers to add); the provider's form; and,
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
            name = when (choice) {
                is Provider.Existing -> choice.key
                is Provider.Enable -> choice.key
                else -> DecisionSetup.defaultName(DecisionSetup.presetOf(choice), overview)
            },
            url = when (choice) {
                is Provider.Existing -> choice.decision.url
                is Provider.Enable -> choice.decision.url.takeIf { choice.decision.urlParams.isEmpty() }.orEmpty()
                is Provider.Preset -> choice.preset.decision?.takeIf { it.urlParams.isEmpty() }?.url.orEmpty()
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
                    onRemove = { removal -> actions.onRemove(removal) { step = DecisionStep.Providers } },
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
                val where = assigned?.decision?.let(DecisionSetup::where)
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
    if (groups.yours.isNotEmpty()) {
        FlatSection("Your backends") {
            groups.yours.forEach { ProviderRow(it, overview, onChoose) }
        }
    }
    if (groups.builtIn.isNotEmpty()) {
        FlatSection("Built in") {
            groups.builtIn.forEach { ProviderRow(it, overview, onChoose) }
        }
    }
    FlatSection("Add a provider") {
        groups.add.forEach { ProviderRow(it, overview, onChoose) }
    }
}

@Composable
private fun ProviderRow(provider: Provider, overview: ModelsOverview, onChoose: (Provider) -> Unit) {
    val c = OmTheme.colors
    val current = DecisionSetup.isCurrent(provider, overview)
    val tag = when (provider) {
        is Provider.Existing -> provider.key
        is Provider.Enable -> provider.key
        else -> DecisionSetup.brandId(provider)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .testTag("decision-provider-$tag")
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
                text = DecisionSetup.subtitle(provider),
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
    onProbe: (ProbeTarget) -> Unit,
    onSubmit: (SaveRequest) -> Unit,
    onRemove: (DecisionSetup.Removal) -> Unit,
) {
    val c = OmTheme.colors
    val preset = DecisionSetup.presetOf(provider)
    val wire = preset?.decision
    val existing = provider as? Provider.Existing
    val enable = provider as? Provider.Enable
    val typesafe = preset?.isTypeSafe == true && provider is Provider.Preset
    // A new backend, made from a preset or from "Other server".
    val isNew = (provider is Provider.Preset && !typesafe) || provider is Provider.Custom
    // A decision URL with `{param}` placeholders asks for each value.
    val paramsWire = wire?.takeIf { (isNew || enable != null) && it.urlParams.isNotEmpty() }
    val askParams = paramsWire != null
    val askUrl = !typesafe && !askParams && enable == null && (preset == null || preset.isLocal)
    val keyRequired = DecisionSetup.keyRequired(provider, overview, ui.typesafeKey)
    val keyStored = DecisionSetup.keyStored(provider, overview, ui.typesafeKey)
    val keyUnknown = (DecisionSetup.typesafeKeyFor(overview, ui.typesafeKey) as? DecisionSetup.KeyState.Unknown)
        ?.takeIf { typesafe }
    var confirmRemove by remember { mutableStateOf(false) }

    val filled = paramsWire?.let { DecisionSetup.fillUrl(it, values.urlParams) }
    val typedUrl = values.url.trim().takeIf { it.startsWith("http://") || it.startsWith("https://") }
    val url = when {
        askParams -> (filled as? DecisionSetup.FilledUrl.Ok)?.url
        askUrl -> typedUrl
        existing != null -> existing.decision.url
        else -> wire?.url
    }

    // A server of the operator's own lists its installed models.
    val canProbe = DecisionSetup.canProbe(provider) && !typesafe
    val probeTarget: ProbeTarget? = when {
        !canProbe -> null
        existing != null -> ProbeTarget.Saved(existing.key)
        url != null -> ProbeTarget.Unsaved(
            DecisionProbeBody(
                url = url,
                preset = preset?.id,
                protocol = wire?.protocol,
                auth = wire?.auth,
                apiKey = values.apiKey.trim().ifEmpty { null },
            ),
        )
        else -> null
    }
    if (existing != null && canProbe) {
        LaunchedEffect(existing.key) { onProbe(ProbeTarget.Saved(existing.key)) }
    }
    val newLocalPreset = preset?.takeIf { isNew && it.isLocal }
    if (newLocalPreset != null) {
        // A local preset's server is listed once, at its default address.
        LaunchedEffect(newLocalPreset.id) { probeTarget?.let(onProbe) }
    }

    BackRow(onBack)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        BackendBrandIcon(key = DecisionSetup.brandId(provider), size = 28.dp)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(provider.title, style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
            Text(
                when {
                    existing != null -> listOfNotNull(preset?.name, DecisionSetup.where(existing.decision)).joinToString(" · ")
                    enable != null -> "${enable.preset.name} · adds its decision models"
                    preset == null -> "A server you run"
                    preset.isLocal -> DecisionSetup.localPlace(wire?.url.orEmpty())
                    else -> "Hosted API"
                },
                style = MaterialTheme.typography.labelSmall,
                color = c.textMuted,
            )
        }
    }
    wire?.note?.takeIf { existing == null && it.isNotBlank() }?.let {
        Text(it, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
    }
    val bothApis = preset?.takeIf { isNew && it.hasOpenAiApi }
    when {
        enable != null && enable.backend.hasApiKey == true -> Text(
            "Uses the API key this backend already has. Its other models stay as they are.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
        )
        bothApis != null -> Text(
            "Adds ${bothApis.name} as one backend with one key, for its OpenAI-compatible models and its decision models.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
        )
    }

    val nameError = if (isNew) values.name.takeIf { it.isNotEmpty() }?.let { DecisionSetup.nameError(it, overview) } else null
    if (isNew) {
        Field("Name", "my-decision-server", values.name, { onValuesChange(values.copy(name = it)) }, error = nameError,
            hint = "How the assignment names this backend.")
    }

    if (paramsWire != null) {
        paramsWire.urlParams.forEach { param ->
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
            wire?.url ?: "http://127.0.0.1:8080/v1/systemone",
            values.url,
            { onValuesChange(values.copy(url = it)) },
            hint = "The server's decision endpoint.",
        )
    }

    val showKey = if (enable != null) {
        keyRequired
    } else {
        typesafe || keyRequired || keyStored || preset == null || preset.isLocal || wire?.keyRequired == true
    }
    if (showKey) {
        val label = if (keyRequired) "API key" else "API key (optional)"
        val placeholder = when {
            keyStored -> "Saved · leave blank to keep it"
            keyRequired -> "Paste your key"
            keyUnknown != null -> "Leave blank to keep a saved key"
            else -> "Leave blank for a server without a key"
        }
        val hint = "Also used by this backend's OpenAI-compatible models."
            .takeIf { (existing?.backend ?: enable?.backend)?.hasOpenAiApi == true }
        Field(label, placeholder, values.apiKey, { onValuesChange(values.copy(apiKey = it)) }, password = true, hint = hint)
        keyUnknown?.let {
            Text(
                "Could not check for a saved TypeSafe key: ${it.reason}",
                style = MaterialTheme.typography.labelSmall,
                color = c.warning,
            )
        }
        existing?.decision?.apiKeySecretError?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = c.warning)
        }
        val keyLink = wire?.keyUrl?.takeIf { it.isNotBlank() }
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

    val probe = probeTarget?.let { ui.probes[it.id] }
    val probed = ((probe as? ProbeState.Done)?.result?.models).orEmpty()
    ModelField(
        value = values.model,
        suggestions = DecisionSetup.modelSuggestions(wire, probed),
        probe = probe,
        onValueChange = { onValuesChange(values.copy(model = it)) },
    )
    if (existing == null && probeTarget != null && probe != ProbeState.Running) {
        TextButton(onClick = { onProbe(probeTarget) }) {
            Text("List the server's models", color = c.accent, fontWeight = FontWeight.SemiBold)
        }
    }

    ui.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.danger) }

    val canSave = !ui.saving && values.model.isNotBlank() && nameError == null &&
        (!isNew || values.name.isNotBlank()) &&
        (typesafe || url != null) && (!keyRequired || values.apiKey.isNotBlank())
    Button(
        onClick = {
            val request = when {
                typesafe -> SaveRequest.TypeSafe(model = values.model.trim(), apiKey = values.apiKey.trim().ifEmpty { null })
                existing != null -> DecisionSetup.existingBackendSave(existing, url.orEmpty(), values.apiKey, values.model)
                enable != null -> DecisionSetup.enableSave(enable, url.orEmpty(), values.apiKey, values.model)
                else -> DecisionSetup.newBackendSave(values.name, preset, url.orEmpty(), values.apiKey, values.model)
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
        val removal = DecisionSetup.removalFor(existing, overview)
        TextButton(onClick = { confirmRemove = true }, enabled = !ui.saving, modifier = Modifier.fillMaxWidth()) {
            Text(if (removal.wholeBackend) "Remove this backend" else "Stop using it for decision models", color = c.danger)
        }
        if (confirmRemove) {
            val turnedOff = "The Decision model uses this backend, so it will be turned off. "
                .takeIf { removal.clearAssignment }.orEmpty()
            AlertDialog(
                onDismissRequest = { confirmRemove = false },
                title = {
                    Text(if (removal.wholeBackend) "Remove ${existing.key}?" else "Stop decision models on ${existing.key}?")
                },
                text = {
                    Text(
                        if (removal.wholeBackend) {
                            "${turnedOff}Its stored key is deleted."
                        } else {
                            "${turnedOff}Its OpenAI-compatible models and key stay."
                        },
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        confirmRemove = false
                        onRemove(removal)
                    }) { Text(if (removal.wholeBackend) "Remove" else "Stop", color = c.danger) }
                },
                dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text("Cancel") } },
                containerColor = c.bgSecondary,
            )
        }
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

/** A decision API with the given wire details; the sample presets below build theirs from it. */
private fun sampleWire(
    url: String,
    models: List<DecisionModelOption>,
    keyRequired: Boolean = true,
    protocol: String = "systemone",
    keyUrl: String? = null,
    note: String? = null,
    urlParams: List<DecisionUrlParam> = emptyList(),
) = ProviderDecisionPreset(
    url = url, protocol = protocol, keyRequired = keyRequired, keyUrl = keyUrl, note = note, urlParams = urlParams, models = models,
)

private fun presetModels(vararg ids: String) = ids.map { DecisionModelOption(it, source = "preset") }

/**
 * Presets with a decision API: servers on this machine, providers that serve
 * OpenAI-compatible and decision models with one key, TypeSafe built in, and
 * decision-only hosted APIs.
 */
internal fun sampleDecisionPresets() = listOf(
    ProviderPreset(
        id = "ollaya", name = "Ollaya", kind = "local", capabilities = listOf("decision"),
        decision = sampleWire(
            "http://127.0.0.1:11435/v1/systemone", presetModels("kev", "laya", "d1"), keyRequired = false,
            note = "Runs open decision models on this machine. Pull a model with `ollaya pull <model>` first.",
        ),
    ),
    ProviderPreset(
        id = "ollama", name = "Ollama", kind = "local", capabilities = listOf("decision"),
        decision = sampleWire(
            "http://127.0.0.1:11434/v1/systemone", presetModels("d3:4b", "tev1:4b"), keyRequired = false,
            note = "Ollama serves decision models too. Pull a model with `ollama pull <model>` first.",
        ),
    ),
    ProviderPreset(
        id = "fireworks", name = "Fireworks AI", kind = "cloud", modelsDevId = "fireworks-ai",
        defaultUrl = "https://api.fireworks.ai/inference", capabilities = listOf("agent", "embed", "decision"),
        decision = sampleWire(
            "https://api.fireworks.ai/inference/v1/systemone", presetModels("accounts/fireworks/models/rune"),
            keyUrl = "https://app.fireworks.ai/settings/users/api-keys",
        ),
    ),
    ProviderPreset(
        id = "openrouter", name = "OpenRouter", kind = "cloud", defaultUrl = "https://openrouter.ai/api",
        capabilities = listOf("agent", "decision"),
        decision = sampleWire(
            "https://openrouter.ai/api/v1/systemone",
            listOf(
                DecisionModelOption("typesafe/jev-1.14", contextTokens = 32_000, inputCostPerMillion = 0.1, source = "models.dev"),
                DecisionModelOption("liquid/d1.1", contextTokens = 128_000, inputCostPerMillion = 0.02, source = "models.dev"),
            ),
            keyUrl = "https://openrouter.ai/keys", note = "One key for most hosted decision models.",
        ).copy(modelsDevId = "openrouter"),
    ),
    ProviderPreset(
        id = "typesafe", name = "TypeSafe", kind = "cloud", builtIn = "typesafe", capabilities = listOf("decision"),
        decision = sampleWire(
            "https://api.typesafe.ai/v1/systemone", presetModels("jev-1.14.0", "jev-1.13.0"),
            keyUrl = "https://console.typesafe.ai/keys", note = "Jev, the model every decision threshold was tuned on.",
        ),
    ),
    ProviderPreset(
        id = "cloudflare", name = "Cloudflare Workers AI", kind = "cloud", capabilities = listOf("decision"),
        decision = sampleWire(
            "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run",
            listOf(
                DecisionModelOption("@cf/cloudflare/clef-flash", contextTokens = 128_000, inputCostPerMillion = 0.011, source = "preset"),
                DecisionModelOption("@cf/cloudflare/clef", contextTokens = 128_000, source = "preset"),
            ),
            protocol = "workers-ai", keyUrl = "https://dash.cloudflare.com/profile/api-tokens",
            note = "Workers AI shortens long text to fit Clef's context without saying so.",
            urlParams = listOf(DecisionUrlParam("account", "Account ID", "0123456789abcdef0123456789abcdef")),
        ).copy(modelsDevId = "cloudflare-workers-ai"),
    ),
    ProviderPreset(
        id = "perplexity", name = "Perplexity", kind = "cloud", capabilities = listOf("decision"),
        decision = sampleWire(
            "https://api.perplexity.ai/v1/decisions", presetModels("pplx-decider-flash-v1.2", "pplx-decider-v1.2"),
            keyUrl = "https://www.perplexity.ai/account/api/keys",
        ),
    ),
)

/**
 * The sample overview with decision presets, the Decision model on a local
 * Ollaya server's `kev` (a backend with only a decision API), and a Fireworks backend set up for chat whose preset also offers
 * decision models.
 */
internal fun sampleDecisionOverview(): ModelsOverview {
    val base = sampleModelsOverview()
    val ollaya = BackendStatus(
        type = "http",
        status = "ok",
        hasApiKey = false,
        preset = "ollaya",
        decision = BackendDecisionStatus(
            url = "http://127.0.0.1:11435/v1/systemone",
            onHost = true,
        ),
    )
    val fireworks = BackendStatus(
        type = "http",
        status = "ok",
        url = "https://api.fireworks.ai/inference",
        models = listOf("accounts/fireworks/models/example-chat"),
        modelRoles = mapOf("accounts/fireworks/models/example-chat" to listOf("agent")),
        hasApiKey = true,
        preset = "fireworks",
    )
    return base.copy(
        presets = base.presets + sampleDecisionPresets().filter { it.hasOpenAiApi },
        decisionProviders = sampleDecisionPresets().filter { !it.hasOpenAiApi },
        assignmentDisplays = base.assignmentDisplays +
            (DecisionSetup.ROLE to ModelDisplay("ollaya", "Ollaya", "kev", available = true, configured = true)),
        inference = base.inference.copy(
            backends = base.inference.backends + mapOf("ollaya" to ollaya, "fireworks" to fireworks),
            assignments = base.inference.assignments + (
                DecisionSetup.ROLE to ResolvedAssignment(
                    "decision", available = true, model = "kev", backendKey = "ollaya",
                    preset = "ollaya", hasApiKey = false,
                )
            ),
        ),
    )
}
