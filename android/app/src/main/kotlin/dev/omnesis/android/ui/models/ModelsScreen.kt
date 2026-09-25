// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Numbers
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.DocumentScanner
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
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
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.ActiveDownload
import dev.omnesis.android.transport.dto.BackendStatus
import dev.omnesis.android.transport.dto.CapabilityMeta
import dev.omnesis.android.transport.dto.CatalogEntry
import dev.omnesis.android.transport.dto.CodexBackendStatus
import dev.omnesis.android.transport.dto.CodexModelStatus
import dev.omnesis.android.transport.dto.DownloadProgress
import dev.omnesis.android.transport.dto.InferenceOverview
import dev.omnesis.android.transport.dto.ManifestEntry
import dev.omnesis.android.transport.dto.ModelDisplay
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.ModelControlInfo
import dev.omnesis.android.transport.dto.ModelBehaviorSettings
import dev.omnesis.android.transport.dto.RecentModelEntry
import dev.omnesis.android.transport.dto.ResolvedAssignment
import dev.omnesis.android.transport.dto.SystemInfo
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.common.ExperimentalBadge
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.Loadable

@Composable
fun ModelsScreen(
    connection: ConnectionState,
    onBack: () -> Unit,
    initialPickerRole: String? = null,
    onInitialPickerConsumed: () -> Unit = {},
    onOpenSettings: () -> Unit = {},
    onOpenBackends: () -> Unit = {},
    vm: ModelsViewModel = hiltViewModel(),
) {
    BackHandler(onBack = onBack)
    InitialPickerEffect(initialPickerRole, vm::openPicker, onInitialPickerConsumed)
    val state by vm.state.collectAsStateWithLifecycle()
    val system by vm.system.collectAsStateWithLifecycle()
    val notice by vm.notice.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val picker by vm.picker.collectAsStateWithLifecycle()
    val recent by vm.recent.collectAsStateWithLifecycle()
    val logos by vm.logos.collectAsStateWithLifecycle()
    val behaviorError by vm.behaviorError.collectAsStateWithLifecycle()
    val behaviorStatus by vm.behaviorStatus.collectAsStateWithLifecycle()
    val behaviorEpoch by vm.behaviorEpoch.collectAsStateWithLifecycle()
    ProviderLogos(logos) { ModelsContent(
        state = state,
        connection = connection,
        system = system,
        notice = notice,
        busy = busy,
        pickerRole = picker,
        recent = recent,
        onBack = onBack,
        onRetry = vm::load,
        onOpenSettings = onOpenSettings,
        onOpenBackends = onOpenBackends,
        onOpenPicker = vm::openPicker,
        onClosePicker = vm::closePicker,
        onAssign = vm::assign,
        onClear = vm::clear,
        onInstall = vm::install,
        onCancelDownload = vm::cancelDownload,
        onUninstall = vm::uninstall,
        onAddBackend = vm::addBackend,
        onSaveBehavior = vm::saveBehavior,
        onBudgetBehavior = vm::saveBudgetBehavior,
        behaviorError = behaviorError?.takeIf { it.role == picker }?.text,
        behaviorStatus = behaviorStatus?.takeIf { it.role == picker }?.text,
        behaviorEpoch = behaviorEpoch,
        onDismissNotice = vm::dismissNotice,
    ) }
}

@Composable
internal fun InitialPickerEffect(
    role: String?,
    onOpen: (String) -> Unit,
    onConsumed: () -> Unit,
) {
    LaunchedEffect(role) {
        role?.let {
            onOpen(it)
            onConsumed()
        }
    }
}

/**
 * `connection` is accepted for call-site parity with the other tab screens but,
 * matching the iOS Models view, it is intentionally not surfaced here (no
 * connection pill on the Models top bar). The capability list is reached as a
 * child of Settings, so its leading affordance returns there.
 */
