// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import android.util.Log
import androidx.annotation.VisibleForTesting
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.AgentClient
import dev.omnesis.android.transport.client.AgentEventSource
import dev.omnesis.android.transport.client.AgentStreamItem
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.AgentConversationTerminalFailure
import dev.omnesis.android.transport.dto.AgentTrailRecord
import dev.omnesis.android.transport.dto.ConversationSummary
import dev.omnesis.android.transport.dto.CreateSessionResponse
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.formatLine
import dev.omnesis.android.ui.common.classifyGatewayError
import dev.omnesis.android.ui.common.CursorPagingState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.math.max
import kotlinx.coroutines.launch
import java.util.UUID
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min
import kotlin.math.pow

/**
 * Owns the agent harness state: live session, conversation transcript, citations,
 * plan panel, and the sidebar list of prior conversations. Faithful port of the iOS
 * `AgentCoordinator` — a `@Singleton` rebuilt by [dev.omnesis.android.session.SessionManager]
 * on pair/unpair (the iOS `AppStore.rebuildAfterPairingChange()` analogue), so views
 * observing [state] survive screen navigation while the SSE stream stays alive.
 *
 * The SSE event stream is supervised here with the same exponential backoff as
 * `DeviceSocket`. All state mutation is confined to a single-threaded
 * `Dispatchers.Main.immediate` scope (the iOS `@MainActor` analogue) so the SSE
 * collector and user actions never race on the reducer state.
 */
@Singleton
class AgentCoordinator @Inject constructor() {

