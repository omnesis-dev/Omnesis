// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.delivery.PushHealthCoordinator
import dev.omnesis.android.delivery.PushHealthUiState
import dev.omnesis.android.designsystem.components.NoticeGroup
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.IndexStats
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.InternalSource
import dev.omnesis.android.transport.dto.PendingSourceRemoval
import dev.omnesis.android.transport.dto.SourceRecord
import dev.omnesis.android.transport.dto.SourceSyncStatus
import dev.omnesis.android.transport.dto.StatusSnapshot
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.transport.ws.DeviceSocket.WsEvent
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.reloading
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

/**
 * Overview hero stats for the Sources screen. Ported from the iOS `OverviewCard`: the
 * indexing pill word/percent is derived from [enabled] + [totalIndexed] vs [totalDocs],
 * and the stat cells read [sourceCount]/[totalDocs]/[totalChunks]/[diskBytes].
 *
 * [indexLabel] and [diskSize] are retained pre-formatted strings for older call sites; the
 * screen prefers the structured fields when rendering the three-state pill / stat grid.
 */
data class SourcesOverview(
    val sourceCount: Int,
    val totalDocs: Int?,
    val totalChunks: Int?,
    val diskSize: String?,
    val embeddingModel: String?,
    val indexLabel: String,
    val enabled: Boolean = true,
    val totalIndexed: Int? = null,
    val totalIndexErrors: Int? = null,
    /** The gateway's whole on-disk footprint, or its main database from an older gateway. */
    val diskBytes: Long? = null,
)

/** One rendered source row (all display fields resolved generically via SourceCatalog). */
data class SourceRowUi(
    val sourceId: String,
    val label: String,
    val accountId: String,
    val icon: SourceIconModel,
    val countLabel: String?,
    val syncState: String,
    val percentIndexed: Double?,
    val hostDevice: String?,
    val lastActivity: String?,
    val progressPercent: Double?,
    val progressMessage: String?,
    val paused: Boolean = false,
    val count: Int? = null,
    val unit: String? = null,
    val activityAgo: String? = null,
    /** Gateway-internal source (a dataset the gateway hosts itself): read-only, no sync actions. */
    val isInternal: Boolean = false,
    /**
     * The gateway's notices for this source, one group per device that has any. The
     * row shows one icon at the most severe level; the sheet lists every group.
     */
    val noticeGroups: List<NoticeGroup> = emptyList(),
)

data class SourcesContent(
    val overview: SourcesOverview,
    val sources: List<SourceRowUi>,
    /**
     * Set when cached rows are shown but the latest background refresh failed. Drives the
     * inline refresh banner between the overview and the list (iOS shows the same `Label`).
     */
    val refreshError: Throwable? = null,
    val pendingRemovals: List<PendingSourceRemoval> = emptyList(),
)

