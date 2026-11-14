// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

internal data class FilterItemChange(val ref: FilterRef, val mark: FilterItemMark?)

/** Every item of a filter an edit changed on an account that keeps one: what the edit adds, then what it removes, then what it keeps. */
internal fun changedFilterItems(before: SourceFilter, after: SourceFilter): List<FilterItemChange> {
    val had = before.rules.flatMap { it.match }
    val has = after.rules.flatMap { it.match }
    val hadKeys = had.mapTo(mutableSetOf(), ::filterRefKey)
    val hasKeys = has.mapTo(mutableSetOf(), ::filterRefKey)
    return has.filter { filterRefKey(it) !in hadKeys }.map { FilterItemChange(it, FilterItemMark.ADDED) } +
        had.filter { filterRefKey(it) !in hasKeys }.map { FilterItemChange(it, FilterItemMark.REMOVED) } +
        has.filter { filterRefKey(it) in hadKeys }.map { FilterItemChange(it, null) }
}

/** What a review says of a capability that is off, and of an account a granted capability does not read. */
internal const val NOT_GRANTED = "Not granted"
internal const val NOT_SHARED = "Not shared"

/**
 * What one capability reads from one account on one side of an edit. [granted] is whether the level holds
 * the capability, [allowed] whether the capability reads the account, and [policy] the filter saved for it.
 */
internal data class AccountShare(val granted: Boolean, val allowed: Boolean, val policy: SourceFilter?) {
    val shared: Boolean get() = granted && allowed
    /** The filter this side applies. A filter kept on an account that is not read applies nothing. */
    val filter: SourceFilter? get() = policy.takeIf { shared }
    /** The side's value: "Not granted", "Not shared", "All content", or what its filter does with its matches. */
    val status: String get() = when {
        !granted -> NOT_GRANTED
        !allowed -> NOT_SHARED
        else -> filter?.let(::scopePolicyActionLabel) ?: ALL_CONTENT
    }
    val tone: AccessPillTone get() = if (shared) scopePolicyTone(filter) else AccessPillTone.OUTLINE
    /** Whether both sides read the same content: neither reads the account, or both read it through the same filter. */
    fun sameAs(other: AccountShare): Boolean = shared == other.shared && (!shared || sameFilterSettings(listOfNotNull(filter), listOfNotNull(other.filter)))

    companion object {
        fun of(rule: AccessGrantRule?, sourceId: String) = AccountShare(rule != null, rule?.let { sourceAllowed(it.sources, sourceId) } == true,
            rule?.scopePolicies?.firstOrNull { it.sourceId == sourceId })
    }
}

/** One part of an account's change, top to bottom: a side's line, or a list of filter items. */
internal sealed interface AccountChangePart {
    data class Side(val after: Boolean, val share: AccountShare) : AccountChangePart
    /** Items of one side's filter, unmarked, under that side's line; [after] null is the merged list after both lines. */
    data class Items(val after: Boolean?, val items: List<FilterItemChange>) : AccountChangePart
}

/**
 * How a review lays out one account's change. A filter's items stand under the side that holds them: when
 * only one side has a filter its items follow that side's line, unmarked. When both sides have a filter
 * this editor can express, one list follows both lines, marking what the edit added and removed. A filter
 * the editor cannot express keeps its own list under each side that holds it.
 */
internal fun accountChangeParts(before: AccountShare, after: AccountShare): List<AccountChangePart> {
    val old = before.filter
    val new = after.filter
    fun unmarked(policy: SourceFilter) = policy.rules.flatMap { it.match }.map { FilterItemChange(it, null) }
    return buildList {
        if (old != null && new != null && old.editable && new.editable) {
            add(AccountChangePart.Side(false, before)); add(AccountChangePart.Side(true, after))
            changedFilterItems(old, new).takeIf { it.isNotEmpty() }?.let { add(AccountChangePart.Items(null, it)) }
            return@buildList
        }
        add(AccountChangePart.Side(false, before))
        old?.let(::unmarked)?.takeIf { it.isNotEmpty() }?.let { add(AccountChangePart.Items(false, it)) }
        add(AccountChangePart.Side(true, after))
        new?.let(::unmarked)?.takeIf { it.isNotEmpty() }?.let { add(AccountChangePart.Items(true, it)) }
    }
}

