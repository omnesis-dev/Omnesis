// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI)
import SwiftUI

/// Owns the agent harness state: live session, conversation transcript,
/// citations panel, and the sidebar list of prior conversations.
/// Mirrors the reducer in `packages/gateway/portal/js/views/agent.js`.
///
/// Wired by `AppStore.rebuildAfterPairingChange()` (constructed lazily
/// after pair) so views never see a half-instantiated coordinator. The
/// SSE event stream is supervised here — auto-reconnects on transport
/// failure with a small backoff, identically to `DeviceSocket`.
@available(iOS 17.0, *)
@MainActor
@Observable
public final class AgentCoordinator {
    // MARK: - Observable state

    private(set) var client: AgentClient?
    private(set) var sessionId: String?
    private(set) var model: String?
    private(set) var backend: String?
    private(set) var title: String = ""

    /// Conversation turns as the UI renders them — user input bubbles
    /// and aggregated assistant turns (each carrying inline tool calls
    /// + results). Built by the same `chatMessagesToTurns` algorithm
    /// the portal uses, then mutated by streamed events.
    private(set) var turns: [AgentTurn] = []

    /// Monotonic counter incremented on every transcript mutation
    /// (new turn, text delta, tool result, etc.). Cheap to observe
    /// with `.onChange` — avoids diffing the entire turns array.
    private(set) var transcriptVersion: Int = 0

    /// Per-session citations — only documents the agent explicitly
    /// cited via the `annotate` tool. Each citation accumulates one
    /// entry per call (so the same doc can appear with multiple
    /// quotes).
    private(set) var citations: [AgentCitation] = []
    private(set) var citationsByDocId: [String: Int] = [:]

    /// Aggregated annotations from `annotate.recorded` — the ONLY document
    /// source for the side-panel Timeline. The Timeline view synthesises one
    /// row per annotated document.
    private(set) var trailAnnotations: AgentTrailAnnotations = .empty

    /// Directly-cited analytics rows from `cite_record.recorded` (#757),
    /// deduped by `recordKey` (last write wins), in arrival order. The
    /// Timeline synthesises a record-only row for each one.
    private(set) var recordCitations: [AgentTrailRecord] = []

    /// Live plan-panel state — the agent's TODO list for the current
    /// turn. Cleared on session reset and shortly after the last item
    /// flips to `done` (the panel collapses with a small grace period
    /// so the user sees the final checkmark land before it disappears).
    /// Order is preserved end-to-end; the panel view diffs against
    /// this array to drive slide-in / status-flip / auto-remove
    /// animations.
    private(set) var planItems: [AgentPlanItem] = []

    /// True while an assistant turn is in flight. The composer's send
    /// button becomes a cancel button while this is true.
    private(set) var busy: Bool = false

    /// Durable context exhaustion for the active conversation. Kept outside
    /// `turns` so it is never folded back into model-visible chat history.
    private(set) var terminalFailure: AgentConversationTerminalFailure?

    /// True while a user-invoked Deep Research run is in flight (the `/`-pill
    /// set `deepResearch:true` on the send). Drives the bespoke multi-panel
    /// research working-set surface: it appears only while this is set AND at
    /// least one sub-agent panel exists (`isResearchWorkspaceActive`), and
    /// collapses into the written-back report when the run ends (`messageEnd` /
    /// error / reset). A run-active marker, NOT persisted — resuming a
    /// conversation never re-opens the surface. Mirrors the portal reducer's
    /// `state.deepResearch`.
    private(set) var deepResearch: Bool = false

    /// User-facing fatal: agent harness not enabled, key missing,
    /// gateway unreachable, etc. Stored as the raw `Error` so the
    /// shared `GatewayErrorView` classifier can map it to a friendly
    /// kind (URLError → "Couldn't connect to gateway",
    /// GatewayClient.Error.serverError → operator-friendly body, …)
    /// without each consumer having to pre-stringify.
    private(set) var fatalError: Error?

    /// Why the conversation on screen has no live session behind it, when it
    /// has none. Set when the transcript was read from storage because the
    /// agent model could not run; nil whenever a session is live. The
    /// transcript stays fully readable — only sending is withheld, and this
    /// says why.
    private(set) var liveSessionMissingReason: String?

    /// Per-turn streaming error (rendered inline under the assistant
    /// bubble). Cleared at the next user send.
    private(set) var lastTurnError: String?

    /// Failure to deliver the user's explicit stop request. Kept separate
    /// from the streamed turn error because the turn is still authoritative
    /// and may continue running after this request fails.
    private(set) var cancelError: Error?

    /// Origin anchor of the active conversation when it is an anchored
    /// thread (brief talk-back or watch firing). Drives the context
    /// card pinned above the transcript; nil for plain conversations.
    private(set) var briefOrigin: ConversationOrigin?

    /// True while the transcript for a just-switched-to conversation is
    /// still loading over the network. Set the instant a resume begins —
    /// before the round-trip — so the surface flips to the target
    /// conversation immediately (title + skeleton) instead of showing the
    /// previous transcript until the fetch lands. Cleared by
    /// `applyCreatedSession` (success) or the resume error path. The view
    /// renders a transcript skeleton while this is true; the composer is
    /// disabled (the resumed session isn't live server-side yet).
    private(set) var transcriptLoading: Bool = false
    private(set) var transcriptPaging = CursorPagingState()

    private(set) var conversations: [ConversationSummary] = []
    private(set) var conversationsLoading: Bool = false
    private(set) var conversationsLoadingMore: Bool = false
    private(set) var conversationsNextCursor: String?
    private(set) var conversationsPagingTruncated = false
    private(set) var conversationsError: Error?
    private(set) var conversationActionError: Error?
    private(set) var conversationActionErrorSessionId: String?
    private(set) var conversationActionErrorContext = "update this chat"
    private(set) var activeConversationPinned = false
    private(set) var conversationActionsInFlight: Set<String> = []
    private(set) var conversationsPagingError: Error?
    /// Owns every conversation-list request across refreshes and pairing
    /// changes. A first-page refresh supersedes an older snapshot page, and
    /// teardown prevents a previous gateway from repopulating the new pairing.
    @ObservationIgnored
    private var conversationListGeneration = 0
    /// Retires action failures when navigation changes which transcript owns the surface.
    @ObservationIgnored
    private var conversationActionGeneration = 0

    var conversationsAutomaticLoadKey: PagingLoadKey? {
        guard !conversationsLoading, let conversationsNextCursor else { return nil }
        return PagingLoadKey(
            generation: conversationListGeneration,
            cursor: conversationsNextCursor
        )
    }

    /// Whether the composer should accept input. Enabled as soon as a
    /// client exists — including the fresh/empty state where no session has
    /// been minted yet (`send()` mints one lazily on the first message), so
    /// a brand-new conversation is typable immediately with no round-trip.
    /// Disabled while a resumed transcript is still loading (its session
    /// isn't live server-side yet) and while the fatal-error screen owns the
    /// surface.
    var canComposeMessage: Bool {
        client != nil && !transcriptLoading && fatalError == nil && terminalFailure == nil
            && liveSessionMissingReason == nil
    }

    // MARK: - Private internals

    @ObservationIgnored
    private var eventTask: Task<Void, Never>?
    @ObservationIgnored
    private var reconnectAttempt: Int = 0
    /// SSE `id:` of the last event received on the stream. Sent as
    /// `Last-Event-ID` on every (re)connect so the gateway replays exactly
    /// the events missed during a disconnect. Tracks the *last received*
    /// id (not the max) so it naturally resets after a gateway restart,
    /// whose sequence ids start over from 1.
    @ObservationIgnored
    private var lastEventId: String?
    @ObservationIgnored
    private var snapshotHandoffGeneration: Int = 0
    @ObservationIgnored
    private var snapshotHandoff: SnapshotHandoff?
    @ObservationIgnored
    private var overflowSnapshotTask: Task<Void, Never>?
    @ObservationIgnored
    private var pairing: Pairing?
    /// Invalidates HTTP send completions when navigation or a newer send owns
    /// the surface. Separate from the gateway's message id because a response
    /// can race ahead of `agent.message.start`.
    @ObservationIgnored
    private var sendOperationGeneration = 0
    /// Identity of the active turn within the current session. A conversation
    /// can finish one turn and start another without changing `sessionId`.
    @ObservationIgnored
    private var turnGeneration = 0
    /// Identity of the latest Stop request. Multiple taps for one turn are
    /// allowed, so the newest request alone may publish a failure.
    @ObservationIgnored
    private var cancelOperationGeneration = 0
    /// The optimistic turn shown while a brand-new conversation is still
    /// minting its first session. There is no server-side turn to cancel yet;
    /// Stop uses this identity to roll the local send back precisely.
    @ObservationIgnored
    private var pendingSessionMint: PendingSessionMint?

    private struct PendingSessionMint {
        let optimisticId: String
        let sendOperation: Int
        let titleWasEmpty: Bool
        let text: String
        let deepResearch: Bool
    }

    private enum SessionMintResult {
        case ready
        case failed(Error)
        case superseded
    }

    init() {}

    // MARK: - Lifecycle

    /// Bring the agent surface up on a fresh pairing. Creates the
    /// client, starts the SSE stream, and resumes the user's most
    /// recent conversation if one exists. On the very first launch
    /// (no prior conversations) we leave the session unset — the
    /// first send() lazily mints one. This keeps the gateway's
    /// per-caller session cap from being burned by every TestFlight
    /// reinstall.
    func rebuild(pairing: Pairing) {
        teardown()
        self.pairing = pairing
        let client = AgentClient(baseURL: pairing.url, token: pairing.token)
        self.client = client
        startEventStream()
        Task { await self.bootstrap() }
    }

    /// Re-run the bootstrap path. Used by the "Retry" button on the
    /// fatal-error screen so the user can recover from a transient
    /// gateway outage without losing the resume-most-recent behaviour
    /// (a fresh `newConversation()` would skip past their open
    /// transcript).
    func retry() async {
        fatalError = nil
        liveSessionMissingReason = nil
        await bootstrap()
    }

    private func bootstrap() async {
        let choice = sessionChoiceCount
        await refreshConversations()
        // An explicit open that landed while the list was loading (e.g. a
        // push deep-open racing a cold start) owns the surface — skip the
        // default resume entirely.
        guard sessionChoiceCount == choice else { return }
        // Resume the most recent transcript so the app re-opens where the
        // user left off. Keyed on `updatedAt`, not list order — the list
        // is sorted pinned-first, so `conversations.first` may be an older
        // pinned conversation rather than the genuinely most recent one.
        // Falls through to a fresh session only on the very first launch
        // (or if loading fails).
        let mostRecent = conversations.max(by: { $0.updatedAt < $1.updatedAt })
        await applyDefaultSession(resumeFromId: mostRecent?.sessionId, ifStillAt: choice)
    }

    /// The bootstrap default: create (or resume) a session and apply it —
    /// unless an explicit session choice superseded it while the request
    /// was in flight, in which case the result (or error) is discarded.
    private func applyDefaultSession(resumeFromId: String?, ifStillAt choice: Int) async {
        guard let client else { return }
        let handoff = resumeFromId.map { beginSnapshotHandoff(targetSessionId: $0) }
        do {
            let session = try await client.createSession(
                profile: "interactive",
                resumeFromId: resumeFromId,
                transcriptLimit: resumeFromId == nil ? nil : 25
            )
            guard sessionChoiceCount == choice, snapshotHandoffIsCurrent(handoff) else {
                discardSnapshotHandoff(handoff)
                return
            }
            await applyCreatedSession(session)
            await finishSnapshotHandoff(handoff, after: session.eventCursor)
        } catch {
            guard sessionChoiceCount == choice, snapshotHandoffIsCurrent(handoff) else {
                discardSnapshotHandoff(handoff)
                return
            }
            await failSnapshotHandoff(handoff, targetSessionId: resumeFromId)
            // Store the raw Error so `GatewayErrorView.classify(_:)`
            // can route URL failures to "Couldn't connect to gateway"
            // and surface operator-friendly server bodies (e.g.
            // "Anthropic API key not configured") verbatim.
            fatalError = error
        }
    }

    /// Drop client + event stream. Called on unpair / re-pair.
    func teardown() {
        eventTask?.cancel()
        eventTask = nil
        overflowSnapshotTask?.cancel()
        overflowSnapshotTask = nil
        snapshotHandoff = nil
        planClearTask?.cancel()
        planClearTask = nil
        cancelAllGateHolds()
        reconnectAttempt = 0
        lastEventId = nil
        sessionChoiceCount &+= 1
        conversationListGeneration &+= 1
        conversationActionGeneration &+= 1
        sendOperationGeneration &+= 1
        turnGeneration &+= 1
        cancelOperationGeneration &+= 1
        client = nil
        pairing = nil
        sessionId = nil
        model = nil
        backend = nil
        title = ""
        turns = []
        citations = []
        citationsByDocId = [:]
        planItems = []
        busy = false
        terminalFailure = nil
        deepResearch = false
        fatalError = nil
        liveSessionMissingReason = nil
        lastTurnError = nil
        cancelError = nil
        pendingSessionMint = nil
        briefOrigin = nil
        transcriptLoading = false
        transcriptVersion = 0
        transcriptPaging.reset()
        conversations = []
        conversationsLoading = false
        conversationsLoadingMore = false
        conversationsNextCursor = nil
        conversationsPagingTruncated = false
        conversationsError = nil
        conversationActionError = nil
        conversationActionErrorSessionId = nil
        activeConversationPinned = false
        conversationActionsInFlight = []
        conversationsPagingError = nil
    }

    // MARK: - Session orchestration

    /// Count of explicit session choices — a conversation-list tap, a
    /// push deep-open, a talk-back jump, a new-conversation action. The
    /// default flows that can race them (`bootstrap()`'s
    /// resume-most-recent, the foreground/resync reconcile) snapshot
    /// this before their session request and discard the result if the
    /// count moved while the request was in flight — so an explicit
    /// choice wins deterministically no matter which network call
    /// completes last. All reads and writes happen on the MainActor, so
    /// the snapshot-compare cannot itself race.
    @ObservationIgnored
    private var sessionChoiceCount = 0

    /// Start a fresh conversation. This is a purely local, instantaneous
    /// operation: it clears the surface synchronously and mints no session
    /// over the network. The session id is created lazily by the first
    /// `send()` (which immediately shows an optimistic user bubble, so the
    /// mint hides behind it). That keeps the new-conversation button snappy — the
    /// screen clears the moment it's tapped — and avoids burning a session
    /// slot for a conversation the user may never send in. Idempotent:
    /// tapping it again just re-clears.
    func newConversation() {
        sessionChoiceCount += 1
        resetToEmptySession()
    }

    // MARK: - Read state

    /// Whether the transcript surface is on screen, and whether the app is
    /// frontmost. A conversation is being *read* only when both hold: the
    /// scene being active says nothing about whether the user is looking at
    /// this surface rather than Search or Settings.
    ///
    /// Claiming otherwise is not a harmless delay. The gateway treats content
    /// arriving into a conversation it believes is on screen as seen on
    /// arrival — it opens no unread episode at all — so a false claim loses
    /// that answer permanently rather than merely postponing its dot.
    private var surfaceVisible = false
    private var appActive = true
    /// Cancel-and-replace, so a background/foreground bounce cannot land its
    /// two marks out of order and leave a stale claim behind.
    @ObservationIgnored private var seenTask: Task<Void, Never>?
    /// Which conversation the gateway currently believes is on screen.
    private var claimedSeen: String?

    /// The transcript surface appeared or disappeared.
    func agentSurfaceVisibilityChanged(_ visible: Bool) {
        surfaceVisible = visible
        reconcileSeenClaim()
    }

    /// The app became frontmost, or left it.
    func appActiveChanged(_ active: Bool) {
        appActive = active
        reconcileSeenClaim()
    }

    /// Bring the gateway's belief in line with what is actually on screen.
    ///
    /// Idempotent, so every caller can simply state the current facts. The
    /// claim is refreshed on a timer while it holds, because the gateway only
    /// believes an unrefreshed mark for a bounded window — without that, a
    /// long turn outlives the lease and pushes an answer the user is watching
    /// arrive.
    private func reconcileSeenClaim() {
        let target = (surfaceVisible && appActive) ? sessionId : nil
        if target == claimedSeen, target == nil { return }
        let previous = claimedSeen
        claimedSeen = target
        seenTask?.cancel()
        guard let client else { return }
        seenTask = Task { [weak self] in
            if let previous, previous != target {
                try? await client.markConversationSeen(id: previous, viewing: false)
            }
            guard let target else { return }
            self?.clearUnreadLocally(target)
            while !Task.isCancelled {
                try? await client.markConversationSeen(id: target, viewing: true)
                let refresh = await self?.seenRefreshInterval ?? Self.fallbackSeenRefresh
                try? await Task.sleep(nanoseconds: UInt64(refresh * 1_000_000_000))
            }
        }
    }

    /// Drop the dot on a conversation now on screen, rather than waiting for
    /// the next list fetch to say what is already true.
    private func clearUnreadLocally(_ id: String) {
        guard conversations.contains(where: { $0.sessionId == id && $0.unread }) else { return }
        conversations = conversations.map { $0.sessionId == id ? $0.markedRead() : $0 }
    }

    /// Half the window the gateway believes a mark for, so a refresh always
    /// lands well inside it. The gateway advertises its own value; this is the
    /// floor used until it has been read.
    private static let fallbackSeenRefresh: Double = 45

    private var seenRefreshInterval: Double {
        max(5, viewingTtlSeconds / 2)
    }

    /// Populated from `/status`; the gateway's configured viewing window.
    var viewingTtlSeconds: Double = 90

