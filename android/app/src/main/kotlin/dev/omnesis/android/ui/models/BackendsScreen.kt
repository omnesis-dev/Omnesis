// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.MiddleEllipsisText
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.BackendBrandIcon
import dev.omnesis.android.designsystem.components.ProviderIcon
import dev.omnesis.android.designsystem.components.ProviderLogos
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.BackendStatus
import dev.omnesis.android.transport.dto.CodexBackendStatus
import dev.omnesis.android.transport.dto.CodexLoginFlow
import dev.omnesis.android.transport.dto.CodexModelStatus
import dev.omnesis.android.transport.dto.CredentialSpec
import dev.omnesis.android.transport.dto.CredentialField
import dev.omnesis.android.transport.dto.InferenceOverview
import dev.omnesis.android.transport.dto.ModelCredentialEntry
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.dto.ProviderPreset
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.Loadable

/**
 * HTTP-backend + model-provider-credential management — mirrors the iOS
 * `BackendsView` and the portal's Backends page (`models.js` +
 * `model-config.js`), which manages both. Lists the gateway's configured HTTP
 * inference backends (any OpenAI-compatible server), each a collapsed summary
 * card (icon, key, URL, status, meta) with a Test (re-probe) and Remove
 * affordance — tap a card to open its detail, where the per-(model, role)
 * "Verify capabilities" rows live. Below them the model-provider credential rows
 * (e.g. the Anthropic API key) with a Set / Clear affordance. Once a backend is
 * reachable (or a provider key is set), its role-matching models show up in the
 * per-capability assign picker.
 *
 * Protocol (exactly the portal's, no gateway change): backends ride
 * `GET /admin/models` + `PATCH /admin/config` + `POST .../probe` (+ `.../verify`);
 * credentials ride `GET /admin/model-credentials` + `POST`/`DELETE .../:fileKey`.
 * API keys (the add-backend key and the provider credential values alike) are
 * write-only: sent on submit, never read back or rendered (the gateway only
 * surfaces a `hasApiKey` / `configured` bool).
 *
 * The backend list and the [BackendDetailScreen] share one [BackendsViewModel]
 * (scoped to the parent nav entry by the caller), so a verdict issued on the
 * detail survives navigating back to the list and forward again — verify never
 * mutates config, so there's no reload and no staleness.
 */
