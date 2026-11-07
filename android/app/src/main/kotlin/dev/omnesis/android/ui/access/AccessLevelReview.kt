// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

@Composable
internal fun AccessLevelOverview(draft: AccessLevelDraft, overview: AccessOverview, change: (AccessLevelPage) -> Unit) {
    AccessOverviewRow("Name", draft.name, "Change name") { change(AccessLevelPage.REVIEW) }
    AccessOverviewRow("Permissions", listOf(AccessCapability.ANSWER, AccessCapability.DIRECT, AccessCapability.NOTES)
        .filter { draft.rule(it) != null }.joinToString { it.title }, "Change permissions") { change(AccessLevelPage.PERMISSIONS) }
    draft.readingCapabilities.forEach { cap ->
        AccessOverviewRow("${cap.title} data", ruleDataSummary(draft.rule(cap)!!, overview), "Change ${cap.title} data") {
            change(if (cap == AccessCapability.ANSWER) AccessLevelPage.ANSWER_DATA else AccessLevelPage.DIRECT_DATA)
        }
    }
    if (draft.readingCapabilities.isNotEmpty()) AccessOverviewRow("New sources", draft.readingCapabilities.joinToString("\n") {
        "${it.title}: ${if (futureAllowed(draft.rule(it)!!.sources)) "allowed automatically" else "blocked until allowed"}"
    }, "Change new sources") { change(AccessLevelPage.FUTURE) }
    if (draft.rule(AccessCapability.ANSWER) != null) AccessOverviewRow("Answer release", releaseSummary(draft.rule(AccessCapability.ANSWER), overview), "Change Answer release") { change(AccessLevelPage.RELEASE) }
}

@Composable
private fun AccessOverviewRow(title: String, summary: String, label: String, change: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(summary, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton(enabled = LocalAccessEditingEnabled.current, onClick = change, modifier = Modifier.defaultMinSize(minHeight = 48.dp).semantics { contentDescription = label }) { Text("Change") }
        }
        HorizontalDivider()
    }
}