@Suppress("UNUSED_PARAMETER")
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelsContent(
    state: Loadable<ModelsOverview>,
    connection: ConnectionState,
    system: SystemInfo? = null,
    notice: ModelsViewModel.Notice? = null,
    busy: Boolean = false,
    pickerRole: String? = null,
    recent: List<RecentModelEntry> = emptyList(),
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit = {},
    onOpenBackends: () -> Unit = {},
    onOpenPicker: (String) -> Unit = {},
    onClosePicker: () -> Unit = {},
    onAssign: (String, ModelManagement.PickerOption) -> Unit = { _, _ -> },
    onClear: (String) -> Unit = {},
    onInstall: (String) -> Unit = {},
    onCancelDownload: (String) -> Unit = {},
    onUninstall: (String) -> Unit = {},
    onAddBackend: (String, String, String?, String?) -> Unit = { _, _, _, _ -> },
    onSaveBehavior: (String, String, ModelBehaviorValues) -> Unit = { _, _, _ -> },
    onBudgetBehavior: (String, String, ModelBehaviorValues?) -> Unit = { _, _, _ -> },
    behaviorError: String? = null,
    behaviorStatus: String? = null,
    behaviorEpoch: Int = 0,
    onDismissNotice: () -> Unit = {},
) {
    val c = OmTheme.colors
    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Outlined.ArrowBack,
                            contentDescription = "Back to Settings",
                            tint = c.accent,
                        )
                    }
                },
                title = { Text("Models", style = MaterialTheme.typography.titleMedium, color = c.textPrimary) },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.bgPrimary),
            )
        },
    ) { padding ->
        Box(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .background(c.bgPrimary),
        ) {
            when (state) {
                Loadable.Loading -> ModelsLoading()
                is Loadable.Error -> GatewayErrorView(
                    context = "load models",
                    error = state.throwable,
                    onRetry = onRetry,
                    onOpenSettings = onOpenSettings,
                )
                is Loadable.Content -> CapabilityList(
                    overview = state.value,
                    notice = notice,
                    busy = busy,
                    onOpenBackends = onOpenBackends,
                    onOpenPicker = onOpenPicker,
                    onDismissNotice = onDismissNotice,
                )
            }
        }
    }

    val overview = (state as? Loadable.Content)?.value
    val cap = overview?.capabilities?.firstOrNull { it.role == pickerRole }
    if (overview != null && cap != null) {
        ModelPickerSheet(
            cap = cap,
            overview = overview,
            system = system,
            currentlyConfigured = ModelManagement.isConfigured(overview.inference.assignments[cap.role]),
            busy = busy,
            recent = if (cap.role == pickerRole) recent else emptyList(),
            onPick = { onAssign(cap.role, it) },
            onClear = { onClear(cap.role) },
            onInstall = onInstall,
            onCancelDownload = onCancelDownload,
            onUninstall = onUninstall,
            onAddBackend = onAddBackend,
            onSaveBehavior = { assignment, values -> onSaveBehavior(cap.role, assignment, values) },
            onBudgetBehavior = { assignment, values -> onBudgetBehavior(cap.role, assignment, values) },
            behaviorError = behaviorError,
            behaviorStatus = behaviorStatus,
            behaviorEpoch = behaviorEpoch,
            onDismiss = onClosePicker,
        )
    }
}

@Composable
private fun CapabilityList(
    overview: ModelsOverview,
    notice: ModelsViewModel.Notice?,
    busy: Boolean,
    onOpenBackends: () -> Unit,
    onOpenPicker: (String) -> Unit,
    onDismissNotice: () -> Unit,
) {
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
        OutlinedButton(onClick = onOpenBackends) {
            Text("Configure backends")
        }
        val orderedCapabilities = overview.capabilities.filter { it.section != "cognition" } +
            overview.capabilities.filter { it.section == "cognition" }
        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            orderedCapabilities.forEach { cap ->
                val canEditBehavior = ModelBehaviorPresentation.supportsAssignment(
                    cap.role, overview.inference.assignments[cap.role]?.kind,
                )
                CapabilityCard(
                    cap = cap,
                    display = overview.assignmentDisplays[cap.role],
                    behavior = overview.modelSettings[cap.role].takeIf { canEditBehavior },
                    controls = overview.modelSettings[cap.role]?.assignment?.let { overview.modelControls[it] }
                        .takeIf { canEditBehavior },
                    state = ModelManagement.state(overview.inference.assignments[cap.role]),
                    reason = overview.inference.assignments[cap.role]?.reason,
                    onTap = { onOpenPicker(cap.role) },
                    disabled = busy,
                )
            }
        }
    }
}