@Composable
fun BackendsScreen(
    onBack: () -> Unit,
    onOpenDetail: (String) -> Unit = {},
    onOpenSettings: () -> Unit = {},
    vm: BackendsViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val credentials by vm.credentials.collectAsStateWithLifecycle()
    val notice by vm.notice.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val probes by vm.probes.collectAsStateWithLifecycle()
    val codexLoginFlow by vm.codexLoginFlow.collectAsStateWithLifecycle()
    val logos by vm.logos.collectAsStateWithLifecycle()
    ProviderLogos(logos) { BackendsContent(
        state = state,
        credentials = credentials,
        notice = notice,
        busy = busy,
        probes = probes,
        codexLoginFlow = codexLoginFlow,
        onBack = onBack,
        onRetry = vm::load,
        onOpenSettings = onOpenSettings,
        onOpenDetail = onOpenDetail,
        onAdd = vm::add,
        onRemove = vm::remove,
        onTest = vm::probe,
        onCodexRefresh = vm::refreshCodex,
        onCodexStartLogin = vm::startCodexLogin,
        onCodexCheckLogin = vm::checkCodexLogin,
        onCodexCancelLogin = vm::cancelCodexLogin,
        onCodexRemove = vm::removeCodex,
        onSetCredentials = vm::setCredentials,
        onClearCredentials = vm::clearCredentials,
        onDismissNotice = vm::dismissNotice,
    ) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BackendsContent(
    state: Loadable<ModelsOverview>,
    credentials: List<ModelCredentialEntry> = emptyList(),
    notice: BackendsViewModel.Notice? = null,
    busy: Boolean = false,
    probes: Map<String, BackendsViewModel.ProbeState> = emptyMap(),
    codexLoginFlow: CodexLoginFlow? = null,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit = {},
    onOpenDetail: (String) -> Unit = {},
    onAdd: (String, String, String?, String?) -> Unit = { _, _, _, _ -> },
    onRemove: (String) -> Unit = {},
    onTest: (String) -> Unit = {},
    onCodexRefresh: () -> Unit = {},
    onCodexStartLogin: () -> Unit = {},
    onCodexCheckLogin: () -> Unit = {},
    onCodexCancelLogin: () -> Unit = {},
    onCodexRemove: () -> Unit = {},
    onSetCredentials: (String, Map<String, String>) -> Unit = { _, _ -> },
    onClearCredentials: (String) -> Unit = {},
    onDismissNotice: () -> Unit = {},
) {
    val c = OmTheme.colors
    var showAddSheet by remember { mutableStateOf(false) }
    var showCodexSheet by remember { mutableStateOf(false) }
    var removeConfirm by remember { mutableStateOf<String?>(null) }
    var removeCodexConfirm by remember { mutableStateOf(false) }
    var editingCredential by remember { mutableStateOf<ModelCredentialEntry?>(null) }
    var clearCredentialConfirm by remember { mutableStateOf<ModelCredentialEntry?>(null) }

    val overview = (state as? Loadable.Content)?.value
    val presets = overview?.presets ?: emptyList()
    val codex = overview?.inference?.codex

    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back", tint = c.textPrimary)
                    }
                },
                title = { Text("Backends", style = MaterialTheme.typography.titleMedium, color = c.textPrimary) },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.bgPrimary),
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().background(c.bgPrimary)) {
            when (state) {
                Loadable.Loading -> BackendsLoading()
                is Loadable.Error -> GatewayErrorView(
                    context = "load backends",
                    error = state.throwable,
                    onRetry = onRetry,
                    onOpenSettings = onOpenSettings,
                )
                is Loadable.Content -> BackendsList(
                    backends = ModelManagement.httpBackends(state.value),
                    codex = state.value.inference.codex,
                    credentials = credentials,
                    notice = notice,
                    busy = busy,
                    probes = probes,
                    onOpenDetail = onOpenDetail,
                    onAddTap = { showAddSheet = true },
                    onTest = onTest,
                    onRemoveTap = { removeConfirm = it },
                    onCodexManage = { showCodexSheet = true },
                    onCodexRefresh = onCodexRefresh,
                    onCodexRemoveTap = { removeCodexConfirm = true },
                    onSetCredentialTap = { editingCredential = it },
                    onClearCredentialTap = { clearCredentialConfirm = it },
                    onDismissNotice = onDismissNotice,
                )
            }
        }
    }

    if (showAddSheet) {
        AddBackendSheet(
            presets = presets,
            codex = codex,
            onAdd = { name, url, apiKey, prefix ->
                showAddSheet = false
                onAdd(name, url, apiKey, prefix)
            },
            onConfigureCodex = {
                showAddSheet = false
                showCodexSheet = true
            },
            onDismiss = { showAddSheet = false },
        )
    }

    if (showCodexSheet) {
        CodexSetupSheet(
            status = codex,
            flow = codexLoginFlow,
            busy = busy,
            onStartLogin = onCodexStartLogin,
            onCheckLogin = onCodexCheckLogin,
            onRefresh = onCodexRefresh,
            onCancelLogin = onCodexCancelLogin,
            onRemove = { removeCodexConfirm = true },
            onDismiss = { showCodexSheet = false },
        )
    }

    val editing = editingCredential
    if (editing != null) {
        SetCredentialSheet(
            entry = editing,
            onSave = { fields ->
                editingCredential = null
                onSetCredentials(editing.fileKey, fields)
            },
            onDismiss = { editingCredential = null },
        )
    }

    val pendingRemove = removeConfirm
    if (pendingRemove != null) {
        AlertDialog(
            onDismissRequest = { removeConfirm = null },
            containerColor = c.bgSecondary,
            title = { Text("Remove backend?", color = c.textPrimary) },
            text = {
                Text(
                    "Remove \"$pendingRemove\"? Any capability using this backend will become unavailable.",
                    color = c.textSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    removeConfirm = null
                    onRemove(pendingRemove)
                }) { Text("Remove", color = c.danger) }
            },
            dismissButton = {
                TextButton(onClick = { removeConfirm = null }) { Text("Cancel", color = c.textSecondary) }
            },
        )
    }

    if (removeCodexConfirm) {
        AlertDialog(
            onDismissRequest = { removeCodexConfirm = false },
            containerColor = c.bgSecondary,
            title = { Text("Remove Codex?", color = c.textPrimary) },
            text = { Text("Log out Codex on the gateway host and clear any Codex assignment.", color = c.textSecondary) },
            confirmButton = {
                TextButton(onClick = {
                    removeCodexConfirm = false
                    showCodexSheet = false
                    onCodexRemove()
                }) { Text("Remove", color = c.danger) }
            },
            dismissButton = {
                TextButton(onClick = { removeCodexConfirm = false }) { Text("Cancel", color = c.textSecondary) }
            },
        )
    }

    val pendingClear = clearCredentialConfirm
    if (pendingClear != null) {
        AlertDialog(
            onDismissRequest = { clearCredentialConfirm = null },
            containerColor = c.bgSecondary,
            title = { Text("Clear credentials?", color = c.textPrimary) },
            text = {
                Text(
                    "Clear the ${pendingClear.providerName} credentials? Any capability using ${pendingClear.providerName} will become unavailable.",
                    color = c.textSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    clearCredentialConfirm = null
                    onClearCredentials(pendingClear.fileKey)
                }) { Text("Clear", color = c.danger) }
            },
            dismissButton = {
                TextButton(onClick = { clearCredentialConfirm = null }) { Text("Cancel", color = c.textSecondary) }
            },
        )
    }
}

@Composable
private fun BackendsList(
    backends: List<ModelManagement.BackendRow>,
    codex: CodexBackendStatus?,
    credentials: List<ModelCredentialEntry>,
    notice: BackendsViewModel.Notice?,
    busy: Boolean,
    probes: Map<String, BackendsViewModel.ProbeState>,
    onOpenDetail: (String) -> Unit,
    onAddTap: () -> Unit,
    onTest: (String) -> Unit,
    onRemoveTap: (String) -> Unit,
    onCodexManage: () -> Unit,
    onCodexRefresh: () -> Unit,
    onCodexRemoveTap: () -> Unit,
    onSetCredentialTap: (ModelCredentialEntry) -> Unit,
    onClearCredentialTap: (ModelCredentialEntry) -> Unit,
    onDismissNotice: () -> Unit,
) {
    val c = OmTheme.colors
    Column(
        Modifier
            .verticalScroll(rememberScrollState())
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        if (notice != null) {
            NoticeBanner(notice, onDismissNotice)
        }
        // Inline tinted "Add backend" affordance — the only add entry point
        // (the redundant top-bar "+" was removed), so the primary action stays
        // reachable on an empty list.
        Row(
            Modifier
                .fillMaxWidth()
                .background(c.accent.copy(alpha = 0.10f), RoundedCornerShape(12.dp))
                .clickable(enabled = !busy, onClick = onAddTap)
                .padding(OmSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            Icon(Icons.Default.Add, contentDescription = null, tint = c.accent, modifier = Modifier.size(18.dp))
            Text("Add backend", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.accent)
        }

        if (codex?.configured == true) {
            FlatSection(title = "Codex") {
                CodexRowCard(
                    status = codex,
                    busy = busy,
                    onManage = onCodexManage,
                    onRefresh = onCodexRefresh,
                    onRemove = onCodexRemoveTap,
                )
            }
        }

        FlatSection(title = "HTTP backends") {
            if (backends.isEmpty()) {
                BackendsEmpty()
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                    backends.forEach { row ->
                        BackendRowCard(
                            row = row,
                            probe = probes[row.key],
                            busy = busy,
                            onOpen = { onOpenDetail(row.key) },
                            onTest = { onTest(row.key) },
                            onRemove = { onRemoveTap(row.key) },
                        )
                    }
                }
            }
        }

        if (credentials.isNotEmpty()) {
            FlatSection(title = "Provider credentials") {
                Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                    credentials.forEach { entry ->
                        CredentialRowCard(
                            entry = entry,
                            busy = busy,
                            onSet = { onSetCredentialTap(entry) },
                            onClear = { onClearCredentialTap(entry) },
                        )
                    }
                }
            }
        }

        Text(
            "Backends and provider keys are shared across every capability. After adding a backend, logging in to Codex, or setting a key, assign its models from the Models screen.",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Normal,
            color = c.textMuted,
            modifier = Modifier.padding(top = OmSpacing.sm),
        )
    }
}