@HiltViewModel
class SourcesViewModel @Inject constructor(
    private val session: SessionManager,
    private val catalog: SourceCatalog,
    private val pushHealthCoordinator: PushHealthCoordinator,
) : ViewModel() {

    /**
     * Delivery health for this phone's own sources, held app-wide rather than
     * here: the same banner renders on more than one screen, and a retry
     * started on either is one operation.
     */
    val pushHealth: StateFlow<PushHealthUiState> = pushHealthCoordinator.state

    fun retryDelivery() = pushHealthCoordinator.retry()

    fun discardUndelivered() = pushHealthCoordinator.discardUndelivered()

    /** Display name for a source id, resolved through the catalog — never spelled out here. */
    fun sourceLabel(sourceId: String): String = catalog.label(sourceId)

    /** "412 events" / "1 event", from the provider's own unit noun. */
    fun sourceUnitLabel(sourceId: String, count: Int): String = catalog.unitLabel(sourceId, count)

    /**
     * Raw building blocks of the last successful fetch. Live WS events mutate these maps in
     * place; [rebuild] re-derives the rendered [SourcesContent] from them so row construction
     * never has to be duplicated across the load path and the live-update path.
     */
    private data class Snapshot(
        val sources: List<SourceRecord>,
        /** Gateway-internal sources (a dataset the gateway hosts itself): read-only rows. */
        val inner: List<InternalSource> = emptyList(),
        val pendingRemovals: List<PendingSourceRemoval> = emptyList(),
        val syncById: Map<String, SourceSyncStatus>,
        val status: StatusSnapshot?,
        val index: IndexStats?,
        val deviceNames: Map<String, String>,
    )

    private val _state = MutableStateFlow<Loadable<SourcesContent>>(Loadable.Loading)
    val state = _state.asStateFlow()

    private var snapshot: Snapshot? = null

    private val refetcher = SyncStatusRefetcher(
        scope = viewModelScope,
        fetch = { id -> session.requireSession().admin.syncStatus(id) },
        apply = ::replaceSyncStatus,
    )

    init {
        load()
        observeSocket()
    }

    /** First load: shows a spinner, then content or a full-screen error. */
    fun load() {
        _state.value = Loadable.Loading
        fetch(firstLoad = true)
    }

    /**
     * Background refresh (pull-to-refresh / WS-triggered). Keeps any cached content on the
     * screen; a failure surfaces as the inline banner rather than blowing away the rows.
     */
    fun refresh() = fetch(firstLoad = false)

    private fun fetch(firstLoad: Boolean) {
        // A refresh keeps the rows on screen and says so on the content itself; only a first
        // load has nothing to preserve.
        if (!firstLoad) _state.value = _state.value.reloading()
        // Delivery evidence is local, so it is re-read on every pass rather
        // than only on a successful fetch — a gateway that cannot be reached is
        // exactly when the phone's own backlog matters most.
        pushHealthCoordinator.refresh()
        val ticket = refetcher.beginFullLoad()
        viewModelScope.launch {
            runCatching {
                val s = session.requireSession()
                coroutineScope {
                    val catalogReady = async { catalog.load(s.admin) }
                    val sources = async { s.admin.sourceInventory() }
                    val sync = async { runCatching { s.admin.syncStatus() }.getOrDefault(emptyList()) }
                    val status = async { runCatching { s.gateway.status() }.getOrNull() }
                    val index = async { runCatching { s.gateway.indexStats() }.getOrNull() }
                    val devices = async { runCatching { s.admin.devices() }.getOrDefault(emptyList()) }
                    catalogReady.await()
                    val inventory = sources.await()
                    val registered = inventory.items
                    val inner = inventory.internalSources.filter { it.id.isNotBlank() }
                    Snapshot(
                        sources = registered,
                        pendingRemovals = inventory.pendingRemovals,
                        // A registered row of the same id always wins — an
                        // internal id must never shadow a real registration.
                        inner = inner.filterNot { i -> registered.any { it.id == i.id } },
                        syncById = sync.await().associateBy { it.sourceId },
                        status = status.await(),
                        index = index.await(),
                        deviceNames = devices.await().associate { it.id to it.name },
                    )
                }
            }.fold(
                onSuccess = { loaded ->
                    // A re-fetch that started after this load read the gateway later.
                    val snap = loaded.copy(
                        syncById = refetcher.reconcileFullLoad(
                            ticket,
                            loaded.syncById,
                            snapshot?.syncById.orEmpty(),
                        ),
                    )
                    snapshot = snap
                    _state.value = Loadable.Content(build(snap))
                },
                onFailure = { err ->
                    val cached = (_state.value as? Loadable.Content)?.value
                    _state.value = if (!firstLoad && cached != null) {
                        Loadable.Content(cached.copy(refreshError = err))
                    } else {
                        Loadable.Error(err)
                    }
                },
            )
        }
    }

    // --- Live WS updates (mirror the iOS AdminCoordinator) ---

    /**
     * The gateway pushes `sync.status` (per-source lifecycle) and `source.*` (registry
     * deltas); merge each into the cached [Snapshot] and re-derive in place rather than
     * re-fetching. On a WS *re*connect, silently refresh so a missed gateway restart can't
     * leave the rows stale. Kept fully generic — no per-source branching.
     */
    private fun observeSocket() {
        val socket = session.session?.socket ?: return
        viewModelScope.launch {
            socket.events.collect { event -> applyEvent(event) }
        }
        viewModelScope.launch {
            var sawConnect = false
            socket.state.collect { st ->
                if (st is ConnectionState.Connected) {
                    if (sawConnect) refresh() else sawConnect = true
                }
            }
        }
    }

    private fun applyEvent(event: WsEvent) {
        if (event.type == "source.removed") {
            refresh()
            return
        }
        val snap = snapshot ?: return
        // A finished sync moves the numbers the delivery banner reports, and
        // retires any retry report still sitting under them.
        if (event.type == "sync.status") pushHealthCoordinator.refresh()
        val next = when (event.type) {
            "sync.status" -> applySyncStatus(snap, event.payload)
            "source.added", "source.updated" -> applySourceUpsert(snap, event.payload)
            else -> null
        } ?: return
        snapshot = next
        _state.value = rebuiltContent(build(next), _state.value)
    }

    private fun applySyncStatus(snap: Snapshot, payload: JsonObject): Snapshot? {
        val broadcast = SyncStatusBroadcast.decode(payload) ?: return null
        val sourceId = broadcast.sourceId ?: return null
        val previous = snap.syncById[sourceId]
        val merged = mergeSyncStatus(previous, broadcast, sourceId)
        refetcher.onBroadcast(sourceId, previous, merged, broadcast)
        return snap.copy(syncById = snap.syncById + (sourceId to merged))
    }

    /** Swap in a freshly fetched status — the one place notices change between full loads. */
    private fun replaceSyncStatus(status: SourceSyncStatus) {
        val snap = snapshot ?: return
        val next = snap.copy(syncById = snap.syncById + (status.sourceId to status))
        snapshot = next
        if (_state.value is Loadable.Content) _state.value = rebuiltContent(build(next), _state.value)
    }

    private fun applySourceUpsert(snap: Snapshot, payload: JsonObject): Snapshot? {
        val record = decodeSource(payload) ?: return null
        val sources = snap.sources.filterNot { it.id == record.id } + record
        return snap.copy(sources = sources)
    }

    // Event payloads for source.added / source.updated look like { source: {...} }.
    private fun decodeSource(payload: JsonObject): SourceRecord? {
        val element = payload["source"]?.jsonObject ?: payload
        return runCatching { OmnesisJson.decodeFromJsonElement(SourceRecord.serializer(), element) }.getOrNull()
    }

    private fun build(snap: Snapshot): SourcesContent {
        val status = snap.status
        val index = snap.index

        // Gateway-internal sources join as view-layer records so the shared
        // row renders them without nullable surgery. The id doubles as type
        // and account: labels and icons resolve through the catalog, counts
        // through `/status`, and every other field is inert — internal rows
        // never reach a mutating action.
        val all = snap.sources +
            snap.inner.map { SourceRecord(id = it.id, type = it.id, accountId = it.id) }
        val internalIds = snap.inner.map { it.id }.toSet()
        val rows = all
            .map { record ->
                val docCount = status?.documents?.bySource?.get(record.id)
                val unitCount = status?.documents?.unitCountBySource?.get(record.id) ?: docCount
                val st = snap.syncById[record.id]
                val activity = status?.latestActivityBySource?.get(record.id)
                val unit = catalog.unitName(record.id)
                SourceRowUi(
                    sourceId = record.id,
                    label = catalog.label(record.id),
                    accountId = record.accountId,
                    icon = catalog.iconModel(record.id),
                    countLabel = unitCount?.let { catalog.unitLabel(record.id, it) },
                    syncState = st?.state ?: "idle",
                    percentIndexed = index?.bySource?.get(record.id)?.percentIndexed,
                    hostDevice = rowDeviceLabel(
                        st,
                        snap.deviceNames[record.deviceId]?.takeIf { it.isNotBlank() }
                            ?: if (record.id in internalIds) "Gateway" else null,
                    ),
                    lastActivity = activity?.let { activityTitle(it) },
                    progressPercent = st?.progress?.let { progressPercent(it) },
                    progressMessage = st?.progress?.message?.takeIf { it.isNotBlank() },
                    paused = !record.enabled,
                    count = unitCount,
                    unit = unitCount?.let { pluralizeUnit(unit, it) },
                    activityAgo = activity?.let { formatTimeAgo(it.latestActivityAt) },
                    isInternal = record.id in internalIds,
                    noticeGroups = noticeGroups(st) { snap.deviceNames[it] },
                )
            }
            .sortedWith(compareBy({ it.label.lowercase() }, { it.accountId.lowercase() }))

        val total = status?.documents?.total
        val indexed = index?.totalIndexed
        val enabled = index?.enabled ?: false
        val overview = SourcesOverview(
            sourceCount = snap.sources.size + snap.inner.size,
            totalDocs = total,
            totalChunks = index?.totalChunks,
            diskSize = formatBytes(status?.onDiskBytes),
            embeddingModel = index?.model?.name?.takeIf { it.isNotBlank() },
            indexLabel = when {
                index == null || !index.enabled -> "Indexer off"
                index.state == "running" -> "Indexing"
                else -> "Up to date"
            },
            enabled = enabled,
            totalIndexed = indexed,
            totalIndexErrors = index?.totalIndexErrors,
            diskBytes = status?.onDiskBytes,
        )
        return SourcesContent(overview, rows, pendingRemovals = snap.pendingRemovals)
    }
}

