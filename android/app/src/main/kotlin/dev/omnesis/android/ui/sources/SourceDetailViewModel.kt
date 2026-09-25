// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import android.util.Log
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.NoticeUi
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.setup.notices.toNoticeUi
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.IndexStats
import dev.omnesis.android.transport.dto.InternalSource
import dev.omnesis.android.transport.dto.SourceRecord
import dev.omnesis.android.transport.dto.SourceSyncStatus
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.transport.ws.DeviceSocket.WsEvent
import dev.omnesis.android.ui.common.Loadable
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Detail view-model for one source. Carries display state plus the in-flight / error /
 * debug state that drives the action list, the confirmation dialogs, and the debug sheet.
 *
 * The mutating actions hit the gateway admin surface (mirroring the iOS `AdminCoordinator`):
 * sync now (`POST /admin/sources/:id/sync`), pause/resume (`PATCH /admin/sources/:id`),
 * resync (delete-all then sync), remove (`DELETE /admin/sources/:id`), and the debug fetch
 * (`GET /admin/sources/:id/debug`). Each reloads the detail on success.
 */
data class SourceDetailUi(
    val sourceId: String,
    val label: String,
    val accountId: String,
    val icon: SourceIconModel,
    val type: String,
    val hostDevices: List<SourceHostDeviceUi>,
    val syncState: String,
    val lastSyncAt: String?,
    val percentIndexed: Double?,
    val progressPercent: Double?,
    val progressMessage: String?,
    val paused: Boolean = false,
    val unit: String? = null,
    val progressTotal: Int? = null,
    val progressDone: Int? = null,
    val actionInFlight: Boolean = false,
    val actionError: String? = null,
    val debug: Loadable<String>? = null,
    /** Gateway-internal source (a dataset the gateway hosts itself): read-only, no sync actions. */
    val isInternal: Boolean = false,
    /**
     * Notices no listed host device claims — e.g. a gateway-hosted source, or a member
     * on a device the record does not list. Shown beside the STATUS pill.
     */
    val notices: List<NoticeUi> = emptyList(),
)

data class SourceHostDeviceUi(
    val id: String,
    val name: String?,
    /** The gateway's notices for this source on this device, most severe first. */
    val notices: List<NoticeUi> = emptyList(),
)

/** Whether a re-fetched [status] belongs to the detail showing [sourceId]. */
internal fun isStatusFor(sourceId: String, status: SourceSyncStatus): Boolean = status.sourceId == sourceId

internal class SourceNoLongerAvailable : IllegalStateException("Source removed")

