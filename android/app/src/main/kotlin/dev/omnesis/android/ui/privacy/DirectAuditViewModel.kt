// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.DirectAuditEvent
import dev.omnesis.android.transport.dto.DirectAuditEventDetail
import dev.omnesis.android.transport.dto.DirectAuditSession
import dev.omnesis.android.ui.common.classifyGatewayError
import dev.omnesis.android.ui.common.gatewayErrorDetail
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import javax.inject.Inject
import javax.inject.Singleton

/** Test seam over the four Direct transcript endpoints (mirrors BriefsGateway). */
internal interface DirectAuditGateway {
    suspend fun sessions(): List<DirectAuditSession>
    suspend fun sessionEvents(sessionId: String): List<DirectAuditEvent>
    suspend fun event(eventId: String): DirectAuditEventDetail
    suspend fun deleteSession(sessionId: String)
}

private class SessionDirectAuditGateway(private val session: SessionManager) : DirectAuditGateway {
    override suspend fun sessions(): List<DirectAuditSession> =
        session.requireSession().admin.directAuditSessions()

    override suspend fun sessionEvents(sessionId: String): List<DirectAuditEvent> =
        session.requireSession().admin.directAuditSessionEvents(sessionId)

    override suspend fun event(eventId: String): DirectAuditEventDetail =
        session.requireSession().admin.directAuditEvent(eventId)

    override suspend fun deleteSession(sessionId: String) {
        session.requireSession().admin.deleteDirectAuditSession(sessionId)
    }
}

/**
 * The Direct half of the Audit screen: raw corpus reads by external agents,
 * grouped into transcript sessions. Unlike the Answer feed — reviewed
 * releases — these rows are unreviewed reads, so no release vocabulary
 * (shared, held, denied) appears anywhere here.
 */
@Singleton
class DirectAuditChangeBus @Inject constructor() {
    // replay = 1: two rapid deletes must not drop the second — a replayed id
    // is harmless (the list filterNot's a no-op and reloads; a detail ignores
    // non-matching ids and correctly marks its own session deleted).
    private val _deleted = MutableSharedFlow<String>(replay = 1, extraBufferCapacity = 1)
    val deleted = _deleted.asSharedFlow()

    fun notifyDeleted(sessionId: String) {
        _deleted.tryEmit(sessionId)
    }
}

data class DirectAuditUiState(
    val loading: Boolean = true,
    val sessions: List<DirectAuditSession> = emptyList(),
    val error: Throwable? = null,
    /**
     * The gateway predates the Direct boundary (its routes 404). Version
     * skew, not a failure: the tab names the remedy and Answer keeps working.
     */
    val unavailable: Boolean = false,
)

/** A deleted Direct session leaves the list immediately. */
internal fun removeDeletedDirectSession(
    state: DirectAuditUiState,
    sessionId: String,
): DirectAuditUiState = state.copy(sessions = state.sessions.filterNot { it.id == sessionId })

/**
 * The session row's identity. An explicit caller grouping key names its
 * conversation or workflow; without one the calls were grouped while idle
 * gaps stayed short, and the row says so. A key from a newer gateway than
 * this client shows verbatim rather than guessing a friendlier label,
 * mirroring the portal.
 */
internal fun directAuditSessionLabel(session: DirectAuditSession): String {
    val key = session.explicitKey ?: return "Grouped by activity"
    val cut = key.indexOf(':')
    if (cut <= 0) return key
    val id = key.substring(cut + 1)
    return when (key.substring(0, cut)) {
        "workflow" -> "Workflow $id"
        "conversation" -> "Conversation $id"
        else -> key
    }
}

/** The agent the session belongs to: the operator-approved principal name, or "External agent". */
internal fun directAuditAgentName(session: DirectAuditSession): String {
    val name = session.principalName?.trim().orEmpty()
    return name.ifEmpty { "External agent" }
}