@Composable
private fun CapabilityCard(
    cap: CapabilityMeta,
    display: ModelDisplay?,
    behavior: ModelBehaviorSettings?,
    controls: ModelControlInfo?,
    state: ModelManagement.CapabilityState,
    reason: String?,
    onTap: () -> Unit,
    disabled: Boolean,
) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .clickable(enabled = !disabled, onClick = onTap)
            .padding(OmSpacing.md),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Icon(
            ModelCapabilityIcon.icon(cap.icon),
            contentDescription = null,
            tint = c.textSecondary,
            modifier = Modifier.size(20.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(cap.title, style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
                if (cap.experimental) {
                    ExperimentalBadge()
                }
                StateBadge(state)
            }
            if (display != null && display.configured) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    ProviderIcon(providerId = display.providerId, size = 14.dp)
                    MiddleEllipsisText(
                        text = listOf(display.providerLabel, display.modelName).filter { it.isNotBlank() }.joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                        modifier = Modifier.weight(1f),
                    )
                }
            } else {
                Text("Not configured", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            }
            if (state == ModelManagement.CapabilityState.WARN && !reason.isNullOrBlank()) {
                Text(reason, style = MaterialTheme.typography.labelSmall, color = c.warning, maxLines = 2)
            }
            val behaviorText = ModelBehaviorPresentation.summary(behavior, controls)
            if (behaviorText != null) {
                Text(behaviorText, style = MaterialTheme.typography.labelSmall, color = c.textSecondary)
            }
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = c.textMuted,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun StateBadge(state: ModelManagement.CapabilityState) {
    val c = OmTheme.colors
    val (text, color) = when (state) {
        ModelManagement.CapabilityState.ON -> "ENABLED" to c.success
        ModelManagement.CapabilityState.WARN -> "NEEDS ATTENTION" to c.warning
        ModelManagement.CapabilityState.OFF -> return
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelPickerSheet(
    cap: CapabilityMeta,
    overview: ModelsOverview,
    system: SystemInfo?,
    currentlyConfigured: Boolean,
    busy: Boolean,
    recent: List<RecentModelEntry> = emptyList(),
    onPick: (ModelManagement.PickerOption) -> Unit,
    onClear: () -> Unit,
    onInstall: (String) -> Unit,
    onCancelDownload: (String) -> Unit,
    onUninstall: (String) -> Unit,
    onAddBackend: (String, String, String?, String?) -> Unit,
    onSaveBehavior: (String, ModelBehaviorValues) -> Unit,
    onBudgetBehavior: (String, ModelBehaviorValues?) -> Unit = { _, _ -> },
    behaviorError: String? = null,
    behaviorStatus: String? = null,
    behaviorEpoch: Int = 0,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        ModelPickerContent(
            cap = cap,
            overview = overview,
            system = system,
            currentlyConfigured = currentlyConfigured,
            busy = busy,
            recent = recent,
            onPick = onPick,
            onClear = onClear,
            onInstall = onInstall,
            onCancelDownload = onCancelDownload,
            onUninstall = onUninstall,
            onAddBackend = onAddBackend,
            onSaveBehavior = onSaveBehavior,
            onBudgetBehavior = onBudgetBehavior,
            behaviorError = behaviorError,
            behaviorStatus = behaviorStatus,
            behaviorEpoch = behaviorEpoch,
        )
    }
}

/**
 * Pure two-pane picker body — exercised directly by the screenshot test. Pane 1
 * is a 2-col grid of backend tiles (Local / Anthropic / each HTTP backend) plus
 * an "Add HTTP backend" affordance and the Clear-assignment row. Tapping a tile
 * opens pane 2 for that backend: a model-search field, the role-matching options
 * (or the local-GGUF install/use/remove list under the Local tile), and — for an
 * HTTP backend — a custom-model-id field that assigns "<key>/<model>". Ports the
 * iOS two-level `ModelPickerSheet`.
 *
 * `previewSelectedBackend` / `previewSearch` seed which pane is on screen so the
 * model-list pane renders deterministically in screenshots.
 */
@Composable
fun ModelPickerContent(
    cap: CapabilityMeta,
    overview: ModelsOverview,
    system: SystemInfo? = null,
    currentlyConfigured: Boolean,
    busy: Boolean = false,
    recent: List<RecentModelEntry> = emptyList(),
    onPick: (ModelManagement.PickerOption) -> Unit = {},
    onClear: () -> Unit = {},
    onInstall: (String) -> Unit = {},
    onCancelDownload: (String) -> Unit = {},
    onUninstall: (String) -> Unit = {},
    onAddBackend: (String, String, String?, String?) -> Unit = { _, _, _, _ -> },
    onSaveBehavior: (String, ModelBehaviorValues) -> Unit = { _, _ -> },
    onBudgetBehavior: (String, ModelBehaviorValues?) -> Unit = { _, _ -> },
    behaviorError: String? = null,
    behaviorStatus: String? = null,
    behaviorEpoch: Int = 0,
    previewSelectedBackend: String? = null,
    previewSearch: String = "",
) {
    val c = OmTheme.colors
    // Which backend's model list is on screen; null = the backend grid (pane 1).
    var selectedBackend by remember { mutableStateOf(previewSelectedBackend) }
    // Free-text model-search filter inside the model-list pane.
    var search by remember { mutableStateOf(previewSearch) }
    // Typed custom model id for an HTTP backend's "Use" affordance.
    var customModel by remember { mutableStateOf("") }
    // Catalog id pending an uninstall confirm (drives the confirmation dialog).
    var uninstallConfirm by remember { mutableStateOf<ModelManagement.LocalModelRow?>(null) }
    // The add-backend sheet (the picker's add affordance opens it over pane 1).
    var showAddSheet by remember { mutableStateOf(false) }
    val pickAndReturn: (ModelManagement.PickerOption) -> Unit = { option ->
        selectedBackend = null
        search = ""
        customModel = ""
        onPick(option)
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Text(cap.title, style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        Text(cap.description, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
        val behavior = overview.modelSettings[cap.role]
        val assignedDisplay = overview.assignmentDisplays[cap.role]
        val supportsBehavior = ModelBehaviorPresentation.supportsAssignment(
                cap.role, overview.inference.assignments[cap.role]?.kind,
            )
        val hasAssignedModelCard = supportsBehavior && behavior?.assignment != null
        if (hasAssignedModelCard) {
            AssignedModelBehaviorCard(
                settings = behavior,
                info = behavior?.assignment?.let { overview.modelControls[it] },
                display = assignedDisplay,
                unavailableReason = overview.inference.assignments[cap.role]?.reason,
                busy = busy,
                error = behaviorError,
                status = behaviorStatus,
                resetEpoch = behaviorEpoch,
                onSave = onSaveBehavior,
                onBudgetChange = onBudgetBehavior,
            )
        }
        if (!hasAssignedModelCard && behaviorError != null) {
            Text(behaviorError, style = MaterialTheme.typography.bodySmall, color = c.danger)
        }

        val backendKey = selectedBackend
        if (backendKey == null) {
            if (recent.isNotEmpty()) {
                RecentlyUsedSection(
                    capRole = cap.role,
                    entries = recent,
                    busy = busy,
                    onPick = pickAndReturn,
                )
            }
            BackendGridPane(
                cap = cap,
                overview = overview,
                currentlyConfigured = currentlyConfigured,
                busy = busy,
                onOpenBackend = {
                    search = ""
                    customModel = ""
                    selectedBackend = it
                },
                onAddBackendTap = { showAddSheet = true },
                onClear = onClear,
            )
        } else {
            ModelListPane(
                cap = cap,
                overview = overview,
                system = system,
                backendKey = backendKey,
                search = search,
                customModel = customModel,
                busy = busy,
                onSearchChange = { search = it },
                onCustomModelChange = { customModel = it },
                onBack = { selectedBackend = null },
                onPick = pickAndReturn,
                onInstall = onInstall,
                onCancelDownload = onCancelDownload,
                onRemoveRequest = { uninstallConfirm = it },
            )
        }
    }

    uninstallConfirm?.let { row ->
        AlertDialog(
            onDismissRequest = { uninstallConfirm = null },
            title = { Text("Remove ${row.entry.name}?") },
            text = { Text("The model file is deleted from the gateway host. You can re-install it any time.") },
            confirmButton = {
                TextButton(onClick = {
                    onUninstall(row.entry.id)
                    uninstallConfirm = null
                }) { Text("Remove", color = c.danger) }
            },
            dismissButton = {
                TextButton(onClick = { uninstallConfirm = null }) { Text("Cancel") }
            },
            containerColor = c.bgSecondary,
        )
    }

    if (showAddSheet) {
        AddBackendSheet(
            presets = overview.presets,
            onAdd = { name, url, apiKey, prefix ->
                showAddSheet = false
                onAddBackend(name, url, apiKey, prefix)
            },
            onDismiss = { showAddSheet = false },
        )
    }
}

/** Selected-model confirmation and its controls, matching the iOS card. */
@Composable
private fun AssignedModelBehaviorCard(
    settings: ModelBehaviorSettings?,
    info: ModelControlInfo?,
    display: ModelDisplay?,
    unavailableReason: String?,
    busy: Boolean,
    error: String?,
    status: String?,
    resetEpoch: Int,
    onSave: (String, ModelBehaviorValues) -> Unit,
    onBudgetChange: (String, ModelBehaviorValues?) -> Unit,
) {
    val assignment = settings?.assignment?.takeIf { it.isNotBlank() } ?: return
    val c = OmTheme.colors
    val shape = RoundedCornerShape(12.dp)
    val unavailable = display?.available == false
    val brand = info?.providerId?.takeIf { info.source == "models.dev" }
        ?: display?.providerId
        ?: "http"
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.bgSecondary, shape)
            .border(1.dp, c.success.copy(alpha = 0.45f), shape)
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            BackendBrandIcon(key = brand, size = 24.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Assigned model", style = MaterialTheme.typography.labelSmall, color = c.textMuted)
                MiddleEllipsisText(
                    text = display?.modelName?.takeIf { it.isNotBlank() } ?: assignment,
                    style = MaterialTheme.typography.titleSmall,
                    color = c.textPrimary,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    display?.providerLabel?.takeIf { it.isNotBlank() } ?: assignment,
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
        if (!unavailableReason.isNullOrBlank()) {
            Text(unavailableReason, style = MaterialTheme.typography.labelSmall, color = c.warning)
        }
        val hasBehaviorControls = info?.controls?.isNotEmpty() == true ||
            ModelBehaviorPresentation.hasSavedOverrides(settings)
        if (hasBehaviorControls) {
            HorizontalDivider(color = c.textMuted.copy(alpha = 0.2f))
            ModelBehaviorControlsSection(
                settings = settings,
                info = info,
                busy = busy,
                error = error,
                status = status,
                resetEpoch = resetEpoch,
                onSave = onSave,
                onBudgetChange = onBudgetChange,
            )
        }
    }
}


/**
 * "Recently used" section above the backend grid: one flat row per entry
 * (provider glyph + model name + Use button — deliberately not cards, so it
 * reads as a list, not a second grid). Entries with an incomplete apply
 * payload are skipped; the caller hides the whole section when empty.
 */
@Composable
private fun RecentlyUsedSection(
    capRole: String,
    entries: List<RecentModelEntry>,
    busy: Boolean,
    onPick: (ModelManagement.PickerOption) -> Unit,
) {
    val c = OmTheme.colors
    val usable = entries.mapNotNull { entry ->
        ModelManagement.recentPickerOption(capRole, entry)?.let { entry to it }
    }
    if (usable.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            "Recently used",
            style = MaterialTheme.typography.titleSmall,
            color = c.textSecondary,
        )
        usable.forEachIndexed { index, (entry, option) ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            ) {
                BackendBrandIcon(key = entry.providerId, size = 18.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    MiddleEllipsisText(
                        text = entry.modelName.ifBlank { entry.assignment },
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.textPrimary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (entry.providerLabel.isNotBlank()) {
                        Text(
                            entry.providerLabel,
                            style = MaterialTheme.typography.labelSmall,
                            color = c.textMuted,
                            maxLines = 1,
                        )
                    }
                }
                TextButton(onClick = { onPick(option) }, enabled = !busy) {
                    Text("Use", color = c.accent, fontWeight = FontWeight.SemiBold)
                }
            }
            if (index < usable.size - 1) {
                HorizontalDivider(color = c.textMuted.copy(alpha = 0.2f))
            }
        }
    }
}

/** Pane 1: the backend grid + add affordance + clear-assignment row. */
@Composable
private fun BackendGridPane(
    cap: CapabilityMeta,
    overview: ModelsOverview,
    currentlyConfigured: Boolean,
    busy: Boolean,
    onOpenBackend: (String) -> Unit,
    onAddBackendTap: () -> Unit,
    onClear: () -> Unit,
) {
    val c = OmTheme.colors
    val backends = ModelManagement.pickerBackends(cap.role, overview)

    if (backends.isEmpty()) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(c.bgSecondary, RoundedCornerShape(12.dp))
                .padding(OmSpacing.md),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text("No backends available for this capability.", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
            Text(
                "Add an HTTP backend below, or install a local model, then it will show up here.",
                style = MaterialTheme.typography.labelSmall,
                color = c.textMuted,
            )
        }
    } else {
        // 2-col grid built from rows so it nests inside the sheet's scrolling
        // column without a nested-scroll conflict (a LazyVerticalGrid would).
        backends.chunked(2).forEach { rowBackends ->
            Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm), modifier = Modifier.fillMaxWidth()) {
                rowBackends.forEach { backend ->
                    BackendTile(backend, Modifier.weight(1f), onClick = { onOpenBackend(backend.providerId) })
                }
                if (rowBackends.size == 1) {
                    Box(Modifier.weight(1f))
                }
            }
        }
    }

    Row(
        Modifier
            .fillMaxWidth()
            .background(c.accent.copy(alpha = 0.10f), RoundedCornerShape(12.dp))
            .clickable(enabled = !busy, onClick = onAddBackendTap)
            .padding(OmSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Icon(Icons.Default.Add, contentDescription = null, tint = c.accent, modifier = Modifier.size(18.dp))
        Text("Add HTTP backend", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.accent)
    }

    if (currentlyConfigured) {
        Box(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = !busy, onClick = onClear)
                .background(c.danger.copy(alpha = 0.10f), RoundedCornerShape(10.dp))
                .padding(vertical = OmSpacing.sm),
            contentAlignment = Alignment.Center,
        ) {
            Text("Clear assignment", style = MaterialTheme.typography.titleSmall, color = c.danger)
        }
    }
}

