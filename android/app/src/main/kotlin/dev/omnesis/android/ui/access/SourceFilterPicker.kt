// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

/**
 * The second step of a filter: the content of one account to match, by kind. Choices can be ticked as soon
 * as they are listed; a count that is still being prepared shows a spinner and arrives by itself.
 */
@Composable
internal fun SourceFilterPicker(
    source: AccessSourceInstance, gateway: ScopeEditorGateway, onClose: () -> Unit,
    capability: String = "answer", initialSelection: List<ScopeRef> = emptyList(),
    state: SourceFilterPickerState? = null, icon: SourceIconModel = SourceIconModel(), nameFor: (String) -> String? = { null },
    onBack: (() -> Unit)? = null, onSelectionChange: ((List<ScopeRef>) -> Unit)? = null, selected: (List<ScopeRef>) -> Unit,
) {
    val colors = AccessUi.colors
    val compact = WindowInsets.ime.getBottom(LocalDensity.current) > 0 || LocalDensity.current.fontScale > 1.3f
    val session = remember(gateway) { gateway.previewSession() }
    val names by session.labels.collectAsState()
    val picker = remember(source.id, capability) { state ?: SourceFilterPickerState.opening(source) }
    val original = remember(source.id, capability) { initialSelection.distinctBy(::scopeRefKey).associateBy(::scopeRefKey) }
    val originalOrder = remember(source.id, capability) { original.keys.withIndex().associate { it.value to it.index } }
    var refs by remember(source.id, capability) { mutableStateOf(initialSelection.distinctBy(::scopeRefKey)) }
    var viewing by remember { mutableStateOf(false) }
    val kinds = (source.scopes ?: picker.options?.scopes)?.items.orEmpty()
    val declaration = kinds.firstOrNull { it.kind == picker.kind }
    val ready = (picker.options?.readiness ?: source.scopeReadiness.orEmpty()).firstOrNull { it.kind == picker.kind }?.ready == true
    fun setRefs(value: List<ScopeRef>) {
        val selection = value.distinctBy(::scopeRefKey).sortedBy { originalOrder[scopeRefKey(it)] ?: Int.MAX_VALUE }
        refs = selection; onSelectionChange?.invoke(selection)
    }
    fun isSelected(ref: ScopeRef) = refs.any { scopeRefKey(it) == scopeRefKey(ref) }
    fun toggle(ref: ScopeRef) {
        val key = scopeRefKey(ref)
        setRefs(if (isSelected(ref)) refs.filterNot { scopeRefKey(it) == key } else refs + (original[key] ?: ref))
    }
    fun back() { if (picker.enteringIdentifier) picker.enteringIdentifier = false else (onBack ?: onClose)() }
    val addresses = declaration?.identifiers.orEmpty().takeIf { picker.kind == "participant" }.orEmpty()
    val typedId = picker.identifierType.takeIf { it in addresses }?.let { scopeTypedIdentifier(picker.typed, it) }
    val duplicate = typedId != null && refs.any { typedId in it.identifiers.orEmpty() }
    val withinLimits = ScopePolicy.empty(source.id, NEW_ACCESS_LEVEL_ID, capability).copy(rules = listOf(ScopeRule(refs, "hide"))).withinLimits
    fun addAddress() {
        if (typedId != null && !duplicate) {
            setRefs(refs + ScopeRef("participant", label = typedId.value, identifiers = listOf(typedId)))
            picker.typed = ""; picker.enteringIdentifier = false
        }
    }
    LaunchedEffect(picker.kind, declaration?.identifiers) {
        if (picker.identifierType !in declaration?.identifiers.orEmpty()) picker.identifierType = declaration?.identifiers?.firstOrNull().orEmpty()
    }
    val page = picker.page
    LaunchedEffect(session, picker.location, page.cursor, page.retry, page.poll) {
        // A page already listed is read again only to refresh its counts, and keeps what it lists meanwhile.
        val refreshing = page.loaded && page.loadedCursor == page.cursor
        if (refreshing && page.polled == page.poll) return@LaunchedEffect
        val token = Any(); page.request = token
        val asked = page.poll
        if (!refreshing) { page.loading = true; if (!page.loaded) page.listState.scrollToItem(0) }
        try {
            val value = session.options(source.id, picker.kind, picker.query, picker.parent, if (refreshing) null else page.cursor)
            coroutineContext.ensureActive()
            if (page.request !== token) return@LaunchedEffect
            val listed = page.options
            page.options = if (refreshing && listed != null) value.copy(items = mergeScopeOptions(listed.items, value.items), nextCursor = if (page.cursor == null) value.nextCursor else listed.nextCursor)
                else value.copy(items = mergeScopeOptions(if (page.cursor == null) emptyList() else listed?.items.orEmpty(), value.items))
            page.loaded = true; page.loadedCursor = page.cursor; page.error = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { coroutineContext.ensureActive(); if (!refreshing) page.error = accessManagementError(error, reading = true) }
        finally { page.polled = asked; if (page.request === token) page.loading = false }
    }
    AccessAutoRefresh(!picker.enteringIdentifier && page.loaded && !ready && page.error == null) { page.poll++ }
    val title = capabilityTitle(capability)
    val account = source.accountName(nameFor)
    Dialog(onDismissRequest = ::back, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = colors.background) {
            AccessTaskScaffold(
                title = if (compact && !picker.enteringIdentifier) "$title · ${account.source}" else "$title filter",
                question = if (picker.enteringIdentifier) addAddressLabel(addresses) else "Choose matching content",
                primary = if (picker.enteringIdentifier) "Add" else "Review filter",
                enabled = if (picker.enteringIdentifier) typedId != null && !duplicate else refs.isNotEmpty() && withinLimits,
                onPrimary = { if (picker.enteringIdentifier) addAddress() else selected(refs) },
                leading = "Back", onLeading = ::back, onCancel = onClose, scrollable = picker.enteringIdentifier, compactHeader = compact && !picker.enteringIdentifier,
                account = { AccessAccountLine(account, icon) },
            ) {
                if (picker.enteringIdentifier) {
                    if (addresses.size > 1) {
                        AccessKindTabs(addresses.map { it to addressTitle(it) }, picker.identifierType) { picker.identifierType = it; picker.typed = "" }
                        AccessGap(16.dp)
                    }
                    AccessTextField(picker.typed, { picker.typed = it }, label = addressTitle(picker.identifierType))
                    AccessGap(12.dp)
                    Text(when {
                        duplicate -> "This one is already selected."
                        typedId != null -> "Matches ${typedId.value}"
                        picker.typed.isNotBlank() -> invalidAddressMessage(picker.identifierType)
                        picker.identifierType == "phone" -> "Include the international country code."
                        else -> "Only this exact entry will be added."
                    }, style = AccessType.RowSecondary, color = colors.secondary)
                } else {
                    if (kinds.size > 1) {
                        AccessKindTabs(kinds.map { it.kind to scopeKindTitle(it.kind, source) }, picker.kind, picker::chooseKind)
                        AccessGap(16.dp)
                    }
                    AccessTextField(picker.query, { picker.query = it }, label = "Search ${scopeKindTitle(picker.kind, source).lowercase()}", search = true)
                    AccessGap(8.dp)
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("${refs.size} selected", style = AccessType.RowSecondary.copy(fontWeight = FontWeight.SemiBold), color = colors.primary, modifier = Modifier.weight(1f))
                        AccessTextAction("View selected", enabled = refs.isNotEmpty(), alignment = Alignment.CenterEnd) { viewing = true }
                    }
                    if (!withinLimits) Text("$FILTER_LIMIT_MESSAGE Remove some under View selected.", style = AccessType.RowSecondary, color = colors.danger, modifier = Modifier.padding(bottom = 8.dp))
                    if (declaration?.picker == "tree") { FolderLocation(scopeTreeRootLabel(picker.kind, source), picker.ancestors.map { it.label }, picker::goToAncestor); AccessGap(4.dp) }
                    picker.error?.let { Text(it, style = AccessType.RowSecondary, color = colors.danger); AccessTextAction("Try again") { page.retry++ } }
                    if (picker.loading && picker.options == null) Box(Modifier.padding(vertical = 12.dp)) { AccessSpinner(20.dp) }
                    val options = picker.options?.items.orEmpty()
                    val current = picker.ancestors.lastOrNull().takeIf { declaration?.picker == "tree" }
                    val more = picker.options?.nextCursor
                    LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = picker.listState) {
                        if (current != null) item(key = "current-folder") {
                            val level = scopeLevelNoun(picker.kind, source, picker.ancestors.lastIndex)?.one ?: scopeKindCaption(picker.kind, source).lowercase()
                            ChoiceRow("Select this $level", isSelected(current.ref), current.count.takeIf { ready }, counting = !ready, last = options.isEmpty() && addresses.isEmpty()) { toggle(current.ref) }
                        }
                        itemsIndexed(options, key = { _, item -> scopeRefKey(item.ref) }) { index, item ->
                            ChoiceRow(item.label, isSelected(item.ref), item.count.takeIf { ready }, counting = !ready, last = index == options.lastIndex && more == null && addresses.isEmpty(),
                                open = if (item.hasChildren == true) { { picker.open(item) } } else null) { toggle(item.ref) }
                        }
                        if (!picker.loading && picker.error == null && options.isEmpty() && current == null) item { Text("No matching options.", style = AccessType.RowSecondary, color = colors.secondary, modifier = Modifier.padding(vertical = 16.dp)) }
                        if (more != null) item { AccessTextAction("Load more", Modifier.fillMaxWidth().padding(vertical = 6.dp), enabled = !picker.loading) { page.cursor = more } }
                        if (addresses.isNotEmpty()) item { AccessAddRow(addAddressLabel(addresses)) { picker.enteringIdentifier = true } }
                    }
                }
            }
        }
    }
    if (viewing) AccessDialog(title = SELECTED_FILTERS_TITLE, confirm = "Done", onConfirm = { viewing = false }, onDismiss = { viewing = false }) {
        if (refs.isEmpty()) Text("Nothing is selected.", style = AccessType.Subtitle, color = colors.secondary)
        refs.forEachIndexed { index, ref ->
            val listed = (picker.options?.items.orEmpty() + picker.ancestors).firstOrNull { scopeRefKey(it.ref) == scopeRefKey(ref) }
            AccessSelectedFilterRow(ref, source, names, last = index == refs.lastIndex, depth = listed?.depth) { setRefs(refs.filterNot { scopeRefKey(it) == scopeRefKey(ref) }) }
        }
    }
}