/** How many records one selected item matches, when a ready [preview] counted it. */
internal fun scopeItemCount(preview: FilterPreview?, ref: FilterRef): Long? =
    preview?.takeIf { !it.pending && it.connected }?.items?.firstOrNull { filterRefKey(it.ref) == filterRefKey(ref) }?.count?.takeIf { it >= 0 }

/**
 * The name a selected item is known by: a name this session has read, the name the item carries, the name a
 * [preview] of its filter gives it, else its captured addresses; never its stored id. Null when none is known.
 */
internal fun filterItemLabel(ref: FilterRef, sourceId: String, hints: Map<Pair<String, String>, FilterEntryHint>, preview: FilterPreview? = null): String? =
    hints[sourceId to filterRefKey(ref)]?.label ?: ref.label
        ?: preview?.items?.firstOrNull { filterRefKey(it.ref) == filterRefKey(ref) && it.missing != true }?.label
        ?: ref.identifiers?.joinToString { it.value }

/**
 * One selected item of a filter, by the name it is known by and captioned by its [field]; an item whose name is not
 * known is shown as a saved selection of its field. [remove] puts "Remove" where the count stands.
 */
@Composable
internal fun AccessSelectedFilterRow(
    ref: FilterRef, sourceId: String, field: FilterEditorField?, hints: Map<Pair<String, String>, FilterEntryHint>, last: Boolean,
    preview: FilterPreview? = null, count: Long? = null, counting: Boolean = false, mark: FilterItemMark? = null, remove: (() -> Unit)? = null,
) {
    val known = filterItemLabel(ref, sourceId, hints, preview)
    val name = known ?: savedSelectionName(field)
    val hint = hints[sourceId to filterRefKey(ref)]
    val missing = preview?.items?.firstOrNull { filterRefKey(it.ref) == filterRefKey(ref) && it.missing == true }
    AccessFilterItemRow(filterEntryCaption(ref, field, hint?.depth), name, count, last = last, mark = mark, counting = counting,
        detail = when {
            missing != null -> missingEntryNote(missing.reason)
            hint?.missing == true -> missingEntryNote(hint.reason)
            known == null && !counting -> NAME_UNAVAILABLE
            else -> null
        },
        trailing = if (remove != null) { { AccessTextAction("Remove", danger = true, alignment = Alignment.CenterEnd, description = "Remove $name", onClick = remove) } } else null)
}

/** The field of an account an entry belongs to, once the account's fields are known. */
internal fun FilterEditor?.fieldOf(ref: FilterRef): FilterEditorField? = this?.field(ref.fieldPath)

/** What heads the list of a filter's selected items. */
internal const val SELECTED_FILTERS_TITLE = "Selected filters"

/** What a filter with more entries than the gateway accepts says. */
internal const val FILTER_LIMIT_MESSAGE = "A filter can include at most $MAX_FILTER_ENTRIES items."

/** What stands where counts will be while the gateway works them out. */
internal const val COUNTING_MESSAGE = "Counting…"

/** What stands where counts would be when they could not be read. */
internal const val COUNTS_UNAVAILABLE_MESSAGE = "Counts could not be loaded."

/**
 * The preview of exactly [policy]; [preview] stays null until a response for that policy has arrived, and [failure] is
 * why it could not be read. [retry] asks again after a failure; [refresh] asks again without dropping what is on screen.
 */
internal class PolicyPreviewState(val policy: SourceFilter, val preview: FilterPreview?, val failure: Exception?, val refresh: () -> Unit = {}, val retry: () -> Unit) {
    val failed: Boolean get() = failure != null
    /** Whether the counts have arrived: the gateway has finished counting this filter. */
    val settled: Boolean get() = preview != null && !preview.pending
    /** Whether the counts are still on their way. */
    val counting: Boolean get() = policy.editable && !failed && !settled
    /** Per-item counts are shown only once the counts have arrived. */
    fun count(ref: FilterRef): Long? = if (settled) scopeItemCount(preview, ref) else null
}