@Composable
private fun CredentialRowCard(
    entry: ModelCredentialEntry,
    busy: Boolean,
    onSet: () -> Unit,
    onClear: () -> Unit,
) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            ProviderIcon(providerId = entry.providerType, size = 20.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(entry.providerName, style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
                    if (entry.configured) {
                        Text(
                            "CONFIGURED",
                            style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp, letterSpacing = 0.5.sp),
                            fontWeight = FontWeight.SemiBold,
                            color = c.success,
                            modifier = Modifier
                                .background(c.success.copy(alpha = 0.12f), RoundedCornerShape(50))
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                }
                Text(
                    if (entry.configured) "API key set" else "Not configured",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (entry.configured) c.textSecondary else c.textMuted,
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            OutlinedButton(
                onClick = onSet,
                enabled = !busy,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = c.accent),
            ) { Text(if (entry.configured) "Replace key" else "Set key", fontWeight = FontWeight.SemiBold) }
            if (entry.configured) {
                OutlinedButton(
                    onClick = onClear,
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = c.danger),
                ) { Text("Clear", fontWeight = FontWeight.SemiBold) }
            }
        }
    }
}

/**
 * One collapsed backend summary card: icon, key, URL, status badge, meta
 * ("N models · API key set"), plus Test + Remove. The whole header row is
 * tappable ([onOpen]) to push the backend detail, where the per-(model, role)
 * "Verify capabilities" section lives — Test / Remove stay on this card and so
 * aren't repeated there.
 */
@Composable
private fun BackendRowCard(
    row: ModelManagement.BackendRow,
    probe: BackendsViewModel.ProbeState?,
    busy: Boolean,
    onOpen: () -> Unit,
    onTest: () -> Unit,
    onRemove: () -> Unit,
) {
    val c = OmTheme.colors
    val probing = probe is BackendsViewModel.ProbeState.Probing
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = !busy, onClick = onOpen),
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            BackendBrandIcon(key = row.key, size = 20.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    MiddleEllipsisText(
                        text = row.key,
                        style = MaterialTheme.typography.titleSmall,
                        color = c.textPrimary,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    StatusBadge(row.status.status)
                }
                if (!row.status.url.isNullOrBlank()) {
                    MiddleEllipsisText(
                        text = row.status.url!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Text(backendMetaLine(row.status), style = MaterialTheme.typography.labelSmall, color = c.textMuted)
                ProbeResultLine(probe)
            }
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(16.dp),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            OutlinedButton(
                onClick = onTest,
                enabled = !busy && !probing,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = c.accent),
            ) { Text(if (probing) "Testing…" else "Test", fontWeight = FontWeight.SemiBold) }
            OutlinedButton(
                onClick = onRemove,
                enabled = !busy,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = c.danger),
            ) { Text("Remove", fontWeight = FontWeight.SemiBold) }
        }
    }
}

@Composable
private fun CodexRowCard(
    status: CodexBackendStatus,
    busy: Boolean,
    onManage: () -> Unit,
    onRefresh: () -> Unit,
    onRemove: () -> Unit,
) {
    val c = OmTheme.colors
    val probing = status.status == "probing"
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = !busy, onClick = onManage),
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            BackendBrandIcon(key = "codex", size = 20.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("Codex", style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
                    CodexStatusBadge(status)
                }
                Text(codexMetaLine(status), style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                // Bind to a local: `reason` is a property from another module
                // (transport.dto), which Kotlin won't smart-cast across the
                // null check.
                val reason = status.reason
                if (!reason.isNullOrBlank()) {
                    Text(reason, style = MaterialTheme.typography.labelSmall, color = c.warning, maxLines = 2)
                }
            }
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(16.dp),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            OutlinedButton(
                onClick = onRefresh,
                enabled = !busy && !probing,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = c.accent),
            ) { Text(if (probing) "Checking..." else "Check", fontWeight = FontWeight.SemiBold) }
            OutlinedButton(
                onClick = onRemove,
                enabled = !busy,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = c.danger),
            ) { Text("Remove", fontWeight = FontWeight.SemiBold) }
        }
    }
}

private fun codexMetaLine(status: CodexBackendStatus): String {
    val runtime = codexRuntimeMeta(status)
    if (status.loggedIn && status.status == "ok") {
        val count = status.models.size
        val base = "$count model${if (count == 1) "" else "s"}"
        return listOfNotNull(base, runtime).joinToString(" · ")
    }
    return listOfNotNull(
        if (status.configured) "OpenAI login needs attention" else "Not configured",
        runtime,
    ).joinToString(" · ")
}

