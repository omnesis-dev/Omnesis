// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

// The owner's per-account filter API (`/admin/access/source-filters/...`). Every sentence a
// response carries (`text`, `cost`, `tooOldText`, ...) is the gateway's, shown as it comes.

/** What a source calls one item and several of a kind: `{ one: "label", many: "labels" }`. */
@Serializable data class FilterNoun(val one: String, val many: String)

/** An address captured for a person: a phone in E.164, or a lower-case email or domain. */
@Serializable data class FilterIdentifier(val type: String, val value: String)

/**
 * One entry of a saved filter. An item the account lists ([MEMBERSHIP] or [TREE]) is its [field]'s path and the
 * source's own [id] for it, plus the [device] for a field kept per device, where an empty [id] stands for the whole
 * device. A person ([PERSON]) is a display [label] and the [identifiers] captured for them. Absent values are never
 * sent, so each kind of entry carries exactly its own keys.
 */
@Serializable data class FilterRef(
    val capability: String,
    val field: String? = null,
    val id: String? = null,
    val device: String? = null,
    val label: String? = null,
    val identifiers: List<FilterIdentifier>? = null,
) {
    val isPerson: Boolean get() = capability == PERSON
    /** Whether the entry stands for a whole device of a per-device field. */
    val isDevice: Boolean get() = !isPerson && id.isNullOrEmpty() && device != null

    companion object {
        const val MEMBERSHIP = "membership"
        const val TREE = "tree"
        const val PERSON = "person"
        /** The field path a person entry belongs to. */
        const val PEOPLE_FIELD = "\$people"

        fun item(capability: String, field: String, id: String, device: String? = null) = FilterRef(capability, field, id, device)
        fun person(label: String, identifiers: List<FilterIdentifier>) = FilterRef(PERSON, label = label, identifiers = identifiers)
    }
}

/** The field an entry matches on: its path, or [FilterRef.PEOPLE_FIELD] for a person. */
val FilterRef.fieldPath: String get() = if (isPerson) FilterRef.PEOPLE_FIELD else field.orEmpty()

@Serializable data class FilterAudience(val accessLevel: String, val capability: String)
@Serializable data class FilterRule(val match: List<FilterRef>, val action: String)

/**
 * The filter one level applies to one account for one capability: one rule that shares or hides what it matches, and
 * the opposite for everything else. Gateway type: `SourceFilter`.
 */
@Serializable data class SourceFilter(
    val sourceId: String, val audience: FilterAudience, val rules: List<FilterRule>, val otherwise: String,
) {
    /** Whether the filter has the one shape this editor writes: one rule, and the opposite for everything else. */
    val editable: Boolean get() = rules.size == 1 && rules.single().action in listOf("share", "hide") && otherwise in listOf("share", "hide") &&
        rules.single().action != otherwise
    /** Whether the filter holds no more entries than the gateway accepts; a person counts once per captured address. */
    val withinLimits: Boolean get() = rules.size == 1 && rules.single().match.sumOf { it.entryWeight } <= MAX_FILTER_ENTRIES

    companion object {
        fun empty(sourceId: String, levelId: String, capability: String) = SourceFilter(
            sourceId, FilterAudience(levelId, capability), listOf(FilterRule(emptyList(), "hide")), "share",
        )
    }
}

/** The most entries one filter can hold; a person counts once per captured address. */
const val MAX_FILTER_ENTRIES = 256

/** What an entry counts towards [MAX_FILTER_ENTRIES]: a person its addresses, any other entry one. */
val FilterRef.entryWeight: Int get() = if (isPerson) identifiers?.size ?: 0 else 1

@Serializable data class SourceFiltersAvailability(val enabled: Boolean)

/** A device that hosts an account. */
@Serializable data class FilterDevice(val id: String, val name: String)

/**
 * Whether a field can take new entries ([READY]), and otherwise what stands in the way, in the gateway's [text]. A
 * status this build does not know is treated as not ready, with its text.
 */
@Serializable data class FilterFieldState(
    val status: String,
    val text: String? = null,
    /** [NEEDS_RESYNC]: what a resync reads, from the source's package; null when it declares nothing. */
    val cost: String? = null,
    /** [RESYNCING]: records read so far, of about [total]. */
    val processed: Long? = null,
    /** [RESYNCING]: null on a first read, which has no earlier size to compare with. */
    val total: Long? = null,
    /** [COLLECTOR_BEHIND]: the devices whose Omnesis must be updated. */
    val devices: List<FilterDevice>? = null,
) {
    val ready: Boolean get() = status == READY

    companion object {
        const val READY = "ready"
        const val NEEDS_RESYNC = "needs-resync"
        const val RESYNCING = "resyncing"
        const val COLLECTOR_BEHIND = "collector-behind"
        const val GATEWAY_BEHIND = "gateway-behind"
        const val LIST_PENDING = "list-pending"
        /** The account is no longer connected; its saved entries are kept until they are removed. */
        const val DISCONNECTED = "disconnected"
    }
}

/**
 * How many of an account's records a filter on one field must keep hidden: those too old to carry the detail and
 * those whose detail cannot be matched, each with the gateway's sentence (null when the count is 0). [pending] while
 * the gateway is still counting.
 */
@Serializable data class FilterHiddenCounts(
    val status: String,
    val tooOld: Long = 0,
    val unmatched: Long = 0,
    val tooOldText: String? = null,
    val unmatchedText: String? = null,
) {
    val pending: Boolean get() = status != "ready"
}