@Composable
private fun BackendTile(
    backend: ModelManagement.PickerBackend,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val c = OmTheme.colors
    val subtitle = backend.url?.takeIf { it.isNotBlank() }
        ?: "${backend.optionCount} model${if (backend.optionCount == 1) "" else "s"}"
    Column(
        modifier
            .height(96.dp)
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BackendBrandIcon(key = backend.providerId, size = 24.dp)
        MiddleEllipsisText(
            text = backend.title,
            style = MaterialTheme.typography.bodyMedium,
            color = c.textPrimary,
            modifier = Modifier.fillMaxWidth(),
        )
        MiddleEllipsisText(
            text = subtitle,
            style = MaterialTheme.typography.labelSmall,
            color = c.textMuted,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** Pane 2: a backend's model list (search + options + local lifecycle + custom id). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelListPane(
    cap: CapabilityMeta,
    overview: ModelsOverview,
    system: SystemInfo?,
    backendKey: String,
    search: String,
    customModel: String,
    busy: Boolean,
    onSearchChange: (String) -> Unit,
    onCustomModelChange: (String) -> Unit,
    onBack: () -> Unit,
    onPick: (ModelManagement.PickerOption) -> Unit,
    onInstall: (String) -> Unit,
    onCancelDownload: (String) -> Unit,
    onRemoveRequest: (ModelManagement.LocalModelRow) -> Unit,
) {
    val c = OmTheme.colors
    val isHttp = ModelManagement.pickerBackends(cap.role, overview).firstOrNull { it.providerId == backendKey }?.isHttp == true
    val isLocal = backendKey == "local"
    val options = ModelManagement.pickerOptions(cap.role, overview, forProviderId = backendKey, search = search)
    val localModels = if (isLocal) ModelManagement.localModelRows(cap.role, overview, system) else emptyList()

    Row(
        Modifier.clickable(onClick = onBack),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            Icons.AutoMirrored.Outlined.ArrowBack,
            contentDescription = null,
            tint = c.accent,
            modifier = Modifier.size(16.dp),
        )
        Text("Back", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.accent)
    }

    OutlinedTextField(
        value = search,
        onValueChange = onSearchChange,
        placeholder = { Text("Search models…") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )

    if (isLocal && localModels.isNotEmpty()) {
        localModels.forEach { row ->
            LocalModelRowItem(
                row = row,
                busy = busy,
                onUse = { onPick(localUseOption(cap.role, row)) },
                onInstall = { onInstall(row.entry.id) },
                onCancelDownload = { onCancelDownload(row.entry.id) },
                onRemoveRequest = { onRemoveRequest(row) },
            )
        }
    } else if (options.isEmpty()) {
        Text(
            if (search.isEmpty()) "No models for this capability." else "No matching models.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textMuted,
            modifier = Modifier.padding(vertical = OmSpacing.sm),
        )
    } else {
        options.forEach { OptionRow(it, onPick) }
    }

    if (isHttp) {
        CustomModelField(
            backendKey = backendKey,
            value = customModel,
            busy = busy,
            onValueChange = onCustomModelChange,
            onUse = {
                val model = customModel.trim()
                if (model.isNotEmpty()) {
                    onPick(
                        ModelManagement.PickerOption(
                            id = "$backendKey/$model",
                            providerId = backendKey,
                            label = model,
                            detail = backendKey,
                            apply = ModelManagement.Apply.Assign(value = "$backendKey/$model"),
                        ),
                    )
                }
            },
        )
    }
}

/**
 * Typed custom model id for an HTTP backend — the gateway accepts any model id
 * the backend serves, even one its probe didn't classify into this role.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CustomModelField(
    backendKey: String,
    value: String,
    busy: Boolean,
    onValueChange: (String) -> Unit,
    onUse: () -> Unit,
) {
    val c = OmTheme.colors
    Column(
        Modifier.padding(top = OmSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Or use a custom model id", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.textSecondary)
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                placeholder = { Text("model-id served by $backendKey") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onUse, enabled = !busy && value.trim().isNotEmpty()) {
                Text("Use", color = c.accent, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** "Use" an installed local GGUF — assign it to this capability via activate. */
private fun localUseOption(capabilityRole: String, row: ModelManagement.LocalModelRow): ModelManagement.PickerOption {
    val catalogRole = ModelManagement.catalogRole(capabilityRole) ?: capabilityRole
    return ModelManagement.PickerOption(
        id = "local/${row.entry.id}",
        providerId = "local",
        label = row.entry.name,
        detail = "Local · downloaded",
        apply = ModelManagement.Apply.Activate(
            catalogId = row.entry.id,
            catalogRole = catalogRole,
            capabilityRole = capabilityRole,
        ),
    )
}

@Composable
private fun LocalModelRowItem(
    row: ModelManagement.LocalModelRow,
    busy: Boolean,
    onUse: () -> Unit,
    onInstall: () -> Unit,
    onCancelDownload: () -> Unit,
    onRemoveRequest: () -> Unit,
) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            ProviderIcon(providerId = "local", size = 18.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    MiddleEllipsisText(
                        text = row.entry.name,
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.textPrimary,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (row.entry.recommended == true) {
                        Tag("RECOMMENDED", c.success)
                    }
                }
                Text(
                    localMetaLine(row.entry),
                    style = MaterialTheme.typography.labelSmall,
                    color = c.textMuted,
                    maxLines = 1,
                )
            }
            LocalTrailingControl(row, busy, onUse, onInstall, onCancelDownload, onRemoveRequest)
        }
        val state = row.state
        if (state is ModelManagement.LocalModelState.Downloading) {
            LinearProgressIndicator(
                progress = { state.percent / 100f },
                modifier = Modifier.fillMaxWidth(),
                color = c.accent,
            )
        }
        row.fitWarnings.forEach { warning ->
            Text("⚠ ${warning.text}", style = MaterialTheme.typography.labelSmall, color = c.warning, maxLines = 2)
        }
    }
}

