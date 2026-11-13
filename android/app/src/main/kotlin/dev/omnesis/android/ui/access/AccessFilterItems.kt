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

internal data class FilterItemChange(val ref: ScopeRef, val mark: FilterItemMark?)

/** Every item of a filter an edit changed on an account that keeps one: what the edit adds, then what it removes, then what it keeps. */
internal fun changedFilterItems(before: ScopePolicy, after: ScopePolicy): List<FilterItemChange> {
    val had = before.rules.flatMap { it.match }
    val has = after.rules.flatMap { it.match }
    val hadKeys = had.mapTo(mutableSetOf(), ::scopeRefKey)
    val hasKeys = has.mapTo(mutableSetOf(), ::scopeRefKey)
    return has.filter { scopeRefKey(it) !in hadKeys }.map { FilterItemChange(it, FilterItemMark.ADDED) } +
        had.filter { scopeRefKey(it) !in hasKeys }.map { FilterItemChange(it, FilterItemMark.REMOVED) } +
        has.filter { scopeRefKey(it) in hadKeys }.map { FilterItemChange(it, null) }
}

/** What a review says of a capability that is off, and of an account a granted capability does not read. */
internal const val NOT_GRANTED = "Not granted"
internal const val NOT_SHARED = "Not shared"

/**
 * What one capability reads from one account on one side of an edit. [granted] is whether the level holds
 * the capability, [allowed] whether the capability reads the account, and [policy] the filter saved for it.
 */