@HiltViewModel
class DirectAuditViewModel internal constructor(
    private val gateway: DirectAuditGateway,
    changeBus: DirectAuditChangeBus,
) : ViewModel() {
    @Inject constructor(
        session: SessionManager,
        changeBus: DirectAuditChangeBus,
    ) : this(SessionDirectAuditGateway(session), changeBus)
    private val _state = MutableStateFlow(DirectAuditUiState())
    val state = _state.asStateFlow()
    private var generation = 0L

    init {
        load()
        viewModelScope.launch {
            changeBus.deleted.collect { sessionId ->
                _state.value = removeDeletedDirectSession(_state.value, sessionId)
                load(showLoadingIndicator = false)
            }
        }
    }

    fun load(showLoadingIndicator: Boolean = true) {
        val request = ++generation
        _state.value = _state.value.copy(
            loading = if (showLoadingIndicator) true else _state.value.loading,
            error = if (showLoadingIndicator) null else _state.value.error,
        )
        viewModelScope.launch {
            runCatching { gateway.sessions() }.fold(
                onSuccess = { sessions ->
                    if (request != generation) return@fold
                    _state.value = DirectAuditUiState(loading = false, sessions = sessions)
                },
                onFailure = { error ->
                    if (request != generation) return@fold
                    if (error is GatewayException.NotFound) {
                        _state.value = DirectAuditUiState(loading = false, unavailable = true)
                    } else {
                        _state.value = _state.value.copy(loading = false, error = error)
                    }
                },
            )
        }
    }
}

/* ── One session's transcript ─────────────────────────────────────────── */

data class DirectAuditDetailUiState(
    val loading: Boolean = true,
    val deleting: Boolean = false,
    val deleted: Boolean = false,
    val unavailable: Boolean = false,
    /**
     * The session re-resolved against the reloaded feed, mirroring the
     * portal — null until loaded, or when the session left the capped list.
     * The header falls back to the loaded event count without it.
     */
    val session: DirectAuditSession? = null,
    val events: List<DirectAuditEvent> = emptyList(),
    /** Event ids whose payload was read, mapped to the bounded payload (null when absent). */
    val payloads: Map<String, JsonElement?> = emptyMap(),
    val payloadLoading: Set<String> = emptySet(),
    val payloadErrors: Map<String, String> = emptyMap(),
    /** Payload errors that will never succeed on retry (the event is gone). */
    val payloadTerminal: Set<String> = emptySet(),
    val actionError: String? = null,
    val error: Throwable? = null,
)