@HiltViewModel
class SourceDetailViewModel @Inject constructor(
    private val session: SessionManager,
    private val catalog: SourceCatalog,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    val sourceId: String = checkNotNull(savedStateHandle["id"]) { "missing source id" }

    /**
     * Raw building blocks of the last successful fetch. Live WS `sync.status` events mutate
     * [sync] in place; [rebuild] re-derives the rendered [SourceDetailUi] from them so the
     * detail row mapping never has to be duplicated across load and live-update paths.
     */
    private data class Snapshot(
        val record: SourceRecord,
        val isInternal: Boolean = false,
        val sync: SourceSyncStatus?,
        val index: IndexStats?,
        val deviceNames: Map<String, String>,
    )

    private val loads = SourceDetailLoads<SourceDetailUi>()
    private val _state = loads.state
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

    fun load() {
        val generation = loads.begin(clear = true)
        val ticket = refetcher.beginFullLoad()
        viewModelScope.launch {
            runCatching {
                val s = session.requireSession()
                coroutineScope {
                    val catalogReady = async { catalog.load(s.admin) }
                    val sources = async { s.admin.sourcesAndInternal() }
                    val sync = async { runCatching { s.admin.syncStatus() }.getOrDefault(emptyList()) }
                    val index = async { runCatching { s.gateway.indexStats() }.getOrNull() }
                    val devices = async { runCatching { s.admin.devices() }.getOrDefault(emptyList()) }
                    catalogReady.await()

                    val (registered, inner) = sources.await()
                    val (record, isInternal) = resolveRecord(registered, inner)
                        ?: throw SourceNoLongerAvailable()

                    Snapshot(
                        record = record,
                        isInternal = isInternal,
                        sync = sync.await().firstOrNull { it.sourceId == sourceId },
                        index = index.await(),
                        deviceNames = devices.await().associate { it.id to it.name },
                    )
                }
            }.fold(
                onSuccess = { loaded ->
                    if (!loads.owns(generation)) return@fold
                    val snap = reconciled(ticket, loaded)
                    snapshot = snap
                    loads.succeeded(generation, build(snap))
                },
                onFailure = { loads.failed(generation, it) },
            )
        }
    }

    /**
     * Resolve [sourceId] to its record. A registered row always wins — an
     * internal id must never shadow a real registration. Internal ids
     * resolve to view-layer records (the id doubles as type and account);
     * every other field is inert — internal rows never reach a mutating action.
     */
    private fun resolveRecord(
        registered: List<SourceRecord>,
        inner: List<InternalSource>,
    ): Pair<SourceRecord, Boolean>? {
        registered.firstOrNull { it.id == sourceId }?.let { return it to false }
        val hit = inner.firstOrNull { it.id == sourceId } ?: return null
        return SourceRecord(id = hit.id, type = hit.id, accountId = hit.id) to true
    }

    /**
     * Re-derive the rendered detail from the cached [snap], preserving the action / debug
     * transient state from the currently shown content (so a live row update doesn't clear an
     * in-flight spinner or an open debug sheet).
     */
    private fun build(snap: Snapshot): SourceDetailUi {
        val st = snap.sync
        val current = (_state.value as? Loadable.Content)?.value
        val hostIds = snap.record.hostDeviceIds()
        val attributed = attributeNotices(st, hostIds)
        return SourceDetailUi(
            sourceId = sourceId,
            label = catalog.label(sourceId),
            accountId = snap.record.accountId,
            icon = catalog.iconModel(sourceId),
            type = snap.record.type,
            hostDevices = hostIds.map { id ->
                SourceHostDeviceUi(
                    id,
                    snap.deviceNames[id]?.takeIf(String::isNotBlank),
                    attributed.byDevice[id].orEmpty().toNoticeUi(),
                )
            },
            syncState = st?.state ?: "idle",
            lastSyncAt = st?.lastSyncAt,
            percentIndexed = snap.index?.bySource?.get(sourceId)?.percentIndexed,
            progressPercent = st?.progress?.percentComplete,
            progressMessage = st?.progress?.message?.takeIf { it.isNotBlank() },
            paused = !snap.record.enabled,
            unit = (st?.unitName ?: catalog.unitName(sourceId))?.takeIf { it.isNotBlank() },
            progressTotal = st?.progress?.total,
            progressDone = st?.progress?.processed,
            actionInFlight = current?.actionInFlight ?: false,
            actionError = current?.actionError,
            debug = current?.debug,
            isInternal = snap.isInternal,
            notices = attributed.unattributed.toNoticeUi(),
        )
    }

    // --- Live WS updates (mirror the iOS AdminCoordinator) ---

    /**
     * Merge `sync.status` broadcasts for this source into the cached [Snapshot] and re-derive
     * in place. On a WS *re*connect, silently reload so a missed gateway restart can't leave
     * the detail stale. Fully generic — no per-source branching.
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
                    if (sawConnect) silentReload() else sawConnect = true
                }
            }
        }
    }

    private fun applyEvent(event: WsEvent) {
        if (event.type == "source.removed" && event.payload["sourceId"]?.jsonPrimitive?.content == sourceId) {
            markRemoved()
            return
        }
        if (event.type == "source.updated" || event.type == "source.added") {
            silentReload()
            return
        }
        if (event.type != "sync.status") return
        val snap = snapshot ?: return
        val broadcast = SyncStatusBroadcast.decode(event.payload) ?: return
        if (broadcast.sourceId != sourceId) return
        val merged = mergeSyncStatus(snap.sync, broadcast, sourceId)
        refetcher.onBroadcast(sourceId, snap.sync, merged, broadcast)
        val next = snap.copy(sync = merged)
        snapshot = next
        _state.update { current ->
            if (current is Loadable.Content) Loadable.Content(build(next)) else current
        }
    }

    /** [loaded] with this source's status kept where a later-started re-fetch answered. */
    private fun reconciled(ticket: Long, loaded: Snapshot): Snapshot {
        val kept = refetcher.reconcileFullLoad(
            ticket,
            listOfNotNull(loaded.sync).associateBy { it.sourceId },
            listOfNotNull(snapshot?.sync).associateBy { it.sourceId },
        )
        return loaded.copy(sync = kept[sourceId])
    }

    /** Swap in a freshly fetched status — the one place notices change between full loads. */
    private fun replaceSyncStatus(status: SourceSyncStatus) {
        val snap = snapshot ?: return
        if (!isStatusFor(sourceId, status)) return
        val next = snap.copy(sync = status)
        snapshot = next
        _state.update { current ->
            if (current is Loadable.Content) Loadable.Content(build(next)) else current
        }
    }

    /** Refresh without clearing the screen (keeps cached content visible across a reconnect). */
    private fun silentReload() {
        val generation = loads.begin(clear = false)
        val ticket = refetcher.beginFullLoad()
        viewModelScope.launch {
            runCatching {
                val s = session.requireSession()
                coroutineScope {
                    val sources = async { s.admin.sourcesAndInternal() }
                    val sync = async { runCatching { s.admin.syncStatus() }.getOrDefault(emptyList()) }
                    val index = async { runCatching { s.gateway.indexStats() }.getOrNull() }
                    val devices = async { runCatching { s.admin.devices() }.getOrDefault(emptyList()) }
                    val (registered, inner) = sources.await()
                    val (record, isInternal) = resolveRecord(registered, inner) ?: return@coroutineScope null
                    Snapshot(
                        record = record,
                        isInternal = isInternal,
                        sync = sync.await().firstOrNull { it.sourceId == sourceId },
                        index = index.await(),
                        deviceNames = devices.await().associate { it.id to it.name },
                    )
                }
            }.onSuccess { snap ->
                if (!loads.owns(generation)) return@onSuccess
                if (snap == null) markRemoved() else {
                    val next = reconciled(ticket, snap)
                    snapshot = next
                    loads.succeeded(generation, build(next))
                }
            }

        }
    }

    private fun markRemoved() {
        snapshot = null
        loads.removed(SourceNoLongerAvailable())
    }

    // --- Actions (mirror the iOS AdminCoordinator) ---

    fun syncNow() = runAction { session.requireSession().admin.syncSource(sourceId) }

    /** Toggle enabled: pause a running source or resume a paused one. */
    fun togglePause() = runAction {
        val paused = (state.value as? Loadable.Content)?.value?.paused ?: false
        session.requireSession().admin.patchSource(sourceId, enabled = paused)
    }

    /** Wipe every doc + analytics row for the source, then trigger a fresh sync. */
    fun resync() = runAction {
        val admin = session.requireSession().admin
        admin.deleteAllForSource(sourceId)
        admin.syncSource(sourceId)
    }

    fun remove() = runAction(onSuccess = ::markRemoved, reloadAfter = false) {
        session.requireSession().admin.removeSource(sourceId)
    }

    fun loadDebug() {
        // Internal sources have no debug endpoint — the button is hidden,
        // so reaching here means a programming error, not user input.
        // Fail loud (log + error state) rather than silently no-op, so a
        // re-exposed button can't look like it works.
        if (snapshot?.isInternal == true) {
            Log.w(TAG, "loadDebug called for internal source $sourceId")
            updateContent { it.copy(debug = Loadable.Error(IllegalStateException("no debug view for internal sources"))) }
            return
        }
        updateContent { it.copy(debug = Loadable.Loading) }
        viewModelScope.launch {
            runCatching { session.requireSession().admin.sourceDebug(sourceId) }.fold(
                onSuccess = { json -> updateContent { it.copy(debug = Loadable.Content(json)) } },
                onFailure = { err -> updateContent { it.copy(debug = Loadable.Error(err)) } },
            )
        }
    }

    private fun runAction(onSuccess: () -> Unit = {}, reloadAfter: Boolean = true, body: suspend () -> Unit) {
        // Every mutating action flows through here; internal sources have
        // none, and the gateway would 409 — refuse before the round-trip.
        // Fail loud (log + error state) rather than silently no-op, matching
        // iOS's throwing guard, so a re-exposed button can't look like it
        // works.
        if (snapshot?.isInternal == true) {
            Log.w(TAG, "mutating action called for internal source $sourceId")
            updateContent { it.copy(actionError = "That action isn't available for gateway-hosted sources.") }
            return
        }
        val detail = (_state.value as? Loadable.Content)?.value ?: return
        if (detail.actionInFlight) return

        updateContent { it.copy(actionInFlight = true, actionError = null) }
        viewModelScope.launch {
            runCatching { body() }.fold(
                onSuccess = {
                    updateContent { it.copy(actionInFlight = false) }
                    onSuccess()
                    // Skip the reload after a remove — the source row is gone, so a
                    // reload would just 404 into an error screen as the caller pops.
                    if (reloadAfter) load()
                },
                onFailure = { err ->
                    updateContent { it.copy(actionInFlight = false, actionError = err.message ?: "Action failed.") }
                },
            )
        }
    }

    private fun updateContent(transform: (SourceDetailUi) -> SourceDetailUi) {
        _state.update { current ->
            if (current is Loadable.Content) Loadable.Content(transform(current.value)) else current
        }
    }

    companion object {
        private const val TAG = "SourceDetailVM"
    }
}