/** One field of an account a filter can match on, as the source declares it. */
@Serializable data class FilterEditorField(
    val field: String,
    val capability: String,
    val noun: FilterNoun,
    /** A tree's noun per depth, roots first; the last names every deeper level. */
    val levels: List<FilterNoun>? = null,
    val inside: FilterNoun? = null,
    /** A tree's hint, ready to show: "Includes the folders inside." */
    val insideText: String? = null,
    val picker: String = "search",
    /** "global", or "device" for a field whose items exist per device. */
    val scope: String = "global",
    /** [FilterRef.PEOPLE_FIELD] only: the kinds of address a typed entry may be. */
    val identifiers: List<String>? = null,
    val state: FilterFieldState,
    val counts: FilterHiddenCounts = FilterHiddenCounts("pending"),
) {
    val tree: Boolean get() = picker == "tree"
}

/** `GET /admin/access/source-filters/:sourceId`: what one account's filter can match on, field by field. */
@Serializable data class FilterEditor(
    val sourceId: String,
    val sourceType: String,
    /** The devices that host the account, in the order they joined. */
    val devices: List<FilterDevice> = emptyList(),
    /** Whether a per-device field's tree starts at the devices; false when the account has one device. */
    val showDeviceLevel: Boolean = false,
    val fields: List<FilterEditorField> = emptyList(),
    /** Set while any field's counts are pending: ask again after it. */
    val retryAfterMs: Long? = null,
    /** The one resync several fields wait on, stated once for all of them; null when none does. */
    val resync: FilterEditorResync? = null,
    /** Whether the source has told the gateway what can be filtered: "declared", "no-profile" or "collector-behind". */
    val profile: String = "declared",
    /** The gateway's sentence for an account with nothing to filter on, or one no longer connected; shown as it comes. */
    val profileText: String? = null,
    /** False for an account that is gone while a saved filter still names it: its entries can only be removed. */
    val connected: Boolean = true,
) {
    fun field(path: String): FilterEditorField? = fields.firstOrNull { it.field == path }
}

/**
 * A resync of the account that the [fields] it lists (by path) all wait on: needed ([FilterFieldState.NEEDS_RESYNC])
 * or running ([FilterFieldState.RESYNCING], with its progress), in one sentence naming them all.
 */
@Serializable data class FilterEditorResync(
    val state: String,
    val fields: List<String> = emptyList(),
    val text: String,
    val processed: Long? = null,
    val total: Long? = null,
) {
    /** The state the covered fields share, as one field's state would say it. */
    val fieldState: FilterFieldState get() = FilterFieldState(state, text = text, processed = processed, total = total)
}

/** One choice of a field: what to save when it is picked, its full and short names, and the records it matches. */
@Serializable data class FilterOption(
    val ref: FilterRef,
    /** The full form, for search results and tables: "~/work/atlas-api". */
    val label: String,
    /** The last name, for a row shown inside its parent: "atlas-api". */
    val shortLabel: String? = null,
    /** Records a share-only filter with this entry alone would share; null while it is counted. */
    val count: Long? = null,
    val parentId: String? = null,
    val hasChildren: Boolean? = null,
    /** How many nodes stand above this one in its tree. */
    val depth: Int? = null,
    /** A person's row, for display only. */
    val personId: String? = null,
)

/** `GET /admin/access/source-filters/:sourceId/options`: one page of a field's choices. */
@Serializable data class FilterOptions(
    val sourceId: String,
    val field: String,
    val items: List<FilterOption> = emptyList(),
    val nextCursor: String? = null,
    /** Set while any count is pending: ask again after it. */
    val retryAfterMs: Long? = null,
)

/** One entry of a previewed filter: its full name and how many records it matches alone. */
@Serializable data class FilterPreviewItem(
    val ref: FilterRef,
    val label: String,
    val count: Long,
    /** The entry names something the account's list no longer holds; [label] is then its id. */
    val missing: Boolean? = null,
    /** How many nodes stand above the entry in its tree; level 0 is the top. */
    val depth: Int? = null,
    /** With [missing]: [NOT_IN_LIST] when the list no longer holds the entry, [LIST_GONE] when there is no list. */
    val reason: String? = null,
) {
    companion object {
        const val NOT_IN_LIST = "not-in-list"
        const val LIST_GONE = "list-gone"
    }
}

/**
 * `POST /admin/access/source-filters/:sourceId/preview`: what a draft filter shares and hides. While [pending] only
 * [retryAfterMs] is set, and the same draft is asked for again after it.
 */
@Serializable data class FilterPreview(
    val status: String,
    val retryAfterMs: Long? = null,
    val sourceId: String? = null,
    val total: Long = 0,
    val visible: Long = 0,
    val hidden: Long = 0,
    val tooOld: Long = 0,
    val unmatched: Long = 0,
    val tooOldText: String? = null,
    val unmatchedText: String? = null,
    val items: List<FilterPreviewItem> = emptyList(),
    /** False for an account that is gone: every count is 0 and only the entries' names mean anything. */
    val connected: Boolean = true,
) {
    val pending: Boolean get() = status != "ready"
}

@Serializable data class FilterPreviewBody(val policy: SourceFilter)

/** `POST /admin/access/source-filters/identifiers`: a typed address to check. */
@Serializable data class FilterIdentifierBody(val type: String, val value: String)

/** The gateway's reading of a typed address: its canonical [identifier], or the [error] sentence to show under the field. */
@Serializable data class FilterIdentifierCheck(val identifier: FilterIdentifier? = null, val error: String? = null)

@Serializable data class AccessLevelCreateBody(val name: String, val rules: List<AccessGrantRule>)
@Serializable data class AccessLevelUpdateBody(
    val name: String, val rules: List<AccessGrantRule>, val expectedRevision: Int,
    val expectedFilterRevisions: Map<String, Int>,
)
@Serializable data class AccessLevelReply(val level: AccessLevelSummary)