@HiltViewModel
class DirectAuditDetailViewModel internal constructor(
    private val sessionId: String,
    private val gateway: DirectAuditGateway,
    private val changeBus: DirectAuditChangeBus,
    /** The shared loaded catalog, so rows show real source icons — never a fresh empty one. */
    val catalog: SourceCatalog,
) : ViewModel() {
    @Inject constructor(
        savedStateHandle: SavedStateHandle,
        session: SessionManager,
        changeBus: DirectAuditChangeBus,
        catalog: SourceCatalog,
    ) : this(
        checkNotNull(savedStateHandle["sessionId"]),
        SessionDirectAuditGateway(session),
        changeBus,
        catalog,
    )

    private val _state = MutableStateFlow(DirectAuditDetailUiState())
    val state = _state.asStateFlow()
    private var generation = 0L

    init {
        load()
        viewModelScope.launch {
            changeBus.deleted.collect { deletedId ->
                // Deleted elsewhere (e.g. from another surface): never show a
                // stale transcript, navigate back to the refreshed list.
                if (deletedId == sessionId) _state.value = DirectAuditDetailUiState(
                    loading = false,
                    deleted = true,
                )
            }
        }
    }

    fun load() {
        val request = ++generation
        _state.value = _state.value.copy(loading = true, error = null)
        viewModelScope.launch {
            // The events are the transcript; the sessions feed re-resolves
            // this session's label and principal for the header, like the
            // portal. A sessions failure never fails the transcript.
            val sessions = runCatching { gateway.sessions() }.getOrNull()
            runCatching { gateway.sessionEvents(sessionId) }.fold(
                onSuccess = { events ->
                    if (request != generation) return@fold
                    _state.value = _state.value.copy(
                        loading = false,
                        session = sessions?.find { it.id == sessionId },
                        events = events,
                        error = null,
                        unavailable = false,
                    )
                },
                onFailure = { error ->
                    if (request != generation) return@fold
                    if (error is GatewayException.NotFound) {
                        _state.value = _state.value.copy(loading = false, unavailable = true)
                    } else {
                        _state.value = _state.value.copy(loading = false, error = error)
                    }
                },
            )
        }
    }

    /**
     * Read one call's bounded arguments and result on first visibility; later
     * calls are local. A second call while the read is in flight is a no-op,
     * not a second request. Rows fire this from composition as they scroll
     * into view, mirroring the portal's IntersectionObserver.
     */
    fun ensurePayload(eventId: String) {
        val current = _state.value
        if (eventId in current.payloads || eventId in current.payloadLoading) return
        fetchPayload(eventId)
    }

    fun retryEvent(eventId: String) {
        val current = _state.value
        _state.value = current.copy(
            payloads = current.payloads - eventId,
            payloadErrors = current.payloadErrors - eventId,
            payloadTerminal = current.payloadTerminal - eventId,
        )
        if (eventId in current.payloadLoading) return
        fetchPayload(eventId)
    }

    private fun fetchPayload(eventId: String) {
        _state.value = _state.value.copy(
            payloadLoading = _state.value.payloadLoading + eventId,
            payloadErrors = _state.value.payloadErrors - eventId,
        )
        viewModelScope.launch {
            runCatching { gateway.event(eventId) }.fold(
                onSuccess = { detail ->
                    val latest = _state.value
                    _state.value = latest.copy(
                        payloads = latest.payloads + (eventId to detail.payload),
                        payloadLoading = latest.payloadLoading - eventId,
                    )
                },
                onFailure = { error ->
                    val latest = _state.value
                    // The event vanished after the list loaded: terminal, not
                    // retryable — a Retry could never succeed.
                    val terminal = error is GatewayException.NotFound
                    val message = if (terminal) {
                        "This call is no longer on the gateway."
                    } else {
                        directAuditErrorMessage(error)
                    }
                    _state.value = latest.copy(
                        payloadLoading = latest.payloadLoading - eventId,
                        payloadErrors = latest.payloadErrors + (eventId to message),
                        payloadTerminal = if (terminal) {
                            latest.payloadTerminal + eventId
                        } else {
                            latest.payloadTerminal
                        },
                    )
                },
            )
        }
    }

    fun deleteSession() {
        if (_state.value.deleting) return
        val request = ++generation
        _state.value = _state.value.copy(deleting = true, actionError = null)
        viewModelScope.launch {
            runCatching { gateway.deleteSession(sessionId) }.fold(
                onSuccess = {
                    if (request != generation) return@fold
                    changeBus.notifyDeleted(sessionId)
                    _state.value = DirectAuditDetailUiState(loading = false, deleted = true)
                },
                onFailure = { error ->
                    if (request != generation) return@fold
                    if (error is GatewayException.NotFound) {
                        // Already gone elsewhere is gone — no error to show.
                        changeBus.notifyDeleted(sessionId)
                        _state.value = DirectAuditDetailUiState(loading = false, deleted = true)
                        return@fold
                    }
                    _state.value = _state.value.copy(
                        deleting = false,
                        actionError = directAuditErrorMessage(error),
                    )
                },
            )
        }
    }

    override fun onCleared() {
        generation += 1
        super.onCleared()
    }
}

/** Prefer an actionable gateway detail, then use the shared transport vocabulary. */
internal fun directAuditErrorMessage(error: Throwable): String =
    gatewayErrorDetail(error) ?: classifyGatewayError(error)
