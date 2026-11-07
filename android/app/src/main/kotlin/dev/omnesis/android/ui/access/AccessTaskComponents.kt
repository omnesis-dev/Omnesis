// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp

internal val LocalAccessEditingEnabled = staticCompositionLocalOf { true }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AccessTaskScaffold(
    title: String, question: String, description: String? = null, progress: String? = null,
    primary: String, enabled: Boolean, onPrimary: () -> Unit, onBack: () -> Unit,
    onCancel: (() -> Unit)? = null, backLabel: String = "Back", footer: String? = null,
    scrollable: Boolean = true, busy: Boolean = false, focusKey: Any? = null, content: @Composable ColumnScope.() -> Unit,
) {
    val scroll = rememberScrollState()
    val focus = remember { FocusRequester() }
    Scaffold(
        topBar = { TopAppBar(title = { Text(title, style = MaterialTheme.typography.titleMedium) },
            navigationIcon = { TextButton(enabled = !busy, onClick = onBack, modifier = Modifier.defaultMinSize(minHeight = 48.dp)) { Text(backLabel) } },
            actions = { onCancel?.let { TextButton(enabled = !busy, onClick = it, modifier = Modifier.defaultMinSize(minHeight = 48.dp)) { Text("Cancel") } } }) },
        bottomBar = { Surface(shadowElevation = 3.dp, tonalElevation = 1.dp) {
            Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                footer?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Button(onClick = onPrimary, enabled = enabled, modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp)) { Text(primary, style = MaterialTheme.typography.titleSmall) }
            }
        } },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().then(if (scrollable) Modifier.verticalScroll(scroll) else Modifier)
            .padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            progress?.let { Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary) }
            Text(question, style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.focusRequester(focus).focusable().semantics { heading() })
            LaunchedEffect(question, focusKey) { if (scrollable) scroll.scrollTo(0); focus.requestFocus() }
            description?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            content()
            if (scrollable) Spacer(Modifier.height(4.dp))
        }
    }
}

@Composable
internal fun AccessChoice(title: String, detail: String, selected: Boolean, enabled: Boolean = true, choose: () -> Unit) {
    val editable = enabled && LocalAccessEditingEnabled.current
    Surface(shape = MaterialTheme.shapes.medium, color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .38f),
        modifier = Modifier.fillMaxWidth().selectable(selected = selected, enabled = editable, role = Role.RadioButton, onClick = choose)) {
        Row(Modifier.padding(16.dp).heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(detail, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            RadioButton(selected, onClick = null, enabled = editable)
        }
    }
}

@Composable
internal fun AccessToggleChoice(title: String, detail: String, checked: Boolean, change: (Boolean) -> Unit) {
    Surface(shape = MaterialTheme.shapes.medium, color = if (checked) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .38f),
        modifier = Modifier.fillMaxWidth().toggleable(enabled = LocalAccessEditingEnabled.current, value = checked, role = Role.Checkbox, onValueChange = change)) {
        Row(Modifier.padding(16.dp).heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(detail, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Checkbox(checked, enabled = LocalAccessEditingEnabled.current, onCheckedChange = null)
        }
    }
}

@Composable
internal fun AccessNotice(message: String, error: Boolean = false) {
    Surface(shape = MaterialTheme.shapes.small, color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceVariant) {
        Text(message, style = MaterialTheme.typography.bodyLarge,
            color = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(16.dp).semantics { liveRegion = if (error) LiveRegionMode.Assertive else LiveRegionMode.Polite })
    }
}