internal data class AccountShare(val granted: Boolean, val allowed: Boolean, val policy: ScopePolicy?) {
    val shared: Boolean get() = granted && allowed
    /** The filter this side applies. A filter kept on an account that is not read applies nothing. */
    val filter: ScopePolicy? get() = policy.takeIf { shared }
    /** The side's value: "Not granted", "Not shared", "All content", or what its filter does with its matches. */
    val status: String get() = when {
        !granted -> NOT_GRANTED
        !allowed -> NOT_SHARED
        else -> filter?.let(::scopePolicyActionLabel) ?: ALL_CONTENT
    }
    val tone: AccessPillTone get() = if (shared) scopePolicyTone(filter) else AccessPillTone.OUTLINE
    /** Whether both sides read the same content: neither reads the account, or both read it through the same filter. */
    fun sameAs(other: AccountShare): Boolean = shared == other.shared && (!shared || sameScopeSettings(listOfNotNull(filter), listOfNotNull(other.filter)))

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
    fun unmarked(policy: ScopePolicy) = policy.rules.flatMap { it.match }.map { FilterItemChange(it, null) }
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

/** How many records one selected item matches, when the preview counted it. */
internal fun scopeItemCount(preview: ScopePreview?, ref: ScopeRef): Long? =
    preview?.items?.firstOrNull { scopeRefKey(it.ref) == scopeRefKey(ref) }?.count?.takeIf { it >= 0 }

/**
 * The name a selected item is known by: a name this session has read, the name the item carries, the name a
 * [preview] of its filter gives it, else its captured addresses; never its stored id. Null when none is known.
 */
internal fun filterItemLabel(ref: ScopeRef, sourceId: String, names: Map<Pair<String, String>, String>, preview: ScopePreview? = null): String? =
    names[sourceId to scopeRefKey(ref)] ?: ref.label ?: preview?.items?.firstOrNull { scopeRefKey(it.ref) == scopeRefKey(ref) }?.label
        ?: ref.identifiers?.joinToString { it.value }

/** How deep in its source's tree a [preview] places a selected item; null when the preview does not say. */
internal fun scopeItemDepth(preview: ScopePreview?, ref: ScopeRef): Int? =
    preview?.items?.firstOrNull { scopeRefKey(it.ref) == scopeRefKey(ref) }?.depth

/**
 * One selected item of a filter, by the name it is known by; an item whose name is not known is shown as a saved
 * selection of its kind. [remove] puts "Remove" where the count stands.
 */
@Composable
internal fun AccessSelectedFilterRow(
    ref: ScopeRef, source: AccessSourceInstance, names: Map<Pair<String, String>, String>, last: Boolean, preview: ScopePreview? = null,
    count: Long? = null, counting: Boolean = false, mark: FilterItemMark? = null, depth: Int? = scopeItemDepth(preview, ref),
    remove: (() -> Unit)? = null,
) {
    val known = filterItemLabel(ref, source.id, names, preview)
    val name = known ?: savedSelectionName(ref.kind, source)
    AccessFilterItemRow(scopeKindCaption(ref.kind, source, depth), name, count, last = last, mark = mark, counting = counting,
        detail = NAME_UNAVAILABLE.takeIf { known == null && !counting },
        trailing = if (remove != null) { { AccessTextAction("Remove", danger = true, alignment = Alignment.CenterEnd, description = "Remove $name", onClick = remove) } } else null)
}

/** What heads the list of a filter's selected items. */
internal const val SELECTED_FILTERS_TITLE = "Selected filters"

/** What a filter with more entries than the gateway accepts says, before the screen says where to remove some. */
internal const val FILTER_LIMIT_MESSAGE = "A filter can hold at most $MAX_SCOPE_FILTER_ENTRIES entries."

/** What stands where counts will be while they are prepared. */
internal const val COUNTING_MESSAGE = "Counting matching records…"

/**
 * The preview of exactly [policy]; [preview] stays null until that preview has arrived, and [failure] is why it
 * could not be read. [retry] asks again after a failure; [refresh] asks again without dropping the counts on screen.
 */
internal class PolicyPreviewState(val policy: ScopePolicy, val preview: ScopePreview?, val failure: Exception?, val refresh: () -> Unit = {}, val retry: () -> Unit) {
    val failed: Boolean get() = failure != null
    /** Whether the counts are final: the preview has arrived and the gateway has prepared everything the filter matches by. */
    val settled: Boolean get() = preview != null && policy.readyToSave(preview.readiness)
    /** Whether the counts are still on their way: no preview yet, or one whose counts are not final. */
    val counting: Boolean get() = policy.editable && !failed && !settled
    /** Per-item counts are shown only once the preview is final. */
    fun count(ref: ScopeRef): Long? = if (settled) scopeItemCount(preview, ref) else null
}

/**
 * Reads the preview of [policy] through [session] and keeps it current: again when the filter changes, and every few
 * seconds while its counts are not final. Nothing is read while [active] is false, or for a filter the editor cannot
 * express. Every screen that states a filter's counts reads them here.
 */
@Composable
internal fun rememberPolicyPreview(session: ScopePreviewSession, policy: ScopePolicy, active: Boolean = true): PolicyPreviewState {
    var preview by remember(session, policy.sourceId, policy.audience.capability) { mutableStateOf<ScopePreview?>(null) }
    var current by remember(session, policy.sourceId, policy.audience.capability) { mutableStateOf<ScopePolicy?>(null) }
    var failure by remember { mutableStateOf<Exception?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(session, policy, active, retry, refresh) {
        // A refresh of the policy already on screen keeps its preview until the next one arrives.
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
    AccessAutoRefresh(active && state.preview != null && !state.settled, state.refresh)
    return state
}

/** A saved filter's shared and hidden counts in a line, a spinner while they are counted, or a way to ask again when they could not be read. */
@Composable
internal fun PolicyCounts(state: PolicyPreviewState, after: Boolean) {
    val preview = state.preview
    when {
        !state.policy.editable -> Unit
        state.failed -> {
            AccessChangeValue("Counts could not be loaded. Your selection is kept.", after)
            AccessTextAction("Try again", onClick = state.retry)
        }
        preview == null || !state.settled -> AccessProgressLine(COUNTING_MESSAGE)
        else -> AccessChangeValue("${accessCount(preview.visible)} shared · ${accessCount(preview.hidden)} hidden", after)
    }
}
