// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.*

@Composable
fun AccessHomeScreen(onClose: () -> Unit, onConnect: () -> Unit, vm: AccessManagementViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val gateway = remember(vm) { vm.scopeGateway }
    LaunchedEffect(vm) { vm.refresh() }
    BackHandler { if (state.draft != null) vm.closeEditor() else onClose() }
    AccessHomeContent(state, gateway, onClose = { if (state.draft != null) vm.closeEditor() else onClose() },
        onConnect = onConnect, onEdit = vm::edit, onUpdate = vm::update, onSave = vm::save, onDelete = vm::delete,
        onDismissDeleteError = vm::dismissDeleteError, onShowPolicy = vm::showPolicy, onDismissPolicy = vm::dismissPolicy,
        onReload = { vm.refresh(state.draft != null) }, iconFor = vm::sourceIcon, nameFor = vm::sourceName)
}

/**
 * The Access page: every access level with the connections that use it nested under it. The top-right
 * menu adds a level or connects an agent; a tap on a level edits it and a long press offers its deletion.
 * [menuOpen] opens the page with that menu showing.
 */
@Composable
internal fun AccessHomeContent(
    state: AccessManagementState, gateway: FilterEditorGateway, onClose: () -> Unit,
    onConnect: () -> Unit = {}, onEdit: (AccessLevelSummary?) -> Unit = {},
    onUpdate: (AccessLevelDraft) -> Unit = {}, onSave: () -> Unit = {}, onReload: () -> Unit = {},
    onDelete: (AccessLevelSummary) -> Unit = {}, onDismissDeleteError: () -> Unit = {},
    onShowPolicy: (String) -> Unit = {}, onDismissPolicy: () -> Unit = {},
    iconFor: (String) -> SourceIconModel = { SourceIconModel(fallbackInitial = it.take(1)) },
    nameFor: (String) -> String? = { null }, menuOpen: Boolean = false,
) {
    if (state.draft != null && state.overview != null) {
        AccessLevelEditor(state, gateway, iconFor, nameFor, onUpdate, onSave, onClose, onReload, readPolicy = onShowPolicy)
        state.policyPreview?.let { AccessPolicySheet(it, onDismissPolicy) }
        return
    }
    val colors = AccessUi.colors
    val overview = state.overview
    // The level a long press chose to delete: confirmed when nothing uses it, refused with the reason otherwise.
    var deleting by remember { mutableStateOf<AccessLevelSummary?>(null) }
    Column(Modifier.fillMaxSize().background(colors.background)) {
        AccessTopBar("Access", "Back", onClose) { AccessHomeMenu(menuOpen, enabled = overview != null && !state.loading, onNewLevel = { onEdit(null) }, onConnect = onConnect) }
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = AccessUi.Inset).padding(top = 12.dp, bottom = 24.dp)) {
            if (state.loading || state.refreshing) { AccessProgressLine(if (state.deleting) "Deleting…" else "Loading…"); AccessGap(16.dp) }
            state.error?.let { message ->
                AccessNotice(message, error = true)
                AccessTextAction("Try again", onClick = onReload)
                AccessGap(8.dp)
            }
            if (overview != null) {
                if (overview.levels.isEmpty()) Text("No access levels yet.", style = AccessType.Subtitle, color = colors.secondary)
                // Levels are listed by name, whatever their case.
                overview.levels.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name }).forEachIndexed { index, level ->
                    if (index > 0) { AccessGap(20.dp); AccessDivider(); AccessGap(8.dp) }
                    AccessLevelGroup(level, level.users(overview), enabled = !state.loading, edit = { onEdit(level) }, delete = { deleting = level })
                }
                if (overview.levels.isNotEmpty()) {
                    AccessGap(AccessUi.SectionGap)
                    Text("Touch and hold an access level to delete it.", style = AccessType.Small, color = colors.muted)
                }
            }
        }
    }
    deleting?.let { level ->
        val blocker = overview?.let { level.users(it).deletionBlocker }
        if (blocker != null) AccessDeleteRefusedDialog(blocker, inUse = true) { deleting = null }
        else AccessDialog(title = "Delete “${level.name}”?", body = "This cannot be undone.", confirm = "Delete", dismiss = "Cancel", destructive = true,
            onConfirm = { deleting = null; onDelete(level) }, onDismiss = { deleting = null })
    }
    if (deleting == null) state.deleteError?.let { AccessDeleteRefusedDialog(it, inUse = it == ACCESS_LEVEL_IN_USE_HINT, onDismissDeleteError) }
}

/** The page's menu behind "⋯": the two things the page can start. */
@Composable
private fun AccessHomeMenu(initiallyOpen: Boolean, enabled: Boolean, onNewLevel: () -> Unit, onConnect: () -> Unit) {
    val colors = AccessUi.colors
    var open by remember { mutableStateOf(initiallyOpen) }
    Box {
        Box(Modifier.size(44.dp).clickable(enabled = enabled, role = Role.Button) { open = true }.semantics { contentDescription = "More actions" }, contentAlignment = Alignment.CenterEnd) {
            Icon(Icons.Outlined.MoreHoriz, contentDescription = null, tint = if (enabled) colors.accent else colors.muted, modifier = Modifier.size(24.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text(NEW_ACCESS_LEVEL_LABEL, style = AccessType.RowAction) }, leadingIcon = { Icon(Icons.Outlined.Add, contentDescription = null) }, onClick = { open = false; onNewLevel() })
            DropdownMenuItem(text = { Text("Connect an agent", style = AccessType.RowAction) }, leadingIcon = { Icon(Icons.Outlined.Link, contentDescription = null) }, onClick = { open = false; onConnect() })
        }
    }
}

/** A deletion that did not go ahead: a level still [inUse] says what to move first, any other refusal says what failed. */
@Composable
private fun AccessDeleteRefusedDialog(message: String, inUse: Boolean, dismiss: () -> Unit) {
    AccessDialog(title = if (inUse) "This access level is still in use" else "The access level could not be deleted", body = message, confirm = "OK", onConfirm = dismiss, onDismiss = dismiss)
}

/** One level: its name and capability pills, then the connections and integrations that use it. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AccessLevelGroup(level: AccessLevelSummary, users: AccessLevelUsers, enabled: Boolean, edit: () -> Unit, delete: () -> Unit) {
    val colors = AccessUi.colors
    Row(Modifier.fillMaxWidth().combinedClickable(enabled = enabled, role = Role.Button, onClickLabel = "Change", onLongClickLabel = "Delete", onLongClick = delete, onClick = edit).padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(level.name, style = AccessType.Heading, color = colors.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            AccessCapabilityPills(AccessCapabilityHoldings.of(level.rules))
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = colors.muted, modifier = Modifier.size(22.dp))
    }
    // The level's users hang from a rule that ties them to the level above.
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(start = 2.dp, top = 4.dp)) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(colors.divider))
        Column(Modifier.weight(1f).padding(start = 14.dp, top = 6.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (!users.inUse) Text(connectionCountLabel(0), style = AccessType.RowSecondary, color = colors.muted)
            users.connections.forEach { AccessConnectionName(it, integration = false) }
            if (users.connections.isEmpty() && users.connectionCount > 0) Text(connectionCountLabel(users.connectionCount), style = AccessType.RowSecondary, color = colors.secondary)
            users.integrations.forEach { AccessConnectionName(it, integration = true) }
        }
    }
}