private fun codexRuntimeMeta(status: CodexBackendStatus): String? {
    val runtime = status.runtime ?: return status.discovery
    val source = if (runtime.source == "managed") {
        runtime.packageVersion?.let { "@openai/codex $it" } ?: "managed"
    } else {
        "override"
    }
    return listOfNotNull(source, runtime.version?.let { "CLI $it" }, status.discovery).joinToString(", ")
}

@Composable
private fun CodexStatusBadge(status: CodexBackendStatus) {
    val c = OmTheme.colors
    val (text, color) = when {
        status.status == "ok" && status.loggedIn -> "CONNECTED" to c.success
        status.status == "probing" -> "PROBING" to c.warning
        status.configured -> "ATTENTION" to c.warning
        else -> "NOT CONFIGURED" to c.textMuted
    }
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

private fun backendMetaLine(status: BackendStatus): String {
    val count = status.models?.size ?: 0
    return buildString {
        append("$count model").append(if (count == 1) "" else "s")
        if (status.hasApiKey == true) append(" · API key set")
    }
}

@Composable
private fun ProbeResultLine(probe: BackendsViewModel.ProbeState?) {
    val c = OmTheme.colors
    val (text, color) = when (probe) {
        null -> return
        is BackendsViewModel.ProbeState.Probing -> "Testing…" to c.textMuted
        is BackendsViewModel.ProbeState.Ok ->
            "Reachable · ${probe.modelCount} model${if (probe.modelCount == 1) "" else "s"}" to c.success
        is BackendsViewModel.ProbeState.Reachable -> "No model list · ${probe.reason}" to c.warning
        is BackendsViewModel.ProbeState.Fail -> probe.reason to c.danger
    }
    Text(text, style = MaterialTheme.typography.labelSmall, color = color, maxLines = 2)
}

@Composable
private fun StatusBadge(status: String) {
    val c = OmTheme.colors
    val (text, color) = when (status) {
        "ok" -> "REACHABLE" to c.success
        // Host answered, but its model list couldn't be fetched — still usable
        // with a manually-assigned model id.
        "reachable" -> "NO MODEL LIST" to c.warning
        "unreachable" -> "UNREACHABLE" to c.danger
        "probing" -> "PROBING" to c.warning
        else -> return
    }
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

@Composable
private fun BackendsEmpty() {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("No HTTP backends configured.", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
        Text(
            "Add one to point Omnesis at any OpenAI-compatible server (a local vLLM/Ollama, or a cloud provider).",
            style = MaterialTheme.typography.labelSmall,
            color = c.textMuted,
        )
    }
}

@Composable
private fun NoticeBanner(notice: BackendsViewModel.Notice, onDismiss: () -> Unit) {
    val c = OmTheme.colors
    val color = if (notice.ok) c.success else c.danger
    Text(
        notice.text,
        style = MaterialTheme.typography.bodySmall,
        color = color,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onDismiss)
            .background(color.copy(alpha = 0.10f), RoundedCornerShape(10.dp))
            .padding(OmSpacing.sm),
    )
}

@Composable
private fun BackendsLoading() {
    val c = OmTheme.colors
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        OmSpinner(color = c.accent)
        Text(
            "Loading backends…",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = OmSpacing.sm),
        )
    }
}

// --- Backend detail (verify capabilities) ---

/**
 * Detail screen for one backend, reached by tapping its summary card. Resolves
 * the [ModelManagement.BackendRow] for [backendKey] from the shared
 * [BackendsViewModel]'s overview and shows the backend header plus the
 * "Verify capabilities" section: one behavioral-verify affordance per
 * (model, role) the probe classified into a verifiable role. The verify state +
 * handlers live in the same view-model, so a verdict survives navigating back
 * and forth. Test / Remove stay on the summary card, so they're not repeated
 * here.
 */