/**
 * Reads the preview of [policy] through [session] and keeps it current: again when the filter changes, and again
 * after the gateway's `retryAfterMs` while its counts are pending. Nothing is read while [active] is false, or for a
 * filter the editor cannot express. Every screen that states a filter's counts reads them here.
 */
@Composable
internal fun rememberPolicyPreview(session: FilterEditorSession, policy: SourceFilter, active: Boolean = true): PolicyPreviewState {
    var preview by remember(session, policy.sourceId, policy.audience.capability) { mutableStateOf<FilterPreview?>(null) }
    var current by remember(session, policy.sourceId, policy.audience.capability) { mutableStateOf<SourceFilter?>(null) }
    var failure by remember { mutableStateOf<Exception?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(session, policy, active, retry, refresh) {
        // Asking again for the policy already on screen keeps its preview until the next one arrives.
        val refreshing = current == policy && preview != null
        if (!refreshing) { current = null; preview = null }
        failure = null
        if (!active || !policy.editable) return@LaunchedEffect
        try {
            val value = session.preview(policy)
            coroutineContext.ensureActive(); preview = value; current = policy
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { coroutineContext.ensureActive(); if (!refreshing) failure = error }
    }
    val state = PolicyPreviewState(policy, preview.takeIf { current == policy }, failure, retry = { retry += 1 }, refresh = { refresh += 1 })
    AccessAutoRefresh(active && state.preview?.pending == true, state.preview?.retryAfterMs ?: ACCESS_REFRESH_INTERVAL_MILLIS, state.refresh)
    return state
}

/** A saved filter's shared and hidden counts in a line, a spinner while they are counted, or a way to ask again when they could not be read. */
@Composable
internal fun PolicyCounts(state: PolicyPreviewState, after: Boolean) {
    val preview = state.preview
    when {
        !state.policy.editable -> Unit
        state.failed -> {
            AccessChangeValue(COUNTS_UNAVAILABLE_MESSAGE, after)
            AccessTextAction("Try again", onClick = state.retry)
        }
        preview == null || !state.settled -> AccessProgressLine(COUNTING_MESSAGE)
        // An account that is no longer connected has nothing to count.
        !preview.connected -> Unit
        else -> AccessChangeValue("${accessCount(preview.visible)} shared · ${accessCount(preview.hidden)} hidden", after)
    }
}

/**
 * One account's filter editor response through [session], kept current: asked again after the gateway's
 * `retryAfterMs` while counts are pending, and every few seconds while a field is being resynced or waits for its
 * list. [failure] is why it could not be read; [retry] asks again after one, and [refresh] at once.
 */
internal class FilterEditorState(val editor: FilterEditor?, val failure: Exception?, val retry: () -> Unit, val refresh: () -> Unit)

/** Whether a field's state changes by itself, so its editor is asked again until it does. */
internal val FilterFieldState.settling: Boolean get() = status == FilterFieldState.RESYNCING || status == FilterFieldState.LIST_PENDING

@Composable
internal fun rememberFilterEditor(session: FilterEditorSession, sourceId: String, active: Boolean = true): FilterEditorState {
    val known by session.editors.collectAsState()
    var failure by remember(session, sourceId) { mutableStateOf<Exception?>(null) }
    var retry by remember(session, sourceId) { mutableIntStateOf(0) }
    var refresh by remember(session, sourceId) { mutableIntStateOf(0) }
    LaunchedEffect(session, sourceId, active, retry, refresh) {
        if (!active) return@LaunchedEffect
        failure = null
        try { session.editor(sourceId) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { coroutineContext.ensureActive(); if (known[sourceId] == null) failure = error }
    }
    val editor = known[sourceId]
    val waiting = editor != null && (editor.retryAfterMs != null || editor.fields.any { it.state.settling })
    AccessAutoRefresh(active && waiting, editor?.retryAfterMs ?: ACCESS_REFRESH_INTERVAL_MILLIS) { refresh += 1 }
    return FilterEditorState(editor, failure, retry = { retry += 1 }, refresh = { refresh += 1 })
}