/**
 * Content re-derived from a live update, keeping the refresh-failure banner of what is
 * shown: a live update proves nothing about the last full refresh.
 */
internal fun rebuiltContent(rebuilt: SourcesContent, shown: Loadable<SourcesContent>): Loadable<SourcesContent> =
    Loadable.Content(rebuilt.copy(refreshError = (shown as? Loadable.Content)?.value?.refreshError))

/**
 * Render the bar whenever we have either a server percentage or enough info to derive one
 * (processed + total). Falls back to 0 when only `processed` is known so the bar still
 * appears during early bootstrap before `total` is known. Mirrors the iOS `progressPercent`.
 */
private fun progressPercent(prog: SourceSyncStatus.Progress): Double? {
    prog.percentComplete?.let { return it.coerceIn(0.0, 100.0) }
    val total = prog.total
    val done = prog.processed
    if (total != null && total > 0 && done != null) {
        return (done.toDouble() / total * 100).coerceIn(0.0, 100.0)
    }
    if (done != null) return 0.0
    return null
}

/**
 * Latest-activity title. Documents fall back to "(untitled)"; analytics rows use the
 * table's display name. Reads the [kind] discriminator off the record — never branches on a
 * source name. Mirrors the iOS `activityTitle`.
 */
private fun activityTitle(a: StatusSnapshot.LatestActivity): String? = when (a.kind) {
    "document" -> a.title?.takeIf { it.isNotBlank() } ?: "(untitled)"
    "analytics" -> (a.tableDisplayName ?: a.tableName)?.takeIf { it.isNotBlank() }
    else -> null
}

/** "emails" / "email" — singularize the provider plural for count==1; generic, never branched. */
private fun pluralizeUnit(plural: String?, count: Int): String {
    val noun = plural?.takeIf { it.isNotBlank() } ?: "docs"
    return if (count == 1) noun.removeSuffix("s").ifEmpty { noun } else noun
}

private fun formatBytes(bytes: Long?): String? {
    if (bytes == null) return null
    if (bytes < 1024) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble() / 1024
    var i = 0
    while (value >= 1024 && i < units.size - 1) {
        value /= 1024
        i++
    }
    return "%.1f %s".format(value, units[i])
}