    /** The full surface the agent UI renders. Wraps the reducer's [AgentChatState]. */
    data class UiState(
        val chat: AgentChatState = AgentChatState(),
        val sessionId: String? = null,
        val model: String? = null,
        val backend: String? = null,
        val title: String = "",
        /** Fatal that blocks the whole surface (session create failed). Raw for the classifier. */
        val fatalError: Throwable? = null,
        /**
         * True while the transcript for a just-switched-to conversation is still loading over
         * the network. Set the instant a resume begins — before the round-trip — so the surface
         * flips to the target conversation immediately (title + skeleton) instead of showing the
         * previous transcript until the fetch lands. Cleared by [applyCreatedSession] (success)
         * or the resume error path. Mirrors the iOS `AgentCoordinator.transcriptLoading`.
         */
        val transcriptLoading: Boolean = false,
        /** Older persisted transcript pages, prepended only at complete turn boundaries. */
        val transcriptPaging: CursorPagingState = CursorPagingState(),
        /** Anchor used to project legacy, unfiltered older-message responses consistently. */
        val conversationOrigin: ConversationOrigin? = null,
        /** Bumped after a prepend so Compose can restore the previous top-row anchor. */
        val transcriptPrependVersion: Long = 0,
        /**
         * One-shot: the text of a send that the gateway never accepted — a failed lazy mint,
         * a locally stopped pre-mint send, or a refused POST. The composer restores it (then
         * acks via [ackSendRejected]). Navigation retires the send instead, so an abandoned
         * prompt cannot leak into a different conversation's composer.
         */
        val sendRejectedText: String? = null,
        /** Durable context exhaustion, kept outside model-visible chat history. */
        val terminalFailure: AgentConversationTerminalFailure? = null,
        /** Bumped whenever a fresh conversation must reset and refocus the local composer. */
        val composerGeneration: Long = 0,
        val conversations: List<ConversationSummary> = emptyList(),
        val conversationsLoading: Boolean = false,
        val conversationsPaging: CursorPagingState = CursorPagingState(),
        val conversationsError: String? = null,
        /** Failure from pinning or deleting a conversation, separate from list loading. */
        val conversationActionError: String? = null,
        /** Conversation that owns [conversationActionError], so chat B never shows chat A's failure. */
        val conversationActionErrorSessionId: String? = null,
        /** Pin state for the conversation on screen, even before it enters the loaded list page. */
        val activeConversationPinned: Boolean = false,
        /** Conversation ids with an outstanding pin/delete mutation. */
        val conversationActionsInFlight: Set<String> = emptySet(),
        /** False before the first pairing — the UI shows the unpaired placeholder. */
        val hasClient: Boolean = false,
        /**
         * Why the conversation on screen has no live session behind it, when it has none. Set
         * when the transcript was read from storage because the agent model could not run; null
         * whenever a session is live. The transcript stays fully readable — only sending is
         * withheld, and this says why.
         */
        val liveSessionMissingReason: String? = null,
    ) {
        /**
         * Whether the composer should accept input. Enabled as soon as a client exists —
         * including the fresh/empty state where no session has been minted yet ([send] mints
         * one lazily on the first message), so a brand-new conversation and a cold start are
         * typable immediately. Disabled while a resumed transcript is still loading (its session
         * isn't live server-side yet) and while the fatal-error screen owns the surface.
         */
        val canCompose: Boolean
            get() = hasClient && !transcriptLoading && fatalError == null &&
                terminalFailure == null && liveSessionMissingReason == null
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var client: AgentClient? = null
    private var events: AgentEventSource? = null
    private var streamJob: Job? = null
    private var planClearJob: Job? = null
    private var overflowSnapshotJob: Job? = null
    private var ephemeralGateTimeoutJob: Job? = null
    private var ephemeralGateTimeoutKey: Pair<String, String>? = null
    @VisibleForTesting internal var ephemeralGateMaxHoldMs = EPHEMERAL_GATE_MAX_HOLD_MS
    private var reconnectAttempt = 0
    private var snapshotHandoffGeneration = 0L
    /**
     * Events that arrive while a session snapshot is in flight, held until the snapshot's
     * `eventCursor` says which of them the snapshot already contains.
     *
     * [overflowed] latches once the stream outruns [SNAPSHOT_HANDOFF_CAPACITY]: the buffer is
     * released and everything after it is DROPPED, because the snapshot plus a rewound stream
     * replay reconstruct it far more cheaply than an unbounded buffer. It makes the snapshot
     * mandatory (a failed one must be retried — the dropped events exist nowhere else) and
     * makes the stream rewind to the snapshot cursor on completion.
     */
    private data class SnapshotHandoff(
        val generation: Long,
        val targetSessionId: String,
        val events: MutableList<AgentStreamItem> = mutableListOf(),
        var overflowed: Boolean = false,
    )
    private var snapshotHandoff: SnapshotHandoff? = null

    /**
     * Monotonic counter bumped on every explicit session choice — a conversation-list tap, a
     * new-conversation action, a lazy mint on first send. The default flows that can race them
     * (`bootstrap`'s resume-most-recent) snapshot this before their session request and discard
     * the result if the count moved while the request was in flight, so an explicit choice wins
     * deterministically. All reads/writes happen on the single-threaded Main.immediate scope, so
     * the snapshot-compare cannot itself race. Mirrors the iOS `sessionChoiceCount`.
     */
    private var sessionChoice = 0
    /** Latest send owner; turn boundaries, snapshots, and newer sends invalidate late failures. */
    private var sendOperationGeneration = 0L
    /**
     * A first send whose optimistic UI is visible while its session is still being minted.
     * Stop can cancel this local-only phase even though there is no session id to send to the
     * gateway yet. The mint request may still complete, but its choice/generation no longer own
     * the surface and therefore cannot resurrect the abandoned send.
     */
    private data class PendingSessionMint(
        val choice: Int,
        val sendOperation: Long,
        val optimisticId: String,
        val text: String,
        val titleWasEmpty: Boolean,
    )
    private var pendingSessionMint: PendingSessionMint? = null
    /** Latest Stop owner; repeated Stop, snapshots, and newer turn activity retire old failures. */
    private var cancelOperationGeneration = 0L
    /**
     * Owns the conversation drawer's first-page and load-more requests. Refreshes
     * supersede pages from an older snapshot, and rebuild/teardown invalidates
     * responses that still belong to the previous gateway.
     */
    private var conversationListGeneration = 0L
    /** Surface owner for mutation errors; successful list reconciliation survives navigation. */
    private var conversationActionGeneration = 0L

    /**
     * Last SSE `id:` seen. Passed as `Last-Event-ID` on reconnect so the gateway
     * replays exactly what was missed since the connection dropped (mirrors the
     * iOS `AgentCoordinator.lastEventId`).
     */
    private var lastEventId: String? = null

    // MARK: - Lifecycle

    /** Bring the agent surface up on a fresh pairing. */
    fun rebuild(client: AgentClient, events: AgentEventSource) {
        teardown()
        this.client = client
        this.events = events
        _state.value = UiState(hasClient = true)
        startEventStream()
        scope.launch { bootstrap() }
    }

    /** Drop client + event stream. Called on unpair / re-pair. */
    fun teardown() {
        stopSeenLease()
        visibleConversationId = null
        streamJob?.cancel()
        streamJob = null
        planClearJob?.cancel()
        planClearJob = null
        overflowSnapshotJob?.cancel()
        overflowSnapshotJob = null
        cancelEphemeralGateTimeout()
        reconnectAttempt = 0
        lastEventId = null
        snapshotHandoff = null
        pendingSessionMint = null
        // Invalidate any in-flight resume/mint so a session request that completes after this
        // teardown can't apply itself over the torn-down surface (its captured choice no longer
        // matches).
        sessionChoice++
        conversationListGeneration++
        conversationActionGeneration++
        sendOperationGeneration++
        cancelOperationGeneration++
        client = null
        events = null
        _state.value = UiState()
    }

    /**
     * Test seam: attach a pre-built client + event source and stamp an initial state WITHOUT
     * running bootstrap or the SSE stream, so session-orchestration (new/resume/send/gating) can
     * be exercised from a deterministic starting point. Mirrors the iOS `attachForTesting`.
     */
    @VisibleForTesting
    internal fun attachForTesting(client: AgentClient, events: AgentEventSource, initial: UiState) {
        cancelEphemeralGateTimeout()
        this.client = client
        this.events = events
        _state.value = initial
    }

    /**
     * Re-run bootstrap after a transient fatal. Preserves resume-most-recent so the
     * user's open transcript isn't skipped past (a fresh `newConversation()` would).
     */
    fun retry() {
        _state.update { it.copy(fatalError = null) }
        scope.launch { bootstrap() }
    }

    private suspend fun bootstrap() {
        val choice = sessionChoice
        refreshConversations()
        // An explicit open that landed while the list was loading owns the surface — skip the
        // default resume entirely.
        if (sessionChoice != choice) return
        // Resume the most recent transcript so the app re-opens where the user left off; fall
        // through to a fresh (empty, lazily-minted) session on the very first launch. Keyed on
        // updatedAt, not list order — the list is sorted pinned-first, so the first row may be an
        // older pinned conversation rather than the latest one.
        // The cold-start resume reuses the same optimistic path as an explicit open
        // (beginResume → load), so app launch shows the most-recent conversation's title +
        // skeleton while it loads rather than a blank surface. First launch (no prior
        // conversations) drops into a fresh, lazily-minted empty session.
        val mostRecent = _state.value.conversations.maxByOrNull { it.updatedAt }
        if (mostRecent != null) resumeInto(mostRecent.sessionId, choice)
        else resetToEmptySession()
    }

    // MARK: - Session orchestration

    /**
     * Start a fresh conversation. Purely local and instantaneous: it clears the surface
     * synchronously and mints NO session over the network. The session id is created lazily by
     * the first [send] (which already shows an optimistic user bubble, so the mint hides behind
     * it). Keeps the new-conversation button snappy and avoids burning a session slot for a
     * conversation the user never sends in. Mirrors the iOS `newConversation()`.
     */
    fun newConversation() {
        sessionChoice++
        resetToEmptySession()
    }

    /**
     * Open a stored conversation. The surface switches to the target immediately — its known
     * title from the list summary plus a transcript skeleton — before the transcript round-trip
     * starts, so navigation never blocks on I/O. An explicit open superseded while its fetch is
     * in flight is discarded via [sessionChoice]. Re-tapping the conversation already on screen
     * is a no-op. Mirrors the iOS `resumeConversation(id:)`.
     */
    /**
     * Resume a conversation, optionally posting [autoSend] as its first message once the
     * resume has actually landed.
     *
     * The auto-send exists for dictation hand-offs, where the user spoke a question at a
     * surface that is not the agent and expects to arrive mid-answer. It is deliberately
     * conditional: the surface adopts the target id optimistically, before the transcript
     * loads, so "did we land here" has to mean *and nothing failed on the way* — otherwise
     * a dictated question posts into a thread that never opened.
     */
    fun resumeConversation(id: String, autoSend: String? = null) {
        val st = _state.value
        if (id == st.sessionId && !st.transcriptLoading) {
            autoSend?.takeIf { it.isNotBlank() }?.let { send(it) }
            return
        }
        sessionChoice++
        resumeInto(id, sessionChoice, autoSend)
    }

    /**
     * Tell the gateway this app is showing a conversation, which clears its
     * unread marker everywhere. Optimistic locally so the drawer's dot goes at
     * once rather than waiting for the next list fetch, and best-effort on the
     * wire: a badge is not worth surfacing an error over.
     */
    /** Keeps the viewing claim alive while the surface shows a conversation. */
    private var seenLeaseJob: Job? = null
    private val seenRequestMutex = Mutex()
    private var visibleConversationId: String? = null
    private var claimedConversationId: String? = null
    private var appForeground = true

    private fun markConversationSeen(id: String, viewing: Boolean) {
        val c = client ?: return
        if (viewing) {
            _state.update { st ->
                if (st.conversations.none { it.sessionId == id && it.unread }) {
                    st
                } else {
                    st.copy(
                        conversations = st.conversations.map { summary ->
                            if (summary.sessionId == id) summary.copy(unread = false) else summary
                        },
                    )
                }
            }
        }
        // Foreground/background transitions can happen while the preceding
        // request is in flight. Serialize them so a late `viewing=false`
        // cannot overwrite the foreground lease that followed it.
        scope.launch {
            seenRequestMutex.withLock {
                runCatching { c.markConversationSeen(id, viewing) }
            }
        }
    }

    /**
     * The transcript surface is showing [id], or has stopped showing it.
     *
     * Only the surface may say this. Resuming a conversation is not rendering
     * it: a headless wake — a periodic sync worker, or the arrival of the push
     * itself — builds the session and resumes the most recent conversation
     * with no UI at all, and a claim from there would tell the gateway the
     * operator is reading something nobody can see.
     *
     * That is not a harmless delay. The gateway treats content arriving into a
     * conversation it believes is on screen as seen on arrival and opens no
     * unread episode, so a false claim loses that answer on every surface
     * rather than postponing it.
     */
    fun conversationSurfaceVisible(id: String, visible: Boolean) {
        if (!visible) {
            // A retiring screen can dispose after its replacement has already
            // claimed the surface. It no longer owns the lease in that case.
            if (visibleConversationId != id) return
            visibleConversationId = null
            stopSeenLease()
            return
        }
        if (visibleConversationId != id) {
            stopSeenLease()
            visibleConversationId = id
        }
        if (!appForeground || seenLeaseJob != null) return
        startSeenLease(id)
    }

    /** The transcript is not visible while the whole application is backgrounded. */
    fun appVisibilityChanged(foreground: Boolean) {
        if (appForeground == foreground) return
        appForeground = foreground
        if (!foreground) {
            stopSeenLease()
        } else {
            visibleConversationId?.let(::startSeenLease)
        }
    }

    private fun startSeenLease(id: String) {
        claimedConversationId = id
        // The gateway believes a viewing mark only for a bounded window and
        // advertises that window so clients can pace themselves. Without a
        // refresh the lease lapses under the user's eyes: a long turn then
        // lands as unread and pushes a banner for the answer they are watching
        // arrive.
        seenLeaseJob = scope.launch {
            while (isActive) {
                markConversationSeen(id, viewing = true)
                delay(seenRefreshMillis())
            }
        }
    }

    private fun stopSeenLease() {
        seenLeaseJob?.cancel()
        seenLeaseJob = null
        claimedConversationId?.let { markConversationSeen(it, viewing = false) }
        claimedConversationId = null
    }

    /**
     * Half the gateway's viewing window, so a refresh always lands well inside
     * it. [viewingTtlSeconds] is the gateway's own value where it is known.
     */
    private fun seenRefreshMillis(): Long =
        max(5_000L, (viewingTtlSeconds * 1_000L) / 2)

    /** The gateway's configured viewing window; its documented default. */
    var viewingTtlSeconds: Long = 90

    /** Re-pull the conversation list — driven by the drawer opening (pull-to-refresh / on-show). */
    fun refreshConversationsPublic() = scope.launch { refreshConversations() }.let { }

    fun loadMoreConversationsPublic() = scope.launch { loadMoreConversations() }.let { }

    /**
     * Optimistically flip the surface to [id] (adopting its known title from the sidebar summary
     * and raising the loading flag), then load + reconcile the persisted transcript. The result
     * is discarded if [sessionChoice] moved past [choice] while the fetch was in flight. Shared
     * by the explicit [resumeConversation] and the bootstrap resume-most-recent.
     */
    private fun resumeInto(id: String, choice: Int, autoSend: String? = null) {
        val c = client ?: return
        beginResume(id)
        val handoff = beginSnapshotHandoff(id)
        scope.launch {
            runCatching { c.createSession(id, transcriptLimit = 25) }.fold(
                onSuccess = {
                    if (sessionChoice == choice && snapshotHandoffIsCurrent(handoff)) {
                        applyCreatedSession(it)
                        finishSnapshotHandoff(handoff, it.eventCursor)
                        // Only once the resume has genuinely landed on this thread.
                        val landed = _state.value
                        if (landed.sessionId == id && landed.fatalError == null) {
                            autoSend?.takeIf { text -> text.isNotBlank() }?.let(::send)
                        }
                    } else {
                        discardSnapshotHandoff(handoff)
                    }
                },
                // Store the raw Error so the classifier can route URL failures to
                // "Couldn't connect to gateway" and surface operator bodies verbatim.
                onFailure = { e ->
                    if (sessionChoice == choice && snapshotHandoffIsCurrent(handoff)) {
                        failSnapshotHandoff(handoff, id)
                        // Minting a live session needs a runnable model; reading
                        // what was already said does not. When only the model is
                        // missing, show the conversation from storage rather than
                        // an error page over history the gateway still serves.
                        if (!isMissingLiveSession(e) || !loadReadOnlyTranscript(id, choice)) {
                            _state.update { it.copy(transcriptLoading = false, fatalError = e) }
                        }
                    } else {
                        discardSnapshotHandoff(handoff)
                    }
                },
            )
        }
    }

    /**
     * Reset the surface to the blank slate a brand-new conversation shows. Session identity is
     * dropped (a fresh session is minted lazily on first send); model/backend/title clear because
     * no session backs them yet. Sidebar state (`conversations`) is left untouched.
     */
    private fun resetToEmptySession() {
        cancelEphemeralGateTimeout()
        planClearJob?.cancel()
        planClearJob = null
        overflowSnapshotJob?.cancel()
        overflowSnapshotJob = null
        snapshotHandoff = null
        pendingSessionMint = null
        sendOperationGeneration++
        cancelOperationGeneration++
        conversationActionGeneration++
        _state.update {
            it.copy(
                sessionId = null,
                model = null,
                backend = null,
                title = "",
                chat = AgentChatState(),
                fatalError = null,
                transcriptLoading = false,
                transcriptPaging = CursorPagingState(),
                conversationOrigin = null,
                transcriptPrependVersion = 0,
                terminalFailure = null,
                sendRejectedText = null,
                conversationActionError = null,
                conversationActionErrorSessionId = null,
                activeConversationPinned = false,
                composerGeneration = it.composerGeneration + 1,
            )
        }
    }

    /**
     * Adopt [id] and its known title (from the list summary, if present) and raise the loading
     * flag so the view shows a transcript skeleton. The authoritative transcript arrives via
     * [applyCreatedSession], which lowers the flag. Live SSE events for [id] that arrive during
     * the load are buffered until the snapshot lands, then only events beyond its event cursor
     * are reduced so neither an in-flight delta nor a replayed delta is lost or duplicated.
     */
    private fun beginResume(id: String) {
        cancelEphemeralGateTimeout()
        planClearJob?.cancel()
        planClearJob = null
        pendingSessionMint = null
        sendOperationGeneration++
        cancelOperationGeneration++
        conversationActionGeneration++
        val summary = _state.value.conversations.firstOrNull { it.sessionId == id }
        _state.update {
            it.copy(
                sessionId = id,
                model = summary?.model,
                backend = summary?.backend,
                title = summary?.title ?: "",
                chat = AgentChatState(),
                fatalError = null,
                transcriptLoading = true,
                transcriptPaging = CursorPagingState(),
                conversationOrigin = null,
                transcriptPrependVersion = 0,
                terminalFailure = null,
                sendRejectedText = null,
                conversationActionError = null,
                conversationActionErrorSessionId = null,
                activeConversationPinned = summary?.pinned ?: false,
            )
        }
    }

    private fun applyCreatedSession(session: CreateSessionResponse) {
        cancelEphemeralGateTimeout()
        planClearJob?.cancel()
        planClearJob = null
        if (_state.value.sessionId == session.sessionId) {
            // A resumed snapshot is authoritative even when it reuses the visible session id.
            // Retire failures from requests that started against the pre-snapshot turn so they
            // cannot overwrite the reconstructed state after this hand-off.
            sendOperationGeneration++
            cancelOperationGeneration++
        }
        // Rebuild transcript + citations + trails from persisted history. Active-turn state
        // not represented by ChatMessage (plan, usage, tool children, research lifecycle) is
        // restored by replayEvents below.
        val messages = selectVisibleConversationMessages(
            messages = session.messages,
            messagesAreVisible = session.messagesAreVisible,
            origin = session.origin,
        )
        val rebuilt = AgentTurnBuilder.stateFrom(messages)
        val lastAssistantIndex = rebuilt.turns.indexOfLast { it is AgentTurn.Assistant }
        val lastTurnFailure = session.lastTurnFailure
        // The record's own account of how the last turn died, which carries the provider's
        // disposition. `AgentTurnBuilder` already lifted a failure out of the history marker for
        // a conversation stored before the record kept one; this is the better source, so it wins
        // where both exist.
        val chat =
            if (lastTurnFailure != null && lastAssistantIndex >= 0) {
                val truncated = lastTurnFailure.code == "output_truncated"
                rebuilt.copy(
                    turns = rebuilt.turns.toMutableList().also { turns ->
                        val assistant = turns[lastAssistantIndex] as AgentTurn.Assistant
                        turns[lastAssistantIndex] = assistant.copy(
                            // Only a truncation ended mid-answer; every other failure stopped the
                            // turn outright and has no output limit to name.
                            stopReason = if (truncated) "max_tokens" else assistant.stopReason,
                            failure = AgentTurnFailure(
                                message = AgentTurnBuilder.failureSentence(lastTurnFailure.message, truncated),
                                code = lastTurnFailure.code,
                                providerDetail = lastTurnFailure.provider?.formatLine(),
                            ),
                        )
                    },
                )
            } else {
                rebuilt
            }
        _state.update {
            it.copy(
                sessionId = session.sessionId,
                model = session.model,
                backend = session.backend,
                title = session.title,
                chat = chat.copy(busy = session.busy),
                fatalError = null,
                // The authoritative transcript is now in place — drop the skeleton.
                transcriptLoading = false,
                transcriptPaging = CursorPagingState(
                    nextCursor = session.messagePageInfo?.nextCursor,
                ),
                conversationOrigin = session.origin,
                terminalFailure = session.terminalFailure,
                // A session is live again, so the composer comes back.
                liveSessionMissingReason = null,
            )
        }
        session.replayEvents.forEach(::handle)
    }

    /**
     * Adopt the identity of a newly created, non-resumed session without replacing the first
     * turn already presented locally. The gateway contract makes this snapshot empty and idle;
     * transcript reconciliation begins with the subsequent message POST/SSE stream.
     */
    private fun adoptFreshlyMintedSession(session: CreateSessionResponse) {
        cancelEphemeralGateTimeout()
        _state.update {
            it.copy(
                sessionId = session.sessionId,
                model = session.model,
                backend = session.backend,
                fatalError = null,
                transcriptLoading = false,
                transcriptPaging = CursorPagingState(
                    nextCursor = session.messagePageInfo?.nextCursor,
                ),
                conversationOrigin = session.origin,
                terminalFailure = session.terminalFailure,
                liveSessionMissingReason = null,
            )
        }
    }

    /**
     * Render a stored conversation with no live session behind it.
     *
     * `GET /agent/conversations/:id/messages` is served by a reader the gateway wires
     * independently of the agent harness, so it answers while session creation is refusing.
     * Returns false if the transcript could not be read either, leaving the caller to report
     * its original error — the more accurate of the two.
     */
    private suspend fun loadReadOnlyTranscript(id: String, choice: Int): Boolean {
        val c = client ?: return false
        val page = runCatching { c.conversationMessages(id, limit = 25) }.getOrNull() ?: return false
        if (sessionChoice != choice) return false
        // The resume cleared the previous thread's anchor, so this read is where a read-only
        // thread learns its own: prefer what the page carried, and keep whatever is already on
        // screen when an older gateway omits it.
        val origin = page.origin ?: _state.value.conversationOrigin
        val messages = selectVisibleConversationMessages(
            messages = page.messages,
            messagesAreVisible = page.messagesAreVisible,
            origin = origin,
        )
        _state.update {
            it.copy(
                chat = AgentTurnBuilder.stateFrom(messages),
                conversationOrigin = origin,
                fatalError = null,
                transcriptLoading = false,
                transcriptPaging = CursorPagingState(nextCursor = page.messagePageInfo.nextCursor),
                liveSessionMissingReason = READ_ONLY_REASON,
            )
        }
        return true
    }

    /**
     * Re-attempt the session mint for the conversation already on screen.
     *
     * Distinct from a generic retry, which would resume whichever conversation is most recent
     * — not necessarily the one being read. On success the composer returns with the
     * transcript untouched; on failure the conversation simply stays read-only.
     */
    fun retryLiveSession() {
        val id = _state.value.sessionId ?: return
        if (_state.value.liveSessionMissingReason == null) return
        val c = client ?: return
        sessionChoice++
        val choice = sessionChoice
        scope.launch {
            runCatching { c.createSession(id, transcriptLimit = 25) }.onSuccess {
                if (sessionChoice == choice) applyCreatedSession(it)
            }
        }
    }

    /** Load one complete page before the visible transcript, preserving live suffix turns. */
    fun loadOlderMessages() {
        val c = client ?: return
        val current = _state.value
        val sid = current.sessionId ?: return
        if (current.chat.busy || current.transcriptLoading) return
        val started = current.transcriptPaging.beginLoadMore() ?: return
        val choice = sessionChoice
        _state.update { it.copy(transcriptPaging = started.state) }
        scope.launch {
            runCatching {
                c.conversationMessages(
                    sid,
                    limit = 25,
                    cursor = started.request.cursor,
                )
            }.fold(
                onSuccess = { page ->
                    val latest = _state.value
                    if (
                        sessionChoice != choice ||
                        latest.sessionId != sid ||
                        !latest.transcriptPaging.owns(started.request)
                    ) {
                        return@fold
                    }
                    val prefixed = "older:${started.request.cursor}:"
                    val messages = selectVisibleConversationMessages(
                        messages = page.messages,
                        messagesAreVisible = page.messagesAreVisible,
                        origin = latest.conversationOrigin,
                    )
                    val merged = prependOlderTranscript(latest.chat, messages, prefixed)
                    _state.value = latest.copy(
                        chat = merged,
                        transcriptPaging = latest.transcriptPaging.finishLoadMore(
                            started.request,
                            page.messagePageInfo.nextCursor,
                            madeProgress = merged.turns.size > latest.chat.turns.size,
                        ),
                        transcriptPrependVersion = latest.transcriptPrependVersion + 1,
                    )
                },
                onFailure = { error ->
                    _state.update {
                        it.copy(
                            transcriptPaging = it.transcriptPaging.failLoadMore(
                                started.request,
                                error,
                            ),
                        )
                    }
                },
            )
        }
    }

    // MARK: - User actions

    fun send(text: String, deepResearch: Boolean = false) {
        val c = client ?: return
        if (_state.value.terminalFailure != null) return
        val cleaned = text.trim()
        if (cleaned.isEmpty()) return
        // Compose blocks both the visible Send affordance and the IME action while busy. Keep a
        // coordinator-side guard as the final authority for a stale-composition race, restoring
        // the text because the composer's submit callback clears its local draft after dispatch.
        if (_state.value.chat.busy) {
            _state.update { it.copy(sendRejectedText = cleaned) }
            return
        }
        cancelOperationGeneration++
        val sendOperation = ++sendOperationGeneration

        scope.launch {
            // Claim the transcript before any network suspension. On a fresh conversation this
            // moves the surface off the landing page while POST /agent/sessions is still in
            // flight; established-session sends retain the same optimistic ordering as before.
            val optimisticId = "u-pending-${UUID.randomUUID()}"
            val titleWasEmpty = _state.value.title.isEmpty()
            _state.update {
                it.copy(
                    transcriptPaging = it.transcriptPaging.reset(it.transcriptPaging.nextCursor),
                    chat = it.chat.copy(
                        turns = it.chat.turns + AgentTurn.User(optimisticId, cleaned),
                        busy = true,
                        // A Deep Research send (`/`-pill) opens the working-set surface for this
                        // run; an ordinary send closes any surface left from a prior run.
                        deepResearch = deepResearch,
                        lastTurnError = null,
                    ),
                    title = if (titleWasEmpty) AgentReducer.deriveTitle(cleaned) else it.title,
                )
            }

            var sid = _state.value.sessionId
            if (sid == null) {
                // A new conversation stays sessionless until its first send. Mint behind the
                // already-visible user bubble and waiting indicator; only then can the message POST.
                // This explicit choice also makes a cold-start default resume yield to the send.
                sessionChoice++
                val mint = PendingSessionMint(
                    choice = sessionChoice,
                    sendOperation = sendOperation,
                    optimisticId = optimisticId,
                    text = cleaned,
                    titleWasEmpty = titleWasEmpty,
                )
                pendingSessionMint = mint
                val minted = runCatching { c.createSession(null) }.getOrElse { error ->
                    if (pendingSessionMint == mint) pendingSessionMint = null
                    if (
                        sessionChoice == mint.choice &&
                        sendOperationGeneration == mint.sendOperation
                    ) {
                        rollbackOptimisticSend(
                            optimisticId = optimisticId,
                            text = cleaned,
                            titleWasEmpty = titleWasEmpty,
                            error = "Send failed: ${classifyGatewayError(error)}",
                        )
                    } else if (client === c && sendOperationGeneration == mint.sendOperation) {
                        // The navigation reset already removed the bubble. Restore only its draft,
                        // and never write back into a torn-down or rebuilt coordinator.
                        _state.update { it.copy(sendRejectedText = cleaned) }
                    }
                    return@launch
                }
                if (pendingSessionMint == mint) pendingSessionMint = null
                if (
                    sessionChoice != mint.choice ||
                    sendOperationGeneration != mint.sendOperation
                ) {
                    // Navigation superseded this send. Preserve the draft only when no newer send
                    // has claimed the composer; its reset path already removed the old bubble.
                    if (client === c && sendOperationGeneration == mint.sendOperation) {
                        _state.update { it.copy(sendRejectedText = cleaned) }
                    }
                    return@launch
                }
                adoptFreshlyMintedSession(minted)
                sid = minted.sessionId
            }
            val liveSid = sid ?: run {
                rollbackOptimisticSend(
                    optimisticId = optimisticId,
                    text = cleaned,
                    titleWasEmpty = titleWasEmpty,
                    error = "Send failed: no live session was created",
                )
                return@launch
            }
            val sendSessionChoice = sessionChoice

            runCatching { c.sendMessage(liveSid, cleaned, deepResearch) }.fold(
                onSuccess = { resp ->
                    if (
                        sessionChoice != sendSessionChoice ||
                        _state.value.sessionId != liveSid
                    ) {
                        return@fold
                    }
                    val umid = resp.userMessageId ?: return@fold
                    _state.update { st ->
                        val turns = st.chat.turns
                        val alreadyMaterialized = turns.any { it is AgentTurn.User && it.id == umid }
                        val newTurns = if (alreadyMaterialized) {
                            // The agent.user.message event raced ahead of the HTTP
                            // response and already appended a server-stamped bubble —
                            // drop the optimistic placeholder to avoid a double render.
                            turns.filterNot { it is AgentTurn.User && it.id == optimisticId }
                        } else {
                            // Stamp the placeholder with the server id so the event-side
                            // dedupe recognises this bubble as already-rendered.
                            turns.map { if (it is AgentTurn.User && it.id == optimisticId) it.copy(id = umid) else it }
                        }
                        st.copy(chat = st.chat.copy(turns = newTurns))
                    }
                },
                onFailure = { e ->
                    if (
                        sessionChoice != sendSessionChoice ||
                        _state.value.sessionId != liveSid ||
                        sendOperationGeneration != sendOperation
                    ) {
                        return@fold
                    }
                    // The POST failed — roll back the optimistic bubble + temp title, and offer
                    // the text back to the composer rather than losing it.
                    if (isContextWindowConflict(e)) {
                        _state.update { st ->
                            st.copy(
                                chat = st.chat.copy(
                                    turns = st.chat.turns.filterNot {
                                        it is AgentTurn.User && it.id == optimisticId
                                    },
                                    busy = false,
                                    deepResearch = false,
                                    lastTurnError = null,
                                ),
                                title = if (titleWasEmpty) "" else st.title,
                            )
                        }
                        val handoff = beginSnapshotHandoff(liveSid)
                        val resumed = runCatching {
                            c.createSession(liveSid, transcriptLimit = 25)
                        }.getOrNull()
                        if (resumed != null && _state.value.sessionId == liveSid && snapshotHandoffIsCurrent(handoff)) {
                            applyCreatedSession(resumed)
                            finishSnapshotHandoff(handoff, resumed.eventCursor)
                        } else {
                            failSnapshotHandoff(handoff, liveSid)
                        }
                    } else {
                        _state.update { st ->
                            st.copy(
                                chat = st.chat.copy(
                                    turns = st.chat.turns.filterNot {
                                        it is AgentTurn.User && it.id == optimisticId
                                    },
                                    busy = false,
                                    // The POST failed — the run never started, so close the surface.
                                    deepResearch = false,
                                    lastTurnError = "Send failed: ${classifyGatewayError(e)}",
                                ),
                                title = if (titleWasEmpty) "" else st.title,
                                sendRejectedText = cleaned,
                            )
                        }
                    }
                },
            )
        }
    }

    /** Remove a locally optimistic send that never reached the message endpoint. */
    private fun rollbackOptimisticSend(
        optimisticId: String,
        text: String,
        titleWasEmpty: Boolean,
        error: String?,
    ) {
        _state.update { state ->
            state.copy(
                chat = state.chat.copy(
                    turns = state.chat.turns.filterNot {
                        it is AgentTurn.User && it.id == optimisticId
                    },
                    busy = false,
                    deepResearch = false,
                    lastTurnError = error,
                ),
                title = if (titleWasEmpty) "" else state.title,
                sendRejectedText = text,
            )
        }
    }

    /**
     * Ack the composer's consumption of [UiState.sendRejectedText] so a restored message isn't
     * re-restored on the next state emission.
     */
    fun ackSendRejected() {
        if (_state.value.sendRejectedText != null) _state.update { it.copy(sendRejectedText = null) }
    }

    /** Dismiss the current action-level error without disturbing the transcript. */
    fun ackLastTurnError() {
        if (_state.value.chat.lastTurnError != null) {
            _state.update { it.copy(chat = it.chat.copy(lastTurnError = null)) }
        }
    }

    fun cancelTurn() {
        val c = client ?: return
        val current = _state.value
        if (current.sessionId == null) {
            val mint = pendingSessionMint ?: return
            if (!current.chat.busy) return
            // The message endpoint has not been reached, so there is no server turn to cancel.
            // Retire the mint locally and hand its text back to the composer. If the HTTP mint
            // still completes, the invalidated choice/generation discards its response.
            sessionChoice++
            sendOperationGeneration++
            pendingSessionMint = null
            rollbackOptimisticSend(
                optimisticId = mint.optimisticId,
                text = mint.text,
                titleWasEmpty = mint.titleWasEmpty,
                error = null,
            )
            return
        }
        val sid = current.sessionId
        val cancelSessionChoice = sessionChoice
        val cancelOperation = ++cancelOperationGeneration
        _state.update { state ->
            if (state.sessionId == sid) {
                state.copy(chat = state.chat.copy(lastTurnError = null))
            } else {
                state
            }
        }
        scope.launch {
            val failure = runCatching {
                if (!c.cancel(sid)) {
                    throw GatewayException.InvalidResponse("gateway refused the stop request")
                }
            }.exceptionOrNull()

            // A late response belongs to the conversation on which Stop was pressed. Switching
            // conversations while the request is in flight must not stain the new transcript.
            if (
                sessionChoice != cancelSessionChoice ||
                _state.value.sessionId != sid ||
                cancelOperationGeneration != cancelOperation ||
                !_state.value.chat.busy
            ) {
                return@launch
            }
            if (failure != null) {
                Log.w(TAG, "agent cancel failed: $failure")
                _state.update { state ->
                    if (state.sessionId == sid) {
                        state.copy(
                            chat = state.chat.copy(
                                lastTurnError = "Stop failed: ${classifyGatewayError(failure)}",
                            ),
                        )
                    } else {
                        state
                    }
                }
            }
            // Do not clear the plan here. A successful cancellation emits agent.message.end,
            // whose authoritative reducer path schedules cleanup; a failed cancellation leaves
            // the turn and its live plan intact.
        }
    }

    private suspend fun refreshConversations() {
        val c = client ?: return
        val generation = ++conversationListGeneration
        val started = _state.value.conversationsPaging.beginRefresh()
        _state.update {
            it.copy(
                conversationsLoading = true,
                conversationsPaging = started.state,
            )
        }
        runCatching { c.conversationPage() }.fold(
            onSuccess = { page ->
                if (generation != conversationListGeneration || client !== c) return@fold
                _state.update { state ->
                    state.copy(
                        conversations = sortedPinnedFirst(page.conversations),
                        activeConversationPinned = page.conversations
                            .firstOrNull { summary -> summary.sessionId == state.sessionId }
                            ?.pinned
                            ?: state.activeConversationPinned,
                        conversationsPaging = state.conversationsPaging.finishRefresh(
                            started.request,
                            page.nextCursor,
                        ),
                        conversationsError = null,
                        conversationsLoading = false,
                    )
                }
            },
            onFailure = { e ->
                if (generation != conversationListGeneration || client !== c) return@fold
                _state.update {
                    it.copy(
                        conversationsError = "Could not load conversations: ${classifyGatewayError(e)}",
                        conversationsLoading = false,
                        conversationsPaging = it.conversationsPaging.failRefresh(started.request, e),
                    )
                }
            },
        )
    }

    private suspend fun loadMoreConversations() {
        val c = client ?: return
        val current = _state.value
        if (current.conversationsLoading) return
        val started = current.conversationsPaging.beginLoadMore() ?: return
        val generation = conversationListGeneration
        _state.update { it.copy(conversationsPaging = started.state) }
        runCatching { c.conversationPage(cursor = started.request.cursor) }.fold(
            onSuccess = { page ->
                val latest = _state.value
                if (
                    generation != conversationListGeneration ||
                    client !== c ||
                    !latest.conversationsPaging.owns(started.request)
                ) {
                    return@fold
                }
                _state.update { state ->
                    val seen = state.conversations.map { it.sessionId }.toSet()
                    val merged = state.conversations +
                        page.conversations.filterNot { seen.contains(it.sessionId) }
                    state.copy(
                        conversations = sortedPinnedFirst(merged),
                        conversationsPaging = state.conversationsPaging.finishLoadMore(
                            started.request,
                            page.nextCursor,
                            madeProgress = merged.size > state.conversations.size,
                        ),
                    )
                }
            },
            onFailure = { e ->
                val latest = _state.value
                if (
                    generation != conversationListGeneration ||
                    client !== c ||
                    !latest.conversationsPaging.owns(started.request)
                ) {
                    return@fold
                }
                _state.update {
                    it.copy(
                        conversationsPaging = it.conversationsPaging.failLoadMore(
                            started.request,
                            e,
                        ),
                    )
                }
            },
        )
    }

    fun deleteConversation(id: String) {
        val c = client ?: return
        if (id in _state.value.conversationActionsInFlight) {
            _state.update {
                it.copy(
                    conversationActionError = "A chat update is already in progress.",
                    conversationActionErrorSessionId = id,
                )
            }
            return
        }
        val exitedActiveConversation = _state.value.sessionId == id
        if (exitedActiveConversation) {
            // Navigation is local and immediate. A rejected DELETE leaves the
            // drawer row intact so the user can reopen it or retry.
            newConversation()
        }
        val generation = conversationActionGeneration
        _state.update {
            it.copy(
                conversationActionError = null,
                conversationActionErrorSessionId = null,
                conversationActionsInFlight = it.conversationActionsInFlight + id,
            )
        }
        scope.launch {
            runCatching { c.deleteConversation(id) }.fold(
                onSuccess = {
                    if (client !== c) return@fold
                    conversationListGeneration++
                    _state.update {
                        it.copy(
                            conversations = it.conversations.filterNot { summary -> summary.sessionId == id },
                            conversationsLoading = false,
                            conversationsPaging = it.conversationsPaging.reset(
                                it.conversationsPaging.nextCursor,
                            ),
                            conversationActionError = null,
                            conversationActionErrorSessionId = null,
                            conversationActionsInFlight = it.conversationActionsInFlight - id,
                        )
                    }
                },
                onFailure = { e ->
                    if (client !== c) return@fold
                    _state.update {
                        it.copy(
                            conversationActionError = if (generation == conversationActionGeneration) {
                                "Could not delete this chat: ${classifyGatewayError(e)}"
                            } else {
                                it.conversationActionError
                            },
                            conversationActionErrorSessionId = if (generation == conversationActionGeneration) {
                                if (exitedActiveConversation) null else id
                            } else {
                                it.conversationActionErrorSessionId
                            },
                            conversationActionsInFlight = it.conversationActionsInFlight - id,
                        )
                    }
                },
            )
        }
    }

    fun togglePin(id: String, pinned: Boolean) {
        val c = client ?: return
        if (id in _state.value.conversationActionsInFlight) {
            _state.update {
                it.copy(
                    conversationActionError = "A chat update is already in progress.",
                    conversationActionErrorSessionId = id,
                )
            }
            return
        }
        val generation = conversationActionGeneration
        _state.update {
            it.copy(
                conversationActionError = null,
                conversationActionErrorSessionId = null,
                conversationActionsInFlight = it.conversationActionsInFlight + id,
            )
        }
        scope.launch {
            runCatching { c.setPinned(id, pinned) }.fold(
                onSuccess = {
                    if (client !== c) return@fold
                    conversationListGeneration++
                    // Optimistically reflect the new state and re-sort pinned-first;
                    // the next natural refresh re-fetches the canonical server order.
                    _state.update { state ->
                        state.copy(
                            conversations = sortedPinnedFirst(
                                state.conversations.map {
                                    if (it.sessionId == id) it.copy(pinned = pinned) else it
                                },
                            ),
                            activeConversationPinned = if (state.sessionId == id) {
                                pinned
                            } else {
                                state.activeConversationPinned
                            },
                            conversationsLoading = false,
                            conversationsPaging = state.conversationsPaging.reset(
                                state.conversationsPaging.nextCursor,
                            ),
                            conversationActionError = null,
                            conversationActionErrorSessionId = null,
                            conversationActionsInFlight = state.conversationActionsInFlight - id,
                        )
                    }
                },
                onFailure = { e ->
                    if (client !== c) return@fold
                    val verb = if (pinned) "pin" else "unpin"
                    _state.update {
                        it.copy(
                            conversationActionError = if (generation == conversationActionGeneration) {
                                "Could not $verb this chat: ${classifyGatewayError(e)}"
                            } else {
                                it.conversationActionError
                            },
                            conversationActionErrorSessionId = if (generation == conversationActionGeneration) {
                                id
                            } else {
                                it.conversationActionErrorSessionId
                            },
                            conversationActionsInFlight = it.conversationActionsInFlight - id,
                        )
                    }
                },
            )
        }
    }

    fun ackConversationActionError() {
        _state.update {
            it.copy(
                conversationActionError = null,
                conversationActionErrorSessionId = null,
            )
        }
    }

    /**
     * Pinned conversations float to the top; the server's newest-first order is
     * preserved within each pin group. `sortedWith` is a stable sort, so the
     * descending-by-pinned comparator keeps each group's relative order.
     */
    private fun sortedPinnedFirst(items: List<ConversationSummary>): List<ConversationSummary> =
        items.sortedWith(compareByDescending { it.pinned })

    /** UI-driven: an ephemeral card's dismiss animation finished — drain its parked events. */
    fun flushEphemeralTail(toolCallId: String) {
        scope.launch {
            _state.update { it.copy(chat = AgentReducer.flushEphemeralTail(it.chat, toolCallId)) }
            reconcileEphemeralGateTimeout()
        }
    }

    /**
     * The card normally releases its causality gate after fading. This coordinator-owned
     * backstop keeps streamed answer text moving if Compose disposes the card mid-lifecycle.
     * The session + tool key prevents an old timeout from touching a newly selected chat.
     */
    private fun reconcileEphemeralGateTimeout() {
        val state = _state.value
        val sessionId = state.sessionId
        val toolCallId = AgentReducer.activeEphemeralGateWithPendingTail(state.chat)
        if (sessionId == null || toolCallId == null) {
            cancelEphemeralGateTimeout()
            return
        }
        val key = sessionId to toolCallId
        if (ephemeralGateTimeoutKey == key && ephemeralGateTimeoutJob?.isActive == true) return
        cancelEphemeralGateTimeout()
        ephemeralGateTimeoutKey = key
        ephemeralGateTimeoutJob = scope.launch {
            delay(ephemeralGateMaxHoldMs)
            val current = _state.value
            if (
                current.sessionId == key.first &&
                AgentReducer.activeEphemeralGateWithPendingTail(current.chat) == key.second
            ) {
                _state.update { latest ->
                    if (latest.sessionId != key.first) latest else latest.copy(
                        chat = AgentReducer.flushEphemeralTail(latest.chat, key.second),
                    )
                }
            }
            if (ephemeralGateTimeoutKey == key) {
                ephemeralGateTimeoutKey = null
                ephemeralGateTimeoutJob = null
            }
            // Flushing can replay a queued second ephemeral call and make it the new gate.
            reconcileEphemeralGateTimeout()
        }
    }

    private fun cancelEphemeralGateTimeout() {
        ephemeralGateTimeoutJob?.cancel()
        ephemeralGateTimeoutJob = null
        ephemeralGateTimeoutKey = null
    }

    // MARK: - SSE supervision

    private fun beginSnapshotHandoff(targetSessionId: String): Long {
        snapshotHandoffGeneration++
        val prior = snapshotHandoff
        val carriesPrior = prior?.targetSessionId == targetSessionId
        snapshotHandoff = SnapshotHandoff(
            generation = snapshotHandoffGeneration,
            targetSessionId = targetSessionId,
            events = if (carriesPrior) prior.events.toMutableList() else mutableListOf(),
            // A drop the superseded handoff already took is still a drop: this snapshot
            // inherits the duty to land and to rewind the stream over the gap.
            overflowed = carriesPrior && prior.overflowed,
        )
        return snapshotHandoffGeneration
    }

    private fun discardSnapshotHandoff(generation: Long) {
        if (snapshotHandoff?.generation == generation) snapshotHandoff = null
    }

    private fun snapshotHandoffIsCurrent(generation: Long): Boolean =
        snapshotHandoff?.generation == generation

    private fun failSnapshotHandoff(generation: Long, targetSessionId: String) {
        val handoff = snapshotHandoff ?: return
        if (handoff.generation != generation) return
        if (handoff.overflowed) {
            retryOverflowSnapshot(targetSessionId, generation)
        } else {
            finishSnapshotHandoff(generation, null)
        }
    }

    private fun acceptStreamItem(item: AgentStreamItem) {
        val handoff = snapshotHandoff
        if (handoff == null || item.event is AgentEvent.Resync || item.event.sessionId != handoff.targetSessionId) {
            handle(item.event)
            return
        }
        val duplicateIndex = item.id?.let { id -> handoff.events.indexOfFirst { it.id == id } } ?: -1
        if (duplicateIndex >= 0) {
            handoff.events[duplicateIndex] = item
            return
        }
        if (handoff.overflowed || handoff.events.size >= SNAPSHOT_HANDOFF_CAPACITY) {
            // The stream is outrunning the snapshot request. Release the buffer and drop what
            // follows rather than restarting the snapshot on every overflow — a restarted
            // request can never win that race, and each restart re-opens the same window, so
            // the transcript would sit frozen for as long as the stream stayed hot. The
            // snapshot in flight is left to land; `finishSnapshotHandoff` then rewinds the
            // stream to its cursor and the gateway replays the gap.
            handoff.overflowed = true
            handoff.events.clear()
            return
        }
        handoff.events += item
    }

    /**
     * Keep retrying the snapshot an overflowed handoff cannot do without: it dropped events
     * that exist nowhere else on this device, so "best effort" would leave the transcript
     * permanently behind. Retries until it lands or a newer handoff takes ownership.
     */
    private fun retryOverflowSnapshot(targetSessionId: String, generation: Long) {
        val c = client ?: return
        overflowSnapshotJob?.cancel()
        overflowSnapshotJob = scope.launch {
            var attempt = 0
            while (isActive && snapshotHandoffIsCurrent(generation)) {
                attempt++
                val session = try {
                    c.createSession(targetSessionId, transcriptLimit = 25)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Throwable) {
                    null
                }
                if (!isActive || !snapshotHandoffIsCurrent(generation)) return@launch
                // A snapshot without a cursor is no use to an overflowed handoff: it cannot say
                // where to rewind the stream to, and the buffer it would have fallen back on is
                // already released. Treat it like a failure and ask again.
                val cursor = session?.eventCursor
                if (session != null && cursor != null) {
                    applyCreatedSession(session)
                    finishSnapshotHandoff(generation, cursor)
                    return@launch
                }
                if (attempt >= OVERFLOW_SNAPSHOT_ATTEMPTS) {
                    // Stop holding the transcript still. A gap that keeps moving beats an answer
                    // frozen mid-sentence, and the next `agent.resync` or foreground reconcile
                    // gets another chance at a clean snapshot.
                    Log.w(TAG, "agent snapshot for $targetSessionId failed $attempt times — resuming the stream with a gap")
                    discardSnapshotHandoff(generation)
                    return@launch
                }
                delay(min(2.0.pow(attempt - 1).toLong() * 1000L, 30_000L))
            }
        }
    }

    private fun finishSnapshotHandoff(generation: Long, cursor: Long?) {
        val handoff = snapshotHandoff ?: return
        if (handoff.generation != generation) return
        // An overflowed handoff cannot be finished by a cursor-less snapshot: the dropped
        // events exist nowhere else, and without a cursor there is no point to rewind the
        // stream to. Keep ownership and ask for another one.
        if (handoff.overflowed && cursor == null) {
            retryOverflowSnapshot(handoff.targetSessionId, generation)
            return
        }
        snapshotHandoff = null
        overflowSnapshotJob = null
        if (handoff.overflowed) {
            // `lastEventId` tracked every event we RECEIVED, including the ones the overflow
            // dropped, so resuming from it would skip the gap for good. Rewind it to the
            // snapshot cursor and reconnect: the gateway replays from there, and if the gap
            // predates its buffer it says so with `agent.resync` and we snapshot again.
            lastEventId = checkNotNull(cursor).toString()
            startEventStream()
        } else if (cursor != null && (lastEventId?.toLongOrNull() ?: Long.MIN_VALUE) < cursor) {
            lastEventId = cursor.toString()
        }
        handoff.events.filter { streamEventIsNewer(it.id, cursor) }.forEach { handle(it.event) }
    }

    private fun startEventStream() {
        streamJob?.cancel()
        val src = events ?: return
        streamJob = scope.launch {
            while (isActive) {
                // Per-connection flag: the first delivered event clears the backoff so
                // the next failure starts over at 1s (without it, it accumulates forever).
                var sawEvent = false
                try {
                    // Resume from the last id seen so the gateway replays only the events
                    // missed since the previous connection dropped.
                    src.events(lastEventId).collect { item ->
                        if (!sawEvent) {
                            sawEvent = true
                            reconnectAttempt = 0
                        }
                        item.id?.let { lastEventId = it }
                        acceptStreamItem(item)
                    }
                    // Stream closed cleanly — back off identically to the error path so a
                    // gateway that EOFs on every connect doesn't tight-loop us.
                    delay(nextBackoffDelay())
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    val delayMs = nextBackoffDelay()
                    Log.w(TAG, "agent SSE error: $e — reconnecting in ${delayMs}ms")
                    delay(delayMs)
                }
            }
        }
    }

    private fun nextBackoffDelay(): Long {
        reconnectAttempt = min(reconnectAttempt + 1, 6)
        return min(2.0.pow(reconnectAttempt - 1).toLong() * 1000L, 30_000L)
    }

    private fun handle(event: AgentEvent) {
        // Forward-compat: ignore unrecognised event types.
        if (event is AgentEvent.Unknown) return
        // Resync is a connection-control signal, not a transcript event (it carries no
        // sessionId), so it has to be handled before the session-id guard: the gateway
        // couldn't replay what we missed, so reload the persisted transcript instead of
        // routing it through the reducer. Mirrors the iOS `.resync` SSE-loop branch.
        if (event is AgentEvent.Resync) {
            scope.launch { reconcileActiveConversation() }
            return
        }
        // Drop events for other sessions (the SSE is admin-scoped and sees every caller).
        // See #52 — planned: a list-level conversation event handled above this guard
        // so the drawer updates live for conversations advanced on another device.
        val live = _state.value.sessionId ?: return
        if (event.sessionId != live) return

        if (event is AgentEvent.MessageStart || event is AgentEvent.MessageEnd) {
            // A start hands ownership to the turn now visible on this session; an end retires it.
            // Either boundary makes failures from an older Stop or send request stale, including
            // a remote turn that starts while this device is still awaiting an HTTP callback.
            cancelOperationGeneration++
            sendOperationGeneration++
        }

        _state.update {
            val terminalFailure =
                if (
                    event is AgentEvent.MessageEnd &&
                    event.failure?.code == "context_window_exceeded"
                ) {
                    val failure = checkNotNull(event.failure)
                    AgentConversationTerminalFailure(
                        code = failure.code,
                        message = failure.message,
                        retryable = failure.retryable,
                        backend = failure.backend,
                        model = failure.model,
                        failedAt = Instant.now().toString(),
                        context = event.context,
                    )
                } else {
                    it.terminalFailure
                }
            it.copy(
                chat = AgentReducer.reduce(it.chat, event),
                terminalFailure = terminalFailure,
                // A live event can advance the suffix while an older page is
                // in flight. Invalidate that page rather than letting it
                // rebuild over newer reducer state.
                transcriptPaging = if (it.transcriptPaging.isLoadingMore) {
                    it.transcriptPaging.reset(it.transcriptPaging.nextCursor)
                } else {
                    it.transcriptPaging
                },
            )
        }
        reconcileEphemeralGateTimeout()

        // Side-effects the pure reducer can't own.
        if (event is AgentEvent.MessageEnd) {
            scope.launch { refreshConversations() }
            schedulePlanClear()
        }
    }

    @VisibleForTesting
    internal fun applyEventForTesting(event: AgentEvent) {
        handle(event)
    }

    @VisibleForTesting
    internal fun applySnapshotForTesting(
        session: CreateSessionResponse,
        buffered: List<AgentStreamItem>,
    ) {
        val handoff = beginSnapshotHandoff(session.sessionId)
        buffered.forEach(::acceptStreamItem)
        if (!snapshotHandoffIsCurrent(handoff)) return
        applyCreatedSession(session)
        finishSnapshotHandoff(handoff, session.eventCursor)
    }

    @VisibleForTesting
    internal fun beginSnapshotHandoffForTesting(targetSessionId: String): Long =
        beginSnapshotHandoff(targetSessionId)

    @VisibleForTesting
    internal fun bufferSnapshotEventForTesting(item: AgentStreamItem) = acceptStreamItem(item)

    @VisibleForTesting
    internal fun applySnapshotForTesting(session: CreateSessionResponse, generation: Long) {
        if (!snapshotHandoffIsCurrent(generation)) return
        applyCreatedSession(session)
        finishSnapshotHandoff(generation, session.eventCursor)
    }

    @VisibleForTesting
    internal fun failSnapshotHandoffForTesting(generation: Long, targetSessionId: String) =
        failSnapshotHandoff(generation, targetSessionId)

    /** `(generation, buffered event count, overflowed)` of the handoff in flight, if any. */
    @VisibleForTesting
    internal fun snapshotHandoffStateForTesting(): Triple<Long, Int, Boolean>? =
        snapshotHandoff?.let { Triple(it.generation, it.events.size, it.overflowed) }

    @VisibleForTesting
    internal fun lastEventIdForTesting(): String? = lastEventId

    /**
     * What the live collector records for every delivered event, applied or buffered — the
     * `item.id?.let { lastEventId = it }` line in [startEventStream]'s collect.
     */
    @VisibleForTesting
    internal fun noteStreamCursorForTesting(id: String) {
        lastEventId = id
    }

    /**
     * Reconcile the UI with the gateway's session snapshot. Persisted messages plus
     * replayEvents restore active-turn state, and eventCursor defines the exact handoff
     * to buffered SSE whether the session is idle or busy. Invoked on an `agent.resync`
     * control event and on foreground.
     * Best-effort: a failure leaves the current transcript in place. Mirrors the iOS
     * `reconcileActiveConversation`.
     */
    private suspend fun reconcileActiveConversation() {
        val c = client ?: return
        val sid = _state.value.sessionId ?: return
        val handoff = beginSnapshotHandoff(sid)
        runCatching { c.createSession(sid, transcriptLimit = 25) }.fold(
            onSuccess = { session ->
                if (!snapshotHandoffIsCurrent(handoff)) return
                applyCreatedSession(session)
                finishSnapshotHandoff(handoff, session.eventCursor)
            },
            onFailure = { e ->
                failSnapshotHandoff(handoff, sid)
                Log.w(TAG, "agent reconcile failed: $e")
            },
        )
    }

    /**
     * Bring the agent surface back in sync the instant the app returns to the
     * foreground: reconcile (reload the persisted terminal state) first, then resume
     * the stream. A backgrounded SSE connection is usually a zombie on resume — and
     * after a gateway restart the reconnect's stale `Last-Event-ID` is ahead of the
     * reset sequence, so the live stream can't catch us up incrementally. That left a
     * turn that finished while we were away stuck on a phantom "running…".
     * With no active session there's nothing to reconcile — just (re)open the stream.
     *
     * Independently of the active transcript, the conversation list can go stale
     * while backgrounded: the SSE feed is scoped to the active session, so a
     * conversation created or advanced on another device never reaches us. Re-fetch
     * the list on resume — in parallel, so it never delays the stream restart the
     * reconcile path is timed around. Mirrors the iOS `onForeground`.
     */
    fun onForeground() {
        if (client == null) return
        scope.launch { refreshConversations() }
        if (_state.value.sessionId == null) {
            startEventStream()
            return
        }
        scope.launch {
            // Quiesce first: a still-live connection would pour events into the handoff buffer
            // for the whole snapshot round-trip, and a busy turn (a Deep Research fan-out, say)
            // fills it in a fraction of a second. Reconciling against a silent stream and
            // reconnecting from the snapshot's cursor costs one replay and cannot race.
            streamJob?.cancel()
            streamJob = null
            try {
                reconcileActiveConversation()
            } finally {
                // The stream comes back even when the reconcile fails: leaving it down would
                // strand the surface with no live events at all until the next foreground.
                // A reconcile that already reopened it (the overflow rewind path) is left alone
                // rather than reconnected a second time.
                if (streamJob?.isActive != true) startEventStream()
            }
        }
    }

    // MARK: - Plan housekeeping

    /**
     * Schedule a deferred clear of plan items — a backstop for any items that didn't
     * reach `done` before the turn ended. 1.4s gives the panel's done-then-remove
     * animation time to land before we yank the rest.
     */
    private fun schedulePlanClear() {
        planClearJob?.cancel()
        planClearJob = scope.launch {
            delay(1400)
            _state.update { it.copy(chat = it.chat.copy(planItems = emptyList())) }
        }
    }

    internal companion object {
        const val TAG = "Omnesis:agent"
        // How many events a snapshot handoff buffers before it gives up on buffering and falls
        // back to a rewound stream replay (see SnapshotHandoff.overflowed).
        const val SNAPSHOT_HANDOFF_CAPACITY = 256

        // How many times an overflowed handoff re-requests the snapshot it cannot do without
        // before it abandons the gap and lets live events through again.
        const val OVERFLOW_SNAPSHOT_ATTEMPTS = 5
        private const val EPHEMERAL_GATE_MAX_HOLD_MS = 1_500L

        fun isContextWindowConflict(error: Throwable): Boolean =
            error is GatewayException.ServerError &&
                error.status == 409 &&
                error.code == "CONTEXT_WINDOW_EXCEEDED"

        /**
         * Whether a session mint failed for want of a runnable model rather than for want of a
         * gateway. The agent routes answer 503 only when the harness cannot run — unassigned,
         * no key, egress off, endpoint unreachable — so the status alone is the signal;
         * matching on the message would break every time the gateway rewords one.
         */
        fun isMissingLiveSession(error: Throwable): Boolean =
            error is GatewayException.ServerError && error.status == 503

        /**
         * Shown in place of the composer while a conversation is readable but not continuable.
         * Deliberately says what to do, not which backend timed out — the model's own state is
         * stated on the Models screen.
         */
        const val READ_ONLY_REASON =
            "The agent model isn't reachable, so this conversation is read-only."
    }
}

@VisibleForTesting
internal fun streamEventIsNewer(id: String?, cursor: Long?): Boolean {
    val sequence = id?.toLongOrNull()
    return cursor == null || sequence == null || sequence > cursor
}

/**
 * Prepend one server-guaranteed complete-turn page without rebuilding or
 * clobbering the live suffix. Citation/record indexes are merged so the older
 * turns' drawers work immediately too.
 */
@VisibleForTesting
internal fun prependOlderTranscript(
    current: AgentChatState,
    messages: List<ChatMessage>,
    idPrefix: String,
): AgentChatState {
    val older = AgentTurnBuilder.stateFrom(messages, idPrefix)
    val citations = older.citations.toMutableList()
    for (citation in current.citations) {
        val index = citations.indexOfFirst { it.documentId == citation.documentId }
        if (index < 0) {
            citations += citation
        } else {
            val existing = citations[index]
            val known = existing.entries.mapTo(mutableSetOf()) { it.toolCallId }
            citations[index] = existing.copy(
                docNote = citation.docNote ?: existing.docNote,
                entries = existing.entries + citation.entries.filter { known.add(it.toolCallId) },
            )
        }
    }
    val records = mergeOlderRecords(older.records, current.records)
    return current.copy(
        turns = older.turns + current.turns,
        citations = citations,
        citationsByDocId = citations.mapIndexed { index, citation ->
            citation.documentId to index
        }.toMap(),
        records = records,
    )
}

@VisibleForTesting
internal fun mergeOlderRecords(
    older: List<AgentTrailRecord>,
    current: List<AgentTrailRecord>,
): List<AgentTrailRecord> =
    current.fold(older, ::mergeRecord)

@VisibleForTesting
internal fun selectVisibleConversationMessages(
    messages: List<ChatMessage>,
    messagesAreVisible: Boolean,
    origin: ConversationOrigin?,
): List<ChatMessage> =
    if (messagesAreVisible) messages else visibleConversationMessages(messages, origin)

/**
 * Whether this build has a card to pin above the transcript for [origin] — an anchored thread
 * whose kind it recognises and whose snapshot it actually received.
 *
 * This is the precondition for two things that must agree: hiding the seeded prefix, and
 * showing the transcript rather than the blank-chat empty state. A thread whose whole
 * transcript is its seed has no visible turns, so a build that hid the prefix without drawing
 * the card would render an empty screen; one that drew neither would open on the agent's hidden
 * briefing prompt.
 */
/**
 * Whether the surface is already a blank new conversation — nothing said on it, nothing it is a
 * reply to, nothing loading or failed.
 *
 * Starting a new conversation from here would land on the state it is already in, so the
 * affordance that does it has nothing to offer and is not shown. This is the state
 * `newConversation()` resets to.
 */
@VisibleForTesting
internal fun isBlankNewConversation(state: AgentCoordinator.UiState): Boolean =
    state.sessionId == null &&
        state.chat.turns.isEmpty() &&
        state.conversationOrigin == null &&
        !state.transcriptLoading &&
        state.fatalError == null &&
        state.terminalFailure == null

@VisibleForTesting
internal fun hasContextCard(origin: ConversationOrigin?): Boolean = when (origin?.kind) {
    "brief" -> origin.brief != null
    "watch_firing" -> origin.watch != null
    else -> false
}

/**
 * Legacy gateways can return the creating run's folded transcript before the messages the user
 * wrote in an anchored thread. Hide that prefix only when the origin also carries the snapshot
 * that replaces it visually; unknown/partial origins remain fully visible.
 */
@VisibleForTesting
internal fun visibleConversationMessages(
    messages: List<ChatMessage>,
    origin: ConversationOrigin?,
): List<ChatMessage> {
    val seedCount = origin?.seedMessageCount
    return if (
        hasContextCard(origin) &&
        seedCount != null &&
        seedCount > 0 &&
        seedCount <= messages.size
    ) {
        messages.drop(seedCount)
    } else {
        messages
    }
}