    /// Open a stored conversation. The surface switches to the target
    /// *immediately* — its known title from the list summary, plus a
    /// transcript skeleton — before the transcript round-trip starts, so
    /// navigation never blocks on I/O. The persisted transcript then loads
    /// and reconciles the view. An explicit open that's superseded while its
    /// fetch is in flight (a newer tap, a new conversation) is discarded via
    /// the `sessionChoiceCount` guard rather than clobbering the surface.
    func resumeConversation(id: String) async {
        // Re-tapping the conversation already on screen is a no-op — don't
        // flash a skeleton over content that's already correct.
        if id == sessionId, !transcriptLoading { return }
        sessionChoiceCount += 1
        let choice = sessionChoiceCount
        guard let client else { return }
        beginResume(to: id)
        let handoff = beginSnapshotHandoff(targetSessionId: id)
        do {
            let session = try await client.createSession(
                profile: "interactive",
                resumeFromId: id,
                transcriptLimit: 25
            )
            guard sessionChoiceCount == choice, snapshotHandoffIsCurrent(handoff) else {
                discardSnapshotHandoff(handoff)
                return
            }
            await applyCreatedSession(session)
            await finishSnapshotHandoff(handoff, after: session.eventCursor)
        } catch {
            guard sessionChoiceCount == choice, snapshotHandoffIsCurrent(handoff) else {
                discardSnapshotHandoff(handoff)
                return
            }
            await failSnapshotHandoff(handoff, targetSessionId: id)
            // Minting a live session needs a runnable model; reading what was
            // already said does not. When only the model is missing, show the
            // conversation from storage rather than an error page over history
            // the gateway is still perfectly willing to serve.
            if Self.isMissingLiveSession(error), await loadReadOnlyTranscript(id: id, choice: choice) {
                return
            }
            transcriptLoading = false
            fatalError = error
        }
    }

    /// Whether a session mint failed for want of a runnable model rather than
    /// for want of a gateway. The agent routes answer 503 only when the
    /// harness cannot run — unassigned, no key, egress off, endpoint
    /// unreachable — so the status alone is the signal; matching on the
    /// message would break every time the gateway rewords one.
    static func isMissingLiveSession(_ error: Error) -> Bool {
        guard case GatewayClient.Error.serverError(let status, _) = error else { return false }
        return status == 503
    }

    /// Render a stored conversation with no live session behind it.
    ///
    /// `GET /agent/conversations/:id/messages` is served by a reader the
    /// gateway wires independently of the agent harness, so it answers while
    /// session creation is refusing. Returns false if the transcript could not
    /// be read either, leaving the caller to report its original error — the
    /// more accurate of the two.
    private func loadReadOnlyTranscript(id: String, choice: Int) async -> Bool {
        guard let client else { return false }
        do {
            let page = try await client.loadConversationMessages(id: id, limit: 25)
            guard sessionChoiceCount == choice else { return false }
            applyStoredTranscript(page)
            transcriptLoading = false
            liveSessionMissingReason = Self.readOnlyReason
            return true
        } catch {
            return false
        }
    }

    /// Shown in place of the composer while a conversation is readable but not
    /// continuable. Deliberately says what to do, not which backend timed out —
    /// the model's own state is stated on Settings → Models.
    static let readOnlyReason = "The agent model isn't reachable, so this conversation is read-only."

    /// Re-attempt the session mint for the conversation already on screen.
    ///
    /// Distinct from `retry()`, which re-runs bootstrap and would resume
    /// whichever conversation is most recent — not necessarily the one being
    /// read. On success the composer returns with the transcript untouched; on
    /// failure the conversation simply stays read-only.
    func retryLiveSession() async {
        guard liveSessionMissingReason != nil, let client else { return }
        _ = await mintSessionIfNeeded(client: client)
    }

    /// Clear every per-conversation transcript field shared by starting a
    /// fresh conversation and switching to a resumed one. The caller sets the
    /// identity fields (`sessionId`/`model`/`backend`/`title`) and
    /// `transcriptLoading` afterward, since those are exactly what
    /// distinguishes the two entry points. Sidebar state (`conversations`) is
    /// left untouched. Kept in one place so the two callers — and the
    /// wholesale reset in `applyCreatedSession` — can't drift.
    private func clearTranscriptState() {
        sendOperationGeneration &+= 1
        turnGeneration &+= 1
        cancelOperationGeneration &+= 1
        conversationActionGeneration &+= 1
        conversationActionError = nil
        conversationActionErrorSessionId = nil
        planClearTask?.cancel()
        planClearTask = nil
        cancelAllGateHolds()
        turns = []
        citations = []
        citationsByDocId = [:]
        trailAnnotations = .empty
        recordCitations = []
        planItems = []
        briefOrigin = nil
        busy = false
        terminalFailure = nil
        deepResearch = false
        lastTurnError = nil
        cancelError = nil
        pendingSessionMint = nil
        fatalError = nil
        liveSessionMissingReason = nil
        transcriptVersion = 0
        transcriptPaging.reset()
    }

    /// Reset the surface to the blank slate a brand-new conversation shows.
    /// Session identity is dropped (a fresh session is minted lazily on first
    /// send); model/backend/title clear because no session backs them yet.
    private func resetToEmptySession() {
        overflowSnapshotTask?.cancel()
        overflowSnapshotTask = nil
        snapshotHandoff = nil
        clearTranscriptState()
        sessionId = nil
        model = nil
        backend = nil
        title = ""
        activeConversationPinned = false
        transcriptLoading = false
    }

    /// Optimistically flip the surface to a conversation being resumed: adopt
    /// its id and its known title (from the list summary, if present) and
    /// raise the loading flag so the view shows a transcript skeleton. The
    /// authoritative transcript arrives via `applyCreatedSession`, which lowers
    /// the flag. Live SSE events for `id` that arrive during the load are
    /// buffered until the snapshot lands, then reduced only when their id
    /// is beyond its event cursor.
    private func beginResume(to id: String) {
        clearTranscriptState()
        let summary = conversations.first { $0.sessionId == id }
        sessionId = id
        model = summary?.model
        backend = summary?.backend
        title = summary?.title ?? ""
        activeConversationPinned = summary?.pinned ?? false
        transcriptLoading = true
    }

    /// Ensure a live session exists before a send, minting one lazily for a
    /// fresh conversation. Returns `.ready` immediately when a session is
    /// already active. The mint is counted as an explicit session choice so a
    /// bootstrap default-resume still in flight is discarded rather than
    /// clobbering this new chat. The caller owns any optimistic presentation
    /// across the authoritative snapshot that session creation applies.
    private func mintSessionIfNeeded(
        client: AgentClient,
        preserving optimisticSend: PendingSessionMint? = nil
    ) async
        -> SessionMintResult {
        // A read-only conversation has an id but no live session, so it needs
        // the same lazy mint a fresh chat does — resuming into the thread on
        // screen rather than starting a new one beside it.
        let resumeTarget = liveSessionMissingReason == nil ? nil : sessionId
        guard sessionId == nil || resumeTarget != nil else { return .ready }
        sessionChoiceCount += 1
        let choice = sessionChoiceCount
        do {
            let session = try await client.createSession(
                profile: "interactive",
                resumeFromId: resumeTarget
            )
            guard sessionChoiceCount == choice else { return .superseded }
            await applyCreatedSession(session, preserving: optimisticSend)
            return .ready
        } catch {
            guard sessionChoiceCount == choice else { return .superseded }
            return .failed(error)
        }
    }

    private func applyCreatedSession(
        _ session: CreateSessionResponse,
        preserving optimisticSend: PendingSessionMint? = nil
    ) async {
        sendOperationGeneration &+= 1
        turnGeneration &+= 1
        cancelOperationGeneration &+= 1
        cancelError = nil
        sessionId = session.sessionId
        activeConversationPinned = conversations
            .first(where: { $0.sessionId == session.sessionId })?.pinned ?? activeConversationPinned
        // The surface now shows this conversation — covers an explicit open,
        // the cold-launch resume, and a re-tap alike, and only once the
        // transcript actually arrived rather than on the optimistic switch.
        defer { reconcileSeenClaim() }
        model = session.model
        backend = session.backend
        title = session.title
        briefOrigin = session.origin
        // A brief thread's leading messages are the folded transcript of
        // the steward run that created the brief — context for the
        // agent, internals for the user. Hide that prefix everywhere
        // (turns, citations, annotations) and let the pinned brief card
        // carry the context instead.
        let visible = session.messagesAreVisible
            ? session.messages
            : Self.visibleMessages(session.messages, origin: session.origin)
        turns = AgentTurnBuilder.turns(from: visible)
        // The record's own account of how the last turn died, which carries the
        // provider's disposition. `AgentTurnBuilder.turns(from:)` already lifted
        // a failure out of the history marker for a conversation stored before
        // the record kept one; this is the better source, so it wins where both
        // exist.
        if let lastTurnFailure = session.lastTurnFailure {
            let truncated = lastTurnFailure.code == "output_truncated"
            mutateLastAssistant { turn in
                // Only a truncation ended mid-answer; every other failure
                // stopped the turn outright and has no output limit to name.
                if truncated { turn.stopReason = "max_tokens" }
                turn.failure = AgentTurnFailure(
                    code: lastTurnFailure.code,
                    message: AgentTurnBuilder.failureSentence(
                        lastTurnFailure.message,
                        truncated: truncated
                    ),
                    provider: lastTurnFailure.provider
                )
            }
        }
        var cits = AgentTurnBuilder.citations(from: visible)
        // Seed the Citations set from any persisted Deep Research
        // `report_artifact` part (#748). A deep-research run cites via the
        // merged artifact set, not via `annotate` tool pairs, so
        // `citations(from:)` reconstructs none of them — without this the
        // resumed citation drawer loses those sources. Each seed has empty
        // entries because quote/note context is not persisted.
        var seenDocs = Set(cits.map(\.documentId))
        for ref in AgentTurnBuilder.reportArtifactCitations(from: visible)
            where !seenDocs.contains(ref.documentId) {
            seenDocs.insert(ref.documentId)
            cits.append(AgentCitation(documentId: ref.documentId, ref: ref, entries: []))
        }
        citations = cits
        citationsByDocId = Dictionary(uniqueKeysWithValues: cits.enumerated().map { ($1.documentId, $0) })
        // Rebuild the Timeline's annotation + record-citation state from
        // persisted history so the Citations drawer's Timeline tab works on
        // resume the same way it does live. Mirror of the citations rebuild
        // above. The raw `trace_connections` walk output is deliberately not
        // rebuilt — it never feeds the Timeline.
        trailAnnotations = AgentTurnBuilder.trailAnnotations(from: visible)
        recordCitations = AgentTurnBuilder.recordCitations(from: visible)
        // Reset persisted-history state first. Active-turn state not represented
        // by ChatMessage (plan, usage, tool children, research lifecycle) is
        // restored by replayEvents below.
        planClearTask?.cancel()
        planClearTask = nil
        planItems = []
        busy = session.busy
        terminalFailure = session.terminalFailure
        // The research surface is a live-run marker — a resumed/reset session
        // never re-opens it.
        deepResearch = session.replayEvents.contains { event in
            if case .subagentSpawned(_, _, let specialist, _, _, _) = event {
                return specialist != "generic"
            }
            return false
        }
        lastTurnError = nil
        transcriptVersion = 0
        // A successful session-create dismisses the fatal-error screen.
        // Without this, Retry can succeed silently while the UI stays
        // stuck on the previous error message. It also ends a read-only
        // stretch: a session is live again, so the composer comes back.
        fatalError = nil
        liveSessionMissingReason = nil
        // The authoritative transcript is now in place — drop the skeleton.
        transcriptLoading = false
        if let optimisticSend {
            // A brand-new session snapshot is authoritative but empty. Re-overlay the local
            // first turn as part of the same MainActor reconciliation so observers retain one
            // continuous bubble-and-working state across the mint.
            presentOptimisticSend(
                id: optimisticSend.optimisticId,
                text: optimisticSend.text,
                deepResearch: optimisticSend.deepResearch,
                deriveTitle: optimisticSend.titleWasEmpty
            )
            pendingSessionMint = nil
        }
        transcriptPaging.reset(nextCursor: session.messagePageInfo?.nextCursor)
        for event in session.replayEvents {
            await handle(event: event)
        }
    }

    /// Populate the surface from stored messages alone, with no live session
    /// behind it. The same derivations `applyCreatedSession` runs over a
    /// resumed transcript, minus everything that only a live session can
    /// supply: there are no replay events to fold, nothing is busy, and no
    /// turn is in flight.
    private func applyStoredTranscript(_ page: ConversationMessagePage) {
        let visible = page.messagesAreVisible
            ? page.messages
            : Self.visibleMessages(page.messages, origin: briefOrigin)
        turns = AgentTurnBuilder.turns(from: visible)
        var cits = AgentTurnBuilder.citations(from: visible)
        var seenDocs = Set(cits.map(\.documentId))
        for ref in AgentTurnBuilder.reportArtifactCitations(from: visible)
            where !seenDocs.contains(ref.documentId) {
            seenDocs.insert(ref.documentId)
            cits.append(AgentCitation(documentId: ref.documentId, ref: ref, entries: []))
        }
        citations = cits
        citationsByDocId = Dictionary(uniqueKeysWithValues: cits.enumerated().map { ($1.documentId, $0) })
        trailAnnotations = AgentTurnBuilder.trailAnnotations(from: visible)
        recordCitations = AgentTurnBuilder.recordCitations(from: visible)
        planClearTask?.cancel()
        planClearTask = nil
        planItems = []
        busy = false
        deepResearch = false
        lastTurnError = nil
        transcriptVersion = 0
        fatalError = nil
        transcriptPaging.reset(nextCursor: page.messagePageInfo.nextCursor)
    }

    /// Prepend one complete page of older persisted turns while preserving
    /// live turns already appended by SSE. The gateway cuts pages only at
    /// turn boundaries, so an assistant/tool-result group is never split.
    @discardableResult
    func loadOlderMessages() async -> Bool {
        guard let client, let sessionId else { return false }
        guard let request = transcriptPaging.beginLoadMore() else { return false }
        do {
            let page = try await client.loadConversationMessages(
                id: sessionId,
                limit: 25,
                cursor: request.cursor
            )
            guard transcriptPaging.owns(request) else { return false }
            let visible = page.messagesAreVisible
                ? page.messages
                : Self.visibleMessages(page.messages, origin: briefOrigin)
            let prefix = "older-\(request.cursor?.hashValue ?? 0)-"
            let olderTurns = AgentTurnBuilder.turns(from: visible, idPrefix: prefix)
            turns.insert(
                contentsOf: olderTurns,
                at: 0
            )
            mergeOlderCitations(from: visible)
            transcriptVersion &+= 1
            transcriptPaging.finishLoadMore(
                request,
                nextCursor: page.messagePageInfo.nextCursor,
                madeProgress: !olderTurns.isEmpty
            )
            return !olderTurns.isEmpty
        } catch {
            transcriptPaging.failLoadMore(request, error: error)
            return false
        }
    }

    private func mergeOlderCitations(from messages: [ChatMessage]) {
        var older = AgentTurnBuilder.citations(from: messages)
        var seen = Set(older.map(\.documentId))
        for ref in AgentTurnBuilder.reportArtifactCitations(from: messages)
            where !seen.contains(ref.documentId) {
            seen.insert(ref.documentId)
            older.append(AgentCitation(documentId: ref.documentId, ref: ref, entries: []))
        }
        for citation in citations {
            if let index = older.firstIndex(where: { $0.documentId == citation.documentId }) {
                older[index].entries.append(contentsOf: citation.entries)
                older[index].docNote = citation.docNote ?? older[index].docNote
            } else {
                older.append(citation)
            }
        }
        citations = older
        citationsByDocId = Dictionary(
            uniqueKeysWithValues: citations.enumerated().map { ($1.documentId, $0) }
        )

        let earlierAnnotations = AgentTurnBuilder.trailAnnotations(from: messages)
        for (documentId, current) in trailAnnotations.byDoc {
            var combined = earlierAnnotations.byDoc[documentId] ?? AgentDocAnnotations()
            combined.ref = combined.ref ?? current.ref
            combined.note = current.note ?? combined.note
            combined.quotes.append(contentsOf: current.quotes)
            trailAnnotations.byDoc[documentId] = combined
        }
        for (documentId, earlier) in earlierAnnotations.byDoc
            where trailAnnotations.byDoc[documentId] == nil {
            trailAnnotations.byDoc[documentId] = earlier
        }

        var records = AgentTurnBuilder.recordCitations(from: messages)
        var recordIndexByKey = Dictionary(
            uniqueKeysWithValues: records.enumerated().map { ($1.recordKey, $0) }
        )
        for current in recordCitations {
            if let index = recordIndexByKey[current.recordKey] {
                // The existing page is newer than the page being prepended.
                // Replace the value while preserving the record's first
                // arrival position across the combined transcript.
                records[index] = current
            } else {
                recordIndexByKey[current.recordKey] = records.count
                records.append(current)
            }
        }
        recordCitations = records
    }

    /// The messages a user should see for a conversation. An anchored
    /// thread (brief talk-back or watch firing) opens with the
    /// creating run's folded transcript — agent context, not user
    /// content — so when the origin declares a seed prefix AND carries
    /// the snapshot that replaces it visually (the pinned context card),
    /// that prefix is dropped. Without the snapshot (threads created
    /// before snapshots existed, or an origin kind this build doesn't
    /// know) everything stays visible: hiding context with nothing in
    /// its place would strand the reader.
    nonisolated static func visibleMessages(
        _ messages: [ChatMessage],
        origin: ConversationOrigin?
    )
        -> [ChatMessage] {
        guard let origin,
              hasContextCard(origin),
              let seed = origin.seedMessageCount,
              seed > 0,
              seed <= messages.count
        else { return messages }
        return Array(messages.dropFirst(seed))
    }

    /// Whether this build renders a pinned context card for the origin —
    /// the precondition for hiding the seeded transcript prefix.
    nonisolated static func hasContextCard(_ origin: ConversationOrigin) -> Bool {
        (origin.kind == "brief" && origin.brief != nil)
            || (origin.kind == "watch_firing" && origin.watch != nil)
    }

    /// Whether the surface is already a blank new conversation — nothing said on it, nothing it
    /// is a reply to, nothing loading or failed.
    ///
    /// Starting a new conversation from here would land on the state it is already in, so the
    /// affordance that does it has nothing to offer and is not shown. This is the state
    /// `newConversation()` resets to.
    var isBlankNewConversation: Bool {
        sessionId == nil
            && turns.isEmpty
            && briefOrigin == nil
            && !transcriptLoading
            && fatalError == nil
            && terminalFailure == nil
    }

    // MARK: - User actions