@Composable
fun BackendDetailScreen(
    backendKey: String,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: BackendsViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val verifies by vm.verifies.collectAsStateWithLifecycle()
    val logos by vm.logos.collectAsStateWithLifecycle()
    val row = (state as? Loadable.Content)?.value
        ?.let { ModelManagement.httpBackends(it).firstOrNull { b -> b.key == backendKey } }
    ProviderLogos(logos) { BackendDetailContent(
        backendKey = backendKey,
        row = row,
        verifies = verifies,
        busy = busy,
        onBack = onBack,
        onVerify = { vm.verify(it, force = false) },
        onReVerify = { vm.verify(it, force = true) },
    ) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BackendDetailContent(
    backendKey: String,
    row: ModelManagement.BackendRow?,
    verifies: Map<String, BackendsViewModel.VerifyState> = emptyMap(),
    busy: Boolean = false,
    onBack: () -> Unit = {},
    onVerify: (ModelManagement.VerifyTarget) -> Unit = {},
    onReVerify: (ModelManagement.VerifyTarget) -> Unit = {},
) {
    val c = OmTheme.colors
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back", tint = c.textPrimary)
                    }
                },
                title = { Text(backendKey, style = MaterialTheme.typography.titleMedium, color = c.textPrimary) },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.bgPrimary),
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().background(c.bgPrimary)) {
            if (row == null) {
                // The backend went away (e.g. removed while the detail was open).
                Column(
                    Modifier.fillMaxSize().padding(OmSpacing.lg),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("This backend no longer exists.", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
                }
            } else {
                val targets = ModelManagement.verifyTargets(row)
                Column(
                    Modifier
                        .verticalScroll(rememberScrollState())
                        .fillMaxWidth()
                        .padding(horizontal = OmSpacing.lg)
                        .padding(bottom = OmSpacing.lg),
                    verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
                ) {
                    BackendDetailHeader(row)
                    if (targets.isEmpty()) {
                        BackendDetailEmptyVerify()
                    } else {
                        FlatSection(title = "Verify capabilities") {
                            Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                                targets.forEach { target ->
                                    Column(
                                        Modifier
                                            .fillMaxWidth()
                                            .background(c.bgSecondary, RoundedCornerShape(12.dp))
                                            .padding(OmSpacing.md),
                                    ) {
                                        VerifyRow(
                                            target = target,
                                            state = verifies[target.id],
                                            busy = busy,
                                            onVerify = { onVerify(target) },
                                            onReVerify = { onReVerify(target) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BackendDetailHeader(row: ModelManagement.BackendRow) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = OmSpacing.md)
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            BackendBrandIcon(key = row.key, size = 20.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    MiddleEllipsisText(
                        text = row.key,
                        style = MaterialTheme.typography.titleMedium,
                        color = c.textPrimary,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    StatusBadge(row.status.status)
                }
                if (!row.status.url.isNullOrBlank()) {
                    MiddleEllipsisText(
                        text = row.status.url!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Text(backendMetaLine(row.status), style = MaterialTheme.typography.labelSmall, color = c.textMuted)
            }
        }
    }
}

@Composable
private fun BackendDetailEmptyVerify() {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("Nothing to verify yet.", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
        Text(
            "Once this backend is reachable and its probe classifies a model into a verifiable role (embedder, agent, or privacy reviewer), a Verify affordance shows up here.",
            style = MaterialTheme.typography.labelSmall,
            color = c.textMuted,
        )
    }
}

/**
 * One behavioral-verify affordance: the role label + model, a Verify button, and
 * the inline verdict/error/in-flight line. The probe's `/v1/models` list only
 * advertises which models *claim* a role; a Verify confirms the model actually
 * serves it (the gateway issues the role's minimal capability call). Once a
 * verdict is in, the button becomes a "Re-verify" that force-bypasses the
 * gateway's cache.
 */
@Composable
private fun VerifyRow(
    target: ModelManagement.VerifyTarget,
    state: BackendsViewModel.VerifyState?,
    busy: Boolean,
    onVerify: () -> Unit,
    onReVerify: () -> Unit,
) {
    val c = OmTheme.colors
    val verifying = state is BackendsViewModel.VerifyState.Verifying
    val hasVerdict = state is BackendsViewModel.VerifyState.Verdict
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                ModelManagement.roleLabel(target.role),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = c.textPrimary,
            )
            MiddleEllipsisText(
                text = target.model,
                style = MaterialTheme.typography.labelSmall,
                color = c.textSecondary,
                modifier = Modifier.weight(1f),
            )
            (state as? BackendsViewModel.VerifyState.Verdict)?.let { v ->
                Text(
                    if (v.supported) "✓" else "✗",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                    color = if (v.supported) c.success else c.danger,
                )
            }
            OutlinedButton(
                onClick = if (hasVerdict) onReVerify else onVerify,
                enabled = !busy && !verifying,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = c.accent),
            ) {
                Text(
                    when {
                        verifying -> "Verifying…"
                        hasVerdict -> "Re-verify"
                        else -> "Verify"
                    },
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        val detail: Pair<String, Color>? = when (state) {
            null -> null
            is BackendsViewModel.VerifyState.Verifying ->
                "Issuing a ${ModelManagement.roleLabel(target.role).lowercase()} call…" to c.textMuted
            is BackendsViewModel.VerifyState.Verdict -> {
                val text = state.detail.ifBlank { if (state.supported) "Supported" else "Not supported" }
                text to (if (state.supported) c.success else c.danger)
            }
            is BackendsViewModel.VerifyState.Error -> "Verify failed: ${state.reason}" to c.danger
        }
        if (detail != null) {
            Text(detail.first, style = MaterialTheme.typography.labelSmall, color = detail.second, maxLines = 3)
        }
    }
}

// --- Add-backend bottom sheet ---

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CodexSetupSheet(
    status: CodexBackendStatus?,
    flow: CodexLoginFlow?,
    busy: Boolean,
    onStartLogin: () -> Unit,
    onCheckLogin: () -> Unit,
    onRefresh: () -> Unit,
    onCancelLogin: () -> Unit,
    onRemove: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        CodexSetupForm(
            status = status,
            flow = flow,
            busy = busy,
            onStartLogin = onStartLogin,
            onCheckLogin = onCheckLogin,
            onRefresh = onRefresh,
            onCancelLogin = onCancelLogin,
            onRemove = onRemove,
        )
    }
}

@Composable
fun CodexSetupForm(
    status: CodexBackendStatus? = null,
    flow: CodexLoginFlow? = null,
    busy: Boolean = false,
    onStartLogin: () -> Unit = {},
    onCheckLogin: () -> Unit = {},
    onRefresh: () -> Unit = {},
    onCancelLogin: () -> Unit = {},
    onRemove: () -> Unit = {},
) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.lg),
    ) {
        Text("Codex", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        Column(
            Modifier
                .fillMaxWidth()
                .background(c.bgSecondary, RoundedCornerShape(12.dp))
                .padding(OmSpacing.md),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm), verticalAlignment = Alignment.CenterVertically) {
                BackendBrandIcon(key = "codex", size = 24.dp)
                Column(Modifier.weight(1f)) {
                    Text("Codex", style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
                    Text(codexSetupStatusLine(status), style = MaterialTheme.typography.bodySmall, color = codexSetupStatusColor(status))
                }
            }
            if (!status?.reason.isNullOrBlank()) {
                Text(status!!.reason!!, style = MaterialTheme.typography.labelSmall, color = c.textMuted, maxLines = 3)
            }
            if (!status?.refreshedAt.isNullOrBlank()) {
                Text("Last checked ${status!!.refreshedAt}", style = MaterialTheme.typography.labelSmall, color = c.textMuted)
            }
        }

        if (flow?.status == "pending") {
            CodexLoginInstructions(flow, busy, onCheckLogin, onCancelLogin)
        } else {
            Text(
                "Use Codex with the gateway host's dedicated Codex login. OpenAI will show a one-time code flow; Omnesis never sees your ChatGPT password.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
            Button(
                onClick = onStartLogin,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
            ) {
                Text(if (status?.loggedIn == true) "Log in again" else "Log in to OpenAI", fontWeight = FontWeight.SemiBold)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(
                    onClick = onRefresh,
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = c.accent),
                ) { Text("Check status", fontWeight = FontWeight.SemiBold) }
                if (status?.configured == true) {
                    OutlinedButton(
                        onClick = onRemove,
                        enabled = !busy,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = c.danger),
                    ) { Text("Remove", fontWeight = FontWeight.SemiBold) }
                }
            }
        }
    }
}

@Composable
private fun CodexLoginInstructions(
    flow: CodexLoginFlow,
    busy: Boolean,
    onCheckLogin: () -> Unit,
    onCancelLogin: () -> Unit,
) {
    val c = OmTheme.colors
    val uriHandler = LocalUriHandler.current
    val clipboard = LocalClipboardManager.current
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
        Text(
            "Open this link to log in to OpenAI, then paste this one-time code.",
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
            color = c.textPrimary,
        )
        val uri = flow.verificationUri
        if (!uri.isNullOrBlank()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(c.accent.copy(alpha = 0.10f), RoundedCornerShape(10.dp))
                    .clickable(enabled = !busy) { uriHandler.openUri(uri) }
                    .padding(OmSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Open OpenAI login", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.accent)
            }
        }
        val code = flow.userCode
        if (!code.isNullOrBlank()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(c.bgSecondary, RoundedCornerShape(10.dp))
                    .padding(OmSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            ) {
                Text(
                    code,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
                TextButton(onClick = { clipboard.setText(AnnotatedString(code)) }) {
                    Text("Copy", color = c.accent, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        if (!flow.expiresAt.isNullOrBlank()) {
            Text("Expires ${flow.expiresAt}", style = MaterialTheme.typography.labelSmall, color = c.textMuted)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm), modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(
                onClick = onCheckLogin,
                enabled = !busy,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = c.accent),
            ) { Text("Check login", fontWeight = FontWeight.SemiBold) }
            OutlinedButton(
                onClick = onCancelLogin,
                enabled = !busy,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = c.danger),
            ) { Text("Cancel", fontWeight = FontWeight.SemiBold) }
        }
    }
}

@Composable
private fun codexSetupStatusColor(status: CodexBackendStatus?): Color {
    val c = OmTheme.colors
    return when {
        status?.status == "ok" && status?.loggedIn == true -> c.success
        status?.configured == true -> c.warning
        else -> c.textMuted
    }
}

private fun codexSetupStatusLine(status: CodexBackendStatus?): String {
    if (status == null) return "Not available"
    if (status.status == "probing") return "Checking status"
    if (status.loggedIn && status.status == "ok") {
        val count = status.models.size
        return "Connected · $count model${if (count == 1) "" else "s"}"
    }
    if (status.configured) return "Login needs attention"
    return "Not configured"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AddBackendSheet(
    presets: List<ProviderPreset>,
    codex: CodexBackendStatus? = null,
    onAdd: (String, String, String?, String?) -> Unit,
    onConfigureCodex: () -> Unit = {},
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        AddBackendForm(presets = presets, codex = codex, onAdd = onAdd, onConfigureCodex = onConfigureCodex)
    }
}

/**
 * Pure add-backend body — exercised directly by the screenshot test. A two-step
 * flow: first a 2-col grid of provider-preset cards (+ a "Custom" card); picking
 * a preset prefills the form (disabled name = preset id, url = default URL,
 * apiPathPrefix), shows the API-key field with a per-provider note, and offers a
 * Back affordance to the grid. "Custom" → a blank form. Ports the iOS
 * `AddBackendSheet`. Keeps the existing name validation + add callback.
 */
@Composable
fun AddBackendForm(
    presets: List<ProviderPreset> = emptyList(),
    codex: CodexBackendStatus? = null,
    onAdd: (String, String, String?, String?) -> Unit = { _, _, _, _ -> },
    onConfigureCodex: () -> Unit = {},
) {
    val c = OmTheme.colors
    // null = grid; non-null = the form for the active preset (a Custom preset is
    // represented by the sentinel below).
    var activePreset by remember { mutableStateOf<ProviderPreset?>(null) }
    var showForm by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var apiPathPrefix by remember { mutableStateOf("") }

    fun selectPreset(preset: ProviderPreset) {
        activePreset = preset
        name = preset.id
        url = preset.defaultUrl
        apiKey = ""
        apiPathPrefix = preset.apiPathPrefix ?: ""
        showForm = true
    }

    fun selectCustom() {
        activePreset = null
        name = ""
        url = ""
        apiKey = ""
        apiPathPrefix = ""
        showForm = true
    }

    fun backToGrid() {
        showForm = false
        activePreset = null
    }

    if (!showForm) {
        AddBackendPresetGrid(
            presets = presets,
            codex = codex,
            onSelectPreset = ::selectPreset,
            onSelectCodex = onConfigureCodex,
            onSelectCustom = ::selectCustom,
        )
        return
    }

    val preset = activePreset
    val nameError = if (name.isEmpty()) null else ModelManagement.validateBackendName(name)
    val canAdd = name.trim().isNotEmpty() && url.trim().isNotEmpty() && nameError == null

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Row(
            Modifier.clickable(onClick = ::backToGrid),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = null, tint = c.accent, modifier = Modifier.size(16.dp))
            Text("Back", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.accent)
        }

        if (preset != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                ProviderIcon(providerId = preset.id, size = 16.dp)
                Text(
                    "Configuring ${preset.name} — add your API key; the URL is pre-filled.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
            }
        } else {
            Text(
                "Point Omnesis at any OpenAI-compatible server. Backends are shared across every capability.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
        }

        Field("Name", "my-vllm", name, { name = it }, error = nameError, enabled = preset == null)
        Field("Base URL", "https://api.deepseek.com/v1", url, { url = it })
        Field(
            if (preset != null) "API key" else "API key (optional)",
            "Leave blank for a keyless local server",
            apiKey,
            { apiKey = it },
            password = true,
        )
        Field("API path prefix (optional)", "/v1", apiPathPrefix, { apiPathPrefix = it })

        Button(
            onClick = {
                onAdd(
                    name.trim(),
                    url.trim(),
                    apiKey.ifBlank { null },
                    apiPathPrefix.ifBlank { null },
                )
            },
            enabled = canAdd,
            modifier = Modifier.fillMaxWidth().height(48.dp),
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
        ) {
            Text("Add backend", fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun AddBackendPresetGrid(
    presets: List<ProviderPreset>,
    codex: CodexBackendStatus?,
    onSelectPreset: (ProviderPreset) -> Unit,
    onSelectCodex: () -> Unit,
    onSelectCustom: () -> Unit,
) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.lg),
    ) {
        Text("Add backend", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        Text(
            "Pick a provider to pre-fill its URL, or point Omnesis at any OpenAI-compatible server. Backends are shared across every capability.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
        )
        // 2-col grid built from rows so it nests inside the sheet's column
        // without a nested-scroll conflict (a LazyVerticalGrid would).
        val cards = presets.map { preset ->
            PresetCardSpec(preset.id, preset.name, "Set up this provider") { onSelectPreset(preset) }
        } +
            listOfNotNull(
                codex?.let {
                    PresetCardSpec(
                        "codex",
                        "Codex",
                        if (it.configured) "Manage OpenAI login" else "Log in with OpenAI",
                        onSelectCodex,
                    )
                },
            ) +
            PresetCardSpec("http", "Custom", "Any OpenAI-compatible server", onSelectCustom)
        cards.chunked(2).forEach { rowCards ->
            Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm), modifier = Modifier.fillMaxWidth()) {
                rowCards.forEach { spec ->
                    PresetCard(spec, Modifier.weight(1f))
                }
                if (rowCards.size == 1) {
                    Box(Modifier.weight(1f))
                }
            }
        }
    }
}

private data class PresetCardSpec(
    val providerId: String,
    val title: String,
    val subtitle: String,
    val onClick: () -> Unit,
)

@Composable
private fun PresetCard(spec: PresetCardSpec, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Column(
        modifier
            .height(96.dp)
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .clickable(onClick = spec.onClick)
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ProviderIcon(providerId = spec.providerId, size = 24.dp)
        Text(
            spec.title,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            color = c.textPrimary,
            maxLines = 1,
        )
        Text(spec.subtitle, style = MaterialTheme.typography.labelSmall, color = c.textMuted, maxLines = 2)
    }
}

// --- Set-credential bottom sheet ---

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SetCredentialSheet(
    entry: ModelCredentialEntry,
    onSave: (Map<String, String>) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        SetCredentialForm(entry = entry, onSave = onSave)
    }
}

/**
 * Pure set-credential form body — exercised directly by the screenshot test.
 * One field per `spec.fields`, masked for `secret` fields. Values are
 * write-only: submitted, never read back. The submit button gates on
 * `ModelManagement.validateCredentialFields` (required + per-field pattern);
 * the gateway re-validates.
 */
@Composable
fun SetCredentialForm(
    entry: ModelCredentialEntry,
    onSave: (Map<String, String>) -> Unit = {},
) {
    val c = OmTheme.colors
    val values = remember { mutableStateMapOf<String, String>() }
    val validation = ModelManagement.validateCredentialFields(values, entry.spec)
    val canSave = validation is ModelManagement.CredentialValidation.Valid

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Text(entry.providerName, style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        Text(
            "Enter your ${entry.providerName} credentials. They're stored on the gateway host and used to call ${entry.providerName}; the key is never shown again.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
        )

        entry.spec.fields.forEach { field ->
            Field(
                label = field.label,
                placeholder = field.placeholder ?: "",
                value = values[field.name] ?: "",
                onValueChange = { values[field.name] = it },
                password = field.secret == true,
                hint = field.patternHint,
            )
        }

        Button(
            onClick = {
                (validation as? ModelManagement.CredentialValidation.Valid)?.let { onSave(it.cleaned) }
            },
            enabled = canSave,
            modifier = Modifier.fillMaxWidth().height(48.dp),
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
        ) {
            Text("Save", fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun Field(
    label: String,
    placeholder: String,
    value: String,
    onValueChange: (String) -> Unit,
    password: Boolean = false,
    error: String? = null,
    hint: String? = null,
    enabled: Boolean = true,
) {
    val c = OmTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.textSecondary)
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text(placeholder) },
            singleLine = true,
            enabled = enabled,
            isError = error != null,
            visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            modifier = Modifier.fillMaxWidth(),
        )
        if (error != null) {
            Text(error, fontSize = 11.sp, color = c.danger)
        } else if (hint != null) {
            Text(hint, fontSize = 11.sp, color = c.textMuted)
        }
    }
}

/**
 * Flat section — an uppercased grey-caps header with a 1px rule, then the content
 * directly on the page background. Ports the iOS FlatSection.
 */
@Composable
private fun FlatSection(
    title: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val c = OmTheme.colors
    Column(
        modifier = modifier.padding(top = OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            Text(
                title.uppercase(),
                style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 0.5.sp),
                fontWeight = FontWeight.SemiBold,
                color = c.textSecondary,
            )
            Box(Modifier.weight(1f).height(1.dp).background(c.border))
        }
        content()
    }
}

