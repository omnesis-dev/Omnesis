// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
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
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

/**
 * The second step of a filter: the content of one account to match, field by field. Each field the account offers is a
 * tab. A field that can take entries lists its choices, which can be ticked as soon as they are listed, a count still
 * being worked out showing a spinner until it arrives. A field that cannot yet says why in the gateway's words, with
 * the one action that helps where there is one, and refreshes by itself.
 */
@Composable
internal fun SourceFilterPicker(
    source: AccessSourceInstance, gateway: FilterEditorGateway, onClose: () -> Unit,
    capability: String = "answer", initialSelection: List<FilterRef> = emptyList(),
    state: SourceFilterPickerState? = null, icon: SourceIconModel = SourceIconModel(), nameFor: (String) -> String? = { null },
    onBack: (() -> Unit)? = null, onSelectionChange: ((List<FilterRef>) -> Unit)? = null, selected: (List<FilterRef>) -> Unit,
) {
    val colors = AccessUi.colors
    val compact = WindowInsets.ime.getBottom(LocalDensity.current) > 0 || LocalDensity.current.fontScale > 1.3f
    val session = remember(gateway) { gateway.editorSession() }
    val hints by session.hints.collectAsState()
    val loaded = rememberFilterEditor(session, source.id)
    val editor = loaded.editor
    val picker = remember(source.id, capability) { state ?: SourceFilterPickerState() }
    // Fields that wait on the same resync of the account are stated once, in the gateway's sentence, above the fields that can be picked from.
    val shared = editor?.resync
    val tabs = editor?.fields.orEmpty().filterNot { shared != null && it.field in shared.fields }
    LaunchedEffect(editor, tabs.map { it.field }) { if (editor != null) picker.settle(tabs) }
    val original = remember(source.id, capability) { initialSelection.distinctBy(::filterRefKey).associateBy(::filterRefKey) }
    val originalOrder = remember(source.id, capability) { original.keys.withIndex().associate { it.value to it.index } }
    var refs by remember(source.id, capability) { mutableStateOf(initialSelection.distinctBy(::filterRefKey)) }
    var viewing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val field = tabs.firstOrNull { it.field == picker.field }
    val ready = field?.state?.ready == true
    fun setRefs(value: List<FilterRef>) {
        val selection = value.distinctBy(::filterRefKey).sortedBy { originalOrder[filterRefKey(it)] ?: Int.MAX_VALUE }
        refs = selection; onSelectionChange?.invoke(selection)
    }
    fun isSelected(ref: FilterRef) = refs.any { filterRefKey(it) == filterRefKey(ref) }
    fun toggle(ref: FilterRef) {
        val key = filterRefKey(ref)
        setRefs(if (isSelected(ref)) refs.filterNot { filterRefKey(it) == key } else refs + (original[key] ?: ref))
    }
    fun back() { if (picker.enteringIdentifier) picker.enteringIdentifier = false else (onBack ?: onClose)() }
    var resyncRequested by remember(source.id) { mutableStateOf(false) }
    // After a resync is asked for, the account's fields are read again until the gateway reports it running.
    AccessAutoRefresh(resyncRequested && editor?.fields?.any { it.state.status == FilterFieldState.NEEDS_RESYNC } == true) { loaded.refresh() }
    val resync: suspend () -> Unit = { session.resync(source.id); resyncRequested = true; loaded.refresh() }
    val addresses = field?.identifiers.orEmpty().takeIf { field?.capability == FilterRef.PERSON && ready }.orEmpty()
    val withinLimits = SourceFilter.empty(source.id, NEW_ACCESS_LEVEL_ID, capability).copy(rules = listOf(FilterRule(refs, "hide"))).withinLimits
    var checking by remember { mutableStateOf(false) }
    // The gateway reads a typed address into its standard form, or says why it cannot.
    fun addAddress() {
        val type = picker.identifierType.takeIf { it in addresses } ?: return
        val typed = picker.typed
        if (typed.isBlank() || checking) return
        checking = true
        scope.launch {
            try {
                val result = session.identifier(type, typed)
                if (picker.typed != typed) return@launch
                val identifier = result.identifier
                when {
                    identifier == null -> picker.identifierError = result.error ?: GENERIC_ADDRESS_MESSAGE
                    refs.any { identifier in it.identifiers.orEmpty() } -> picker.identifierError = ALREADY_SELECTED_MESSAGE
                    else -> {
                        setRefs(refs + FilterRef.person(identifier.value, listOf(identifier)))
                        picker.typed = ""; picker.identifierError = null; picker.enteringIdentifier = false
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { picker.identifierError = accessManagementError(error, reading = true) }
            finally { checking = false }
        }
    }
    LaunchedEffect(picker.field, field?.identifiers) {
        if (picker.identifierType !in field?.identifiers.orEmpty()) picker.identifierType = field?.identifiers?.firstOrNull().orEmpty()
    }
    val page = picker.page
    LaunchedEffect(session, picker.location, page.cursor, page.retry, page.poll, ready) {
        if (!ready) return@LaunchedEffect
        // A page already listed is read again only to refresh its counts, and keeps what it lists meanwhile.
        val refreshing = page.loaded && page.loadedCursor == page.cursor
        if (refreshing && page.polled == page.poll) return@LaunchedEffect
        val token = Any(); page.request = token
        val asked = page.poll
        if (!refreshing) { page.loading = true; if (!page.loaded) page.listState.scrollToItem(0) }
        try {
            val value = session.options(source.id, picker.field, picker.query, picker.parent, picker.device, if (refreshing) null else page.cursor)
            coroutineContext.ensureActive()
            if (page.request !== token) return@LaunchedEffect
            val listed = page.options
            page.options = if (refreshing && listed != null) value.copy(items = mergeFilterOptions(listed.items, value.items), nextCursor = if (page.cursor == null) value.nextCursor else listed.nextCursor)
                else value.copy(items = mergeFilterOptions(if (page.cursor == null) emptyList() else listed?.items.orEmpty(), value.items))
            picker.learnCounts(value.items)
            page.loaded = true; page.loadedCursor = page.cursor; page.error = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { coroutineContext.ensureActive(); if (!refreshing) page.error = accessManagementError(error, reading = true) }
        finally { page.polled = asked; if (page.request === token) page.loading = false }
    }
    // The opened item's own count is read again from the listing it appears in until it is known.
    val opened = picker.current?.takeIf { field?.tree == true }
    val openedPending = opened != null && picker.countOf(opened) == null
    LaunchedEffect(session, picker.location, page.poll, openedPending, ready) {
        if (!ready || !openedPending || opened == null) return@LaunchedEffect
        val (parentId, device) = picker.currentParent
        try {
            var cursor: String? = null
            var pages = 0
            do {
                val listing = session.options(source.id, picker.field, "", parentId, device, cursor)
                picker.learnCounts(listing.items)
                if (listing.items.any { filterRefKey(it.ref) == filterRefKey(opened.ref) }) break
                cursor = listing.nextCursor
            } while (cursor != null && ++pages < MAX_PARENT_PAGES)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* The next poll asks again. */ }
    }
    val pendingCounts = picker.options?.retryAfterMs ?: ACCESS_REFRESH_INTERVAL_MILLIS.takeIf { openedPending }
    AccessAutoRefresh(ready && !picker.enteringIdentifier && page.loaded && pendingCounts != null && page.error == null, pendingCounts ?: ACCESS_REFRESH_INTERVAL_MILLIS) { page.poll++ }
    val title = capabilityTitle(capability)
    val account = source.accountName(nameFor)
    Dialog(onDismissRequest = ::back, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = colors.background) {
            AccessTaskScaffold(
                title = if (compact && !picker.enteringIdentifier) "$title · ${account.source}" else "$title filter",
                question = if (picker.enteringIdentifier) addAddressLabel(addresses) else "Choose matching content",
                primary = if (picker.enteringIdentifier) "Add" else "Review filter",
                enabled = if (picker.enteringIdentifier) picker.typed.isNotBlank() && !checking else refs.isNotEmpty() && withinLimits,
                onPrimary = { if (picker.enteringIdentifier) addAddress() else selected(refs) },
                leading = "Back", onLeading = ::back, onCancel = onClose, scrollable = picker.enteringIdentifier || (field != null && !ready),
                compactHeader = compact && !picker.enteringIdentifier, busy = checking,
                account = { AccessAccountLine(account, icon) },
            ) {
                if (picker.enteringIdentifier) {
                    if (addresses.size > 1) {
                        AccessKindTabs(addresses.map { it to addressTitle(it) }, picker.identifierType) { picker.identifierType = it; picker.typed = ""; picker.identifierError = null }
                        AccessGap(16.dp)
                    }
                    AccessTextField(picker.typed, { picker.typed = it; picker.identifierError = null }, label = addressTitle(picker.identifierType), error = picker.identifierError)
                    if (picker.identifierError == null) {
                        AccessGap(12.dp)
                        Text(if (picker.identifierType == "phone") "Include the international country code." else "Only this exact entry will be added.",
                            style = AccessType.RowSecondary, color = colors.secondary)
                    }
                } else {
                shared?.let {
                    FilterFieldStateBlock(it.fieldState, account.source, onResync = resync)
                    AccessGap(16.dp)
                }
                if (tabs.size > 1) {
                    AccessKindTabs(tabs.map { it.field to it.title }, picker.field, picker::chooseField)
                    AccessGap(16.dp)
                }
                val failure = loaded.failure
                when {
                    editor == null && failure != null -> {
                        Text(accessManagementError(failure, reading = true), style = AccessType.RowSecondary, color = colors.danger)
                        AccessTextAction("Try again", onClick = loaded.retry)
                    }
                    editor == null -> Box(Modifier.padding(vertical = 12.dp)) { AccessProgressLine(LOADING_MESSAGE) }
                    // An account with nothing to filter on says why, in the gateway's words.
                    field == null -> editor.profileText?.let { AccessNotice(it) }
                    !ready -> FilterFieldStateBlock(field.state, account.source, onResync = resync)
                    else -> {
                        AccessTextField(picker.query, { picker.query = it }, label = "Search ${field.title.lowercase()}", search = true)
                        AccessGap(8.dp)
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text("${refs.size} selected", style = AccessType.RowSecondary.copy(fontWeight = FontWeight.SemiBold), color = colors.primary, modifier = Modifier.weight(1f))
                            AccessTextAction("View selected", enabled = refs.isNotEmpty(), alignment = Alignment.CenterEnd) { viewing = true }
                        }
                        if (!withinLimits) Text(FILTER_LIMIT_MESSAGE, style = AccessType.RowSecondary, color = colors.danger, modifier = Modifier.padding(bottom = 8.dp))
                        val browsing = field.tree && picker.query.isBlank()
                        if (field.tree) {
                            FolderLocation(field.rootLabel(editor.showDeviceLevel), picker.ancestors.map { it.shortLabel ?: it.label }, picker::goToAncestor)
                            field.insideText?.let { Text(it, style = AccessType.RowSecondary, color = colors.secondary, modifier = Modifier.padding(bottom = 4.dp)) }
                            AccessGap(4.dp)
                        }
                        picker.error?.let { Text(it, style = AccessType.RowSecondary, color = colors.danger); AccessTextAction("Try again") { page.retry++ } }
                        if (picker.loading && picker.options == null) Box(Modifier.padding(vertical = 12.dp)) { AccessProgressLine(LOADING_MESSAGE) }
                        val options = picker.options?.items.orEmpty()
                        val current = opened
                        val more = picker.options?.nextCursor
                        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = picker.listState) {
                            if (current != null) item(key = "current-folder") {
                                val level = if (current.ref.isDevice) DEVICE_NOUN.one else (field.levelNoun(current.depth) ?: field.noun).one
                                ChoiceRow("Select this $level", isSelected(current.ref), picker.countOf(current), last = options.isEmpty() && addresses.isEmpty()) { toggle(current.ref) }
                            }
                            itemsIndexed(options, key = { _, item -> filterRefKey(item.ref) }) { index, item ->
                                ChoiceRow(if (browsing) item.shortLabel ?: item.label else item.label, isSelected(item.ref), item.count,
                                    last = index == options.lastIndex && more == null && addresses.isEmpty(),
                                    open = if (item.hasChildren == true) { { picker.open(item) } } else null) { toggle(item.ref) }
                            }
                            if (!picker.loading && picker.error == null && options.isEmpty() && current == null) item { Text(if (picker.query.isBlank()) "No ${field.noun.many} here." else "No ${field.noun.many} match this search.", style = AccessType.RowSecondary, color = colors.secondary, modifier = Modifier.padding(vertical = 16.dp)) }
                            if (more != null) item { AccessTextAction("Load more", Modifier.fillMaxWidth().padding(vertical = 6.dp), enabled = !picker.loading) { page.cursor = more } }
                            if (addresses.isNotEmpty()) item { AccessAddRow(addAddressLabel(addresses)) { picker.enteringIdentifier = true } }
                        }
                    }
                }
                }
            }
        }
    }
    if (viewing) AccessDialog(title = SELECTED_FILTERS_TITLE, confirm = "Done", onConfirm = { viewing = false }, onDismiss = { viewing = false }) {
        if (refs.isEmpty()) Text("Nothing is selected.", style = AccessType.Subtitle, color = colors.secondary)
        refs.forEachIndexed { index, ref ->
            AccessSelectedFilterRow(ref, source.id, editor.fieldOf(ref), hints, last = index == refs.lastIndex) { setRefs(refs.filterNot { filterRefKey(it) == filterRefKey(ref) }) }
        }
    }
}

/** How many pages of its parent's listing are read to find an opened item's count. */
private const val MAX_PARENT_PAGES = 20

/** What a resync that could not be started says. */
internal const val RESYNC_FAILED_MESSAGE = "The resync could not be started. Try again."
/** What a typed address already in the filter says. */
internal const val ALREADY_SELECTED_MESSAGE = "This one is already selected."
/** What a typed address the gateway refused without a sentence says. */
private const val GENERIC_ADDRESS_MESSAGE = "Enter a valid address."

/** The action that reads an account again so a field can take new entries: "Resync Gmail". */
internal fun resyncActionLabel(source: String): String = "Resync $source"

/**
 * Why a field cannot take new entries yet, in the gateway's words, where its choices would be: with the button that
 * resyncs the account when that is what it needs, a bar while the resync runs, and a spinner while the account's list
 * is on its way. A state this app does not know shows the gateway's text.
 */
@Composable
internal fun FilterFieldStateBlock(state: FilterFieldState, source: String, onResync: suspend () -> Unit) {
    val colors = AccessUi.colors
    val scope = rememberCoroutineScope()
    var starting by remember(state.status) { mutableStateOf(false) }
    var started by remember(state.status) { mutableStateOf(false) }
    var failed by remember(state.status) { mutableStateOf(false) }
    val text = state.text ?: FIELD_UNAVAILABLE_MESSAGE
    Column(Modifier.fillMaxWidth().background(colors.surface, RoundedCornerShape(14.dp)).padding(16.dp).semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(14.dp)) {
        when (state.status) {
            FilterFieldState.LIST_PENDING -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AccessSpinner(18.dp)
                Text(text, style = AccessType.Subtitle, color = colors.primary, modifier = Modifier.weight(1f))
            }
            else -> Text(text, style = AccessType.Subtitle, color = colors.primary)
        }
        if (state.status == FilterFieldState.RESYNCING) {
            val total = state.total ?: 0
            AccessProgressBar(if (total > 0) (state.processed ?: 0).toFloat() / total else 0f)
        }
        // Once asked for, the resync is shown starting until the gateway reports it running.
        if (state.status == FilterFieldState.NEEDS_RESYNC && (starting || started)) AccessProgressLine("Resyncing $source…")
        else if (state.status == FilterFieldState.NEEDS_RESYNC) {
            AccessSecondaryButton(resyncActionLabel(source)) {
                starting = true; failed = false
                scope.launch {
                    try { onResync(); started = true }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { failed = true }
                    finally { starting = false }
                }
            }
            if (failed) Text(RESYNC_FAILED_MESSAGE, style = AccessType.RowSecondary, color = colors.danger)
        }
    }
}

/** What stands where choices will be while they are read. */
internal const val LOADING_MESSAGE = "Loading…"

/** What a field in a state the gateway gave no words for says. */
internal const val FIELD_UNAVAILABLE_MESSAGE = "This version of Omnesis can’t use this filter yet."

/** One choice: a tick box, its name, how many records it matches (a spinner while counted), and for a folder with subfolders a way in. */
@Composable
private fun ChoiceRow(label: String, checked: Boolean, count: Long?, last: Boolean, open: (() -> Unit)? = null, toggle: () -> Unit) {
    val colors = AccessUi.colors
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).toggleable(value = checked, role = Role.Checkbox, onValueChange = { toggle() }).padding(vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AccessCheckMark(checked)
                Text(label, style = AccessType.RowTitle.copy(fontWeight = FontWeight.Normal), color = colors.primary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (count != null) AccessMatchCount(count) else AccessSpinner()
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