    /// Send a user message, returning whether the current composer should
    /// consider it accepted. `false` means this surface still owns a request
    /// that never reached the gateway, so the caller restores the text it
    /// cleared optimistically. A completion superseded by navigation or a
    /// newer turn returns `true`: restoring its stale text would overwrite the
    /// newer composer even when that older HTTP request failed.
    @discardableResult
    func send(text: String, deepResearch: Bool = false) async -> Bool {
        guard let client else { return false }
        guard terminalFailure == nil else { return false }
        // The gateway accepts one active turn per session. In particular,
        // keep a follow-up POST from racing a stop request that is waiting for
        // its authoritative terminal event. A rejected busy POST must never
        // roll the active turn's local `busy` state back.
        guard !busy else { return false }
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return false }
        let optimisticId = "u-pending-\(UUID().uuidString)"
        let titleWasEmpty = title.isEmpty
        let needsFreshSession = sessionId == nil

        // A fresh conversation has no server identity yet. Claim the turn
        // locally before minting it so the landing immediately becomes the
        // transcript and the existing working indicator covers the round-trip.
        if needsFreshSession {
            sendOperationGeneration &+= 1
            let operation = sendOperationGeneration
            pendingSessionMint = PendingSessionMint(
                optimisticId: optimisticId,
                sendOperation: operation,
                titleWasEmpty: titleWasEmpty,
                text: cleaned,
                deepResearch: deepResearch
            )
            presentOptimisticSend(
                id: optimisticId,
                text: cleaned,
                deepResearch: deepResearch,
                deriveTitle: titleWasEmpty
            )
        }

        switch await mintSessionIfNeeded(
            client: client,
            preserving: needsFreshSession ? pendingSessionMint : nil
        ) {
        case .ready:
            break
        case .failed(let error):
            guard needsFreshSession else {
                lastTurnError = "Send failed: \(error)"
                return false
            }
            // The failed mint still owns this surface. Roll back the local
            // turn so the caller can restore the prompt into the composer.
            guard let pending = pendingSessionMint,
                  sendOperationGeneration == pending.sendOperation else { return true }
            turns.removeAll { turn in
                if case .user(let id, _) = turn, id == pending.optimisticId { return true }
                return false
            }
            if pending.titleWasEmpty { title = "" }
            pendingSessionMint = nil
            retireActiveTurn()
            self.deepResearch = false
            lastTurnError = "Send failed: \(error)"
            return false
        case .superseded:
            // Navigation, teardown, or local Stop owns the newer surface state.
            // Never restore this retired send into that newer composer.
            return true
        }