// --- previews / screenshot sample data ---

internal fun sampleBackendsOverview() = ModelsOverview(
    inference = InferenceOverview(
        backends = mapOf(
            "deepseek" to BackendStatus(
                type = "http",
                status = "ok",
                url = "https://api.deepseek.com/v1",
                models = listOf("example-embed-v1", "example-chat-v1"),
                modelRoles = mapOf(
                    "example-embed-v1" to listOf("embedder"),
                    "example-chat-v1" to listOf("agent", "privacy-reviewer"),
                ),
                hasApiKey = true,
            ),
            "northstar" to BackendStatus(
                type = "http",
                status = "ok",
                url = "https://ocr.example/v1",
                models = listOf("dots-ocr", "llama-vision-8b"),
                modelRoles = mapOf("dots-ocr" to listOf("ocr"), "llama-vision-8b" to listOf("ocr", "agent")),
                hasApiKey = true,
            ),
            "studio-local" to BackendStatus(
                type = "http",
                status = "unreachable",
                url = "http://192.0.2.10:8000/v1",
                models = emptyList(),
                hasApiKey = false,
            ),
        ),
        codex = CodexBackendStatus(
            configured = true,
            status = "ok",
            loggedIn = true,
            models = listOf("gpt-example-frontier"),
            modelDetails = listOf(
                CodexModelStatus(
                    id = "gpt-example-frontier",
                    name = "GPT Example Frontier",
                    description = "Example Codex model.",
                    recommended = true,
                ),
            ),
            modelRoles = mapOf("gpt-example-frontier" to listOf("agent", "background-agent")),
            refreshedAt = "2026-07-03T12:00:00Z",
        ),
    ),
    presets = samplePresets(),
)