@Composable
internal fun AccessLevelReview(draft: AccessLevelDraft, overview: AccessOverview, session: ScopePreviewSession, update: (AccessLevelDraft) -> Unit, change: (AccessLevelPage) -> Unit) {
    val nameError = draft.nameError(overview)
    OutlinedTextField(draft.name, { update(draft.copy(name = it)) }, label = { Text("Access level name") },
        enabled = LocalAccessEditingEnabled.current, isError = nameError != null, supportingText = { Text(nameError ?: "${draft.name.trim().length}/120") },
        singleLine = true, modifier = Modifier.fillMaxWidth())
    if (draft.id == "new") AccessGrantSummary(draft.serializedRules, overview, session, change, linked = draft.directSameAsAnswer && draft.rule(AccessCapability.ANSWER) != null && draft.rule(AccessCapability.DIRECT) != null)
    else {
        val changes = draft.changes(overview)
        if (changes.isEmpty()) Text("No changes yet.", style = MaterialTheme.typography.bodyLarge)
        changes.forEach { difference ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(difference.title, style = MaterialTheme.typography.titleMedium)
                if (difference.title.endsWith(" data")) {
                    val capability = if (difference.title.startsWith("Answer")) AccessCapability.ANSWER else AccessCapability.DIRECT
                    ChangedSourcePolicies(draft, overview, capability, session)
                } else {
                    Text("Before", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(difference.before, style = MaterialTheme.typography.bodyLarge)
                    Text("After", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    Text(difference.after, style = MaterialTheme.typography.bodyLarge)
                }
                HorizontalDivider()
            }
        }
        if (draft.rule(AccessCapability.DIRECT) != null && changes.any { it.title == "Permissions" || it.title == "Direct data" }) Text("Direct can read originals without Answer’s privacy review.", style = MaterialTheme.typography.bodyLarge)
        var showUnchanged by remember { mutableStateOf(false) }
        TextButton(onClick = { showUnchanged = !showUnchanged }) { Text(if (showUnchanged) "Hide full settings" else "Inspect full settings") }
        if (showUnchanged) AccessGrantSummary(draft.serializedRules, overview, session)
    }
}

@Composable
private fun ChangedSourcePolicies(draft: AccessLevelDraft, overview: AccessOverview, capability: AccessCapability, session: ScopePreviewSession) {
    val before = (draft.originalLevel ?: overview.levels.firstOrNull { it.id == draft.id })?.rules?.firstOrNull { it.capability == capability }
    val after = draft.serializedRules.firstOrNull { it.capability == capability }
    val ids = (overview.sources.map { it.id } + before?.sources?.sourceIds.orEmpty() + after?.sources?.sourceIds.orEmpty() + before?.scopePolicies.orEmpty().map { it.sourceId } + after?.scopePolicies.orEmpty().map { it.sourceId }).distinct()
    ids.forEach { id ->
        val oldPolicy = before?.scopePolicies?.firstOrNull { it.sourceId == id }
        val newPolicy = after?.scopePolicies?.firstOrNull { it.sourceId == id }
        val oldAllowed = before?.let { sourceAllowed(it.sources, id) } == true
        val newAllowed = after?.let { sourceAllowed(it.sources, id) } == true
        if (!sameScopeSettings(listOfNotNull(oldPolicy), listOfNotNull(newPolicy)) || oldAllowed != newAllowed) {
            val source = overview.sources.firstOrNull { it.id == id } ?: AccessSourceInstance(id, "Unavailable account", available = false)
            Text(source.name + source.accountLabel()?.let { " · $it" }.orEmpty(), style = MaterialTheme.typography.titleSmall)
            Text("Before: ${if (oldAllowed) scopePolicySummary(oldPolicy, source) else "Not allowed"}", style = MaterialTheme.typography.bodyLarge)
            if (oldPolicy != null && oldAllowed) AccessPolicySummary(oldPolicy, source, session)
            Text("After: ${if (newAllowed) scopePolicySummary(newPolicy, source) else "Not allowed"}", style = MaterialTheme.typography.bodyLarge)
            if (newPolicy != null && newAllowed) AccessPolicySummary(newPolicy, source, session)
            if (oldPolicy != null && newPolicy != null && oldPolicy.rules.flatMap { it.match }.map(::scopeRefKey).toSet() != newPolicy.rules.flatMap { it.match }.map(::scopeRefKey).toSet()) {
                var identifiers by remember(oldPolicy, newPolicy) { mutableStateOf(false) }
                TextButton(onClick = { identifiers = !identifiers }) { Text(if (identifiers) "Hide selection identifiers" else "Inspect selection identifiers") }
                if (identifiers) {
                    fun details(policy: ScopePolicy) = policy.rules.flatMap { it.match }.joinToString("\n") { ref ->
                        "${scopeKindTitle(ref.kind, source)}: ${ref.id ?: ref.identifiers?.joinToString { it.value }.orEmpty()}"
                    }
                    Text("Before identifiers\n${details(oldPolicy)}", style = MaterialTheme.typography.bodyMedium)
                    Text("After identifiers\n${details(newPolicy)}", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

@Composable
private fun AccessGrantSummary(rules: List<AccessGrantRule>, overview: AccessOverview, session: ScopePreviewSession, change: ((AccessLevelPage) -> Unit)? = null, linked: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ReviewTopic("Permissions", AccessLevelPage.PERMISSIONS, change)
        listOf(AccessCapability.ANSWER, AccessCapability.DIRECT, AccessCapability.NOTES).filter { cap -> rules.any { it.capability == cap } }
            .forEach { Text(it.outcome, style = MaterialTheme.typography.bodyLarge) }
    }
    listOf(AccessCapability.ANSWER, AccessCapability.DIRECT).forEach { cap ->
        rules.firstOrNull { it.capability == cap }?.let { rule ->
            HorizontalDivider()
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ReviewTopic("${cap.title} data", if (cap == AccessCapability.ANSWER) AccessLevelPage.ANSWER_DATA else AccessLevelPage.DIRECT_DATA, change)
                if (linked && cap == AccessCapability.DIRECT) {
                    Text("Direct uses the same data as Answer, including its filters and new-source choice.", style = MaterialTheme.typography.bodyLarge)
                    Text("Direct reads originals without Answer’s privacy review.", style = MaterialTheme.typography.bodyLarge)
                } else {
                    val retained = (rule.sources.sourceIds + rule.scopePolicies.map { it.sourceId }).distinct().filter { id -> overview.sources.none { it.id == id } }
                    val inventory = overview.sources + retained.map { AccessSourceInstance(it, "Unavailable account", available = false) }
                    inventory.filter { sourceAllowed(rule.sources, it.id) }.forEach { source ->
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(source.name + source.accountLabel()?.let { " · $it" }.orEmpty(), style = MaterialTheme.typography.titleSmall)
                            if (!source.available) Text("Unavailable · saved boundary retained", style = MaterialTheme.typography.bodyMedium)
                            val policy = rule.scopePolicies.firstOrNull { it.sourceId == source.id }
                            Text(scopePolicySummary(policy, source), style = MaterialTheme.typography.bodyLarge)
                            if (policy != null) AccessPolicySummary(policy, source, session)
                        }
                    }
                    val excluded = inventory.filter { rule.sources.mode == AccessSourceMode.DENYLIST && it.id in rule.sources.sourceIds }
                    if (excluded.isNotEmpty()) Text("Excluded accounts: " + excluded.joinToString { it.name + it.accountLabel()?.let { label -> " · $label" }.orEmpty() }, style = MaterialTheme.typography.bodyLarge)
                    if (change != null) TextButton(enabled = LocalAccessEditingEnabled.current, onClick = { change(AccessLevelPage.FUTURE) }) { Text("Change new sources for ${cap.title}") }
                    Text("New sources: ${if (futureAllowed(rule.sources)) "allowed automatically" else "blocked until you allow them"}.", style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
    }
    rules.firstOrNull { it.capability == AccessCapability.ANSWER }?.let {
        HorizontalDivider()
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ReviewTopic("Answer release", AccessLevelPage.RELEASE, change)
            Text(releaseSummary(it, overview), style = MaterialTheme.typography.bodyLarge)
        }
    }
    if (!linked && rules.any { it.capability == AccessCapability.DIRECT }) Text("Direct reads originals without Answer’s privacy review.", style = MaterialTheme.typography.bodyLarge)
}

@Composable
internal fun AccessPolicySummary(policy: ScopePolicy, source: AccessSourceInstance, session: ScopePreviewSession) {
    var preview by remember(session, policy.sourceId, policy.audience.capability) { mutableStateOf<ScopePreview?>(null) }
    var current by remember(session, policy.sourceId, policy.audience.capability) { mutableStateOf<ScopePolicy?>(null) }
    var failed by remember { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    LaunchedEffect(session, policy, retry) {
        current = null; preview = null; failed = false
        try {
            val value = session.preview(policy)
            coroutineContext.ensureActive(); preview = value; current = policy
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { coroutineContext.ensureActive(); failed = true }
    }
    val refs = policy.rules.flatMap { it.match }
    var allItems by remember(policy) { mutableStateOf(false) }
    (if (allItems) refs else refs.take(3)).forEach { ref ->
        val label = session.label(source.id, ref) ?: preview?.items?.firstOrNull { scopeRefKey(it.ref) == scopeRefKey(ref) }?.label
            ?: ref.identifiers?.joinToString { it.value } ?: "${scopeKindTitle(ref.kind, source)} · label unavailable"
        Text(label, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (refs.size > 3) TextButton(onClick = { allItems = !allItems }) { Text(if (allItems) "Show fewer selected items" else "Inspect all ${refs.size} selected items") }
    when {
        failed -> {
            Text("Counts unavailable. The restriction itself is unchanged.", style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = { retry += 1 }) { Text("Retry counts") }
        }
        current == policy -> Text("${preview?.visible ?: 0} records available · uncertain records remain hidden", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else -> Text("Checking counts…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ReviewTopic(title: String, page: AccessLevelPage, change: ((AccessLevelPage) -> Unit)?) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        if (change != null) TextButton(enabled = LocalAccessEditingEnabled.current, onClick = { change(page) }, modifier = Modifier.defaultMinSize(minHeight = 48.dp).semantics { contentDescription = "Change $title" }) { Text("Change") }
    }
}