        // A resumed/remote turn can become active while the lazy mint is in
        // flight. Re-check after suspension before claiming this session.
        guard needsFreshSession || !busy else { return false }
        guard let sessionId else { return false }
        sendOperationGeneration &+= 1
        let sendOperation = sendOperationGeneration
        // Established sessions have not presented this send yet; fresh-session reconciliation
        // preserved the already-visible first bubble as part of applying the mint snapshot.
        if !needsFreshSession {
            presentOptimisticSend(
                id: optimisticId,
                text: cleaned,
                deepResearch: deepResearch,
                deriveTitle: titleWasEmpty
            )
        }
        do {
            let resp = try await client.sendMessage(
                sessionId: sessionId,
                text: cleaned,
                deepResearch: deepResearch
            )
            // The request was accepted, but its UI completion may have been
            // superseded by navigation or a newer turn in this conversation.
            // In that case the newer surface already owns all presentation.
            guard self.sessionId == sessionId,
                  sendOperationGeneration == sendOperation else { return true }
            if let userMessageId = resp.userMessageId {
                let alreadyMaterialized = turns.contains { turn in
                    if case .user(let id, _) = turn, id == userMessageId { return true }
                    return false
                }
                if alreadyMaterialized {
                    // The `agent.user.message` event raced ahead of the
                    // HTTP response and already appended a server-stamped
                    // bubble — drop the optimistic placeholder so we
                    // don't double-render the same message.
                    turns.removeAll { turn in
                        if case .user(let id, _) = turn, id == optimisticId { return true }
                        return false
                    }
                } else if let idx = turns.firstIndex(where: {
                    if case .user(let id, _) = $0, id == optimisticId { return true }
                    return false
                }) {
                    // Replace the placeholder id with the server's so the
                    // event-side dedupe below recognises this bubble as
                    // already-rendered.
                    if case .user(_, let body) = turns[idx] {
                        turns[idx] = .user(id: userMessageId, text: body)
                    }
                }
            }
            return true
        } catch {
            // A stale failure must not restore old text, clear a newer turn's
            // busy state, or attach an error to another conversation.
            guard self.sessionId == sessionId,
                  sendOperationGeneration == sendOperation,
                  busy else { return true }
            // The POST failed, so the gateway never accepted this turn.
            // Roll back the optimistic user bubble + the temp title so
            // the transcript reflects what's actually on the server.
            turns.removeAll { turn in
                if case .user(let id, _) = turn, id == optimisticId { return true }
                return false
            }
            if titleWasEmpty { title = "" }
            retireActiveTurn()
            if Self.isContextWindowConflict(error) {
                lastTurnError = nil
                let handoff = beginSnapshotHandoff(targetSessionId: sessionId)
                if let resumed = try? await client.createSession(
                    profile: "interactive",
                    resumeFromId: sessionId,
                    transcriptLimit: 25
                ), self.sessionId == sessionId, snapshotHandoffIsCurrent(handoff) {
                    await applyCreatedSession(resumed)
                    await finishSnapshotHandoff(handoff, after: resumed.eventCursor)
                } else {
                    await failSnapshotHandoff(handoff, targetSessionId: sessionId)
                }
                return false
            }
            lastTurnError = "Send failed: \(error)"
            return false
        }
    }

    /// Install the local state shared by a normal optimistic send and the
    /// first send's presentation on either side of its session snapshot.
    private func presentOptimisticSend(
        id: String,
        text: String,
        deepResearch: Bool,
        deriveTitle: Bool
    ) {
        turns.append(.user(id: id, text: text))
        busy = true
        turnGeneration &+= 1
        cancelOperationGeneration &+= 1
        cancelError = nil
        self.deepResearch = deepResearch
        lastTurnError = nil
        if deriveTitle {
            title = AgentTurnBuilder.deriveTitle(from: text)
        }
    }

    private nonisolated static func isContextWindowConflict(_ error: Error) -> Bool {
        guard case GatewayClient.Error.serverError(let status, let body) = error else {
            return false
        }
        return status == 409 && body.contains("\"CONTEXT_WINDOW_EXCEEDED\"")
    }

    @discardableResult
    func cancelTurn() async -> String? {
        guard let client else { return nil }
        cancelError = nil
        guard busy else { return nil }
        if sessionId == nil, let pending = pendingSessionMint {
            // The gateway has no session (and therefore no turn) to cancel
            // yet. Supersede the mint locally and return its text immediately;
            // the retired send must not restore it again when the request lands.
            sessionChoiceCount += 1
            sendOperationGeneration &+= 1
            turns.removeAll { turn in
                if case .user(let id, _) = turn, id == pending.optimisticId { return true }
                return false
            }
            if pending.titleWasEmpty { title = "" }
            pendingSessionMint = nil
            deepResearch = false
            lastTurnError = nil
            retireActiveTurn()
            return pending.text
        }
        guard let sessionId else { return nil }
        cancelOperationGeneration &+= 1
        let cancelOperation = cancelOperationGeneration
        let canceledTurn = turnGeneration
        do {
            try await client.cancel(sessionId: sessionId)
        } catch {
            guard self.sessionId == sessionId,
                  busy,
                  turnGeneration == canceledTurn,
                  cancelOperationGeneration == cancelOperation else { return nil }
            // A failed request says nothing about whether the server-side
            // turn is still running. Only a streamed terminal event owns the
            // transition out of `busy`.
            cancelError = error
            AppLog.make(category: "agent").warning(
                "agent cancel failed: \(String(describing: error))"
            )
        }
        return nil
    }

    func dismissCancelError() {
        cancelError = nil
    }

    /// End the locally-active turn without changing the send-operation
    /// generation: a late successful POST response may still need to stamp or
    /// deduplicate its optimistic user bubble, while a late failure is gated
    /// by `busy` and cannot disturb the settled transcript.
    private func retireActiveTurn() {
        busy = false
        turnGeneration &+= 1
        cancelOperationGeneration &+= 1
        cancelError = nil
    }

    func refreshConversations() async {
        guard let client else { return }
        conversationListGeneration &+= 1
        let generation = conversationListGeneration
        conversationsLoading = true
        conversationsLoadingMore = false
        conversationsPagingTruncated = false
        conversationsPagingError = nil
        do {
            let page = try await client.listConversationPage()
            guard generation == conversationListGeneration, self.client === client else { return }
            conversations = Self.sortedPinnedFirst(page.conversations)
            if let sessionId,
               let active = page.conversations.first(where: { $0.sessionId == sessionId }) {
                activeConversationPinned = active.pinned
            }
            conversationsNextCursor = page.nextCursor
            conversationsPagingTruncated = false
            conversationsError = nil
            conversationsPagingError = nil
            conversationsLoading = false
        } catch {
            guard generation == conversationListGeneration, self.client === client else { return }
            conversationsError = error
            conversationsLoading = false
        }
    }

    func loadMoreConversations() async {
        guard let client, let cursor = conversationsNextCursor,
              !conversationsLoading, !conversationsLoadingMore else {
            return
        }
        let generation = conversationListGeneration
        conversationsLoadingMore = true
        conversationsPagingError = nil
        do {
            let page = try await client.listConversationPage(cursor: cursor)
            guard generation == conversationListGeneration,
                  self.client === client,
                  conversationsLoadingMore,
                  conversationsNextCursor == cursor else { return }
            let seen = Set(conversations.map(\.sessionId))
            let fresh = page.conversations.filter { !seen.contains($0.sessionId) }
            let merged = conversations + fresh
            conversations = Self.sortedPinnedFirst(merged)
            if let sessionId,
               let active = merged.first(where: { $0.sessionId == sessionId }) {
                activeConversationPinned = active.pinned
            }
            let continuation = pagingCursorContinuation(
                after: cursor,
                next: page.nextCursor,
                madeProgress: !fresh.isEmpty
            )
            conversationsNextCursor = continuation.nextCursor
            conversationsPagingTruncated = continuation.isTruncated
            conversationsError = nil
            conversationsPagingError = nil
            conversationsLoadingMore = false
        } catch {
            guard generation == conversationListGeneration,
                  self.client === client,
                  conversationsLoadingMore,
                  conversationsNextCursor == cursor else { return }
            conversationsPagingError = error
            conversationsLoadingMore = false
        }
    }

    func deleteConversation(id: String) async {
        guard let client else { return }
        guard conversationActionsInFlight.insert(id).inserted else { return }
        let exitedActiveConversation = sessionId == id
        if exitedActiveConversation {
            // Navigation is local and immediate. A rejected DELETE leaves the
            // sidebar row intact so the user can reopen it or retry.
            newConversation()
        }
        let generation = conversationActionGeneration
        conversationActionError = nil
        conversationActionErrorSessionId = nil
        do {
            try await client.deleteConversation(id: id)
            guard self.client === client else { return }
            conversationListGeneration &+= 1
            conversationActionsInFlight.remove(id)
            conversations.removeAll { $0.sessionId == id }
            conversationsLoading = false
            conversationsLoadingMore = false
        } catch {
            guard self.client === client else { return }
            conversationActionsInFlight.remove(id)
            if generation == conversationActionGeneration {
                conversationActionError = error
                conversationActionErrorSessionId = exitedActiveConversation ? nil : id
                conversationActionErrorContext = "delete this chat"
            }
        }
    }

    func togglePin(id: String, pinned: Bool) async {
        guard let client else { return }
        guard conversationActionsInFlight.insert(id).inserted else { return }
        let generation = conversationActionGeneration
        conversationActionError = nil
        conversationActionErrorSessionId = nil
        do {
            try await client.setPinned(id: id, pinned: pinned)
            guard self.client === client else { return }
            conversationListGeneration &+= 1
            conversationActionsInFlight.remove(id)
            // Optimistically reflect the new state and re-sort pinned-first;
            // the next natural refresh re-fetches the canonical server order.
            conversations = Self.sortedPinnedFirst(
                conversations.map { $0.sessionId == id ? $0.withPinned(pinned) : $0 }
            )
            if sessionId == id { activeConversationPinned = pinned }
            conversationsLoading = false
            conversationsLoadingMore = false
        } catch {
            guard self.client === client else { return }
            conversationActionsInFlight.remove(id)
            if generation == conversationActionGeneration {
                conversationActionError = error
                conversationActionErrorSessionId = id
                conversationActionErrorContext = pinned ? "pin this chat" : "unpin this chat"
            }
        }
    }

    func clearConversationActionError() {
        conversationActionError = nil
        conversationActionErrorSessionId = nil
    }

    /// Pinned conversations float to the top; within each pin group the
    /// server's newest-first order is preserved. A stable partition (sort
    /// by a precomputed index) — `Array.sorted(by:)` is not stable.
    static func sortedPinnedFirst(_ items: [ConversationSummary]) -> [ConversationSummary] {
        items.enumerated()
            .sorted { lhs, rhs in
                if lhs.element.pinned != rhs.element.pinned { return lhs.element.pinned }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    // MARK: - SSE supervision

    private struct SnapshotHandoff {
        let generation: Int
        let targetSessionId: String
        var events: [AgentStreamItem]
        var requiresSnapshot: Bool
    }

    /// Keeps a stalled snapshot request from retaining an unbounded SSE tail.
    /// Crossing the limit supersedes that request with a new snapshot whose
    /// cursor covers the discarded prefix.
    private static let snapshotHandoffCapacity = 256

    private func beginSnapshotHandoff(
        targetSessionId: String,
        carryBufferedEvents: Bool = true,
        requiresSnapshot: Bool = false
    )
        -> Int {
        snapshotHandoffGeneration &+= 1
        let prior = snapshotHandoff
        let carriesPrior = carryBufferedEvents && prior?.targetSessionId == targetSessionId
        snapshotHandoff = SnapshotHandoff(
            generation: snapshotHandoffGeneration,
            targetSessionId: targetSessionId,
            events: carriesPrior ? (prior?.events ?? []) : [],
            requiresSnapshot: requiresSnapshot || (carriesPrior && prior?.requiresSnapshot == true)
        )
        return snapshotHandoffGeneration
    }

    private func discardSnapshotHandoff(_ generation: Int?) {
        guard let generation, snapshotHandoff?.generation == generation else { return }
        snapshotHandoff = nil
    }

    private func snapshotHandoffIsCurrent(_ generation: Int?) -> Bool {
        guard let generation else { return true }
        return snapshotHandoff?.generation == generation
    }

    private func failSnapshotHandoff(_ generation: Int?, targetSessionId: String?) async {
        guard let generation, snapshotHandoff?.generation == generation else { return }
        if snapshotHandoff?.requiresSnapshot == true, let targetSessionId {
            scheduleOverflowResnapshot(targetSessionId: targetSessionId, generation: generation)
        } else {
            await finishSnapshotHandoff(generation, after: nil)
        }
    }

    private func acceptStreamItem(_ item: AgentStreamItem) async {
        guard var handoff = snapshotHandoff else {
            await handle(event: item.event)
            return
        }
        guard item.event.sessionId == handoff.targetSessionId else {
            await handle(event: item.event)
            return
        }
        if let id = item.id, let index = handoff.events.firstIndex(where: { $0.id == id }) {
            handoff.events[index] = item
            snapshotHandoff = handoff
            return
        }
        guard handoff.events.count < Self.snapshotHandoffCapacity else {
            let generation = beginSnapshotHandoff(
                targetSessionId: handoff.targetSessionId,
                carryBufferedEvents: false,
                requiresSnapshot: true
            )
            snapshotHandoff?.events.append(item)
            scheduleOverflowResnapshot(targetSessionId: handoff.targetSessionId, generation: generation)
            return
        }
        handoff.events.append(item)
        snapshotHandoff = handoff
    }

    private func scheduleOverflowResnapshot(targetSessionId: String, generation: Int) {
        overflowSnapshotTask?.cancel()
        overflowSnapshotTask = Task { [weak self] in
            guard let self, let client = self.client else { return }
            while !Task.isCancelled, self.snapshotHandoffIsCurrent(generation) {
                do {
                    let session = try await client.createSession(
                        profile: "interactive",
                        resumeFromId: targetSessionId,
                        transcriptLimit: 25
                    )
                    guard !Task.isCancelled,
                          self.snapshotHandoffIsCurrent(generation) else { return }
                    await self.applyCreatedSession(session)
                    await self.finishSnapshotHandoff(generation, after: session.eventCursor)
                    return
                } catch {
                    guard !Task.isCancelled,
                          self.snapshotHandoffIsCurrent(generation) else { return }
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
        }
    }

    private func finishSnapshotHandoff(_ generation: Int?, after cursor: Int?) async {
        guard let generation, snapshotHandoff?.generation == generation else { return }
        let buffered = snapshotHandoff?.events ?? []
        snapshotHandoff = nil
        overflowSnapshotTask = nil
        if let cursor, (Int(lastEventId ?? "") ?? Int.min) < cursor {
            lastEventId = String(cursor)
        }
        for item in buffered where streamEventIsNewer(item.id, than: cursor) {
            await handle(event: item.event)
        }
    }

    private func startEventStream() {
        eventTask?.cancel()
        guard let client else { return }
        eventTask = Task { [weak self] in
            while !Task.isCancelled {
                // Per-connection flag: any successful event delivery on
                // a freshly-opened stream clears the backoff counter so
                // the next failure starts over at 1s. Without this the
                // counter would accumulate forever across reconnects.
                var sawEventOnThisConnection = false
                // Resume from the last id seen, so the gateway replays only
                // the events missed since the previous connection dropped.
                let resumeFrom = self?.lastEventId
                do {
                    for try await item in client.events(lastEventId: resumeFrom) {
                        if Task.isCancelled { return }
                        if !sawEventOnThisConnection {
                            sawEventOnThisConnection = true
                            self?.resetBackoff()
                        }
                        if let id = item.id { self?.lastEventId = id }
                        // Resync is a connection-control signal, not a
                        // transcript event: the gateway couldn't replay what
                        // we missed, so reload the persisted transcript
                        // instead of routing it through the reducer.
                        if case .resync = item.event {
                            await self?.reconcileActiveConversation()
                            continue
                        }
                        await self?.acceptStreamItem(item)
                    }
                    // Stream closed cleanly. Use the same exponential
                    // backoff as the error path — a gateway that 200+
                    // EOFs immediately on every connect would otherwise
                    // tight-loop us.
                    let delay = self?.nextBackoffDelay() ?? 1
                    await self?.wait(seconds: delay)
                } catch {
                    let delay = self?.nextBackoffDelay() ?? 1
                    AppLog.make(category: "agent").warning(
                        "agent SSE error: \(String(describing: error)) — reconnecting in \(delay)s"
                    )
                    await self?.wait(seconds: delay)
                }
            }
        }
    }

    private func resetBackoff() {
        reconnectAttempt = 0
    }

    private func nextBackoffDelay() -> TimeInterval {
        reconnectAttempt = min(reconnectAttempt + 1, 6)
        return min(pow(2.0, Double(reconnectAttempt - 1)), 30)
    }

    private func wait(seconds: TimeInterval) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    /// Reconcile the UI with the gateway's session snapshot. Persisted messages
    /// plus replayEvents restore active-turn state, and eventCursor defines the
    /// exact handoff to buffered SSE whether the session is idle or busy.
    /// Best-effort: a failure leaves the current transcript in place for the
    /// next event or foreground retry.
    private func reconcileActiveConversation() async {
        guard let client, let sessionId else { return }
        let choice = sessionChoiceCount
        let handoff = beginSnapshotHandoff(targetSessionId: sessionId)
        do {
            let session = try await client.createSession(
                profile: "interactive",
                resumeFromId: sessionId,
                transcriptLimit: 25
            )
            // An explicit open landed while the reload was in flight —
            // its conversation owns the surface now; applying this stale
            // reload would yank the user back to the previous one.
            guard sessionChoiceCount == choice, snapshotHandoffIsCurrent(handoff) else {
                discardSnapshotHandoff(handoff)
                return
            }
            await applyCreatedSession(session)
            await finishSnapshotHandoff(handoff, after: session.eventCursor)
        } catch {
            await failSnapshotHandoff(handoff, targetSessionId: sessionId)
            AppLog.make(category: "agent").warning(
                "agent reconcile failed: \(String(describing: error))"
            )
        }
    }

    /// Bring the agent surface back in sync the instant the app returns to
    /// the foreground. iOS suspends the SSE byte-loop while backgrounded, so
    /// the connection is usually a zombie on resume — and after a gateway
    /// restart the reconnect's stale `Last-Event-ID` is ahead of the reset
    /// sequence, so the live stream can't catch us up incrementally. That left
    /// a turn that finished while we were away stuck on a phantom "running…".
    ///
    /// So reconcile the authoritative messages + active-turn replay first,
    /// advance the SSE cursor to that snapshot, then resume the stream. With
    /// no active session there's nothing to reconcile — just (re)open it.
    ///
    /// Independently of the active transcript, the conversation list can also
    /// go stale while backgrounded: the SSE feed is scoped to the active
    /// session, so a conversation created or advanced on another device never
    /// reaches us. Re-fetch the list on resume — in parallel, so it never
    /// delays the stream restart the reconcile path is timed around.
    func onForeground() {
        guard client != nil else { return }
        Task { await refreshConversations() }
        guard sessionId != nil else {
            startEventStream()
            return
        }
        Task {
            await reconcileActiveConversation()
            startEventStream()
        }
    }

    // MARK: - Plan housekeeping

    @ObservationIgnored
    private var planClearTask: Task<Void, Never>?

    /// Schedule a deferred clear of `planItems`. Per-item slide-outs
    /// run inside the panel view; this cleanup is a backstop for any
    /// items that didn't reach `done` before the turn ended (errors,
    /// cancellation, the agent forgetting to mark a step). 1.4s gives
    /// the panel's done-then-remove animation enough time to land
    /// before we yank the rest.
    private func schedulePlanClear() {
        planClearTask?.cancel()
        planClearTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            guard !Task.isCancelled else { return }
            self?.planItems = []
        }
    }

    private func handle(event: AgentEvent) async {
        // Forward-compat: ignore unrecognised event types so a future
        // gateway extension can't deadlock the reducer.
        if case .unknown = event { return }
        // `.resync` is intercepted in the SSE supervisor before it reaches
        // the reducer (it's connection-control, not a transcript event), so
        // it never arrives here — the `.resync` arm below only keeps the
        // switch exhaustive.
        // Drop events for other sessions (the SSE is admin-scoped and
        // sees every caller's session). The reducer-style match here
        // mirrors the portal one-for-one.
        // See #1445 — planned: a list-level conversation event handled above
        // this guard so the drawer updates live for conversations advanced on
        // another device.
        guard let live = sessionId, event.sessionId == live else { return }
        // Causality gate. While the latest ephemeral tool card is still
        // playing out its dismiss animation, every event that would
        // extend the assistant turn is parked on that card's tail queue.
        // The card calls `flushEphemeralTail(toolCallId:)` after the
        // fade-out completes; that drains the queue back through this
        // same handler in order. Net effect: card → result → fade →
        // next text / next tool reads as one chronological narration.
        if eventAppendsToTurn(event), let gateIdx = activeEphemeralGateIndex() {
            parkOnEphemeralGate(at: gateIdx, event: event)
            return
        }
        switch event {
        case .userMessage(_, let userMessageId, let text):
            // Cross-device user-message sync. The originator already has
            // an optimistic bubble; the HTTP send-response stamps it with
            // this `userMessageId`. If we find a turn that matches, skip
            // — that's our own send. Otherwise this came from another
            // device on the same session: append a fresh bubble.
            let alreadyHave = turns.contains { turn in
                if case .user(let id, _) = turn, id == userMessageId { return true }
                return false
            }
            if !alreadyHave {
                turns.append(.user(id: userMessageId, text: text))
                transcriptVersion &+= 1
            }

        case .messageStart(_, let messageId):
            if !busy {
                busy = true
                // A turn started by another device supersedes any older local
                // HTTP completion still unwinding for this conversation.
                sendOperationGeneration &+= 1
                turnGeneration &+= 1
                cancelOperationGeneration &+= 1
                cancelError = nil
            }
            turns.append(.assistant(.init(id: messageId, parts: [], stopReason: nil, failure: nil)))
            transcriptVersion &+= 1

        case .textDelta(_, _, let delta):
            mutateLastAssistant { turn in
                if case .text(var text) = turn.parts.last {
                    text += delta
                    turn.parts[turn.parts.count - 1] = .text(text)
                } else {
                    turn.parts.append(.text(delta))
                }
            }

        case .thinkingDelta(_, _, let delta):
            mutateLastAssistant { turn in
                if case .thinking(var text) = turn.parts.last {
                    text += delta
                    turn.parts[turn.parts.count - 1] = .thinking(text)
                } else {
                    turn.parts.append(.thinking(delta))
                }
            }

        case .usageUpdate:
            // Live usage is consumed inside sub-agent cards when wrapped; a
            // top-level turn has no separate token-progress surface.
            break

        case .toolInputStart(_, _, let toolCallId, let tool):
            // `plan` is panel-only and `join_subagents` is orchestration-only;
            // neither belongs in the transcript. Plan results still route into
            // the pinned TODO panel below.
            if agentHiddenTranscriptTools.contains(tool) { break }
            // Render an immediate "Running…" stub the second the model
            // opens a tool-use content block — the full args land
            // seconds later (`toolStart`). Without this the card
            // pops in fully-formed and the user sees nothing for the
            // gap.
            mutateLastAssistant { turn in
                turn.parts.append(.tool(.init(
                    toolCallId: toolCallId,
                    tool: tool,
                    args: JSONAny(value: NSNull()),
                    argsSummary: "",
                    argsKnown: false,
                    result: nil,
                    durationMs: nil
                )))
            }

        case .toolStart(_, _, let toolCallId, let tool, let args, let argsSummary):
            if agentHiddenTranscriptTools.contains(tool) { break }
            mutateLastAssistant { turn in
                // If the stub from `toolInputStart` is already there,
                // upgrade it in place; otherwise append a fresh part
                // (replay backends + non-Anthropic backends may skip
                // input_start).
                let resolvedSummary = argsSummary
                    ?? AgentTurnBuilder.summarizeArgs(tool: tool, args: args)
                if let idx = turn.parts.lastIndex(where: {
                    if case .tool(let c) = $0 { return c.toolCallId == toolCallId }
                    return false
                }),
                    case .tool(var existing) = turn.parts[idx] {
                    existing.args = args
                    existing.argsSummary = resolvedSummary
                    existing.argsKnown = true
                    turn.parts[idx] = .tool(existing)
                } else {
                    turn.parts.append(.tool(.init(
                        toolCallId: toolCallId,
                        tool: tool,
                        args: args,
                        argsSummary: resolvedSummary,
                        argsKnown: true,
                        result: nil,
                        durationMs: nil
                    )))
                }
            }

        case .toolResult(_, _, let toolCallId, let result, let durationMs):
            // `plan` is panel-only: feed the snapshot directly into
            // `planItems` and skip the transcript-mutation path. No
            // matching tool part was ever appended (see toolInputStart /
            // toolStart), so there's nothing to update on the assistant
            // turn.
            if case .planUpdated(let items) = result {
                planItems = items
                break
            }
            mutateLastAssistant { turn in
                if let idx = turn.parts.lastIndex(where: {
                    if case .tool(let call) = $0 { return call.toolCallId == toolCallId }
                    return false
                }) {
                    if case .tool(var call) = turn.parts[idx] {
                        call.result = result
                        call.durationMs = durationMs
                        turn.parts[idx] = .tool(call)
                    }
                }
            }
            // Timeline bookkeeping for the Citations drawer. Fed ONLY by
            // explicit citations: `annotate.recorded` — and the `annotate.batch`
            // fan-out from annotate_many — feed `byDoc` (the synthesised
            // `agent.citation` event(s), next case, update the citations rollup
            // with the same payload), and `cite_record.recorded` feeds
            // `recordCitations`. A `trace_connections` (`event_trail.built`)
            // walk's raw output is deliberately NOT folded in here.
            switch result {
            case .annotateRecorded, .annotateBatch:
                // A singular `annotate.recorded` contributes one Timeline bucket;
                // an `annotate.batch` (annotate_many) fans out to one per recorded
                // child (a failed `.error` child yields none) — so the live
                // Timeline matches the reload rebuild
                // (`AgentTurnBuilder.trailAnnotations(from:)`). Without the batch
                // arm a live annotate_many turn left the Timeline empty until reload.
                applyAnnotationTimeline(result)
            case .citeRecordRecorded(let record):
                // #757: upsert the directly-cited row, deduped by
                // recordKey (last wins). The unified Timeline synthesises
                // a record-only row for it.
                upsertRecordCitation(record)
                // A directly-cited record is a citation too — bump the
                // citing turn's chip count so the bubble footer matches
                // the annotate path.
                mutateLastAssistant { $0.citationCount += 1 }
            default:
                break
            }

        case .toolChildStart(_, _, let toolCallId, let childIndex, let tool, let argsSummary):
            // Live per-child progress for a batch tool (search_many /
            // fetch_many). Attach the child onto its parent tool part's
            // `children`, keyed by index; AgentPartView projects one live
            // ephemeral card per child. Order is by index, not arrival, so
            // out-of-order completion still renders correctly. Bypasses the
            // causality gate (not in `eventAppendsToTurn`) — a live progress
            // signal, never a transcript-extending event.
            mutateLastAssistant { turn in
                guard let idx = turn.parts.lastIndex(where: {
                    if case .tool(let c) = $0 { return c.toolCallId == toolCallId }
                    return false
                }), case .tool(var call) = turn.parts[idx] else { return }
                if let existing = call.children.firstIndex(where: { $0.index == childIndex }) {
                    call.children[existing].tool = tool
                    if let argsSummary { call.children[existing].argsSummary = argsSummary }
                } else {
                    call.children.append(AgentToolChild(
                        index: childIndex,
                        tool: tool,
                        argsSummary: argsSummary ?? "",
                        result: nil
                    ))
                    call.children.sort { $0.index < $1.index }
                }
                turn.parts[idx] = .tool(call)
            }

        case .toolChildResult(_, _, let toolCallId, let childIndex, let result):
            mutateLastAssistant { turn in
                guard let idx = turn.parts.lastIndex(where: {
                    if case .tool(let c) = $0 { return c.toolCallId == toolCallId }
                    return false
                }), case .tool(var call) = turn.parts[idx] else { return }
                if let existing = call.children.firstIndex(where: { $0.index == childIndex }) {
                    call.children[existing].result = result
                } else {
                    call.children.append(AgentToolChild(
                        index: childIndex,
                        tool: nil,
                        argsSummary: "",
                        result: result
                    ))
                    call.children.sort { $0.index < $1.index }
                }
                turn.parts[idx] = .tool(call)
            }

        case .citation(_, let messageId, let toolCallId, let ref, let quote, let note, let quoteAuthor, let quoteIsSelf):
            // Routing: note-only (no quote) → set the card's docNote
            // (last write wins); does NOT create a quote entry. Quote
            // (with or without note) → append to entries[].
            let isDocNote = quote == nil && note != nil
            if let existingIdx = citationsByDocId[ref.documentId] {
                if isDocNote {
                    citations[existingIdx].docNote = note
                } else {
                    citations[existingIdx].entries.append(
                        AgentCitationEntry(
                            toolCallId: toolCallId,
                            messageId: messageId,
                            quote: quote,
                            note: note,
                            quoteAuthor: quoteAuthor,
                            quoteIsSelf: quoteIsSelf
                        )
                    )
                }
            } else {
                citationsByDocId[ref.documentId] = citations.count
                var seed = AgentCitation(
                    documentId: ref.documentId,
                    ref: ref,
                    docNote: nil,
                    entries: []
                )
                if isDocNote {
                    seed.docNote = note
                } else {
                    seed.entries.append(
                        AgentCitationEntry(
                            toolCallId: toolCallId,
                            messageId: messageId,
                            quote: quote,
                            note: note,
                            quoteAuthor: quoteAuthor,
                            quoteIsSelf: quoteIsSelf
                        )
                    )
                }
                citations.append(seed)
            }
            // Bump the matching assistant turn's citationCount so the
            // bubble footer chip updates.
            if let idx = turns.lastIndex(where: {
                if case .assistant(let a) = $0 { return a.id == messageId }
                return false
            }), case .assistant(var assistant) = turns[idx] {
                assistant.citationCount += 1
                turns[idx] = .assistant(assistant)
            }

        case .citationsUpdate(_, let added, let removed):
            for ref in added where citationsByDocId[ref.documentId] == nil {
                citationsByDocId[ref.documentId] = citations.count
                citations.append(
                    AgentCitation(documentId: ref.documentId, ref: ref, entries: [])
                )
            }
            for id in removed {
                guard let idx = citationsByDocId[id] else { continue }
                citations.remove(at: idx)
                citationsByDocId.removeValue(forKey: id)
                // Re-index entries after the removed slot.
                for (docId, otherIdx) in citationsByDocId where otherIdx > idx {
                    citationsByDocId[docId] = otherIdx - 1
                }
            }

        case .subagentSpawned(_, let subagentId, let specialist, let task, let title, let parentToolCallId):
            // The worker row supersedes the launch call's temporary tool card.
            // Bind by tool-call id so parallel launches remove only their own
            // orchestration chrome.
            if let parentToolCallId {
                removeToolPart(toolCallId: parentToolCallId)
            }
            // Add a live researcher row to the parent's current assistant turn
            // at the spawn position. A re-delivered spawn is a no-op.
            let alreadyHave = turns.contains { turn in
                guard case .assistant(let a) = turn else { return false }
                return a.parts.contains {
                    if case .subagent(let card) = $0 { return card.subagentId == subagentId }
                    return false
                }
            }
            if !alreadyHave {
                mutateLastAssistant { turn in
                    turn.parts.append(.subagent(AgentSubagentCard(
                        subagentId: subagentId,
                        specialist: specialist,
                        title: title,
                        task: task,
                        parentToolCallId: parentToolCallId
                    )))
                }
            }
            // Generic workers stay in the ordinary transcript. Named private
            // readers still arm the Deep Research workspace for replay/demo
            // streams that did not arrive through an explicitly armed send.
            if specialist != "generic" {
                deepResearch = true
            }

        case .subagentEvent(_, let subagentId, _, let childEvent):
            // Fold the wrapped child event into the row's live counters and
            // reached-source set. Unknown events leave it unchanged.
            mutateSubagentCard(subagentId: subagentId) { card in
                reduceChildEvent(&card, childEvent)
            }

        case .subagentResult(_, let subagentId, _, let status, let summary, let citations, let usage, _, let failure):
            // Finalise: terminal status + distilled summary, and adopt the
            // authoritative per-child token total over the running tally when
            // it actually carries numbers. Citations merge into the parent's
            // single set via the separate `agent.citations.update` event (no
            // per-sub-agent attribution surfaced — frozen constraint).
            var parentToolCallId: String?
            mutateSubagentCard(subagentId: subagentId) { card in
                parentToolCallId = card.parentToolCallId
                card.status = status
                card.summary = summary
                card.retainedCitationCount = citations.count
                card.failureCode = failure?.code
                card.failureProvider = failure?.provider
                mergeCardDocs(&card, citations.compactMap { ref in
                    let sourceId = ref.sourceId
                    guard !sourceId.isEmpty else { return nil }
                    return AgentResearchDoc(documentId: ref.documentId, title: ref.title, sourceId: sourceId)
                })
                if let usage, usage.hasAnyToken {
                    card.tokens = usage.total
                    card.completedUsageByMessage = [:]
                    card.liveUsageByMessage = [:]
                }
            }
            // Fallback for reordered/replayed streams where the launch card
            // survived until the terminal child event.
            if let parentToolCallId {
                removeToolPart(toolCallId: parentToolCallId)
            }

        case .deepResearchSummary(_, let messageId, let stoppedReason, let plan, let treeUsage, let verification):
            // Fold the additive summary onto the assistant turn it names
            // (#748). The report prose already streamed as `text` parts, so a
            // run that never carries this event still renders as a plain
            // bubble — the artifact is the enrichment, not a precondition.
            attachReportArtifact(
                messageId: messageId,
                artifact: AgentReportArtifact(
                    stoppedReason: stoppedReason,
                    plan: plan,
                    treeUsage: treeUsage,
                    verification: verification
                )
            )

        case .messageEnd(_, _, let stopReason, _):
            retireActiveTurn()
            // The run is over — collapse the research working-set surface into
            // the written-back report (the now-finished assistant turn).
            deepResearch = false
            // Safety net: if an ephemeral card's SwiftUI lifecycle
            // didn't complete (timing edge case, view recycling, error
            // result preventing the card from rendering), text tokens
            // sit permanently on pendingTail. Force-drain the entire
            // gate chain before removing orchestration tools: a queued
            // subagent.spawned event may own the stable worker row.
            await forceFlushActiveGates()
            mutateLastAssistant { turn in
                turn.parts.removeAll {
                    if case .tool(let call) = $0 {
                        return agentOrchestrationTools.contains(call.tool)
                    }
                    return false
                }
                turn.stopReason = stopReason
            }
            // Refresh the conversations list so the rail reflects the
            // new updatedAt + messageCount.
            Task { await self.refreshConversations() }
            // Drop any lingering plan items after a short grace period
            // so the panel collapses naturally. Items that hit `done`
            // mid-turn are already self-removing via the panel view's
            // per-item timer; this cleans up anything left dangling.
            schedulePlanClear()

        case .outputTruncated(_, _, let stopReason, let failure):
            retireActiveTurn()
            deepResearch = false
            mutateLastAssistant { turn in
                turn.stopReason = stopReason
                turn.failure = AgentTurnFailure(
                    code: failure.code,
                    message: failure.message,
                    provider: failure.provider
                )
            }
            await forceFlushActiveGates()
            Task { await self.refreshConversations() }
            schedulePlanClear()

        case .contextWindowExceeded(_, _, let stopReason, let failure, let context):
            retireActiveTurn()
            deepResearch = false
            terminalFailure = AgentConversationTerminalFailure(
                code: failure.code,
                message: failure.message,
                retryable: failure.retryable,
                backend: failure.backend,
                model: failure.model,
                failedAt: ISO8601DateFormatter().string(from: Date()),
                context: context,
                provider: failure.provider
            )
            mutateLastAssistant { turn in
                turn.stopReason = stopReason
            }
            await forceFlushActiveGates()
            Task { await self.refreshConversations() }
            schedulePlanClear()

        case .error(_, _, let code, let message, let provider):
            if code == "context_window_exceeded" || code == "output_truncated" {
                // Live signals only. The following authoritative message-end
                // failure owns the durable freeze or partial-answer marker.
                return
            }
            retireActiveTurn()
            deepResearch = false
            mutateLastAssistant { turn in
                turn.failure = AgentTurnFailure(code: code, message: message, provider: provider)
            }
            await forceFlushActiveGates()

        case .resync, .unknown:
            // Both are handled above the session guard — kept here only so
            // the switch stays exhaustive.
            break
        }
    }

    /// Fold an annotate tool result — a singular `annotate.recorded` or a batch
    /// `annotate.batch` (annotate_many) — into the Citations drawer's Timeline
    /// buckets. The batch fans out to one bucket per recorded child (a failed
    /// `.error` child yields none). Shares the reload rebuild's
    /// `AgentTurnBuilder.annotateRecordedItems` fan-out so a live turn's Timeline
    /// is identical to the reloaded one.
    func applyAnnotationTimeline(_ result: AgentToolResult) {
        for rec in AgentTurnBuilder.annotateRecordedItems(result) {
            trailAnnotations.applyDocAnnotation(
                documentId: rec.documentId,
                ref: rec.ref,
                quote: rec.quote,
                note: rec.note,
                quoteAuthor: rec.quoteAuthor,
                quoteIsSelf: rec.quoteIsSelf
            )
        }
    }

    /// Insert or replace a directly-cited record (#757), deduped by
    /// `recordKey` so a re-cite of the same row updates in place (last
    /// write wins) while preserving the original arrival position.
    private func upsertRecordCitation(_ record: AgentTrailRecord) {
        if let idx = recordCitations.firstIndex(where: { $0.recordKey == record.recordKey }) {
            recordCitations[idx] = record
        } else {
            recordCitations.append(record)
        }
    }

    private func mutateLastAssistant(_ mutation: (inout AgentAssistantTurn) -> Void) {
        guard let idx = turns.lastIndex(where: { if case .assistant = $0 { return true }
            return false
        })
        else { return }
        if case .assistant(var assistant) = turns[idx] {
            mutation(&assistant)
            turns[idx] = .assistant(assistant)
            transcriptVersion &+= 1
        }
    }

    // MARK: - Sub-agent cards (#748)

    /// Locate the `subagent` card with `subagentId` across every assistant
    /// turn (a card can outlive the turn that spawned it) and replace it
    /// in place. No-op when the card isn't found (a `subagent.event` /
    /// `.result` arriving before its `spawned`, or for another session's
    /// card — graceful degrade).
    private func mutateSubagentCard(
        subagentId: String,
        _ mutation: (inout AgentSubagentCard) -> Void
    ) {
        for turnIdx in turns.indices.reversed() {
            guard case .assistant(var assistant) = turns[turnIdx] else { continue }
            guard let partIdx = assistant.parts.firstIndex(where: {
                if case .subagent(let card) = $0 { return card.subagentId == subagentId }
                return false
            }) else { continue }
            guard case .subagent(var card) = assistant.parts[partIdx] else { continue }
            mutation(&card)
            assistant.parts[partIdx] = .subagent(card)
            turns[turnIdx] = .assistant(assistant)
            transcriptVersion &+= 1
            return
        }
    }

    /// Remove one orchestration tool part after its stable worker card exists.
    private func removeToolPart(toolCallId: String) {
        for turnIdx in turns.indices.reversed() {
            guard case .assistant(var assistant) = turns[turnIdx] else { continue }
            let originalCount = assistant.parts.count
            assistant.parts.removeAll {
                if case .tool(let call) = $0 { return call.toolCallId == toolCallId }
                return false
            }
            guard assistant.parts.count != originalCount else { continue }
            turns[turnIdx] = .assistant(assistant)
            transcriptVersion &+= 1
            return
        }
    }

    /// Fold an `agent.deep_research.summary` onto the assistant turn it names
    /// (#748) — the iOS twin of the portal `attachReportArtifact`. Located by
    /// the event's `messageId`; cross-session is already guarded by the
    /// `event.sessionId == live` check at the top of `handle`. If the matching
    /// turn isn't found (a race / a resumed transcript that lost the turn) the
    /// state is left unchanged rather than mis-attaching the artifact —
    /// graceful degrade to the plain bubble.
    private func attachReportArtifact(messageId: String, artifact: AgentReportArtifact) {
        guard let idx = turns.firstIndex(where: {
            if case .assistant(let a) = $0 { return a.id == messageId }
            return false
        }) else { return }
        guard case .assistant(var assistant) = turns[idx] else { return }
        assistant.reportArtifact = artifact
        turns[idx] = .assistant(assistant)
        transcriptVersion &+= 1
    }

    /// Fold a wrapped child event into the compact row's live accounting.
    /// `childTurns` is bounded scratch state for pending tool-call identity;
    /// unrendered prose and completed result payloads are never retained.
    private func reduceChildEvent(_ card: inout AgentSubagentCard, _ childEvent: AgentEvent) {
        switch childEvent {
        case .messageStart(_, let messageId):
            // Child requests are sequential. Reset stale scratch state at the
            // next request boundary while remaining idempotent on re-delivery.
            if card.childTurns.last?.id != messageId {
                card.childTurns = [AgentAssistantTurn(id: messageId, parts: [])]
            }

        case .textDelta, .thinkingDelta:
            // The compact row does not render child prose or reasoning. Keeping
            // it made long research runs repeatedly copy an invisible transcript.
            break

        case .toolInputStart(_, _, let toolCallId, let tool):
            if tool == "plan" { return }
            var counted = false
            mutateLastChildTurn(&card) { turn in
                // A new child tool call is one "step" of the sub-agent's work.
                guard !turn.parts.contains(where: {
                    if case .tool(let c) = $0 { return c.toolCallId == toolCallId }
                    return false
                }) else { return }
                turn.parts.append(.tool(.init(
                    toolCallId: toolCallId,
                    tool: tool,
                    args: JSONAny(value: NSNull()),
                    argsSummary: "",
                    argsKnown: false,
                    result: nil,
                    durationMs: nil
                )))
                counted = true
            }
            if counted { card.stepCount += 1 }

        case .toolStart(_, _, let toolCallId, let tool, let args, let argsSummary):
            if tool == "plan" { return }
            let resolvedSummary = argsSummary
                ?? AgentTurnBuilder.summarizeArgs(tool: tool, args: args)
            var counted = false
            mutateLastChildTurn(&card) { turn in
                if let idx = turn.parts.lastIndex(where: {
                    if case .tool(let c) = $0 { return c.toolCallId == toolCallId }
                    return false
                }), case .tool(var existing) = turn.parts[idx] {
                    existing.args = args
                    existing.argsSummary = resolvedSummary
                    existing.argsKnown = true
                    turn.parts[idx] = .tool(existing)
                } else {
                    // No prior input_start (replay / non-Anthropic backends
                    // skip it): this is the step boundary, count it here.
                    turn.parts.append(.tool(.init(
                        toolCallId: toolCallId,
                        tool: tool,
                        args: args,
                        argsSummary: resolvedSummary,
                        argsKnown: true,
                        result: nil,
                        durationMs: nil
                    )))
                    counted = true
                }
            }
            if counted { card.stepCount += 1 }

        case .toolResult(_, _, let toolCallId, let result, _):
            if case .planUpdated = result { return }
            // Accrue any documents this result surfaced onto the card's live
            // working set FIRST — independent of whether a matching transcript
            // part exists, so replay / out-of-order delivery still feeds the
            // research working-set surface.
            mergeCardDocs(&card, Self.docsFromChildToolResult(result))
            mutateLastChildTurn(&card) { turn in
                guard let idx = turn.parts.lastIndex(where: {
                    if case .tool(let c) = $0 { return c.toolCallId == toolCallId }
                    return false
                }) else { return }
                // The result has already contributed its document refs. Drop
                // the pending call instead of retaining its potentially large payload.
                turn.parts.remove(at: idx)
            }

        case .toolChildResult(_, _, _, _, let result):
            // A batch tool's singular child result is the first event that
            // carries the documents reached by search_many / fetch_many.
            // The compact card needs only that working-set update; batch
            // transcript rendering remains owned by the parent tool surface.
            mergeCardDocs(&card, Self.docsFromChildToolResult(result))

        case .messageEnd(_, let messageId, _, let usage):
            applyChildUsage(&card, messageId: messageId, usage: usage, terminal: true)
            card.childTurns.removeAll(keepingCapacity: true)

        case .usageUpdate(_, let messageId, let usage):
            applyChildUsage(&card, messageId: messageId, usage: usage)

        default:
            // userMessage / citation / citationsUpdate / nested subagent.* /
            // error / resync / unknown — not part of the card's inline
            // transcript. Ignored (graceful degrade).
            break
        }
    }

    private func applyChildUsage(
        _ card: inout AgentSubagentCard,
        messageId: String,
        usage: AgentUsage?,
        terminal: Bool = false
    ) {
        if terminal, card.completedUsageByMessage[messageId] != nil { return }
        let snapshot = mergeUsage(card.liveUsageByMessage[messageId], usage)
        if terminal {
            card.liveUsageByMessage.removeValue(forKey: messageId)
            card.completedUsageByMessage[messageId] = snapshot
        } else {
            card.liveUsageByMessage[messageId] = snapshot
        }
        card.tokens = card.completedUsageByMessage.values.reduce(0) { $0 + $1.total }
            + card.liveUsageByMessage.values.reduce(0) { $0 + $1.total }
    }

    private func mergeUsage(_ previous: AgentUsage?, _ next: AgentUsage?) -> AgentUsage {
        AgentUsage(
            inputTokens: next?.inputTokens ?? previous?.inputTokens,
            outputTokens: next?.outputTokens ?? previous?.outputTokens,
            cacheReadTokens: next?.cacheReadTokens ?? previous?.cacheReadTokens,
            cacheCreationTokens: next?.cacheCreationTokens ?? previous?.cacheCreationTokens
        )
    }

    /// Mutate the current request's bounded pending-tool scratch state. Seeds
    /// an implicit turn if a tool event arrives before `message.start`.
    private func mutateLastChildTurn(
        _ card: inout AgentSubagentCard,
        _ mutation: (inout AgentAssistantTurn) -> Void
    ) {
        if card.childTurns.isEmpty {
            card.childTurns.append(AgentAssistantTurn(id: card.subagentId, parts: []))
        }
        let idx = card.childTurns.count - 1
        mutation(&card.childTurns[idx])
    }

    /// Pull the document references out of one child tool result so the
    /// research working-set surface can show this researcher's documents
    /// accumulating live. Generic over result kind — reads the same
    /// `(documentId, title, sourceId)` shape the ephemeral cards already
    /// surface, with NO branching on a specific source (source identity rides
    /// the ref and is resolved through the registry by the view). Returns a
    /// (possibly empty) array; result kinds that carry no documents (SQL,
    /// people, plan, triggers, errors) yield none — graceful degrade. Mirrors
    /// the portal reducer's `docsFromChildToolResult`.
    static func docsFromChildToolResult(_ result: AgentToolResult) -> [AgentResearchDoc] {
        func make(_ ref: AgentDocRef) -> AgentResearchDoc {
            AgentResearchDoc(documentId: ref.documentId, title: ref.title, sourceId: ref.sourceId)
        }
        switch result {
        case .searchResults(_, _, _, let results):
            return results.map(make)
        case .document(let ref, _, _):
            return [make(ref)]
        case .searchBatch(let items), .documentBatch(let items):
            return items.flatMap(docsFromChildToolResult)
        case .documentByUrl(_, _, let ref):
            return ref.map { [make($0)] } ?? []
        case .eventTrailBuilt(_, let events, _, _):
            // Top-level events plus their attachments — the same flatten the
            // trail card uses, so a researcher's trail walk contributes its docs.
            var out: [AgentResearchDoc] = []
            for ev in events {
                if let doc = ev.doc {
                    out.append(AgentResearchDoc(documentId: doc.documentId, title: doc.title, sourceId: doc.sourceId))
                }
                for att in ev.attachments {
                    if let doc = att.doc {
                        out.append(AgentResearchDoc(documentId: doc.documentId, title: doc.title, sourceId: doc.sourceId))
                    }
                }
            }
            return out
        default:
            return []
        }
    }

    /// Append new docs to a card's `docs`, deduped by documentId (existing
    /// entries win, preserving arrival order). No-op when nothing new arrives.
    /// Mirrors the portal reducer's `mergeCardDocs`.
    private func mergeCardDocs(_ card: inout AgentSubagentCard, _ incoming: [AgentResearchDoc]) {
        guard !incoming.isEmpty else { return }
        var seen = Set(card.docs.map(\.documentId))
        for doc in incoming where !seen.contains(doc.documentId) {
            seen.insert(doc.documentId)
            card.docs.append(doc)
        }
    }

    // MARK: - Research working-set surface (#748)

    /// The bespoke multi-panel research working-set surface is driven entirely
    /// off coordinator state — no side channel. `researchPanels` projects the
    /// sub-agent cards on the latest assistant turn into one panel descriptor
    /// per researcher (spawn order); `isResearchWorkspaceActive` gates the
    /// surface to a live Deep Research run that has at least one researcher.
    /// The view renders the surface only while active and lets it collapse into
    /// the report (the finished assistant turn) when the run ends. Pure
    /// functions of `turns` / `deepResearch` so they unit-test without SwiftUI.
    var researchPanels: [AgentResearchPanel] {
        for turn in turns.reversed() {
            guard case .assistant(let assistant) = turn else { continue }
            // The most-recent assistant turn is the run in flight: its
            // sub-agent cards are the researchers. (Matches the portal
            // selector, which stops at the latest assistant turn.)
            let cards = assistant.parts.compactMap { part -> AgentSubagentCard? in
                if case .subagent(let card) = part { return card }
                return nil
            }
            return cards.map { card in
                AgentResearchPanel(
                    subagentId: card.subagentId,
                    specialist: card.specialist,
                    title: card.title,
                    task: card.task,
                    docs: card.docs,
                    stepCount: card.stepCount,
                    tokens: card.tokens,
                    status: card.status,
                    summary: card.summary
                )
            }
        }
        return []
    }

    /// True when the research working-set surface should be on screen: a Deep
    /// Research run is in flight AND at least one researcher panel exists. Once
    /// `deepResearch` clears (run ended) the surface collapses even though the
    /// finished cards still live on the transcript.
    var isResearchWorkspaceActive: Bool {
        deepResearch && !researchPanels.isEmpty
    }

    /// Whether the transcript's turn-level "working" dots are eligible to show:
    /// the turn is in flight AND its trailing content is static, so no per-item
    /// affordance (thinking shimmer, pending-tool spinner, running sub-agent,
    /// live batch cards) is already signalling activity. `AgentWorkingIndicator`
    /// debounces the actual reveal, so this only answers "is there a live
    /// self-animating tail?", not "has the stream gone quiet?".
    ///
    /// Pure over `busy` + `turns` so it is unit-testable without a view. Lives
    /// here rather than on `AgentView` because the batch-tool distinction below
    /// is a transcript-model fact, not a layout one.
    var workingIndicatorActive: Bool {
        Self.workingIndicatorActive(busy: busy, turns: turns)
    }

    static func workingIndicatorActive(busy: Bool, turns: [AgentTurn]) -> Bool {
        guard busy else { return false }
        guard let last = turns.last else { return false }
        switch last {
        case .user:
            // Sent, awaiting the first `message.start` — the assistant turn
            // doesn't exist yet, so nothing else can be animating.
            return true
        case .assistant(let turn):
            guard turn.stopReason == nil else { return false }
            guard let tail = turn.parts.last else {
                // `message.start` landed but no delta yet — empty parts render
                // nothing.
                return true
            }
            switch tail {
            case .text, .unknown:
                return true
            case .thinking:
                // Live trailing thinking part paints its own shimmer + dots.
                return false
            case .tool(let call):
                // A batch retrieval tool renders per-child cards only when the
                // backend streams `agent.tool.child.*` progress. With no
                // children it shows NOTHING on screen for the (often
                // multi-second) batch — running or just-finished — so the dots
                // are the only "still working" signal; with children the
                // per-child cards animate, so stay out of their way.
                if agentBatchTools.contains(call.tool) {
                    return call.children.isEmpty
                }
                // A pending singular tool shows its own spinner (ephemeral card
                // or the generic tool chrome); a completed card is static while
                // the model generates the next step.
                return call.result != nil
            case .subagent(let card):
                // A running sub-agent card spins; a finished one is static.
                return card.status != nil
            }
        }
    }

    // MARK: - Ephemeral causality gate

    /// True for the SSE events that would otherwise extend the latest
    /// assistant turn (text / thinking / new tool stub / tool result /
    /// sub-agent lifecycle update).
    /// Everything else (session-level state, sidebar, end-of-turn)
    /// bypasses the gate.
    private func eventAppendsToTurn(_ event: AgentEvent) -> Bool {
        switch event {
        case .textDelta, .thinkingDelta, .toolInputStart, .toolStart, .toolResult,
             .subagentSpawned, .subagentResult:
            true
        default:
            false
        }
    }

    /// Index of the active gate inside the latest assistant turn's parts
    /// array, or `nil` if no gate is active. The gate is the LAST
    /// ephemeral tool part whose result has landed but whose card has
    /// not yet flushed. By construction at most one ephemeral tool
    /// part in `parts[]` is undismissed at a time — newer ephemeral
    /// tools get queued behind the current gate.
    private func activeEphemeralGateIndex() -> Int? {
        guard let turnIdx = turns.lastIndex(where: {
            if case .assistant = $0 { return true }
            return false
        }) else { return nil }
        guard case .assistant(let assistant) = turns[turnIdx] else { return nil }
        for i in (0 ..< assistant.parts.count).reversed() {
            guard case .tool(let call) = assistant.parts[i] else { continue }
            guard agentEphemeralTools.contains(call.tool) else { continue }
            // A batch parent (search_many / fetch_many) renders as N
            // independent per-child cards, each with its own dismiss
            // lifecycle — there is no single card to drive a gate flush for
            // the parent, so it never gates. Its answer text streams
            // immediately after the batch result rather than parking forever.
            if agentBatchTools.contains(call.tool) { return nil }
            if call.result != nil, !call.tailDismissed { return i }
            // First ephemeral tool from the tail is either already
            // dismissed or has no result yet — not a gate, and any
            // earlier ephemeral tool is bounded by the same rule.
            return nil
        }
        return nil
    }

    /// Park `event` behind the active gate at `partIndex` and, when it is the
    /// FIRST event to queue there, arm the coordinator-side max-hold. The gate
    /// is normally released by the ephemeral card's SwiftUI dismiss task (see
    /// `flushEphemeralTail`); this wall-clock backstop guarantees a long turn —
    /// a firehose of interleaved thinking + batch tools after one early card —
    /// can never be stranded behind that card if the view-driven flush is
    /// delayed (off-screen, recycled, or starved by the event stream).
    private func parkOnEphemeralGate(at partIndex: Int, event: AgentEvent) {
        let wasFirstPark = enqueueOnEphemeralGate(at: partIndex, event: event)
        if wasFirstPark, let toolCallId = gateToolCallId(at: partIndex) {
            scheduleGateMaxHold(toolCallId: toolCallId)
        }
    }

    /// Park `event` on the queue of the gate at `partIndex` inside the
    /// latest assistant turn. Caller has already confirmed the gate exists.
    /// Returns `true` when this is the FIRST event to park on the gate (its
    /// tail was empty), so the caller can arm the max-hold exactly once.
    @discardableResult
    private func enqueueOnEphemeralGate(at partIndex: Int, event: AgentEvent) -> Bool {
        var wasFirstPark = false
        mutateLastAssistant { turn in
            guard partIndex < turn.parts.count else { return }
            guard case .tool(var call) = turn.parts[partIndex] else { return }
            wasFirstPark = call.pendingTail.isEmpty
            call.pendingTail.append(event)
            turn.parts[partIndex] = .tool(call)
        }
        return wasFirstPark
    }

    /// The `toolCallId` of the gate at `partIndex` in the latest assistant
    /// turn, or `nil` if that part is not a tool (defensive — the caller has
    /// the index from `activeEphemeralGateIndex`).
    private func gateToolCallId(at partIndex: Int) -> String? {
        guard let last = turns.last, case .assistant(let assistant) = last,
              partIndex < assistant.parts.count,
              case .tool(let call) = assistant.parts[partIndex]
        else { return nil }
        return call.toolCallId
    }

    /// View-driven flush: an ephemeral card calls this when its dismiss
    /// animation completes. We mark the gate dismissed and replay the
    /// queued events through `handle(event:)` in arrival order. A
    /// replayed event that itself activates a new gate (e.g. a second
    /// ephemeral tool's result) naturally absorbs any further queued
    /// events ordered after it — the gate check re-runs on every event.
    @MainActor
    func flushEphemeralTail(toolCallId: String) async {
        // The gate is being released (by the card OR the max-hold backstop) —
        // retire the wall-clock timer for it either way.
        cancelGateHold(toolCallId: toolCallId)
        guard let turnIdx = turns.lastIndex(where: {
            if case .assistant = $0 { return true }
            return false
        }) else { return }
        guard case .assistant(var assistant) = turns[turnIdx] else { return }
        guard let partIdx = assistant.parts.lastIndex(where: {
            if case .tool(let c) = $0 { return c.toolCallId == toolCallId }
            return false
        }) else { return }
        guard case .tool(var call) = assistant.parts[partIdx] else { return }
        if call.tailDismissed { return } // double-flush guard
        let queued = call.pendingTail
        call.pendingTail = []
        call.tailDismissed = true
        assistant.parts[partIdx] = .tool(call)
        turns[turnIdx] = .assistant(assistant)
        for event in queued {
            await handle(event: event)
        }
    }

    /// Force-drain every active ephemeral gate in the latest assistant
    /// turn. Called from `messageEnd` / `error` as a safety net: by the
    /// time the turn ends, all tool results have landed, so any gate
    /// still active means its card's SwiftUI lifecycle didn't complete
    /// the flush (timing edge case, view recycling, error/unknown
    /// result that prevented the ephemeral card from rendering). Each
    /// iteration drains the outermost gate; replayed events may create
    /// a new inner gate, so we loop until clear.
    @MainActor
    private func forceFlushActiveGates() async {
        cancelAllGateHolds()
        while let gateIdx = activeEphemeralGateIndex() {
            guard let turnIdx = turns.lastIndex(where: {
                if case .assistant = $0 { return true }
                return false
            }) else { return }
            guard case .assistant(var assistant) = turns[turnIdx] else { return }
            guard gateIdx < assistant.parts.count,
                  case .tool(var call) = assistant.parts[gateIdx]
            else { return }
            let queued = call.pendingTail
            call.pendingTail = []
            call.tailDismissed = true
            assistant.parts[gateIdx] = .tool(call)
            turns[turnIdx] = .assistant(assistant)
            for event in queued {
                await handle(event: event)
            }
        }
    }

    // MARK: - Ephemeral gate max-hold backstop

    /// Live max-hold timers, keyed by the gating tool call's id. At most a
    /// couple are ever live (a gate can chain to a successor). Cleared on
    /// flush, force-flush, and teardown/reset.
    @ObservationIgnored
    private var gateHoldTasks: [String: Task<Void, Never>] = [:]

    /// The max-hold interval used for scheduling. Overridable in tests so the
    /// backstop can be exercised deterministically without a real 1.5s wait.
    private var gateMaxHoldSeconds: Double {
        #if DEBUG
        if let override = gateMaxHoldSecondsForTesting { return override }
        #endif
        return agentEphemeralGateMaxHoldSeconds
    }

    #if DEBUG
    @ObservationIgnored
    var gateMaxHoldSecondsForTesting: Double?
    #endif

    /// Arm (or re-arm) the wall-clock backstop for the gate `toolCallId`: if
    /// the card hasn't flushed within `gateMaxHoldSeconds`, force the flush
    /// so parked events reach the transcript regardless of the view's timing.
    private func scheduleGateMaxHold(toolCallId: String) {
        gateHoldTasks[toolCallId]?.cancel()
        let seconds = gateMaxHoldSeconds
        gateHoldTasks[toolCallId] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            // Drop our own handle before flushing so `cancelGateHold` inside
            // `flushEphemeralTail` doesn't try to cancel the task that is
            // currently running it.
            self.gateHoldTasks[toolCallId] = nil
            await self.flushEphemeralTail(toolCallId: toolCallId)
        }
    }

    private func cancelGateHold(toolCallId: String) {
        gateHoldTasks[toolCallId]?.cancel()
        gateHoldTasks[toolCallId] = nil
    }

    private func cancelAllGateHolds() {
        for task in gateHoldTasks.values {
            task.cancel()
        }
        gateHoldTasks.removeAll()
    }
}

// MARK: - Citation shapes

/// One document the agent has cited, with each `annotate` call recorded
/// as an `entries[]` row. Lives here next to the coordinator so views
/// can observe directly without crossing a transport boundary.
///
/// Routing convention (applied in `handle(.citation:)` and on resume):
///   • `annotate(quote:)` (with or without note) → appended to `entries`.
///   • `annotate(note:)` only (no quote) → set `docNote`. Last write
///     wins; `docNote` renders as a single header line on the card,
///     not as a quote entry. Lets the model add doc-level context
///     (e.g. "this is the source thread") without attaching the note
///     to a random quote.
@available(iOS 17.0, *)
struct AgentCitation: Equatable, Identifiable {
    var id: String {
        documentId
    }

    let documentId: String
    let ref: AgentDocRef
    var docNote: String?
    var entries: [AgentCitationEntry]
}

@available(iOS 17.0, *)
struct AgentCitationEntry: Equatable {
    let toolCallId: String
    let messageId: String
    let quote: String?
    let note: String?
    let quoteAuthor: String?
    /// True when the cited words are the user's own. Carried from the
    /// `agent.citation` / `annotate.recorded` payload's `quoteIsSelf`.
    var quoteIsSelf: Bool = false
}

// MARK: - Portal-reducer-equivalent shapes

/// One bubble in the conversation. The portal aggregates an assistant
/// reply + all interleaved tool calls / results into one turn so the
/// chat reads as "user said → agent did/said". iOS does the same.
@available(iOS 17.0, *)
enum AgentTurn: Identifiable, Equatable {
    case user(id: String, text: String)
    case assistant(AgentAssistantTurn)

    var id: String {
        switch self {
        case .user(let id, _): id
        case .assistant(let t): t.id
        }
    }
}

/// Why an assistant turn ended badly, kept in its parts rather than flattened
/// into one string. The humanized sentence is what the reader needs; the code
/// and the provider's disposition are what someone fixing the gateway needs,
/// and interpolating them into the prose serves neither.
@available(iOS 17.0, *)
struct AgentTurnFailure: Equatable {
    /// Machine-readable failure code, e.g. `http_api_error`.
    var code: String?
    /// The humanized sentence naming the condition.
    var message: String
    /// What the model provider reported, when the failure came from one.
    var provider: AgentProviderFailureDetail?

    /// Code and provider disposition as one quiet line, e.g.
    /// `http_api_error · HTTP 404 · NOT_FOUND · param=model`. Nil when the
    /// failure carries neither, so the bubble renders the message alone.
    var detailLine: String? {
        var parts: [String] = []
        if let code, !code.isEmpty { parts.append(code) }
        if let formatted = provider?.formatted { parts.append(formatted) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

@available(iOS 17.0, *)
struct AgentAssistantTurn: Equatable, Identifiable {
    var id: String
    var parts: [AgentPart]
    var stopReason: String?
    var failure: AgentTurnFailure?
    /// The sentence a reopened conversation shows under a reply that was
    /// stopped — the marker the session leaves in history says whether the
    /// user stopped it. A stop is an outcome, not a failure, so it never
    /// reaches `failure`; a live stop ends the turn with no note at all.
    var stopped: String?
    /// Number of `annotate` tool calls made during this turn. Drives
    /// the "N citations" chip in the bubble footer.
    var citationCount: Int = 0
    /// Legacy Deep Research summary metadata set by
    /// `agent.deep_research.summary`, retained for transcript compatibility
    /// and citation reconstruction. It is not rendered.
    var reportArtifact: AgentReportArtifact?

    /// End the turn the way the marker the session left in history says it
    /// ended. A stopped reply is an outcome, not a failure: the live view
    /// ends such a turn with no error affordance, so a reopened one says only
    /// that it stopped. Every other code is the failure the reader sees.
    mutating func recordTerminalMarker(_ failure: AgentTurnFailure) {
        if failure.code == "canceled" {
            stopReason = "canceled"
            stopped = failure.message
        } else {
            self.failure = failure
        }
    }
}

/// Structured Deep Research summary metadata retained for compatibility with
/// persisted transcripts and the additive `agent.deep_research.summary` event.
/// The retired completion card no longer renders this state.
@available(iOS 17.0, *)
struct AgentReportArtifact: Equatable {
    let stoppedReason: String
    let plan: [AgentDeepResearchPlanItem]
    let treeUsage: AgentUsage?
    let verification: AgentDeepResearchVerification
}

@available(iOS 17.0, *)
enum AgentPart: Equatable {
    case text(String)
    case thinking(String)
    case tool(AgentToolCall)
    /// A sub-agent (#748) the parent spawned. Renders as a compact live
    /// `AgentSubAgentCard` with status, token usage, and reached sources.
    /// Mirrors the portal `subagent` part.
    case subagent(AgentSubagentCard)
    /// Forward-compat placeholder for transcript content this client
    /// doesn't recognise (a future assistant-part `kind`, a top-level
    /// user-part the gateway introduced, or a whole new message role).
    /// `label` describes what surface produced the unknown ("message
    /// part", "user content", "message"); `kind` is the unknown
    /// discriminator. The view layer decides whether to surface it
    /// (demo build) or collapse to `EmptyView` (production).
    case unknown(label: String, kind: String)
}

@available(iOS 17.0, *)
struct AgentToolCall: Equatable, Identifiable {
    var id: String {
        toolCallId
    }

    let toolCallId: String
    let tool: String
    // `args` / `argsSummary` / `argsKnown` are mutable so the live
    // `toolInputStart` → `toolStart` upgrade can fill them in without
    // replacing the whole part (which would lose the result if it raced
    // in first). `argsKnown` flips to true once the finalized
    // `tool.start` lands — the pending-state label uses this to
    // distinguish "args still streaming" from "args in, tool running".
    var args: JSONAny
    var argsSummary: String
    var argsKnown: Bool
    var result: AgentToolResult?
    var durationMs: Double?
    // Causality gate state — only meaningful for the ephemeral tools
    // listed in `agentEphemeralTools`. While the card is
    // mid-dismiss-lifecycle, any subsequent SSE event that would
    // extend the assistant turn is parked here in arrival order and
    // replayed once the card emits a `flushEphemeralTail` callback.
    // For non-ephemeral tools `pendingTail` stays empty for the part's
    // entire lifetime. Mirrors the portal's `pendingTail` /
    // `tailDismissed` fields on the same wire-shape part.
    var pendingTail: [AgentEvent] = []
    var tailDismissed: Bool = false
    // Per-child live-progress rows for a batch retrieval tool
    // (`search_many` / `fetch_many`), attached from `agent.tool.child.*`
    // events and kept sorted by `index`. The view projects each child back
    // through the singular ephemeral card it wraps. Empty for every non-batch
    // tool (and for a batch whose backend streams no child progress). Mirrors
    // the portal part's `children[]`.
    var children: [AgentToolChild] = []
}

/// One child row of a batch retrieval tool (`search_many` / `fetch_many`),
/// populated live from `agent.tool.child.*` events and keyed + sorted by
/// `index`. `tool` is the SINGULAR tool name (`search_documents` /
/// `fetch_document`) so the view projects the child back through the existing
/// per-tool ephemeral card; it stays nil when a `child.result` lands before
/// its `child.start`. Mirrors one element of the portal part's `children[]`.
@available(iOS 17.0, *)
struct AgentToolChild: Equatable, Identifiable {
    var id: Int {
        index
    }

    let index: Int
    var tool: String?
    var argsSummary: String
    var result: AgentToolResult?
}

/// Derive the per-child pseudo-`AgentToolCall`s a batch retrieval tool
/// (`search_many` / `fetch_many`) renders. Kept as a free function — separate
/// from the `AgentBatchToolCards` view that consumes it — so this load-bearing
/// derivation is unit-testable in the pure-logic lane (the view itself is
/// UIKit-gated and never built there).
///
/// The per-child cards are derived from the best available data, in priority
/// order, so they render on EVERY backend — not just the one that streams live
/// child progress:
///
///   1. `children` non-empty — the backend streamed `agent.tool.child.*`
///      progress (codex): one card per streamed child, live.
///   2. else a settled `.searchBatch` / `.documentBatch` result — the
///      non-streaming backends (Anthropic / DeepSeek-over-http) run the batch
///      and emit only the terminal `*.batch` result. One SETTLED card per item,
///      with the input query / documentId pulled from `args`.
///   3. else the tool is still running (no children, no result) — one PENDING
///      card per `args` entry (`queries` / `documents`) with a nil result, so
///      each singular card shows its live "searching…" spinner and the turn
///      looks alive during the tool call.
///
/// Without cases 2 and 3 a non-streaming backend renders nothing while (and
/// after) a batch tool runs, so a turn full of `search_many` calls looks
/// frozen. Each pseudo-child carries the SINGULAR tool name and is keyed
/// `toolCallId#index` so SwiftUI identity is stable across the pending→settled
/// transition. Mirrors the portal's projection in `parts.js`.
@available(iOS 17.0, *)
func agentBatchChildCalls(for call: AgentToolCall) -> [AgentToolCall] {
    let childTool = call.tool == "fetch_many" ? "fetch_document" : "search_documents"

    func makeChild(index: Int, tool: String, argsSummary: String, result: AgentToolResult?) -> AgentToolCall {
        AgentToolCall(
            toolCallId: "\(call.toolCallId)#\(index)",
            tool: tool,
            args: JSONAny(value: NSNull()),
            argsSummary: argsSummary,
            argsKnown: true,
            result: result,
            durationMs: nil
        )
    }

    // 1. Live streamed child progress (codex).
    if !call.children.isEmpty {
        return call.children.map { child in
            makeChild(
                index: child.index,
                tool: child.tool ?? childTool,
                argsSummary: child.argsSummary,
                result: child.result
            )
        }
    }

    // The raw per-child input entries — `queries` for search_many, `documents`
    // for fetch_many — as loosely-typed dictionaries. Empty until the finalized
    // `agent.tool.start` fills in `args`.
    let argEntries: [[String: Any]] = {
        guard let dict = call.args.value as? [String: Any] else { return [] }
        let key = call.tool == "fetch_many" ? "documents" : "queries"
        guard let arr = dict[key] as? [Any] else { return [] }
        return arr.compactMap { $0 as? [String: Any] }
    }()

    func entry(_ index: Int) -> [String: Any]? {
        index >= 0 && index < argEntries.count ? argEntries[index] : nil
    }

    // 2. Settled batch result (non-streaming backends, after completion).
    let settledItems: [AgentToolResult]? = switch call.result {
    case .searchBatch(let items), .documentBatch(let items):
        items
    default:
        nil
    }
    if let items = settledItems {
        return items.enumerated().map { index, item in
            // For fetch_many prefer the opened document's title, falling back to
            // the requested id; for search_many prefer the requested query from
            // `args`, falling back to the result's own query. Keeps the row
            // non-empty even when args and result items disagree in length.
            let summary: String = if call.tool == "fetch_many" {
                if case .document(let ref, _, _) = item {
                    ref.title ?? ref.documentId
                } else {
                    (entry(index)?["documentId"] as? String) ?? ""
                }
            } else if let query = entry(index)?["query"] as? String, !query.isEmpty {
                query
            } else if case .searchResults(let query, _, _, _) = item {
                query
            } else {
                ""
            }
            return makeChild(index: index, tool: childTool, argsSummary: summary, result: item)
        }
    }

    // 3. Still running: one pending card per input entry.
    return argEntries.enumerated().map { index, entry in
        let summary: String = call.tool == "fetch_many"
            ? ((entry["documentId"] as? String) ?? "")
            : ((entry["query"] as? String) ?? "")
        return makeChild(index: index, tool: childTool, argsSummary: summary, result: nil)
    }
}

/// A sub-agent (#748) nested under the parent agent — the iOS twin of the
/// portal `subagent` part. `spawned` seeds a compact progress row, wrapped
/// events update its bounded accounting state, and `result` finalises status,
/// summary, sources, and the authoritative token total.
@available(iOS 17.0, *)
struct AgentSubagentCard: Equatable, Identifiable {
    var id: String {
        subagentId
    }

    let subagentId: String
    /// Registry name of the specialist driving the child (e.g. `history-sweep`).
    let specialist: String
    /// Short human-facing outcome set by the parent agent.
    let title: String
    /// The natural-language brief — the child's first user message.
    let task: String
    /// The parent tool call that spawned this child, when known.
    let parentToolCallId: String?
    /// Bounded scratch state for pending child tool-call identity. Child prose,
    /// reasoning, and completed tool payloads are deliberately not retained.
    var childTurns: [AgentAssistantTurn] = []
    /// Documents this researcher has reached so far, accumulated LIVE from its
    /// child tool results (search hits, opened docs, trail walks) and deduped
    /// by documentId. Each is a minimal source-tintable ref — the research
    /// working-set surface and compact row summarize these refs as source
    /// badges while the run proceeds. Mirrors the portal card's `docs[]`.
    var docs: [AgentResearchDoc] = []
    /// Live counter retained for the compact researcher row: one per child tool call.
    var stepCount: Int = 0
    /// Rendered token total: completed requests plus each request's latest
    /// cumulative live usage snapshot. The terminal child result replaces it.
    var tokens: Int = 0
    /// Cumulative provider usage for child requests whose terminal event arrived.
    var completedUsageByMessage: [String: AgentUsage] = [:]
    /// Latest cumulative provider usage by in-flight child message id.
    var liveUsageByMessage: [String: AgentUsage] = [:]
    /// Terminal status (`complete` / `failed` / `budget_exhausted`); `nil`
    /// while the child is still in flight.
    var status: String?
    /// Distilled finding the child returned to the parent on finalise.
    var summary: String?
    /// Deliberate citations retained by a failed worker for a partial result.
    var retainedCitationCount: Int = 0
    /// Authoritative terminal code for deciding whether retained evidence is usable.
    var failureCode: String?
    /// What the model provider reported about the request that killed this
    /// worker, when the failure came from one.
    var failureProvider: AgentProviderFailureDetail?

    /// Code and provider disposition as one quiet line for a failed card, e.g.
    /// `http_api_error · HTTP 404 · NOT_FOUND · param=model`.
    var failureDetailLine: String? {
        var parts: [String] = []
        if let failureCode, !failureCode.isEmpty { parts.append(failureCode) }
        if let formatted = failureProvider?.formatted { parts.append(formatted) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var hasPartialResult: Bool {
        status == "failed"
            && failureCode == "output_truncated"
            && retainedCitationCount > 0
            && summary?.hasPrefix(
                "Partial evidence collected before the worker reached its output limit:"
            ) == true
    }
}

/// A single document a researcher sub-agent has reached, in minimal
/// source-tintable form (#748). Carries only what the research working-set
/// surface needs to paint one source-tinted chip — the title plus the
/// `sourceId` the source registry resolves to an icon/accent/label. Source
/// identity rides this ref; the view never branches on a source name.
@available(iOS 17.0, *)
struct AgentResearchDoc: Equatable, Identifiable {
    var id: String {
        documentId
    }

    let documentId: String
    let title: String?
    let sourceId: String
}

/// View-facing descriptor for one researcher panel on the research working-set
/// surface (#748) — the projection `researchPanels(of:)` builds per sub-agent
/// card in spawn order. Pure value type so the selector stays testable.
@available(iOS 17.0, *)
struct AgentResearchPanel: Equatable, Identifiable {
    var id: String {
        subagentId
    }

    let subagentId: String
    let specialist: String
    let title: String
    let task: String
    let docs: [AgentResearchDoc]
    let stepCount: Int
    let tokens: Int
    let status: String?
    let summary: String?
}

/// Tool names whose live cards self-dismiss; both the resume filter and
/// the causality gate key off this single set. Mirrors the portal's
/// `EPHEMERAL_TOOLS`.
@available(iOS 17.0, *)
let agentEphemeralTools: Set<String> = [
    // Visible only until `agent.subagent.spawned` replaces it with the stable
    // worker row; also dropped from rebuilt history.
    "spawn_subagent",
    "search_documents",
    "fetch_document",
    // Batch retrieval tools: each renders live as N per-child ephemeral cards
    // (AgentPartView projects `call.children`), dropped from resumed history
    // like the singular ephemeral tools they wrap.
    "search_many",
    "fetch_many",
    "run_sql",
    "trace_connections",
    "lookup_people",
    "lookup_document_by_url",
    "search_loops",
    "fetch_loop",
    "list_loops",
    "entity_context",
    // The steward toolset, reachable from brief talk-back threads.
    // These are quick background actions the agent narrates in prose —
    // their cards flash by live (AgentEphemeralActionCard) and are never
    // rebuilt into resumed history.
    "open_loop_search",
    "open_loop_fetch",
    "open_loop_create",
    "open_loop_update",
    "open_loop_delete",
    "open_loop_ledger_append",
    "brief_list",
    "brief_fetch",
    "brief_create",
    "brief_update",
    "brief_delete",
    "temporal_query",
    "temporal_annotation_add",
    "temporal_annotation_update",
    "temporal_annotation_delete",
    // Rollout compatibility for persisted turns from older gateways.
    "time_index_add",
    "time_index_update",
    "time_index_delete",
    "time_index_query",
    "notes_append", "notes_rewrite", "annotate_durable",
    "conversation_memory_evidence", "annotation_search", "annotation_revise", "annotation_retract",
    "annotation_supersede", "annotate_person", "person_annotation_revise",
    "person_annotation_retract", "person_annotation_supersede", "schedule_agent_run",
]

/// Orchestration calls that never own durable transcript content.
@available(iOS 17.0, *)
let agentOrchestrationTools: Set<String> = ["spawn_subagent", "join_subagents"]

/// Panel-only or fully invisible tools skipped at input/start time.
@available(iOS 17.0, *)
let agentHiddenTranscriptTools: Set<String> = ["plan", "join_subagents"]

@available(iOS 17.0, *)
func streamEventIsNewer(_ id: String?, than cursor: Int?) -> Bool {
    guard let cursor, let id, let sequence = Int(id) else { return true }
    return sequence > cursor
}

/// The batch retrieval tools — a subset of `agentEphemeralTools`. They are
/// dropped from resumed history like the singular ephemeral tools they wrap,
/// but they render as N independent per-child cards (each with its own dismiss
/// lifecycle) rather than one card, so a batch parent never acts as a
/// causality gate — there is no single card to drive its flush, and its answer
/// text must stream immediately after the batch result rather than park.
@available(iOS 17.0, *)
let agentBatchTools: Set<String> = [
    "search_many",
    "fetch_many",
]

/// Upper bound on how long the ephemeral causality gate may hold parked
/// events before the coordinator force-flushes it, independent of the
/// ephemeral card's own SwiftUI dismiss task. An ephemeral card expedites
/// its reveal to `agentEphemeralMinVisibleSeconds` (0.5s) once content queues
/// behind it and flushes within roughly a second; this bound sits comfortably
/// above that so it never truncates a legitimate reveal, yet guarantees a long
/// turn — a firehose of interleaved thinking plus batch tools after one early
/// gating card — can never be stranded behind that card if the view-driven
/// flush is delayed (off-screen, recycled, or starved by the event stream).
/// Scaled by the recording-pacing multiplier, like the card's own reveal
/// timings, so a deliberately-slowed demo recording isn't cut short.
@available(iOS 17.0, *)
let agentEphemeralGateMaxHoldSeconds: Double = 1.5 * AppBuild.ephemeralRecordingPacingMultiplier

/// Humanize a structured tool result's `resultType` for the generic
/// steward action card: "open_loop.ledger_appended" → "Open loop
/// ledger appended". Mirrors the portal's inline equivalent.
func agentHumanizeResultType(_ resultType: String) -> String {
    let words = resultType
        .replacingOccurrences(of: ".", with: " ")
        .replacingOccurrences(of: "_", with: " ")
    guard let first = words.first else { return words }
    return first.uppercased() + words.dropFirst()
}

// MARK: - Canonical history → portal-shape converter

/// One recorded annotation extracted from a tool result — the fields the
/// citations rollup and unified-Timeline rebuilders consume. A small value
/// type so `annotateRecordedItems` can fan an `annotate.batch` out to one per
/// child while reusing the same routing the singular path uses.
struct AgentAnnotateRecord {
    let documentId: String
    let ref: AgentDocRef
    let quote: String?
    let note: String?
    let quoteAuthor: String?
    let quoteIsSelf: Bool
}

@available(iOS 17.0, *)
enum AgentTurnBuilder {
    /// Translate the gateway's canonical `ChatMessage[]` into the
    /// per-turn shape the UI renders. Each user-text message starts a
    /// new turn; subsequent assistant + user(tool_result) messages are
    /// folded into the same assistant turn until the next user-text
    /// arrives.
    static func turns(from messages: [ChatMessage], idPrefix: String = "") -> [AgentTurn] {
        var out: [AgentTurn] = []
        var i = 0
        var n = 0
        while i < messages.count {
            switch messages[i] {
            case .unknown(let role, _):
                // A whole-message role the client doesn't recognise.
                // Surface it as a one-part synthetic assistant bubble
                // (label includes the role so the demo can show what
                // was skipped); production collapses the part to
                // EmptyView at render time.
                var bubble = AgentAssistantTurn(
                    id: "\(idPrefix)a-\(n)", parts: [], stopReason: nil, failure: nil, citationCount: 0
                )
                bubble.parts.append(.unknown(label: "message", kind: role))
                out.append(.assistant(bubble))
                n += 1
                i += 1
            case .user(let parts):
                if let text = parts.compactMap({ p -> String? in
                    if case .text(let s) = p { return s } else { return nil }
                }).first {
                    out.append(.user(id: "\(idPrefix)u-\(n)", text: text))
                    n += 1
                }
                i += 1
            case .assistant:
                var assistant = AgentAssistantTurn(
                    id: "\(idPrefix)a-\(n)", parts: [], stopReason: nil, failure: nil, citationCount: 0
                )
                n += 1
                var toolIndexById: [String: Int] = [:]
                fold: while i < messages.count {
                    switch messages[i] {
                    case .unknown:
                        // The fold belongs to the preceding assistant
                        // turn; a whole new role ends it. Hand control
                        // back to the outer loop without advancing.
                        break fold
                    case .assistant(let parts):
                        for p in parts {
                            switch p {
                            case .unknown(let kind, _):
                                // Forward-compat: a future assistant
                                // part kind. Emit a placeholder so the
                                // demo can show what's missing; the
                                // production view collapses it.
                                assistant.parts.append(
                                    .unknown(label: "message part", kind: kind)
                                )
                            case .text(let text):
                                // A turn that died left a marker in
                                // model-visible history so the model knows
                                // on its next turn that it failed. The
                                // reader gets the styled failure instead —
                                // rendering the marker as prose too would
                                // show the same failure twice.
                                if let marked = splitTerminalFailureMarker(text) {
                                    if !marked.body.isEmpty {
                                        assistant.parts.append(.text(marked.body))
                                    }
                                    assistant.recordTerminalMarker(marked.failure)
                                } else {
                                    assistant.parts.append(.text(text))
                                }
                            case .thinking:
                                // Thinking is a transient live-stream indicator
                                // (see AgentThinkingBlock in AgentBubbleViews) —
                                // like the ephemeral tool cards below, it is
                                // never rebuilt into resumed history. Drop it so
                                // reopening a past conversation shows the answer
                                // alone, with no reasoning blocks frozen in the
                                // transcript. The server record is untouched.
                                continue
                            case .reportArtifact(let artifact):
                                // Preserve persisted Deep Research summary
                                // metadata for compatibility with the live
                                // `agent.deep_research.summary` event. Citations
                                // carried on the part are seeded separately in
                                // `reportArtifactCitations(from:)`.
                                assistant.reportArtifact = AgentReportArtifact(
                                    stoppedReason: artifact.stoppedReason,
                                    plan: artifact.plan,
                                    treeUsage: artifact.treeUsage,
                                    verification: artifact.verification
                                )
                            case .toolUse(let id, let tool, let args):
                                // `plan` is a panel-only tool. The
                                // TODO: list it drives is intentionally
                                // not replayed from history, so its
                                // tool_use / tool_result pairs are
                                // dropped from the rebuilt transcript.
                                if agentHiddenTranscriptTools.contains(tool) { continue }
                                // Ephemeral tools (search / fetch /
                                // run_sql) ARE preserved server-side
                                // so the agent has full context on
                                // follow-ups, but their visual cards
                                // are meant to be in-flight only —
                                // re-animating them on resume would
                                // look like the agent is re-doing the
                                // work. Drop them from the UI's
                                // rebuilt transcript; the server
                                // ConversationStore record is
                                // untouched.
                                if agentEphemeralTools.contains(tool) {
                                    // Citation reconstruction is a
                                    // separate walk below, so dropping
                                    // these tool_use parts here doesn't
                                    // affect the chip count.
                                    continue
                                }
                                assistant.parts.append(.tool(.init(
                                    toolCallId: id,
                                    tool: tool,
                                    args: args,
                                    argsSummary: summarizeArgs(tool: tool, args: args),
                                    argsKnown: true,
                                    result: nil,
                                    durationMs: nil
                                )))
                                toolIndexById[id] = assistant.parts.count - 1
                                // Citation tools feed the bubble's citation
                                // chip: `annotate` cites one document,
                                // `cite_record` one analytics row (#757), and
                                // `annotate_many` contributes one per child.
                                if tool == "annotate_many" {
                                    assistant.citationCount += annotateManyChildCount(args)
                                } else if tool == "annotate" || tool == "cite_record" {
                                    assistant.citationCount += 1
                                }
                            }
                        }
                        i += 1
                    case .user(let parts):
                        // Always fold any tool_result parts into the
                        // current assistant turn first — a single user
                        // message may carry both tool_result parts (the
                        // model's tool outputs) and a text part (the
                        // user's next prompt). The text part, when
                        // present, ends the assistant turn; we leave
                        // `i` parked on this message so the outer loop
                        // re-enters via the `.user` case and consumes
                        // the text.
                        for p in parts {
                            switch p {
                            case .toolResult(let id, let result):
                                if let idx = toolIndexById[id],
                                   case .tool(var call) = assistant.parts[idx] {
                                    call.result = result
                                    assistant.parts[idx] = .tool(call)
                                }
                            case .unknown(let kind, _):
                                // Forward-compat: a future user-part
                                // kind without an associated prior
                                // tool_use. Attach a placeholder to the
                                // current assistant turn so the demo
                                // shows that something landed.
                                assistant.parts.append(
                                    .unknown(label: "user content", kind: kind)
                                )
                            case .text:
                                break
                            }
                        }
                        let hasText = parts.contains(where: {
                            if case .text = $0 { return true }
                            return false
                        })
                        if hasText { break fold }
                        i += 1
                    }
                }
                out.append(.assistant(assistant))
            }
        }
        return out
    }

    /// The marker the agent session appends to model-visible history when a
    /// turn dies, so the model knows on its next turn that it failed.
    static let terminalFailureMarker = "Model request failed: "

    /// Lift that marker out of one assistant text part: the body the turn had
    /// produced before it died, plus the failure the marker records. Nil when
    /// the text is an ordinary answer.
    ///
    /// The match is anchored where the session writes the marker — at the very
    /// start of the text, or after the blank line separating it from whatever
    /// the turn produced first. An assistant that merely quotes the phrase
    /// mid-sentence, explaining a log line say, is answering rather than
    /// failing, and its answer must survive the reopen intact.
    static func splitTerminalFailureMarker(_ text: String) -> (body: String, failure: AgentTurnFailure)? {
        guard let markerStart = anchoredMarkerIndex(text) else { return nil }
        let tail = text[markerStart...].dropFirst(terminalFailureMarker.count)
        guard let separator = tail.range(of: ": ") else { return nil }
        let code = tail[..<separator.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        let message = tail[separator.upperBound...]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, !message.isEmpty else { return nil }
        return (
            body: String(text[..<markerStart]).trimmingCharacters(in: .whitespacesAndNewlines),
            // The marker carries the code and the sentence; the provider's
            // disposition reaches only the live stream and the conversation
            // record, both of which hold the whole failure.
            failure: AgentTurnFailure(code: code, message: message, provider: nil)
        )
    }

    private static func anchoredMarkerIndex(_ text: String) -> String.Index? {
        if text.hasPrefix(terminalFailureMarker) { return text.startIndex }
        guard let separated = text.range(
            of: "\n\n\(terminalFailureMarker)",
            options: .backwards
        ) else { return nil }
        return text.index(separated.lowerBound, offsetBy: 2)
    }

    /// The sentence a failed turn shows. The gateway names the condition; a
    /// record that carries no sentence still gets one, since a bubble with an
    /// error style and no words says nothing at all.
    static func failureSentence(_ message: String, truncated: Bool) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return truncated
            ? "The model reached its output limit before completing this response."
            : "The turn failed."
    }

    /// Walk the same canonical history and reconstruct the citations
    /// panel: every (assistant `annotate` tool_use + matching user
    /// `annotate.recorded` tool_result) pair, aggregated by documentId.
    /// Returns Citations in arrival order.
    static func citations(from messages: [ChatMessage]) -> [AgentCitation] {
        var byDoc: [String: Int] = [:]
        var out: [AgentCitation] = []
        var n = 0
        var assistantSlot: String?
        // toolCallId → messageId of the assistant turn it was issued from.
        var pendingAnnotates: [String: String] = [:]
        for m in messages {
            switch m {
            case .unknown:
                // Unknown message role can't carry an annotation pair
                // the client understands; skip.
                continue
            case .user(let parts):
                let hasText = parts.contains(where: {
                    if case .text = $0 { return true }
                    return false
                })
                for p in parts {
                    guard case .toolResult(let id, let result) = p else { continue }
                    guard let messageId = pendingAnnotates[id] else { continue }
                    pendingAnnotates.removeValue(forKey: id)
                    // Fan a batch (`annotate.batch`) out to one citation per
                    // child; a singular `annotate.recorded` yields exactly one.
                    // The per-child id matches the live `agent.citation`
                    // events so a reloaded conversation is identical to live.
                    let recs = annotateRecordedItems(result)
                    for (childIndex, rec) in recs.enumerated() {
                        let childCallId = recs.count > 1 ? "\(id)#\(childIndex)" : id
                        // Same routing as the live event handler: note-only
                        // sets docNote (last-write wins); quote appends an
                        // entry.
                        let isDocNote = rec.quote == nil && rec.note != nil
                        if let idx = byDoc[rec.documentId] {
                            if isDocNote {
                                out[idx].docNote = rec.note
                            } else {
                                out[idx].entries.append(
                                    AgentCitationEntry(
                                        toolCallId: childCallId,
                                        messageId: messageId,
                                        quote: rec.quote,
                                        note: rec.note,
                                        quoteAuthor: rec.quoteAuthor,
                                        quoteIsSelf: rec.quoteIsSelf
                                    )
                                )
                            }
                        } else {
                            byDoc[rec.documentId] = out.count
                            var seed = AgentCitation(
                                documentId: rec.documentId,
                                ref: rec.ref,
                                docNote: nil,
                                entries: []
                            )
                            if isDocNote {
                                seed.docNote = rec.note
                            } else {
                                seed.entries.append(
                                    AgentCitationEntry(
                                        toolCallId: childCallId,
                                        messageId: messageId,
                                        quote: rec.quote,
                                        note: rec.note,
                                        quoteAuthor: rec.quoteAuthor,
                                        quoteIsSelf: rec.quoteIsSelf
                                    )
                                )
                            }
                            out.append(seed)
                        }
                    }
                }
                if hasText {
                    n += 1
                    assistantSlot = nil
                }
            case .assistant(let parts):
                let slot = assistantSlot ?? "a-\(n)"
                assistantSlot = slot
                for p in parts {
                    if case .toolUse(let id, let tool, _) = p, tool == "annotate" || tool == "annotate_many" {
                        pendingAnnotates[id] = slot
                    }
                }
            }
        }
        return out
    }

    /// The merged citation refs carried on any persisted Deep Research
    /// `report_artifact` part (#748), in transcript order, deduped by
    /// documentId. A deep-research run cites via this single merged set, NOT
    /// via `annotate` tool pairs, so `citations(from:)` reconstructs none of
    /// them. This seeds the resumed citation drawer, mirroring the portal
    /// `load-conversation` reducer's `turn.reportCitations` handling.
    static func reportArtifactCitations(from messages: [ChatMessage]) -> [AgentDocRef] {
        var seen = Set<String>()
        var out: [AgentDocRef] = []
        for m in messages {
            guard case .assistant(let parts) = m else { continue }
            for p in parts {
                guard case .reportArtifact(let artifact) = p else { continue }
                for ref in artifact.citations where !seen.contains(ref.documentId) {
                    seen.insert(ref.documentId)
                    out.append(ref)
                }
            }
        }
        return out
    }

    /// Walk a persisted transcript and build the annotation buckets
    /// the Timeline tab projects onto doc rows. Mirrors the portal's
    /// `trailAnnotationsFromMessages`.
    static func trailAnnotations(from messages: [ChatMessage]) -> AgentTrailAnnotations {
        var ann = AgentTrailAnnotations()
        for m in messages {
            guard case .user(let parts) = m else { continue }
            for p in parts {
                guard case .toolResult(_, let result) = p else { continue }
                // One bucket per annotated document — a singular
                // `annotate.recorded` contributes one, an `annotate.batch`
                // (annotate_many) one per child, so the reloaded Timeline
                // matches what the live citations produced.
                for rec in annotateRecordedItems(result) {
                    ann.applyDocAnnotation(
                        documentId: rec.documentId,
                        ref: rec.ref,
                        quote: rec.quote,
                        note: rec.note,
                        quoteAuthor: rec.quoteAuthor,
                        quoteIsSelf: rec.quoteIsSelf
                    )
                }
            }
        }
        return ann
    }

    /// The `annotate.recorded` items in a tool result: one for a singular
    /// annotate, N (in order) for an `annotate.batch` (annotate_many), none
    /// otherwise (a failed child — a `.error` item — yields nothing). Lets the
    /// citations + Timeline reload rebuilders fan a batch out to one entry per
    /// child. Mirrors the portal reducer's `annotateRecordedItems`.
    static func annotateRecordedItems(_ result: AgentToolResult) -> [AgentAnnotateRecord] {
        func record(_ r: AgentToolResult) -> AgentAnnotateRecord? {
            guard case .annotateRecorded(let docId, let ref, let quote, let note, let quoteAuthor, let quoteIsSelf) = r
            else { return nil }
            return AgentAnnotateRecord(
                documentId: docId,
                ref: ref,
                quote: quote,
                note: note,
                quoteAuthor: quoteAuthor,
                quoteIsSelf: quoteIsSelf
            )
        }
        switch result {
        case .annotateRecorded:
            return record(result).map { [$0] } ?? []
        case .annotateBatch(let items):
            return items.compactMap(record)
        default:
            return []
        }
    }

    /// How many citations an `annotate_many` tool_use contributes to a turn's
    /// chip: the length of its `annotations` arg when present (even zero),
    /// else one. Mirrors the portal reducer's `annotate_many` count.
    static func annotateManyChildCount(_ args: JSONAny) -> Int {
        if let dict = args.value as? [String: Any], let anns = dict["annotations"] as? [Any] {
            return anns.count
        }
        return 1
    }

    /// Walk a persisted transcript and pull out every directly-cited
    /// record (#757), deduped by `recordKey` (last write wins) while
    /// preserving arrival order. Used on conversation resume so a
    /// reloaded conversation shows directly-cited records in the
    /// Timeline exactly like it does live.
    static func recordCitations(from messages: [ChatMessage]) -> [AgentTrailRecord] {
        var out: [AgentTrailRecord] = []
        var indexByKey: [String: Int] = [:]
        for m in messages {
            guard case .user(let parts) = m else { continue }
            for p in parts {
                guard case .toolResult(_, let result) = p else { continue }
                guard case .citeRecordRecorded(let record) = result else { continue }
                if let idx = indexByKey[record.recordKey] {
                    out[idx] = record
                } else {
                    indexByKey[record.recordKey] = out.count
                    out.append(record)
                }
            }
        }
        return out
    }

    /// One-line summary for a tool's args — matches the portal's
    /// `summarizeArgs` so chips read the same on every surface.
    static func summarizeArgs(tool: String, args: JSONAny) -> String {
        let dict = args.value as? [String: Any] ?? [:]
        switch tool {
        case "search_documents":
            if let query = dict["query"] as? String {
                var extras: [String] = []
                if let limit = dict["limit"] as? Int { extras.append("limit=\(limit)") }
                return extras.isEmpty ? query : "\(query) (\(extras.joined(separator: ", ")))"
            }
            return ""
        case "fetch_document":
            return String((dict["documentId"] as? String ?? "").prefix(24))
        case "trace_connections":
            let seeds = (dict["seedIds"] as? [Any] ?? []).compactMap { $0 as? String }
            let head = seeds.map { String($0.prefix(8)) }.joined(separator: ",")
            var extras: [String] = []
            if let depth = dict["depth"] as? Int { extras.append("depth=\(depth)") }
            if let fanout = dict["fanoutCap"] as? Int { extras.append("fanout=\(fanout)") }
            return extras.isEmpty ? head : "\(head) \(extras.joined(separator: " "))"
        case "run_sql":
            return String((dict["sql"] as? String ?? "").prefix(80))
        case "lookup_people":
            return (dict["query"] as? String) ?? ""
        case "lookup_document_by_url":
            let url = (dict["url"] as? String) ?? ""
            return url.count > 80 ? String(url.prefix(77)) + "…" : url
        default:
            if agentEphemeralTools.contains(tool) {
                // Loop-agent actions (briefs / loops / temporal notes / notes):
                // surface the most human-readable arg instead of raw JSON —
                // these render in the ephemeral card's header.
                if let title = dict["title"] as? String { return String(title.prefix(80)) }
                if let query = dict["query"] as? String { return String(query.prefix(80)) }
                if let id = dict["id"] as? String { return String(id.prefix(24)) }
                return ""
            }
            return args.jsonString.prefix(120).description
        }
    }

    static func deriveTitle(from text: String) -> String {
        let oneLine = text.replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if oneLine.count > 70 { return String(oneLine.prefix(69)) + "…" }
        return oneLine
    }
}

#if DEBUG
@available(iOS 17.0, *)
extension AgentCoordinator {
    /// Test/preview hook — stamp in a fatal error so the error UI
    /// renders in previews and snapshot tests without spinning up a
    /// broken gateway. Pass real `URLError` / `GatewayClient.Error`
    /// shapes so `GatewayErrorView`'s classifier sees the same
    /// inputs it would in production.
    func installPreviewFatal(error: Error) {
        self.fatalError = error
    }

    /// Test/preview hook — put the surface in the "resumed conversation still
    /// loading" state (target adopted, transcript skeleton showing) without a
    /// live network fetch. Mirrors what `beginResume(to:)` sets so snapshot
    /// tests can render the loading skeleton.
    func installPreviewTranscriptLoading(title: String) {
        self.sessionId = "preview-loading"
        self.title = title
        self.turns = []
        self.transcriptLoading = true
    }

    /// Test/preview hook — overwrite the citations array without
    /// touching the rest of the agent state. Used by snapshot tests
    /// that want a custom citation set on an otherwise-empty session.
    func installPreviewCitations(_ items: [AgentCitation]) {
        self.citations = items
        self.citationsByDocId = Dictionary(
            uniqueKeysWithValues: items.enumerated().map { ($1.documentId, $0) }
        )
    }

    /// Test/preview hook — stamp in the annotation buckets + directly-cited
    /// records so previews and snapshot tests can render the Timeline tab in
    /// the Citations drawer without driving a live SSE stream.
    func installPreviewTimeline(
        annotations: AgentTrailAnnotations = .empty,
        recordCitations: [AgentTrailRecord] = []
    ) {
        self.trailAnnotations = annotations
        self.recordCitations = recordCitations
    }

    /// Test-only entry that drives the event handler directly without
    /// needing a live SSE stream. Mirrors what the SSE loop would do
    /// per incoming `AgentEvent`. Use to exercise the reducer logic
    /// (including the ephemeral gate) from XCTest. Caller is expected
    /// to have set `sessionId` first.
    func applyEventForTesting(_ event: AgentEvent) async {
        await handle(event: event)
    }

    /// Exercise the HTTP snapshot/SSE handoff deterministically: the supplied
    /// stream items are treated as events received while the snapshot request
    /// was in flight.
    func applySnapshotForTesting(
        _ session: CreateSessionResponse,
        buffered: [AgentStreamItem]
    ) async {
        let handoff = beginSnapshotHandoff(targetSessionId: session.sessionId)
        for item in buffered {
            await acceptStreamItem(item)
        }
        guard snapshotHandoffIsCurrent(handoff) else { return }
        await applyCreatedSession(session)
        await finishSnapshotHandoff(handoff, after: session.eventCursor)
    }

    func beginSnapshotHandoffForTesting(targetSessionId: String) -> Int {
        beginSnapshotHandoff(targetSessionId: targetSessionId)
    }

    func bufferSnapshotEventForTesting(_ item: AgentStreamItem) async {
        await acceptStreamItem(item)
    }

    func applySnapshotForTesting(_ session: CreateSessionResponse, generation: Int) async {
        guard snapshotHandoffIsCurrent(generation) else { return }
        await applyCreatedSession(session)
        await finishSnapshotHandoff(generation, after: session.eventCursor)
    }

    func failSnapshotHandoffForTesting(_ generation: Int, targetSessionId: String) async {
        await failSnapshotHandoff(generation, targetSessionId: targetSessionId)
    }

    func snapshotHandoffStateForTesting() -> (
        generation: Int,
        bufferedCount: Int,
        requiresSnapshot: Bool
    )? {
        snapshotHandoff.map { ($0.generation, $0.events.count, $0.requiresSnapshot) }
    }

    static var snapshotHandoffCapacityForTesting: Int {
        snapshotHandoffCapacity
    }

    /// Test/preview hook — stamp the Deep Research run-active marker without a
    /// live `send()` (which needs a client). Lets the working-set selectors
    /// (`researchPanels` / `isResearchWorkspaceActive`) be exercised in
    /// isolation. The live path sets this from `send(deepResearch:)`.
    func setDeepResearchForTesting(_ active: Bool) {
        self.deepResearch = active
    }

    /// Preview/snapshot hook for the system cancel-failure alert. A real
    /// `Error` is retained so the shared gateway classifier exercises the
    /// same copy as production.
    func installPreviewCancelError(_ error: Error) {
        cancelError = error
    }

    /// Test-only: attach a pre-built client (typically backed by a stubbed
    /// `URLSession`) and start the live SSE supervisor, so the real
    /// stream → reduce → resume/reconcile path can be exercised end-to-end
    /// from XCTest without a live gateway.
    func attachForTesting(client: AgentClient, sessionId: String) {
        self.client = client
        self.sessionId = sessionId
        startEventStream()
    }

    /// Test-only: stop the SSE supervisor started by `attachForTesting`.
    func stopForTesting() {
        eventTask?.cancel()
        eventTask = nil
    }

    /// Test/preview hook — stamp in a transcript without touching the
    /// network.
    func installPreviewState(
        // Nil for the landing: a session is minted lazily on the first send, so a conversation
        // nobody has spoken in yet does not have one.
        sessionId: String?,
        model: String,
        backend: String,
        title: String,
        turns: [AgentTurn],
        citations: [AgentCitation],
        conversations: [ConversationSummary],
        busy: Bool = false,
        terminalFailure: AgentConversationTerminalFailure? = nil,
        connected: Bool = false,
        planItems: [AgentPlanItem] = [],
        conversationsNextCursor: String? = nil,
        transcriptNextCursor: String? = nil,
        conversationsError: Error? = nil,
        conversationActionError: Error? = nil
    ) {
        sendOperationGeneration &+= 1
        turnGeneration &+= 1
        cancelOperationGeneration &+= 1
        cancelError = nil
        self.sessionId = sessionId
        self.model = model
        self.backend = backend
        self.title = title
        self.turns = turns
        self.citations = citations
        self.citationsByDocId = Dictionary(
            uniqueKeysWithValues: citations.enumerated().map { ($1.documentId, $0) }
        )
        self.conversations = conversations
        self.conversationsNextCursor = conversationsNextCursor
        self.conversationsPagingTruncated = false
        self.conversationsLoading = false
        self.conversationsLoadingMore = false
        self.conversationsError = conversationsError
        self.conversationActionError = conversationActionError
        self.conversationActionErrorSessionId = conversationActionError == nil ? nil : sessionId
        self.activeConversationPinned = conversations
            .first(where: { $0.sessionId == sessionId })?.pinned ?? false
        self.conversationActionsInFlight = []
        self.conversationsPagingError = nil
        self.conversationListGeneration &+= 1
        self.transcriptPaging.reset(nextCursor: transcriptNextCursor)
        self.busy = busy
        if busy { turnGeneration &+= 1 }
        self.terminalFailure = terminalFailure
        if connected {
            self.client = AgentClient(
                baseURL: URL(string: "https://preview.example")!,
                token: "preview-token"
            )
        }
        self.planItems = planItems
    }
}
#endif
#endif