/**
 * A handful of cloud-provider presets for the add-backend grid. The ids match
 * the real gateway preset ids (so `ProviderIcon` resolves the brand glyph);
 * URLs/models are the documented defaults, not user data.
 */
internal fun samplePresets() = listOf(
    ProviderPreset(
        id = "openai",
        name = "OpenAI",
        defaultUrl = "https://api.openai.com",
        knownModels = listOf("gpt-4o", "text-embedding-3-small"),
        capabilities = listOf("agent", "embed"),
    ),
    ProviderPreset(
        id = "groq",
        name = "Groq",
        defaultUrl = "https://api.groq.com/openai",
        knownModels = listOf("llama-3.3-70b-versatile"),
        capabilities = listOf("agent"),
    ),
    ProviderPreset(
        id = "together",
        name = "Together AI",
        defaultUrl = "https://api.together.xyz",
        capabilities = listOf("agent", "embed"),
    ),
    ProviderPreset(
        id = "google",
        name = "Google AI (Gemini)",
        defaultUrl = "https://generativelanguage.googleapis.com",
        apiPathPrefix = "/v1beta/openai",
        knownModels = listOf("gemini-2.5-flash"),
        capabilities = listOf("agent", "embed"),
    ),
)

/**
 * The four verify states keyed by `VerifyTarget.id`, for the verify-states
 * screenshot — one target per state so a single detail render shows all four.
 */