@Composable
private fun LocalTrailingControl(
    row: ModelManagement.LocalModelRow,
    busy: Boolean,
    onUse: () -> Unit,
    onInstall: () -> Unit,
    onCancelDownload: () -> Unit,
    onRemoveRequest: () -> Unit,
) {
    val c = OmTheme.colors
    when (val state = row.state) {
        is ModelManagement.LocalModelState.Downloading -> Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("${state.percent}%", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
            TextButton(onClick = onCancelDownload, enabled = !busy) { Text("Cancel", color = c.danger) }
        }
        ModelManagement.LocalModelState.Installed -> Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            TextButton(onClick = onUse, enabled = !busy) { Text("Use", color = c.accent) }
            TextButton(onClick = onRemoveRequest, enabled = !busy) { Text("Remove", color = c.danger) }
        }
        ModelManagement.LocalModelState.Available ->
            TextButton(onClick = onInstall, enabled = !busy) { Text("Install", color = c.accent) }
    }
}

@Composable
private fun Tag(text: String, color: androidx.compose.ui.graphics.Color) {
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

private fun localMetaLine(entry: CatalogEntry): String {
    val parts = mutableListOf(ModelManagement.formatBytes(entry.sizeBytes))
    entry.params?.takeIf { it.isNotBlank() }?.let { parts += it }
    entry.quant?.takeIf { it.isNotBlank() }?.let { parts += it }
    entry.minRamGb?.let { ram ->
        val v = if (ram == kotlin.math.floor(ram)) ram.toInt().toString() else String.format(java.util.Locale.US, "%.1f", ram)
        parts += "$v GB RAM"
    }
    return parts.joinToString(" · ")
}

@Composable
private fun OptionRow(option: ModelManagement.PickerOption, onPick: (ModelManagement.PickerOption) -> Unit) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .testTag("model-option-${option.id}")
            .background(c.bgSecondary, RoundedCornerShape(12.dp))
            .clickable { onPick(option) }
            .padding(OmSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        BackendBrandIcon(key = option.providerId, size = 18.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            MiddleEllipsisText(
                text = option.label,
                style = MaterialTheme.typography.bodyMedium,
                color = c.textPrimary,
                modifier = Modifier.fillMaxWidth(),
            )
            MiddleEllipsisText(
                text = option.detail,
                style = MaterialTheme.typography.labelSmall,
                color = c.textMuted,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun NoticeBanner(notice: ModelsViewModel.Notice, onDismiss: () -> Unit) {
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

/** Centered spinner + caption shown while the overview loads. Mirrors iOS. */
@Composable
private fun ModelsLoading() {
    val c = OmTheme.colors
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        OmSpinner(color = c.accent)
        Text(
            "Loading models…",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = OmSpacing.sm),
        )
    }
}

/**
 * Maps the gateway's Lucide icon slugs (CAPABILITY_METADATA[...].icon) to the
 * nearest Material icon. Generic capability presentation, not source-specific.
 */
object ModelCapabilityIcon {
    fun icon(slug: String): ImageVector = when (slug) {
        "binary" -> Icons.Default.Numbers
        "bot" -> Icons.Default.SmartToy
        "shield-check" -> Icons.Default.Shield
        "mic" -> Icons.Default.Mic
        "scan-text" -> Icons.Default.DocumentScanner
        else -> Icons.Default.SmartToy
    }
}

// --- previews ---

private fun sampleCapabilities() = listOf(
    CapabilityMeta("embedder", "Embedder", "Turns your documents into vectors so search can find things by meaning.", "binary", section = "core"),
    CapabilityMeta("agent", "Agent", "The conversational model that answers questions over your corpus.", "bot", section = "cognition"),
    CapabilityMeta(
        "privacy-reviewer",
        "Privacy reviewer",
        "Reviews answers before they leave the Omnesis sandbox.",
        "shield-check",
        section = "core",
    ),
    CapabilityMeta("transcriber", "Transcriber", "Converts voice notes and audio into searchable text.", "mic", section = "core"),
    CapabilityMeta("ocr", "OCR", "Reads text out of images and scanned PDFs.", "scan-text", section = "core"),
    CapabilityMeta(
        "background-agent",
        "Background agent",
        "The model behind Omnesis Briefs: it runs headlessly to maintain open loops and surface briefs.",
        "bot",
        experimental = true,
        section = "cognition",
    ),
    CapabilityMeta(
        "entailment-verifier",
        "Entailment verifier",
        "Checks that a memory claim is supported by its quoted evidence before it persists.",
        "shield-check",
        experimental = true,
        section = "cognition",
    ),
    CapabilityMeta(
        "brief-judge",
        "Brief judge",
        "Decides whether a candidate brief is worth interrupting you for.",
        "shield-check",
        experimental = true,
        section = "cognition",
    ),
)

internal fun sampleModelsOverview() = ModelsOverview(
    assignmentDisplays = mapOf(
        "embedder" to ModelDisplay("local", "Local", "nomic-embed-text-v1.5", available = true, configured = true),
        "agent" to ModelDisplay("codex", "Codex", "GPT Example Frontier", available = true, configured = true),
        "privacy-reviewer" to ModelDisplay("codex", "Codex", "GPT Example Mini", available = true, configured = true),
        "ocr" to ModelDisplay("http", "Studio Northstar", "dots-ocr", available = false, configured = true),
        "background-agent" to ModelDisplay("codex", "Codex", "GPT Example Frontier", available = true, configured = true),
    ),
    capabilities = sampleCapabilities(),
    inference = InferenceOverview(
        backends = mapOf(
            "northstar" to BackendStatus(
                type = "http",
                status = "ok",
                url = "http://example.local:9000/v1",
                models = listOf("dots-ocr", "llama-vision-8b"),
                modelRoles = mapOf("dots-ocr" to listOf("ocr"), "llama-vision-8b" to listOf("ocr", "agent")),
                hasApiKey = false,
            ),
        ),
        codex = CodexBackendStatus(
            configured = true,
            status = "ok",
            loggedIn = true,
            models = listOf("gpt-example-frontier", "gpt-example-mini"),
            modelDetails = listOf(
                CodexModelStatus(
                    id = "gpt-example-frontier",
                    name = "GPT Example Frontier",
                    description = "Example Codex model.",
                    recommended = true,
                ),
                CodexModelStatus(id = "gpt-example-mini", name = "GPT Example Mini"),
            ),
            modelRoles = mapOf(
                "gpt-example-frontier" to listOf("agent", "background-agent"),
                "gpt-example-mini" to listOf("agent", "privacy-reviewer", "background-agent"),
            ),
            refreshedAt = "2026-07-03T12:00:00Z",
        ),
        assignments = mapOf(
            "embedder" to ResolvedAssignment("local", available = true),
            "agent" to ResolvedAssignment("codex", available = true),
            "privacy-reviewer" to ResolvedAssignment("codex", available = true),
            "transcriber" to ResolvedAssignment("unresolved"),
            "ocr" to ResolvedAssignment("http", available = false, reason = "Backend unreachable"),
            "background-agent" to ResolvedAssignment("codex", available = true),
            "entailment-verifier" to ResolvedAssignment("unresolved"),
        ),
    ),
    catalog = listOf(
        CatalogEntry("gguf", "nomic-embed-text-v1.5.Q8_0", "nomic-embed-text-v1.5", listOf("embed"), sizeBytes = 274_000_000, minRamGb = 2.0, recommendedRamGb = 4.0, quant = "Q8_0", params = "137M", recommended = true),
        CatalogEntry("gguf", "example-embed-v1.Q4_K_M", "example-embed-v1", listOf("embed"), sizeBytes = 512_000_000, minRamGb = 8.0, recommendedRamGb = 12.0, quant = "Q4_K_M", params = "560M"),
        CatalogEntry("gguf", "example-embed-large.Q8_0", "example-embed-large", listOf("embed"), sizeBytes = 1_200_000_000, minRamGb = 4.0, quant = "Q8_0", params = "1.2B"),
        CatalogEntry("anthropic-api", "anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6", listOf("agent")),
    ),
    installed = listOf(ManifestEntry("nomic-embed-text-v1.5.Q8_0")),
    activeDownloads = listOf(
        ActiveDownload(
            downloadId = "dl-1",
            modelId = "example-embed-v1.Q4_K_M",
            filename = "example-embed-v1.Q4_K_M.gguf",
            progress = DownloadProgress(downloadedBytes = 215_000_000, totalBytes = 512_000_000, speedBytesPerSec = 8_400_000, etaMs = 35_000),
            startedAt = "2026-01-01T00:00:00Z",
        ),
    ),
    presets = samplePresets(),
)

internal fun sampleSystemInfo() = SystemInfo(totalRamGb = 16.0, freeRamGb = 6.0, modelsDirFreeGb = 40.0)

private val previewConnection = ConnectionState.Connected("d", "Gateway", listOf("admin"))

@Preview(name = "Models · capabilities · dark")
@Composable
private fun ModelsPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        ModelsContent(Loadable.Content(sampleModelsOverview()), previewConnection, onBack = {}, onRetry = {})
    }
}

@Preview(name = "Models · capabilities · light")
@Composable
private fun ModelsPreviewLight() {
    OmnesisTheme(darkTheme = false) {
        ModelsContent(Loadable.Content(sampleModelsOverview()), previewConnection, onBack = {}, onRetry = {})
    }
}

@Preview(name = "Models · loading · dark")
@Composable
private fun ModelsPreviewLoadingDark() {
    OmnesisTheme(darkTheme = true) {
        ModelsContent(Loadable.Loading, previewConnection, onBack = {}, onRetry = {})
    }
}