/** One choice: a tick box, its name, how many records it matches, and for a folder with subfolders a way in. */
@Composable
private fun ChoiceRow(label: String, checked: Boolean, count: Long?, counting: Boolean, last: Boolean, open: (() -> Unit)? = null, toggle: () -> Unit) {
    val colors = AccessUi.colors
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).toggleable(value = checked, role = Role.Checkbox, onValueChange = { toggle() }).padding(vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AccessCheckMark(checked)
                Text(label, style = AccessType.RowTitle.copy(fontWeight = FontWeight.Normal), color = colors.primary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (count != null) AccessMatchCount(count) else if (counting) AccessSpinner()
            }
            if (open != null) Box(Modifier.size(44.dp).clickable(role = Role.Button, onClick = open).semantics { contentDescription = "Open $label" }, contentAlignment = Alignment.CenterEnd) {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = colors.secondary, modifier = Modifier.size(22.dp))
            }
        }
        if (!last) AccessDivider(34.dp)
    }
}

/**
 * Where the tree's list is: its [root] ("All folders") and each item opened below it. The last entry is the current
 * location and is plain text; an entry before it goes up to that item.
 */
@Composable
private fun FolderLocation(root: String, trail: List<String>, goTo: (Int) -> Unit) {
    val colors = AccessUi.colors
    val entries = listOf(root) + trail
    Column(Modifier.padding(top = 8.dp)) {
        Text("Location", style = AccessType.Small, color = colors.secondary)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
            entries.forEachIndexed { index, label ->
                if (index > 0) Text("›", style = AccessType.RowTitle, color = colors.muted, modifier = Modifier.padding(horizontal = 8.dp))
                if (index == entries.lastIndex) Text(label, style = AccessType.RowTitle, color = colors.primary, modifier = Modifier.semantics { contentDescription = "Current location: $label" })
                else Text(label, style = AccessType.RowTitle, color = colors.accent,
                    modifier = Modifier.clickable(role = Role.Button, onClickLabel = "Go up to $label") { goTo(index - 1) }.padding(vertical = 12.dp))
            }
        }
    }
}

/** What a typed address that names none of its type says. */
private fun invalidAddressMessage(type: String): String = when (type) {
    "phone" -> "Enter a valid phone number."
    "email" -> "Enter a valid email address."
    "domain" -> "Enter a valid domain."
    else -> "Enter a valid address."
}

private fun addressTitle(type: String): String = when (type) {
    "phone" -> "Phone number"
    "email" -> "Email address"
    "domain" -> "Email domain"
    else -> "Address"
}

/** The action that adds a typed address, naming only the kinds the source accepts: "Add an email, domain or phone number". */
internal fun addAddressLabel(types: List<String>): String {
    val words = listOf("email" to "an email", "domain" to "a domain", "phone" to "a phone number").filter { it.first in types }.map { it.second }
    if (words.isEmpty()) return "Add an address"
    val rest = words.drop(1).map { it.substringAfter(' ') }
    return "Add " + if (rest.isEmpty()) words.first() else (listOf(words.first()) + rest.dropLast(1)).joinToString(", ") + " or " + rest.last()
}