internal fun sampleVerifyStates() = mapOf(
    "deepseek/example-embed-v1/embedder" to
        BackendsViewModel.VerifyState.Verdict(supported = true, detail = "embeddings endpoint · dim 1024"),
    "deepseek/example-chat-v1/agent" to
        BackendsViewModel.VerifyState.Verdict(supported = false, detail = "HTTP 404: model not found"),
    "deepseek/example-chat-v1/privacy-reviewer" to
        BackendsViewModel.VerifyState.Verifying,
    "northstar/llama-vision-8b/agent" to
        BackendsViewModel.VerifyState.Error("network error"),
)

/** The reachable "deepseek" backend row, for the backend-detail screenshots. */
internal fun sampleBackendDetailRow() =
    ModelManagement.httpBackends(sampleBackendsOverview()).first { it.key == "deepseek" }

/**
 * Two provider rows — one configured, one not — exercising both states. Field
 * spec mirrors the gateway's Anthropic spec (masked `apiKey` with a pattern).
 * All sample data is invented per the privacy rule.
 */
internal fun sampleCredentials() = listOf(
    ModelCredentialEntry(
        fileKey = "anthropic",
        providerType = "anthropic",
        providerName = "Anthropic",
        spec = CredentialSpec(
            fields = listOf(
                CredentialField(
                    name = "apiKey",
                    label = "API Key",
                    placeholder = "sk-ant-…",
                    secret = true,
                    pattern = "^sk-ant-[A-Za-z0-9_-]+$",
                    patternHint = "API keys start with sk-ant- followed by letters, numbers, dashes or underscores.",
                ),
            ),
        ),
        configured = true,
    ),
    ModelCredentialEntry(
        fileKey = "example-provider",
        providerType = "openai",
        providerName = "Example Provider",
        spec = CredentialSpec(
            fields = listOf(
                CredentialField(name = "apiKey", label = "API Key", placeholder = "sk-example-…", secret = true),
            ),
        ),
        configured = false,
    ),
)
