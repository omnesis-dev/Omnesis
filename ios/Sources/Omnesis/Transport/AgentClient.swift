// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// HTTP + SSE client for the gateway's agent harness. Mirrors the
/// portal's `agent-client.js` so the same conversations show up in
/// both places.
///
/// The HTTP surface (create/send/cancel + conversations CRUD) is
/// regular async/await against `URLSession`. The event stream is a
/// long-lived Server-Sent Events connection consumed via
/// `URLSession.bytes(for:)`. We surface it as an
/// `AsyncThrowingStream<AgentEvent, Error>` so callers can iterate
/// with `for try await` and cancel by tearing down the iterator.
///
/// One client instance per session is wasteful — share a single
/// `AgentClient` across the app (the `AgentCoordinator` does) and
/// open exactly one event stream against it.
public final class AgentClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// `URLSession.bytes` requires the concrete type, not our
    /// `URLSessionLike` protocol. Tests that don't need the stream API
    /// can instantiate `AgentClient(baseURL:token:)` and just call the
    /// HTTP methods through the inherited `dispatch` helper.
    public init(baseURL: URL, token: String, session: URLSession = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    // MARK: - Sessions

    /// POST `/agent/sessions` — starts a new session, or resumes a
    /// stored one when `resumeFromId` is set. The gateway returns the
    /// saved transcript (`messages`) for resume cases; for fresh
    /// sessions `messages` is empty.
    ///
    /// `profile` selects the gateway-side answer style: `"voice"` asks
    /// for concise spoken-friendly replies (the Siri ask path); nil
    /// omits the key and the gateway defaults to the interactive
    /// profile, so ordinary sessions' payloads are unchanged.
    ///
    /// The device's own time zone rides along so the agent speaks in the
    /// clock the phone is showing: the gateway sits on a machine at home
    /// while the phone travels, and a wall-clock time rendered in the
    /// gateway's zone is the wrong hour anywhere else.
    public func createSession(
        profile: String? = nil,
        resumeFromId: String? = nil,
        transcriptLimit: Int? = nil
    ) async throws
        -> CreateSessionResponse {
        let body = try Self.createSessionBody(
            profile: profile,
            resumeFromId: resumeFromId,
            timeZone: TimeZone.current.identifier,
            encoder: encoder
        )
        let (data, _) = try await dispatch(
            method: "POST",
            path: Self.createSessionPath(transcriptLimit: transcriptLimit),
            body: body
        )
        return try decodeOrThrow(CreateSessionResponse.self, from: data)
    }

    /// Build the `/agent/sessions` request path. Factored out (and
    /// `internal`) alongside `createSessionBody` so the transcript cap —
    /// the difference between a resume that returns one message and one
    /// that returns the whole thread — is unit-testable without a live
    /// socket. A nil limit omits the query entirely.
    static func createSessionPath(transcriptLimit: Int?) -> String {
        guard let transcriptLimit else { return "/agent/sessions" }
        var components = URLComponents()
        components.path = "/agent/sessions"
        components.queryItems = [
            URLQueryItem(name: "transcriptLimit", value: String(transcriptLimit)),
        ]
        return components.string ?? "/agent/sessions"
    }

    /// Build the `/agent/sessions` POST body. Factored out (and
    /// `internal`) so the optional keys are unit-testable without a live
    /// socket, mirroring `sendMessageBody`: JSONEncoder drops nil
    /// optionals, so a nil `profile` / `resumeFromId` omits its key
    /// entirely and both-nil encodes as `{}` — keeping the default
    /// session's payload byte-identical to a build that predates either
    /// knob.
    static func createSessionBody(
        profile: String?,
        resumeFromId: String?,
        timeZone: String?,
        encoder: JSONEncoder
    ) throws
        -> Data {
        struct Body: Encodable {
            let profile: String?
            let resumeFromId: String?
            let timeZone: String?
        }
        return try encoder.encode(Body(profile: profile, resumeFromId: resumeFromId, timeZone: timeZone))
    }

    /// POST `/agent/sessions/:id/messages` — queue a user message. The
    /// gateway returns the assistant `messageId` synchronously; the
    /// streaming text arrives over `/agent/events`.
    ///
    /// `deepResearch` is the per-message Deep Research flag, armed by the
    /// composer's `/`→pill. It governs only this send (the pill clears
    /// afterward); a normal send leaves it `false` and the gateway runs an
    /// ordinary turn. The flag is omitted from the body when `false` so a
    /// plain turn's payload is byte-identical to before.
    ///
    /// `notifyAfterMs` arms the gateway's answer push: if the turn is
    /// still running after that many milliseconds, the finished assistant
    /// text is delivered as an `agent-answer` push notification when the
    /// turn completes (a turn that finishes sooner sends no push). Nil
    /// omits the key — an ordinary send never pushes.
    ///
    /// `viewingForMs` tells the gateway that a non-transcript surface is
    /// actively presenting this turn for a bounded interval. The Apple Watch
    /// relay uses it so an answer rendered on the wrist is seen on arrival,
    /// without relying on a later read mark that could race turn persistence.
    /// Nil omits the key for every ordinary app send.
    @discardableResult
    public func sendMessage(
        sessionId: String,
        text: String,
        deepResearch: Bool = false,
        notifyAfterMs: Int? = nil,
        viewingForMs: Int? = nil
    ) async throws
        -> SendMessageResponse {
        let body = try Self.sendMessageBody(
            text: text,
            deepResearch: deepResearch,
            notifyAfterMs: notifyAfterMs,
            viewingForMs: viewingForMs,
            encoder: encoder
        )
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/agent/sessions/\(percentEncode(sessionId))/messages",
            body: body
        )
        return try decodeOrThrow(SendMessageResponse.self, from: data)
    }

    /// Build the `/messages` POST body. Factored out (and `internal`) so the
    /// optional flags are unit-testable without a live socket: a `false`
    /// `deepResearch`, a nil `notifyAfterMs`, and a nil `viewingForMs` omit
    /// their keys entirely,
    /// keeping the default turn's payload byte-identical to a build that
    /// predates either flag.
    static func sendMessageBody(
        text: String,
        deepResearch: Bool,
        notifyAfterMs: Int? = nil,
        viewingForMs: Int? = nil,
        encoder: JSONEncoder
    ) throws
        -> Data {
        struct Body: Encodable {
            let text: String
            let deepResearch: Bool?
            let notifyAfterMs: Int?
            let viewingForMs: Int?
        }
        return try encoder.encode(
            Body(
                text: text,
                deepResearch: deepResearch ? true : nil,
                notifyAfterMs: notifyAfterMs,
                viewingForMs: viewingForMs
            )
        )
    }

    /// POST `/agent/sessions/:id/cancel` — abort the in-flight turn.
    public func cancel(sessionId: String) async throws {
        _ = try await dispatch(
            method: "POST",
            path: "/agent/sessions/\(percentEncode(sessionId))/cancel",
            body: "{}".data(using: .utf8)
        )
    }

    // MARK: - Conversations

    /// GET `/agent/conversations` — caller-scoped page of saved
    /// transcripts, newest first.
    public func listConversationPage(
        limit: Int = 50,
        cursor: String? = nil
    ) async throws
        -> ConversationListPage {
        var components = URLComponents()
        components.path = "/agent/conversations"
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor, !cursor.isEmpty {
            query.append(URLQueryItem(name: "cursor", value: cursor))
        }
        components.queryItems = query
        let path = components.string ?? "/agent/conversations"
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(ConversationListPage.self, from: data)
    }

    /// Compatibility wrapper for callers that only need the first page.
    public func listConversations() async throws -> [ConversationSummary] {
        try await listConversationPage().conversations
    }

    /// GET `/agent/conversations/:id` — load a full transcript.
    public func loadConversation(id: String) async throws -> ConversationRecord {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/agent/conversations/\(percentEncode(id))",
            body: nil
        )
        return try decodeOrThrow(ConversationRecord.self, from: data)
    }

    /// GET `/agent/conversations/:id/messages` — one older, user-visible
    /// transcript page. Pages are cut at complete turn boundaries by the
    /// gateway, so tool results never detach from their assistant turn.
    public func loadConversationMessages(
        id: String,
        limit: Int = 25,
        cursor: String? = nil
    ) async throws
        -> ConversationMessagePage {
        var components = URLComponents()
        components.percentEncodedPath = "/agent/conversations/\(percentEncode(id))/messages"
        components.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "cursor", value: cursor),
        ].filter { $0.value != nil }
        let (data, _) = try await dispatch(
            method: "GET",
            path: components.string
                ?? "/agent/conversations/\(percentEncode(id))/messages?limit=\(limit)",
            body: nil
        )
        return try decodeOrThrow(ConversationMessagePage.self, from: data)
    }

    /// DELETE `/agent/conversations/:id` — drop a stored transcript.
    public func deleteConversation(id: String) async throws {
        _ = try await dispatch(
            method: "DELETE",
            path: "/agent/conversations/\(percentEncode(id))",
            body: nil
        )
    }

    /// PATCH `/agent/conversations/:id` — pin or unpin a stored transcript.
    public func setPinned(id: String, pinned: Bool) async throws {
        let body = try JSONEncoder().encode(["pinned": pinned])
        _ = try await dispatch(
            method: "PATCH",
            path: "/agent/conversations/\(percentEncode(id))",
            body: body
        )
    }

    /// POST `/agent/conversations/:id/seen` — report that this app is showing
    /// the conversation to the user, which clears its unread marker on every
    /// surface. Distinct from fetching it: a background sync is not a read, so
    /// only a screen that actually rendered it may say this.
    ///
    /// `viewing` says whether it is still on screen. True holds it open, so an
    /// answer arriving now counts as seen; false says the user moved on.
    public func markConversationSeen(id: String, viewing: Bool) async throws {
        let body = try JSONEncoder().encode(["viewing": viewing])
        _ = try await dispatch(
            method: "POST",
            path: "/agent/conversations/\(percentEncode(id))/seen",
            body: body
        )
    }

    // MARK: - Event stream (SSE)

    /// Hard ceiling on stream silence before we treat the SSE connection
    /// as dead. The gateway emits a `: hb` heartbeat every ~25s, so 60s
    /// (more than two missed heartbeats) reliably distinguishes a quiet
    /// stream from a half-open socket — a suspended app, a NAT rebind, or
    /// a Wi-Fi↔cellular handoff that left the TCP connection a zombie.
    static let streamIdleTimeout: TimeInterval = 60
    /// How often the idle watchdog wakes to check liveness.
    private static let watchdogCheckInterval: TimeInterval = 10

    /// Open a long-lived SSE connection against `/agent/events`. Yields
    /// every `agent.*` event the gateway broadcasts to this caller —
    /// filter by `sessionId` client-side. Each item carries the SSE `id:`
    /// so the supervisor can resume past it on reconnect.
    ///
    /// `lastEventId`, when set, is sent as the `Last-Event-ID` request
    /// header. The gateway replays every event it buffered past that id
    /// before attaching the live feed, so a brief disconnect mid-turn
    /// loses nothing. If the gap predates the gateway's buffer it sends a
    /// single `agent.resync` event instead, and the caller reconciles from
    /// the persisted transcript.
    ///
    /// The stream terminates when the caller drops the iterator (which
    /// cancels the underlying URL task), when the gateway closes the
    /// connection, or when the idle watchdog fires on a silent socket.
    /// Reconnection is the caller's responsibility — the
    /// `AgentCoordinator` wraps this in an auto-reconnect supervisor.
    ///
    /// We iterate raw bytes (rather than `bytes.lines`) and parse the
    /// SSE frame state machine ourselves. `URLSession.AsyncBytes.lines`
    /// has been observed buffering chunked-encoded responses on iOS so
    /// streamed events only arrive when the connection closes —
    /// reading bytes directly bypasses that.
    public func events(lastEventId: String? = nil) -> AsyncThrowingStream<AgentStreamItem, Error> {
        AsyncThrowingStream { continuation in
            let activity = ActivityClock()
            let streamTask = Task { [self] in
                do {
                    guard let url = URL(string: "/agent/events", relativeTo: baseURL)?.absoluteURL
                    else {
                        throw GatewayClient.Error.invalidURL
                    }
                    var request = URLRequest(url: url)
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                    // Disable gzip so the server doesn't batch chunks
                    // waiting for a compression block boundary.
                    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
                    if let lastEventId, !lastEventId.isEmpty {
                        request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
                    }
                    // SSE connections are intentionally long-lived. The
                    // gateway emits a `: hb` heartbeat every ~25s so the
                    // connection doesn't go idle; we keep our own
                    // timeout generous on top of that.
                    request.timeoutInterval = 600
                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse, http.statusCode == 401 {
                        throw GatewayClient.Error.unauthorized
                    }
                    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                        throw GatewayClient.Error
                            .serverError(status: http.statusCode, body: "")
                    }
                    // Drive the byte stream through `SSEFrameParser` and
                    // dispatch each completed frame as one event. Every byte
                    // (including heartbeat comments) resets the idle clock.
                    var parser = SSEFrameParser()
                    for try await byte in bytes {
                        if Task.isCancelled { break }
                        activity.touch()
                        if let frame = parser.consume(byte: byte) {
                            if let raw = frame.data.data(using: .utf8),
                               let event = decodeEvent(raw) {
                                continuation.yield(AgentStreamItem(id: frame.id, event: event))
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // Idle watchdog: a stream that goes silent past `streamIdleTimeout`
            // is a half-open socket the OS won't fail until the 600s request
            // timeout. Cancel the byte loop so it throws and the supervisor
            // reconnects promptly (resuming via Last-Event-ID).
            let watchdog = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(
                        nanoseconds: UInt64(Self.watchdogCheckInterval * 1_000_000_000)
                    )
                    if Task.isCancelled { return }
                    if activity.secondsSinceLast() > Self.streamIdleTimeout {
                        streamTask.cancel()
                        return
                    }
                }
            }
            continuation.onTermination = { _ in
                streamTask.cancel()
                watchdog.cancel()
            }
        }
    }

    // MARK: - Internals

    private func dispatch(
        method: String,
        path: String,
        body: Data?
    ) async throws
        -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        switch http.statusCode {
        case 200 ... 299:
            return (data, http)
        case 401: throw GatewayClient.Error.unauthorized
        case 403: throw GatewayClient.Error.forbidden
        case 404: throw GatewayClient.Error.notFound
        default:
            let text = String(data: data, encoding: .utf8) ?? ""
            throw GatewayClient.Error.serverError(status: http.statusCode, body: text)
        }
    }

    private func decodeOrThrow<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try decoder.decode(type, from: data) } catch {
            throw GatewayClient.Error.decoding("\(error)")
        }
    }

    /// Internal so the unit tests can drive a captured frame through
    /// the same decoder the SSE loop uses. Returns nil on malformed
    /// JSON or when a known event's required payload fields are
    /// missing; an unknown `type` decodes successfully into
    /// `.unknown(type:)` and the caller's reducer ignores it.
    func decodeEvent(_ raw: Data) -> AgentEvent? {
        do { return try decoder.decode(AgentEvent.self, from: raw) } catch {
            return nil
        }
    }

    private func percentEncode(_ string: String) -> String {
        string.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? string
    }
}

// MARK: - Wire types

public struct AgentContextAssessment: Decodable, Sendable, Equatable {
    public let inputTokens: Int?
    public let peakInputTokens: Int?
    public let maxInputTokens: Int?
    public let contextWindowTokens: Int?
    public let reservedOutputTokens: Int?
    public let safetyMarginTokens: Int?
    public let measurement: String
    public let limitSource: String
    public let requestIteration: Int

    public init(
        inputTokens: Int? = nil,
        peakInputTokens: Int? = nil,
        maxInputTokens: Int? = nil,
        contextWindowTokens: Int? = nil,
        reservedOutputTokens: Int? = nil,
        safetyMarginTokens: Int? = nil,
        measurement: String,
        limitSource: String,
        requestIteration: Int
    ) {
        self.inputTokens = inputTokens
        self.peakInputTokens = peakInputTokens
        self.maxInputTokens = maxInputTokens
        self.contextWindowTokens = contextWindowTokens
        self.reservedOutputTokens = reservedOutputTokens
        self.safetyMarginTokens = safetyMarginTokens
        self.measurement = measurement
        self.limitSource = limitSource
        self.requestIteration = requestIteration
    }
}

/// What the model provider itself reported about a rejected request, reduced
/// to the envelope fields that describe the request's disposition.
///
/// The upstream response body is deliberately absent: a misconfigured or
/// hostile model server can echo the submitted prompt — which carries the
/// user's corpus — inside its own error text. The gateway sanitizes every
/// field it forwards here down to identifier shape, so this structure is safe
/// to render verbatim.
public struct AgentProviderFailureDetail: Codable, Sendable, Equatable, Hashable {
    /// Upstream HTTP status, e.g. 404.
    public let status: Int?
    /// Provider error family, e.g. `invalid_request_error`.
    public let type: String?
    /// Provider error code, e.g. `NOT_FOUND`.
    public let code: String?
    /// Request field the provider blamed, e.g. `model`.
    public let param: String?
    /// Provider-side correlation id, for a support ticket upstream.
    public let requestId: String?

    public init(
        status: Int? = nil,
        type: String? = nil,
        code: String? = nil,
        param: String? = nil,
        requestId: String? = nil
    ) {
        self.status = status
        self.type = type
        self.code = code
        self.param = param
        self.requestId = requestId
    }

    /// The disposition as one operator-facing line, e.g.
    /// `HTTP 404 · NOT_FOUND · param=model`. Nil when the provider reported
    /// nothing at all, so a caller renders no empty chrome.
    ///
    /// The field order and separator match what the gateway composes for the
    /// privacy exchange's `failure.detail`, so the same failure reads
    /// identically whichever surface shows it.
    public var formatted: String? {
        AgentProviderFailureDetail.format(self)
    }

    static func format(_ detail: AgentProviderFailureDetail?) -> String? {
        guard let detail else { return nil }
        var parts: [String] = []
        if let status = detail.status { parts.append("HTTP \(status)") }
        if let code = detail.code, !code.isEmpty {
            parts.append(code)
        } else if let type = detail.type, !type.isEmpty {
            parts.append(type)
        }
        if let param = detail.param, !param.isEmpty { parts.append("param=\(param)") }
        if let requestId = detail.requestId, !requestId.isEmpty { parts.append("request \(requestId)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

public struct AgentTerminalFailure: Decodable, Sendable, Equatable {
    public let code: String
    public let message: String
    public let retryable: Bool
    public let backend: String
    public let model: String
    /// What the model provider reported, when this failure came from one.
    /// Absent on gateways that predate the field and on failures with no
    /// upstream envelope (a cancelled turn, a local budget stop).
    public let provider: AgentProviderFailureDetail?

    public init(
        code: String,
        message: String,
        retryable: Bool,
        backend: String,
        model: String,
        provider: AgentProviderFailureDetail? = nil
    ) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.backend = backend
        self.model = model
        self.provider = provider
    }
}

public struct AgentConversationTerminalFailure: Decodable, Sendable, Equatable {
    public let code: String
    public let message: String
    public let retryable: Bool
    public let backend: String
    public let model: String
    public let failedAt: String
    public let context: AgentContextAssessment?
    /// What the model provider reported, when this failure came from one.
    public let provider: AgentProviderFailureDetail?

    public init(
        code: String,
        message: String,
        retryable: Bool,
        backend: String,
        model: String,
        failedAt: String,
        context: AgentContextAssessment? = nil,
        provider: AgentProviderFailureDetail? = nil
    ) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.backend = backend
        self.model = model
        self.failedAt = failedAt
        self.context = context
        self.provider = provider
    }
}

public struct CreateSessionResponse: Decodable, Sendable, Equatable {
    public let sessionId: String
    /// Persisted conversation id for this session — the id the
    /// conversation list and `resumeFromId` use, and the id an
    /// `agent-answer` push carries. Optional so gateways that don't emit
    /// it still decode; callers fall back to `sessionId` (the two are
    /// the same identifier on gateways that emit both).
    public let conversationId: String?
    public let model: String
    public let backend: String
    /// Only present from gateways that ship persistence; defaulted for older
    /// builds so the iOS client doesn't crash mid-rollout.
    public let title: String
    public let messageCount: Int
    /// True when a turn is genuinely in flight for this session right now.
    /// Only a live (in-memory) session can be busy; a disk-resumed or freshly
    /// created session is always idle. Defaulted so a gateway that omits the
    /// field is treated as idle. The coordinator uses this on foreground
    /// reconcile to avoid clobbering a still-running turn.
    public let busy: Bool
    public let messages: [ChatMessage]
    /// Cursor for older user-visible messages when the caller opted into a
    /// bounded transcript on session creation. Nil on legacy/full responses.
    public let messagePageInfo: PageInfo?
    /// True when the gateway already removed an anchored thread's folded seed
    /// prefix. Older gateways omit it and the coordinator applies its legacy
    /// `visibleMessages` projection locally.
    public let messagesAreVisible: Bool
    /// Durable conversation-level context exhaustion. When present, the
    /// transcript remains readable but the conversation cannot accept sends.
    public let terminalFailure: AgentConversationTerminalFailure?
    /// Durable marker for a partial latest answer; does not freeze the conversation.
    public let lastTurnFailure: AgentTerminalFailure?
    /// Present when the resumed conversation is anchored to something —
    /// today, a brief talk-back thread or watch firing. Nil for plain conversations,
    /// fresh sessions, and gateways predating origins.
    public let origin: ConversationOrigin?
    /// Active-turn events not reconstructible from persisted ChatMessages
    /// (for example plan, usage, tool-child, and sub-agent lifecycle state).
    /// Older gateways simply omit it.
    public let replayEvents: [AgentEvent]
    /// Last SSE sequence represented by `messages` + `replayEvents`.
    public let eventCursor: Int?

    public init(
        sessionId: String,
        conversationId: String? = nil,
        model: String,
        backend: String,
        title: String = "",
        messageCount: Int = 0,
        busy: Bool = false,
        messages: [ChatMessage] = [],
        messagePageInfo: PageInfo? = nil,
        messagesAreVisible: Bool = false,
        terminalFailure: AgentConversationTerminalFailure? = nil,
        lastTurnFailure: AgentTerminalFailure? = nil,
        origin: ConversationOrigin? = nil,
        replayEvents: [AgentEvent] = [],
        eventCursor: Int? = nil
    ) {
        self.sessionId = sessionId
        self.conversationId = conversationId
        self.model = model
        self.backend = backend
        self.title = title
        self.messageCount = messageCount
        self.busy = busy
        self.messages = messages
        self.messagePageInfo = messagePageInfo
        self.messagesAreVisible = messagesAreVisible
        self.terminalFailure = terminalFailure
        self.lastTurnFailure = lastTurnFailure
        self.origin = origin
        self.replayEvents = replayEvents
        self.eventCursor = eventCursor
    }

    enum CodingKeys: String, CodingKey {
        case sessionId, conversationId, model, backend, title, messageCount, busy, messages
        case messagePageInfo, messagesAreVisible, terminalFailure, lastTurnFailure, origin, replayEvents
        case eventCursor
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
        model = try container.decode(String.self, forKey: .model)
        backend = try container.decode(String.self, forKey: .backend)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        messageCount = try container.decodeIfPresent(Int.self, forKey: .messageCount) ?? 0
        busy = try container.decodeIfPresent(Bool.self, forKey: .busy) ?? false
        messages = try container.decodeIfPresent([ChatMessage].self, forKey: .messages) ?? []
        messagePageInfo = try container.decodeIfPresent(PageInfo.self, forKey: .messagePageInfo)
        messagesAreVisible = try container.decodeIfPresent(Bool.self, forKey: .messagesAreVisible)
            ?? false
        terminalFailure = try container.decodeIfPresent(
            AgentConversationTerminalFailure.self,
            forKey: .terminalFailure
        )
        lastTurnFailure = try container.decodeIfPresent(
            AgentTerminalFailure.self,
            forKey: .lastTurnFailure
        )
        // A malformed origin must never sink the whole session decode —
        // the thread still works as a plain conversation without it.
        origin = try? container.decodeIfPresent(ConversationOrigin.self, forKey: .origin)
        replayEvents = (try? container.decodeIfPresent([AgentEvent].self, forKey: .replayEvents)) ?? []
        eventCursor = try? container.decodeIfPresent(Int.self, forKey: .eventCursor)
    }
}

/// Origin anchor for a conversation that did not start as a blank chat —
/// a brief's talk-back thread (`kind == "brief"`) or a thread the agent
/// opened itself when one of the operator's watches fired
/// (`kind == "watch_firing"`). Carries the anchor's id, the creating run, a
/// content snapshot for the pinned context card, and how many leading
/// messages are the folded run transcript (hidden by the UI, visible to the
/// agent). The per-kind ids are optional in the decode so an unknown future
/// kind degrades to a plain conversation instead of failing the session
/// decode.
public struct ConversationOrigin: Decodable, Sendable, Equatable {
    public let kind: String
    /// The anchoring brief, when `kind == "brief"`.
    public let briefId: String?
    /// The firing that opened the thread, when `kind == "watch_firing"`.
    public let firingId: String?
    /// The watch that fired — the thread's durable subject.
    public let watchId: String?
    public let runId: String
    /// Brief content at thread creation — survives the brief's expiry.
    public let brief: BriefOriginSnapshot?
    /// Watch + firing content at thread creation — survives the watch's
    /// later renaming, editing or deletion.
    public let watch: WatchFiringOriginSnapshot?
    /// Leading messages that are the folded run transcript.
    public let seedMessageCount: Int?

    public init(
        kind: String,
        briefId: String? = nil,
        firingId: String? = nil,
        watchId: String? = nil,
        runId: String,
        brief: BriefOriginSnapshot? = nil,
        watch: WatchFiringOriginSnapshot? = nil,
        seedMessageCount: Int? = nil
    ) {
        self.kind = kind
        self.briefId = briefId
        self.firingId = firingId
        self.watchId = watchId
        self.runId = runId
        self.brief = brief
        self.watch = watch
        self.seedMessageCount = seedMessageCount
    }

    private enum CodingKeys: String, CodingKey {
        case kind, briefId, firingId, watchId, runId
        case brief, watch, seedMessageCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        briefId = try container.decodeIfPresent(String.self, forKey: .briefId)
        firingId = try container.decodeIfPresent(String.self, forKey: .firingId)
        watchId = try container.decodeIfPresent(String.self, forKey: .watchId)
        runId = try container.decode(String.self, forKey: .runId)
        brief = try container.decodeIfPresent(BriefOriginSnapshot.self, forKey: .brief)
        watch = try container.decodeIfPresent(WatchFiringOriginSnapshot.self, forKey: .watch)
        seedMessageCount = try container.decodeIfPresent(Int.self, forKey: .seedMessageCount)
    }
}

/// The brief fields needed to draw its card inside the thread.
public struct BriefOriginSnapshot: Decodable, Sendable, Equatable {
    public let title: String
    public let description: String
    public let body: String?

    public init(title: String, description: String, body: String? = nil) {
        self.title = title
        self.description = description
        self.body = body
    }
}

/// The watch + firing fields needed to draw the card inside a thread the
/// agent opened on its own. A snapshot, not a live read: the thread stays
/// readable after the watch is renamed, edited or deleted.
public struct WatchFiringOriginSnapshot: Decodable, Sendable, Equatable {
    /// The watch's operator-facing name.
    public let name: String
    /// What the watch was watching for, in the operator's own words.
    public let condition: String
    /// When the firing happened (epoch milliseconds).
    public let firedAt: Int64

    public init(name: String, condition: String, firedAt: Int64) {
        self.name = name
        self.condition = condition
        self.firedAt = firedAt
    }
}

public struct SendMessageResponse: Decodable, Sendable, Equatable {
    public let messageId: String
    /// Stable id for the user message itself — distinct from `messageId`
    /// (which is the assistant turn's id). Used to dedupe the originator's
    /// own optimistic bubble against the `agent.user.message` event that
    /// fans out to every device watching the conversation. Optional so
    /// older gateways still deserialise — newer gateways always populate it.
    public let userMessageId: String?
}

public struct ConversationSummary: Decodable, Sendable, Equatable, Identifiable {
    public var id: String {
        sessionId
    }

    public let sessionId: String
    public let title: String
    public let model: String
    public let backend: String
    public let createdAt: String
    public let updatedAt: String
    public let messageCount: Int
    /// Whether the user pinned this conversation to the top of the list.
    /// Optional-with-default on the wire so an older gateway that omits
    /// the field still decodes (mirrors `userMessageId`).
    public let pinned: Bool
    /// Whether the agent has written something here the user has not seen.
    /// Optional-with-default like `pinned`, so a gateway that predates read
    /// state decodes as read rather than failing the whole list.
    public let unread: Bool

    enum CodingKeys: String, CodingKey {
        case sessionId = "id"
        case title, model, backend, createdAt, updatedAt, messageCount, pinned, unread
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        title = try container.decode(String.self, forKey: .title)
        model = try container.decode(String.self, forKey: .model)
        backend = try container.decode(String.self, forKey: .backend)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
        messageCount = try container.decode(Int.self, forKey: .messageCount)
        pinned = try container.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        unread = try container.decodeIfPresent(Bool.self, forKey: .unread) ?? false
    }

    public init(
        sessionId: String,
        title: String = "",
        model: String,
        backend: String,
        createdAt: String,
        updatedAt: String,
        messageCount: Int,
        pinned: Bool = false,
        unread: Bool = false
    ) {
        self.sessionId = sessionId
        self.title = title
        self.model = model
        self.backend = backend
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messageCount = messageCount
        self.pinned = pinned
        self.unread = unread
    }

    /// Returns a copy with `pinned` flipped — used for optimistic UI
    /// updates before the canonical list refetch lands.
    public func withPinned(_ pinned: Bool) -> ConversationSummary {
        ConversationSummary(
            sessionId: sessionId,
            title: title,
            model: model,
            backend: backend,
            createdAt: createdAt,
            updatedAt: updatedAt,
            messageCount: messageCount,
            pinned: pinned,
            unread: unread
        )
    }

    /// Returns a copy marked read — used the moment this app puts the
    /// conversation on screen, so the dot goes without waiting for the
    /// canonical list refetch.
    public func markedRead() -> ConversationSummary {
        ConversationSummary(
            sessionId: sessionId,
            title: title,
            model: model,
            backend: backend,
            createdAt: createdAt,
            updatedAt: updatedAt,
            messageCount: messageCount,
            pinned: pinned,
            unread: false
        )
    }
}

public struct ConversationListPage: Decodable, Sendable, Equatable {
    public let conversations: [ConversationSummary]
    public let nextCursor: String?
}

public struct ConversationRecord: Decodable, Sendable, Equatable {
    public let id: String
    public let callerId: String
    public let model: String
    public let backend: String
    public let createdAt: String
    public let updatedAt: String
    public let title: String
    public let messages: [ChatMessage]
    public let terminalFailure: AgentConversationTerminalFailure?
    public let lastTurnFailure: AgentTerminalFailure?
}

public struct ConversationMessagePage: Decodable, Sendable, Equatable {
    public let messages: [ChatMessage]
    public let messagePageInfo: PageInfo
    public let messageCount: Int
    public let messagesAreVisible: Bool

    public init(
        messages: [ChatMessage],
        messagePageInfo: PageInfo? = nil,
        messageCount: Int = 0,
        messagesAreVisible: Bool = true
    ) {
        self.messages = messages
        self.messagePageInfo = messagePageInfo ?? .exhausted(limit: messages.count)
        self.messageCount = messageCount
        self.messagesAreVisible = messagesAreVisible
    }

    private enum CodingKeys: String, CodingKey {
        case messages, messagePageInfo, messageCount, messagesAreVisible
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messages = try container.decodeIfPresent([ChatMessage].self, forKey: .messages) ?? []
        messagePageInfo = try container.decodeIfPresent(PageInfo.self, forKey: .messagePageInfo)
            ?? .exhausted(limit: messages.count)
        messageCount = try container.decodeIfPresent(Int.self, forKey: .messageCount) ?? messages.count
        messagesAreVisible = try container.decodeIfPresent(Bool.self, forKey: .messagesAreVisible)
            ?? false
    }
}

// MARK: - Chat message tree (canonical history shape)

/// One canonical message — user or assistant. Mirrors the gateway's
/// `ChatMessage` union shape; encoded as a tagged-by-role JSON.
///
/// Forward-compat: an unrecognised `role` decodes into `.unknown`
/// rather than throwing, so an older build can still load a
/// transcript that contains future message kinds. The original JSON
/// is preserved verbatim on the case so encoding round-trips losslessly
/// (and so the demo build can surface a "[unknown content]" placeholder
/// inline in the transcript).
public enum ChatMessage: Codable, Sendable, Equatable, Hashable {
    case user(parts: [UserPart])
    case assistant(parts: [AssistantPart])
    case unknown(role: String, raw: JSONAny)

    public var role: String {
        switch self {
        case .user: "user"
        case .assistant: "assistant"
        case .unknown(let r, _): r
        }
    }

    enum CodingKeys: String, CodingKey { case role, parts }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let role = try container.decode(String.self, forKey: .role)
        switch role {
        case "user":
            self = try .user(parts: container.decode([UserPart].self, forKey: .parts))
        case "assistant":
            self = try .assistant(parts: container.decode([AssistantPart].self, forKey: .parts))
        default:
            let single = try decoder.singleValueContainer()
            let raw = (try? single.decode(JSONAny.self)) ?? JSONAny.null
            self = .unknown(role: role, raw: raw)
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .user(let parts):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("user", forKey: .role)
            try container.encode(parts, forKey: .parts)
        case .assistant(let parts):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("assistant", forKey: .role)
            try container.encode(parts, forKey: .parts)
        case .unknown(_, let raw):
            var single = encoder.singleValueContainer()
            try single.encode(raw)
        }
    }
}

public enum UserPart: Codable, Sendable, Equatable, Hashable {
    case text(String)
    case toolResult(toolCallId: String, result: AgentToolResult)
    /// Forward-compat: any `kind` we don't recognise lands here so a
    /// transcript with a future user-part type still loads. `raw`
    /// preserves the original JSON so encoding round-trips and the
    /// demo build can render an inline placeholder.
    case unknown(kind: String, raw: JSONAny)

    enum CodingKeys: String, CodingKey { case kind, text, toolCallId, result }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "text":
            self = try .text(container.decode(String.self, forKey: .text))
        case "tool_result":
            self = try .toolResult(
                toolCallId: container.decode(String.self, forKey: .toolCallId),
                result: container.decode(AgentToolResult.self, forKey: .result)
            )
        default:
            let single = try decoder.singleValueContainer()
            let raw = (try? single.decode(JSONAny.self)) ?? JSONAny.null
            self = .unknown(kind: kind, raw: raw)
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .text(let text):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("text", forKey: .kind)
            try container.encode(text, forKey: .text)
        case .toolResult(let id, let r):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("tool_result", forKey: .kind)
            try container.encode(id, forKey: .toolCallId)
            try container.encode(r, forKey: .result)
        case .unknown(_, let raw):
            var single = encoder.singleValueContainer()
            try single.encode(raw)
        }
    }
}

public enum AssistantPart: Codable, Sendable, Equatable, Hashable {
    case text(String)
    case thinking(String)
    case toolUse(toolCallId: String, tool: String, args: JSONAny)
    /// Persisted Deep Research summary metadata written beside report prose.
    /// It carries merged citations used to reconstruct the source set after a
    /// reload. Backends omit it from model history; clients retain it only for
    /// compatibility and citation seeding now that the completion card is gone.
    case reportArtifact(AgentReportArtifactPart)
    /// Forward-compat: any `kind` we don't recognise lands here so a
    /// transcript with a future assistant-part type still loads. `raw`
    /// preserves the original JSON so encoding round-trips and the
    /// demo build can render an inline placeholder.
    case unknown(kind: String, raw: JSONAny)

    enum CodingKeys: String, CodingKey {
        case kind, text, toolCallId, tool, args
        case stoppedReason, plan, treeUsage, verification, citations
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "text":
            self = try .text(container.decode(String.self, forKey: .text))
        case "thinking":
            self = try .thinking(container.decode(String.self, forKey: .text))
        case "tool_use":
            self = try .toolUse(
                toolCallId: container.decode(String.self, forKey: .toolCallId),
                tool: container.decode(String.self, forKey: .tool),
                args: container.decodeIfPresent(JSONAny.self, forKey: .args) ?? JSONAny.null
            )
        case "report_artifact":
            self = try .reportArtifact(
                AgentReportArtifactPart(
                    stoppedReason: container.decodeIfPresent(String.self, forKey: .stoppedReason) ?? "",
                    plan: container.decodeIfPresent([AgentDeepResearchPlanItem].self, forKey: .plan) ?? [],
                    treeUsage: container.decodeIfPresent(AgentUsage.self, forKey: .treeUsage),
                    // A run that quoted nothing reports 0/0 — the badge then reads
                    // "no quotes to verify" rather than a misleading green tick.
                    verification: container.decodeIfPresent(AgentDeepResearchVerification.self, forKey: .verification)
                        ?? AgentDeepResearchVerification(quotesChecked: 0, quotesVerified: 0),
                    citations: container.decodeIfPresent([AgentDocRef].self, forKey: .citations) ?? []
                )
            )
        default:
            let single = try decoder.singleValueContainer()
            let raw = (try? single.decode(JSONAny.self)) ?? JSONAny.null
            self = .unknown(kind: kind, raw: raw)
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .text(let text):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("text", forKey: .kind)
            try container.encode(text, forKey: .text)
        case .thinking(let text):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("thinking", forKey: .kind)
            try container.encode(text, forKey: .text)
        case .toolUse(let id, let tool, let args):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("tool_use", forKey: .kind)
            try container.encode(id, forKey: .toolCallId)
            try container.encode(tool, forKey: .tool)
            try container.encode(args, forKey: .args)
        case .reportArtifact(let artifact):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("report_artifact", forKey: .kind)
            try container.encode(artifact.stoppedReason, forKey: .stoppedReason)
            try container.encode(artifact.plan, forKey: .plan)
            try container.encodeIfPresent(artifact.treeUsage, forKey: .treeUsage)
            try container.encode(artifact.verification, forKey: .verification)
            try container.encode(artifact.citations, forKey: .citations)
        case .unknown(_, let raw):
            var single = encoder.singleValueContainer()
            try single.encode(raw)
        }
    }
}

/// The persisted Deep Research write-back part decoded from a resumed
/// conversation's `report_artifact` assistant part. The transport-layer twin of
/// the gateway `ReportArtifactPart`: it carries the structured artifact facts
/// PLUS the merged citation refs, so the coordinator can rebuild the same
/// `AgentReportArtifact` and seed the same Citations set the live run produced.
public struct AgentReportArtifactPart: Codable, Sendable, Equatable, Hashable {
    public let stoppedReason: String
    public let plan: [AgentDeepResearchPlanItem]
    public let treeUsage: AgentUsage?
    public let verification: AgentDeepResearchVerification
    public let citations: [AgentDocRef]

    public init(
        stoppedReason: String,
        plan: [AgentDeepResearchPlanItem],
        treeUsage: AgentUsage?,
        verification: AgentDeepResearchVerification,
        citations: [AgentDocRef]
    ) {
        self.stoppedReason = stoppedReason
        self.plan = plan
        self.treeUsage = treeUsage
        self.verification = verification
        self.citations = citations
    }
}

// MARK: - Token usage

/// Per-turn / per-sub-agent / per-tree token spend. Mirrors the
/// gateway `agentUsageSchema`. Every field is optional so a backend that
/// reports only some counts still decodes; `total` sums whatever is
/// present so the sub-agent card and report footer render one figure.
public struct AgentUsage: Codable, Sendable, Equatable, Hashable {
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let cacheReadTokens: Int?
    public let cacheCreationTokens: Int?

    public init(
        inputTokens: Int? = nil,
        outputTokens: Int? = nil,
        cacheReadTokens: Int? = nil,
        cacheCreationTokens: Int? = nil
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreationTokens = cacheCreationTokens
    }

    /// True when at least one count is present — lets the reducer prefer an
    /// authoritative `agent.subagent.result.usage` over a running tally only
    /// when it actually carries numbers.
    public var hasAnyToken: Bool {
        inputTokens != nil || outputTokens != nil
            || cacheReadTokens != nil || cacheCreationTokens != nil
    }

    /// Sum of every present count (absent fields contribute 0).
    public var total: Int {
        (inputTokens ?? 0) + (outputTokens ?? 0)
            + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)
    }
}

// MARK: - Doc ref + person

/// A compact reference to an open loop the Cognition Steward tracks that a document
/// is a source for — the "what is this document part of" connection, attached
/// inline to search / fetch results when the gateway is in experimental mode.
/// A pointer, not the loop's full state (that lives behind `fetch_loop`);
/// absent for documents no tracked loop references. Mirrors `DocLoopRef` in
/// `@omnesis/core/agent-protocol.ts`.
public struct AgentDocLoopRef: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String {
        loopId
    }

    /// The open loop's id — feed straight into `fetch_loop`.
    public let loopId: String
    /// The loop's title, so the reader recognises the obligation.
    public let title: String
    /// Lifecycle state (`open` | `snoozed`; terminal loops are never attached).
    public let state: String
    /// Importance the Cognition Steward assigned (0–1), for ordering.
    public let importance: Double?

    public init(loopId: String, title: String, state: String, importance: Double? = nil) {
        self.loopId = loopId
        self.title = title
        self.state = state
        self.importance = importance
    }
}

/// A compact, hint-shaped view of a durable annotation the Cognition Steward recorded
/// ABOUT a document — a prior to reground against, never a hard fact. Attached
/// inline to fetch results in experimental mode; the verbatim evidence quote
/// is deliberately omitted from the wire shape. Mirrors `DocAnnotationHint` in
/// `@omnesis/core/agent-protocol.ts`.
public struct AgentDocAnnotationHint: Codable, Sendable, Equatable, Hashable {
    /// Open-vocabulary claim kind (`topic`, `entity`, `commitment-status`, …).
    public let claimType: String
    /// The derived observation.
    public let claim: String
    /// Recorded confidence (0–1), always below certainty.
    public let confidence: Double

    public init(claimType: String, claim: String, confidence: Double) {
        self.claimType = claimType
        self.claim = claim
        self.confidence = confidence
    }
}

public struct AgentDocRef: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String {
        documentId
    }

    public let documentId: String
    public let sourceType: String
    public let sourceId: String
    public let documentType: String?
    public let title: String?
    public let snippet: String?
    public let ts: Double?
    public let url: String?
    public let appUrl: String?
    /// MIME type from the document's `metadata.extra.mimeType`, baked
    /// into the ref by the gateway. Drives the file-type icon on the
    /// synthesised Timeline row for a doc the agent cited via `annotate`.
    public let mimeType: String?
    public let people: [String]?
    /// Provider-declared unit noun ("emails", "events", "files", …)
    /// baked into the ref by the gateway. Renderers prefer this over
    /// looking up the descriptor cache themselves so the search-card
    /// summary doesn't depend on a side-channel having loaded yet.
    public let unitName: String?
    /// Open loops this document is a source for — the "what is this part
    /// of" connection the Cognition Steward tracks, attached inline in
    /// experimental mode (loops exist only then). Surfaced on both agent
    /// searches and fetch results; nil/empty when no tracked loop
    /// references the document.
    public let openLoops: [AgentDocLoopRef]?
    /// Durable annotations the Cognition Steward recorded ABOUT this document —
    /// grounded priors, never facts. Attached inline on fetch results in
    /// experimental mode; nil/empty when none exist.
    public let annotations: [AgentDocAnnotationHint]?

    public init(
        documentId: String,
        sourceType: String,
        sourceId: String,
        documentType: String? = nil,
        title: String? = nil,
        snippet: String? = nil,
        ts: Double? = nil,
        url: String? = nil,
        appUrl: String? = nil,
        mimeType: String? = nil,
        people: [String]? = nil,
        unitName: String? = nil,
        openLoops: [AgentDocLoopRef]? = nil,
        annotations: [AgentDocAnnotationHint]? = nil
    ) {
        self.documentId = documentId
        self.sourceType = sourceType
        self.sourceId = sourceId
        self.documentType = documentType
        self.title = title
        self.snippet = snippet
        self.ts = ts
        self.url = url
        self.appUrl = appUrl
        self.mimeType = mimeType
        self.people = people
        self.unitName = unitName
        self.openLoops = openLoops
        self.annotations = annotations
    }
}

/// A loop summary row in a `search_loops` result — richer than the inline
/// `AgentDocLoopRef` chip (which only pins a document's connection): enough
/// for the reader to judge the obligation without opening it. Mirrors
/// `LoopSummary` in `@omnesis/core/agent-protocol.ts`.
public struct AgentLoopSummary: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String {
        loopId
    }

    public let loopId: String
    public let title: String
    public let description: String?
    public let state: String
    public let importance: Double?
    public let confidence: Double?
    /// Human/ISO deadline string the port derived from the loop, when it has one.
    public let deadline: String?

    public init(
        loopId: String,
        title: String,
        description: String? = nil,
        state: String,
        importance: Double? = nil,
        confidence: Double? = nil,
        deadline: String? = nil
    ) {
        self.loopId = loopId
        self.title = title
        self.description = description
        self.state = state
        self.importance = importance
        self.confidence = confidence
        self.deadline = deadline
    }
}

/// One recent ledger entry on an open loop — a timestamped note the loop
/// agent appended as it worked the obligation. `at` is unix epoch
/// milliseconds. Mirrors the `ledger[]` element of `LoopDetail`.
public struct AgentLoopLedgerEntry: Codable, Sendable, Equatable, Hashable {
    public let at: Double
    public let note: String

    public init(at: Double, note: String) {
        self.at = at
        self.note = note
    }
}

/// The full read-only view of one open loop from `fetch_loop`: its summary
/// fields (flattened onto this struct, as the wire flattens them) plus the
/// people it concerns, its source documents, and its recent ledger. Mirrors
/// `LoopDetail` in `@omnesis/core/agent-protocol.ts`.
public struct AgentLoopDetail: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String {
        loopId
    }

    public let loopId: String
    public let title: String
    public let description: String?
    public let state: String
    public let importance: Double?
    public let confidence: Double?
    public let deadline: String?
    /// People who need to act (canonical display names).
    public let actors: [String]?
    /// People with a stake (canonical display names).
    public let involved: [String]?
    /// Source document ids the loop rests on.
    public let docIds: [String]?
    /// Recent ledger entries, oldest → newest.
    public let ledger: [AgentLoopLedgerEntry]?

    public init(
        loopId: String,
        title: String,
        description: String? = nil,
        state: String,
        importance: Double? = nil,
        confidence: Double? = nil,
        deadline: String? = nil,
        actors: [String]? = nil,
        involved: [String]? = nil,
        docIds: [String]? = nil,
        ledger: [AgentLoopLedgerEntry]? = nil
    ) {
        self.loopId = loopId
        self.title = title
        self.description = description
        self.state = state
        self.importance = importance
        self.confidence = confidence
        self.deadline = deadline
        self.actors = actors
        self.involved = involved
        self.docIds = docIds
        self.ledger = ledger
    }
}

public struct AgentPersonSummary: Codable, Sendable, Equatable, Hashable {
    public let canonicalId: String
    public let displayName: String
    public let aliases: [String]
    public let emailCount: Int?
    public let meetingCount: Int?
    public let chatCount: Int?
    public let lastInteraction: Double?
    public let avatarHash: String?
    /// `[0, 1]` recency-decayed interaction score — lets the renderer
    /// (or downstream agents working off persisted history) rank
    /// candidates by how active the user is with this person lately.
    /// Optional so older transcripts written before the field shipped
    /// still decode.
    public let interactionScore: Double?

    public init(
        canonicalId: String,
        displayName: String,
        aliases: [String],
        emailCount: Int? = nil,
        meetingCount: Int? = nil,
        chatCount: Int? = nil,
        lastInteraction: Double? = nil,
        avatarHash: String? = nil,
        interactionScore: Double? = nil
    ) {
        self.canonicalId = canonicalId
        self.displayName = displayName
        self.aliases = aliases
        self.emailCount = emailCount
        self.meetingCount = meetingCount
        self.chatCount = chatCount
        self.lastInteraction = lastInteraction
        self.avatarHash = avatarHash
        self.interactionScore = interactionScore
    }
}

// MARK: - Plan item

/// Three-state visual flag for a `plan` tool entry. Mirrors the
/// gateway-side `"pending" | "in_progress" | "done"` union — the
/// server picks which item is active, the client only renders.
public enum AgentPlanStatus: String, Codable, Sendable, Equatable, Hashable {
    case pending
    case inProgress = "in_progress"
    case done
}

/// One entry in the agent's TODO panel. Order is preserved end-to-end
/// (the gateway never reshuffles), so clients can diff successive
/// `plan.updated` results by `id` to drive slide-in / status-flip /
/// auto-remove animations.
public struct AgentPlanItem: Codable, Sendable, Equatable, Hashable, Identifiable {
    public let id: String
    public let label: String
    public let status: AgentPlanStatus

    public init(id: String, label: String, status: AgentPlanStatus) {
        self.id = id
        self.label = label
        self.status = status
    }
}

// MARK: - Trail event (event_trail.built result)

/// One document inside a TrailEvent — either the event's primary doc
/// or one of its attachments. Mirrors `TrailEventDoc` in
/// `@omnesis/core/agent-protocol.ts`.
public struct AgentTrailEventDoc: Codable, Sendable, Equatable, Hashable {
    public let documentId: String
    public let title: String
    public let sourceId: String
    public let sourceUrl: String?
    public let appUrl: String?
    public let documentType: String?
    public let mimeType: String?
}

/// One person incident on a TrailEvent, grouped by role-bucket.
/// `role` is left as a free string at the protocol level — the closed
/// `PersonRole` enum lives in `@omnesis/types/document` and new roles
/// added there light up without an iOS change.
public struct AgentTrailEventPerson: Codable, Sendable, Equatable, Hashable {
    public let personId: String
    public let name: String
    public let role: String
    public let isSelf: Bool
}

/// A reference from a TrailEvent to another doc in the trail.
public struct AgentTrailEventRelated: Codable, Sendable, Equatable, Hashable {
    public let documentId: String
    public let title: String
    public let sourceId: String
    public let linkType: String
    /// "in" | "out" | "peer" — open enum on the wire side too.
    public let direction: String
}

/// One declared key column of a record citation. The gateway derives the
/// label/value from the table's record-display contract and redacts
/// `sensitive` columns server-side — the value here is print-ready.
/// Mirrors `TrailRecordKeyField` in `@omnesis/core/agent-protocol.ts`.
public struct AgentTrailRecordKeyField: Codable, Sendable, Equatable, Hashable {
    public let label: String
    /// Heterogeneous on the wire (string / number / bool / null); decoded
    /// into a display string so the renderer prints it verbatim. `nil`
    /// represents an explicit null value (rendered as an em-dash).
    public let value: String?

    public init(label: String, value: String?) {
        self.label = label
        self.value = value
    }

    private enum CodingKeys: String, CodingKey {
        case label, value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = try container.decode(String.self, forKey: .label)
        // The value column is `string | number | boolean | null` on the
        // wire — coerce every shape to a display string; an explicit JSON
        // null (or a missing key) decodes to `nil` → em-dash.
        if let stringValue = try? container.decodeIfPresent(String.self, forKey: .value) {
            value = stringValue
        } else if let doubleValue = try? container.decodeIfPresent(Double.self, forKey: .value) {
            // Render integral doubles without a trailing ".0".
            value = doubleValue == doubleValue.rounded() ? String(Int(doubleValue)) : String(doubleValue)
        } else if let boolValue = try? container.decodeIfPresent(Bool.self, forKey: .value) {
            value = boolValue ? "true" : "false"
        } else {
            value = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(label, forKey: .label)
        try container.encodeIfPresent(value, forKey: .value)
    }
}

/// A DuckDB analytics row surfaced on the trail as a point-in-time record.
/// The gateway derives every display string from the table's
/// declared record-display contract, so the renderer prints these
/// directly and never learns a column name or branches on a source.
/// Mirrors `TrailRecord` in `@omnesis/core/agent-protocol.ts`.
///
/// `recordKey` (= `analyticsRowKey(table, pk)`) is the stable identity the
/// timeline dedups on: a document plus its `same-entity` row collapse to
/// ONE event (the doc event carries the `record`), so a row never appears
/// twice. `boundDocumentId` deep-links the co-described document when
/// non-nil; when nil the record renders with no tap target (no dead link).
public struct AgentTrailRecord: Codable, Sendable, Equatable, Hashable {
    public let recordKey: String
    public let table: String
    public let tableDisplayName: String
    public let title: String
    public let keyFields: [AgentTrailRecordKeyField]
    /// ISO-8601 declared semantic time. Always present (a timeless row is
    /// never surfaced as a trail record — a frozen rule).
    public let semanticTime: String
    public let sourceId: String
    public let sourceType: String
    /// Co-described document id when the row binds one, else `nil`.
    public let boundDocumentId: String?

    public init(
        recordKey: String,
        table: String,
        tableDisplayName: String,
        title: String,
        keyFields: [AgentTrailRecordKeyField],
        semanticTime: String,
        sourceId: String,
        sourceType: String,
        boundDocumentId: String?
    ) {
        self.recordKey = recordKey
        self.table = table
        self.tableDisplayName = tableDisplayName
        self.title = title
        self.keyFields = keyFields
        self.semanticTime = semanticTime
        self.sourceId = sourceId
        self.sourceType = sourceType
        self.boundDocumentId = boundDocumentId
    }
}

/// One event on a trail. Attachments nest inside `attachments[]`
/// (an email + its PDFs = one event with two entries in
/// `attachments`). Empty arrays — not omitted — for events with no
/// attachments / people / related links so the renderer doesn't
/// have to branch on nil.
///
/// An event carries a `doc`, a `record`, or BOTH:
///   - `doc` only — an ordinary document event.
///   - `doc` + `record` — a document and its `same-entity` analytics row
///     collapsed into ONE timeline entity (dedup on `record.recordKey`);
///     `at` is the row's semantic time so the record places chronologically.
///   - `record` only — a bound row reached from the seed that binds no
///     document; it stands as its own point-in-time entity.
public struct AgentTrailEvent: Codable, Sendable, Equatable, Hashable, Identifiable {
    public let eventId: String
    /// ISO-8601 timestamp. `nil` when the source didn't supply one.
    public let at: String?
    /// "seed" | "duplicate" | "similar" | "document" | "record"
    public let kind: String
    /// Primary document — `nil` for a record-only event (a bound row with
    /// no co-described document).
    public let doc: AgentTrailEventDoc?
    /// Cited DuckDB row. Present on a record-only event and on a
    /// deduped doc+record event; `nil` for an ordinary document event.
    public let record: AgentTrailRecord?
    public let attachments: [AgentTrailEvent]
    public let people: [AgentTrailEventPerson]
    public let related: [AgentTrailEventRelated]

    public init(
        eventId: String,
        at: String?,
        kind: String,
        doc: AgentTrailEventDoc? = nil,
        record: AgentTrailRecord? = nil,
        attachments: [AgentTrailEvent] = [],
        people: [AgentTrailEventPerson] = [],
        related: [AgentTrailEventRelated] = []
    ) {
        self.eventId = eventId
        self.at = at
        self.kind = kind
        self.doc = doc
        self.record = record
        self.attachments = attachments
        self.people = people
        self.related = related
    }

    public var id: String {
        eventId
    }

    /// Source-agnostic source id for icon/colour lookup. A document or
    /// deduped doc+record event uses `doc.sourceId`; a record-only event
    /// uses `record.sourceId`. Mirrors the portal's `eventSourceId(ev)`.
    public var eventSourceId: String? {
        doc?.sourceId ?? record?.sourceId
    }

    /// Stable timeline-entity identity used for dedup + ordering. A
    /// document (or deduped) event keys on its `doc.documentId`; a
    /// record-only event keys on its `record.recordKey`. Mirrors the
    /// portal reducer's identity choice in `buildUnifiedTimeline()`.
    public var entityId: String {
        doc?.documentId ?? record?.recordKey ?? eventId
    }
}

// MARK: - Tool result discriminated union

public struct AgentSqlSource: Codable, Sendable, Equatable, Hashable {
    public let sourceId: String
    public let sourceType: String
    public let displayName: String
}

public enum AgentToolResult: Codable, Sendable, Equatable, Hashable {
    case searchResults(query: String, durationMs: Double, candidates: Int?, results: [AgentDocRef])
    case document(ref: AgentDocRef, content: String?, neighbors: [AgentDocRef])
    case sqlRows(
        sql: String,
        columns: [String],
        rows: [[JSONAny]],
        rowCount: Int,
        truncated: Bool,
        durationMs: Double,
        sources: [AgentSqlSource],
        subjects: [String]
    )
    /// `lookup_people` tool succeeded — 0..N candidate people. The
    /// renderer surfaces this as a rolling-slot ephemeral card (one
    /// row per candidate), same lifecycle as `searchResults`.
    case personResults(query: String, durationMs: Double, results: [AgentPersonSummary])
    /// `lookup_document_by_url` tool succeeded — 0..1 matched doc.
    /// `ref` is nil when the URL is not in the corpus (a successful
    /// "no match", not an error). Renders as a single-slot ephemeral
    /// card on both portal + iOS.
    case documentByUrl(url: String, durationMs: Double, ref: AgentDocRef?)
    /// `trace_connections` tool succeeded (wire result kind
    /// `event_trail.built`). `events` is the typed `AgentTrailEvent` shape
    /// so the live ephemeral card + the document inspector's Timeline can
    /// render it natively; it never populates the agent side-panel Timeline
    /// (that is fed only by `annotate` / `cite_record`). The `stats` payload
    /// stays loose
    /// (`JSONAny`) because nothing in the UI relies on it today —
    /// it's only useful for diagnostics.
    case eventTrailBuilt(
        seeds: [String],
        events: [AgentTrailEvent],
        truncated: Bool,
        stats: JSONAny?
    )
    /// Successful `annotate` tool result. The server records the
    /// agent's intent to cite a document with an optional short quote
    /// and/or one-line note.
    case annotateRecorded(
        documentId: String,
        ref: AgentDocRef,
        quote: String?,
        note: String?,
        quoteAuthor: String?,
        quoteIsSelf: Bool
    )
    /// Successful `cite_record` tool result — the agent cited a
    /// single DuckDB analytics row that materially informed its answer
    /// (the structured twin of `annotate.recorded`). The payload decodes
    /// straight into `AgentTrailRecord` so the same Timeline primitives
    /// that render a `trace_connections` record render a directly-cited one;
    /// the result's extra `primaryKeyColumns` / `snapshot` keys are not
    /// needed for rendering and are ignored.
    case citeRecordRecorded(record: AgentTrailRecord)
    /// Snapshot of the agent's TODO panel after a `plan` call. The
    /// list is the full current plan (not a delta); clients diff
    /// successive snapshots client-side to drive panel animations.
    case planUpdated(items: [AgentPlanItem])
    /// `triggers_list` result — read-only background data fetch, used
    /// internally by the agent. The iOS UI doesn't render these
    /// inline; the case exists so SSE decoding doesn't choke on them.
    case triggersListed(triggers: [AgentTriggerSummary])
    /// `trigger_get` result — read-only background data fetch.
    case triggerFetched(trigger: AgentTriggerRecord)
    /// `trigger_firings` result — read-only background data fetch.
    case triggerFirings(triggerId: String, firings: [AgentTriggerFiring])
    /// An automation write succeeded (`watch_create` / `watch_update`) —
    /// render an inline action card (lightning glyph) in the transcript so
    /// the user sees the automation land without having to ask.
    /// A watch the agent installed or rewrote.
    case watchUpserted(watchId: String, name: String, action: String, enabled: Bool, summary: String?)
    /// The same card from a conversation stored before the result was renamed.
    /// Decoded so an older transcript still opens; nothing emits it.
    case triggerUpserted(triggerId: String, name: String, action: String, enabled: Bool, summary: String?)
    /// A retired toggle result. Kept so transcripts recorded before watches
    /// still decode; the same card surface as `triggerUpserted`, with the
    /// verb derived from `enabled`.
    case triggerToggled(triggerId: String, name: String, enabled: Bool)
    /// `search_loops` result (experimental) — the chat agent read the loop
    /// agent's tracked obligations. Read-only; renders as an ephemeral
    /// rolling-slot card, same lifecycle as `searchResults`. Empty `loops`
    /// is a successful "nothing matched".
    case loopsSearched(query: String, durationMs: Double, loops: [AgentLoopSummary])
    /// `fetch_loop` result (experimental) — one loop's full read-only
    /// detail. `loop` is nil when the id matched nothing (a clean no-match,
    /// not an error).
    case loopFetched(loop: AgentLoopDetail?)
    /// `search_many` batch tool succeeded. One model tool call fanned out to
    /// N child searches; `items` holds the per-child outcomes in INPUT order,
    /// each reusing the SINGULAR result shape — a `.searchResults` on success
    /// or an `.error` in a failed child's slot, so one failure never discards
    /// the batch. Renderers project one live per-child ephemeral card (keyed
    /// by index); on reload the cards are ephemeral and dropped like the
    /// singular `search_documents`. Mirrors `SearchBatchResult` in
    /// `@omnesis/core/agent-protocol.ts`.
    case searchBatch(items: [AgentToolResult])
    /// `fetch_many` batch tool succeeded — the document twin of `searchBatch`.
    /// Each `items` slot is a `.document` on success or an `.error` on a
    /// failed child. Mirrors `DocumentBatchResult`.
    case documentBatch(items: [AgentToolResult])
    /// `annotate_many` batch tool succeeded — the citation twin. Each `items`
    /// slot is an `.annotateRecorded` on success or an `.error` on a failed
    /// child. Silent inline (no card): the Citations drawer + Timeline own the
    /// visible payload; the reload rebuilders fan this out to one citation per
    /// child with the same `<toolCallId>#<idx>` ids the live per-child
    /// `agent.citation` events use, so live and reloaded state align. Mirrors
    /// `AnnotateBatchResult`.
    case annotateBatch(items: [AgentToolResult])
    case error(code: String, message: String)
    /// Forward-compat: any `kind` we don't recognise lands here so a
    /// stored transcript that references a future tool result type
    /// still loads. `raw` preserves the original JSON so encoding
    /// round-trips and the demo build can render an inline placeholder.
    case unknown(kind: String, raw: JSONAny)

    enum CodingKeys: String, CodingKey {
        case kind, query, durationMs, candidates, results, ref, document, neighbors
        case sql, columns, rows, rowCount, truncated, documentId, code, message
        case sources, subjects, quote, note, items
        case triggers, trigger, triggerId, firings, name, action, enabled, summary
        case watchId
        case seeds, events, stats
        case url, quoteAuthor, quoteIsSelf
        case loops, loop
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "search.results":
            self = try .searchResults(
                query: container.decode(String.self, forKey: .query),
                durationMs: container.decodeIfPresent(Double.self, forKey: .durationMs) ?? 0,
                candidates: container.decodeIfPresent(Int.self, forKey: .candidates),
                results: container.decodeIfPresent([AgentDocRef].self, forKey: .results) ?? []
            )
        case "document":
            struct DocBody: Decodable { let content: String? }
            let body = try container.decodeIfPresent(DocBody.self, forKey: .document)
            self = try .document(
                ref: container.decode(AgentDocRef.self, forKey: .ref),
                content: body?.content,
                neighbors: container.decodeIfPresent([AgentDocRef].self, forKey: .neighbors) ?? []
            )
        case "sql.rows":
            self = try .sqlRows(
                sql: container.decode(String.self, forKey: .sql),
                columns: container.decodeIfPresent([String].self, forKey: .columns) ?? [],
                rows: container.decodeIfPresent([[JSONAny]].self, forKey: .rows) ?? [],
                rowCount: container.decodeIfPresent(Int.self, forKey: .rowCount) ?? 0,
                truncated: container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false,
                durationMs: container.decodeIfPresent(Double.self, forKey: .durationMs) ?? 0,
                sources: container.decodeIfPresent([AgentSqlSource].self, forKey: .sources) ?? [],
                subjects: container.decodeIfPresent([String].self, forKey: .subjects) ?? []
            )
        case "person.results":
            self = try .personResults(
                query: container.decode(String.self, forKey: .query),
                durationMs: container.decodeIfPresent(Double.self, forKey: .durationMs) ?? 0,
                results: container.decodeIfPresent([AgentPersonSummary].self, forKey: .results) ?? []
            )
        case "document.byUrl":
            self = try .documentByUrl(
                url: container.decode(String.self, forKey: .url),
                durationMs: container.decodeIfPresent(Double.self, forKey: .durationMs) ?? 0,
                ref: container.decodeIfPresent(AgentDocRef.self, forKey: .ref)
            )
        case "event_trail.built":
            self = try .eventTrailBuilt(
                seeds: container.decodeIfPresent([String].self, forKey: .seeds) ?? [],
                events: container.decodeIfPresent([AgentTrailEvent].self, forKey: .events) ?? [],
                truncated: container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false,
                stats: container.decodeIfPresent(JSONAny.self, forKey: .stats)
            )
        case "annotate.recorded":
            self = try .annotateRecorded(
                documentId: container.decode(String.self, forKey: .documentId),
                ref: container.decode(AgentDocRef.self, forKey: .ref),
                quote: container.decodeIfPresent(String.self, forKey: .quote),
                note: container.decodeIfPresent(String.self, forKey: .note),
                quoteAuthor: container.decodeIfPresent(String.self, forKey: .quoteAuthor),
                quoteIsSelf: container.decodeIfPresent(Bool.self, forKey: .quoteIsSelf) ?? false
            )
        case "cite_record.recorded":
            // The result object IS an `AgentTrailRecord` plus a few extra
            // keys (`kind`, `primaryKeyColumns`, `snapshot`) that the
            // record doesn't model — decode it straight off the same
            // decoder; synthesised Codable reads only the keys it knows.
            self = try .citeRecordRecorded(
                record: AgentTrailRecord(from: decoder)
            )
        case "plan.updated":
            self = try .planUpdated(
                items: container.decodeIfPresent([AgentPlanItem].self, forKey: .items) ?? []
            )
        case "triggers.listed":
            self = try .triggersListed(
                triggers: container.decodeIfPresent([AgentTriggerSummary].self, forKey: .triggers) ?? []
            )
        case "trigger.fetched":
            self = try .triggerFetched(
                trigger: container.decode(AgentTriggerRecord.self, forKey: .trigger)
            )
        case "trigger.firings":
            self = try .triggerFirings(
                triggerId: container.decode(String.self, forKey: .triggerId),
                firings: container.decodeIfPresent([AgentTriggerFiring].self, forKey: .firings) ?? []
            )
        case "watch.upserted":
            self = try .watchUpserted(
                watchId: container.decode(String.self, forKey: .watchId),
                name: container.decode(String.self, forKey: .name),
                action: container.decode(String.self, forKey: .action),
                enabled: container.decode(Bool.self, forKey: .enabled),
                summary: container.decodeIfPresent(String.self, forKey: .summary)
            )
        case "trigger.upserted":
            self = try .triggerUpserted(
                triggerId: container.decode(String.self, forKey: .triggerId),
                name: container.decode(String.self, forKey: .name),
                action: container.decode(String.self, forKey: .action),
                enabled: container.decode(Bool.self, forKey: .enabled),
                summary: container.decodeIfPresent(String.self, forKey: .summary)
            )
        case "trigger.toggled":
            self = try .triggerToggled(
                triggerId: container.decode(String.self, forKey: .triggerId),
                name: container.decode(String.self, forKey: .name),
                enabled: container.decode(Bool.self, forKey: .enabled)
            )
        case "loops.searched":
            self = try .loopsSearched(
                query: container.decode(String.self, forKey: .query),
                durationMs: container.decodeIfPresent(Double.self, forKey: .durationMs) ?? 0,
                loops: container.decodeIfPresent([AgentLoopSummary].self, forKey: .loops) ?? []
            )
        case "loop.fetched":
            self = try .loopFetched(
                loop: container.decodeIfPresent(AgentLoopDetail.self, forKey: .loop)
            )
        case "search.batch":
            self = try .searchBatch(
                items: container.decodeIfPresent([AgentToolResult].self, forKey: .items) ?? []
            )
        case "document.batch":
            self = try .documentBatch(
                items: container.decodeIfPresent([AgentToolResult].self, forKey: .items) ?? []
            )
        case "annotate.batch":
            self = try .annotateBatch(
                items: container.decodeIfPresent([AgentToolResult].self, forKey: .items) ?? []
            )
        case "error":
            self = try .error(
                code: container.decode(String.self, forKey: .code),
                message: container.decode(String.self, forKey: .message)
            )
        default:
            let single = try decoder.singleValueContainer()
            let raw = (try? single.decode(JSONAny.self)) ?? JSONAny.null
            self = .unknown(kind: kind, raw: raw)
        }
    }

    public func encode(to encoder: Encoder) throws {
        // `.unknown` writes its preserved raw payload verbatim via a
        // singleValueContainer; everything else uses the keyed shape.
        if case .unknown(_, let raw) = self {
            var single = encoder.singleValueContainer()
            try single.encode(raw)
            return
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .searchResults(let query, let durationMs, let candidates, let results):
            try container.encode("search.results", forKey: .kind)
            try container.encode(query, forKey: .query)
            try container.encode(durationMs, forKey: .durationMs)
            try container.encodeIfPresent(candidates, forKey: .candidates)
            try container.encode(results, forKey: .results)
        case .document(let ref, let content, let neighbors):
            try container.encode("document", forKey: .kind)
            try container.encode(ref, forKey: .ref)
            struct Body: Encodable { let id: String
                let content: String?
            }
            try container.encode(Body(id: ref.documentId, content: content), forKey: .document)
            try container.encode(neighbors, forKey: .neighbors)
        case .sqlRows(let sql, let cols, let rows, let rc, let trunc, let dur, let sources, let subjects):
            try container.encode("sql.rows", forKey: .kind)
            try container.encode(sql, forKey: .sql)
            try container.encode(cols, forKey: .columns)
            try container.encode(rows, forKey: .rows)
            try container.encode(rc, forKey: .rowCount)
            try container.encode(trunc, forKey: .truncated)
            try container.encode(dur, forKey: .durationMs)
            try container.encode(sources, forKey: .sources)
            try container.encode(subjects, forKey: .subjects)
        case .personResults(let query, let durationMs, let results):
            try container.encode("person.results", forKey: .kind)
            try container.encode(query, forKey: .query)
            try container.encode(durationMs, forKey: .durationMs)
            try container.encode(results, forKey: .results)
        case .documentByUrl(let url, let durationMs, let ref):
            try container.encode("document.byUrl", forKey: .kind)
            try container.encode(url, forKey: .url)
            try container.encode(durationMs, forKey: .durationMs)
            try container.encodeIfPresent(ref, forKey: .ref)
        case .eventTrailBuilt(let seeds, let events, let truncated, let stats):
            try container.encode("event_trail.built", forKey: .kind)
            try container.encode(seeds, forKey: .seeds)
            try container.encode(events, forKey: .events)
            try container.encode(truncated, forKey: .truncated)
            try container.encodeIfPresent(stats, forKey: .stats)
        case .annotateRecorded(let docId, let ref, let quote, let note, let quoteAuthor, let quoteIsSelf):
            try container.encode("annotate.recorded", forKey: .kind)
            try container.encode(docId, forKey: .documentId)
            try container.encode(ref, forKey: .ref)
            try container.encodeIfPresent(quote, forKey: .quote)
            try container.encodeIfPresent(note, forKey: .note)
            try container.encodeIfPresent(quoteAuthor, forKey: .quoteAuthor)
            try container.encode(quoteIsSelf, forKey: .quoteIsSelf)
        case .citeRecordRecorded(let record):
            // Re-emit the record's own keys alongside `kind`. The dropped
            // `primaryKeyColumns` / `snapshot` keys aren't needed to
            // re-render a stored transcript, so a round-trip is lossy on
            // those two fields by design.
            try container.encode("cite_record.recorded", forKey: .kind)
            try record.encode(to: encoder)
        case .planUpdated(let items):
            try container.encode("plan.updated", forKey: .kind)
            try container.encode(items, forKey: .items)
        case .triggersListed(let triggers):
            try container.encode("triggers.listed", forKey: .kind)
            try container.encode(triggers, forKey: .triggers)
        case .triggerFetched(let trigger):
            try container.encode("trigger.fetched", forKey: .kind)
            try container.encode(trigger, forKey: .trigger)
        case .triggerFirings(let triggerId, let firings):
            try container.encode("trigger.firings", forKey: .kind)
            try container.encode(triggerId, forKey: .triggerId)
            try container.encode(firings, forKey: .firings)
        case .watchUpserted(let watchId, let name, let action, let enabled, let summary):
            try container.encode("watch.upserted", forKey: .kind)
            try container.encode(watchId, forKey: .watchId)
            try container.encode(name, forKey: .name)
            try container.encode(action, forKey: .action)
            try container.encode(enabled, forKey: .enabled)
            try container.encodeIfPresent(summary, forKey: .summary)
        case .triggerUpserted(let triggerId, let name, let action, let enabled, let summary):
            try container.encode("trigger.upserted", forKey: .kind)
            try container.encode(triggerId, forKey: .triggerId)
            try container.encode(name, forKey: .name)
            try container.encode(action, forKey: .action)
            try container.encode(enabled, forKey: .enabled)
            try container.encodeIfPresent(summary, forKey: .summary)
        case .triggerToggled(let triggerId, let name, let enabled):
            try container.encode("trigger.toggled", forKey: .kind)
            try container.encode(triggerId, forKey: .triggerId)
            try container.encode(name, forKey: .name)
            try container.encode(enabled, forKey: .enabled)
        case .loopsSearched(let query, let durationMs, let loops):
            try container.encode("loops.searched", forKey: .kind)
            try container.encode(query, forKey: .query)
            try container.encode(durationMs, forKey: .durationMs)
            try container.encode(loops, forKey: .loops)
        case .loopFetched(let loop):
            try container.encode("loop.fetched", forKey: .kind)
            try container.encodeIfPresent(loop, forKey: .loop)
        case .searchBatch(let items):
            try container.encode("search.batch", forKey: .kind)
            try container.encode(items, forKey: .items)
        case .documentBatch(let items):
            try container.encode("document.batch", forKey: .kind)
            try container.encode(items, forKey: .items)
        case .annotateBatch(let items):
            try container.encode("annotate.batch", forKey: .kind)
            try container.encode(items, forKey: .items)
        case .error(let code, let msg):
            try container.encode("error", forKey: .kind)
            try container.encode(code, forKey: .code)
            try container.encode(msg, forKey: .message)
        case .unknown:
            // Handled above via the singleValueContainer fast-path.
            break
        }
    }
}

// MARK: - Trigger result types

/// Compact summary of one trigger. Mirrors `TriggerSummaryEntry` on
/// the gateway side. Wire-stable: `kind` / `actionKinds` are plain
/// strings so a future trigger kind (or action kind) won't crash the
/// decoder when an older client meets a newer gateway.
public struct AgentTriggerSummary: Codable, Sendable, Equatable, Hashable {
    public let id: String
    public let name: String
    public let kind: String
    public let enabled: Bool
    public let expired: Bool
    public let lastFiredAt: Int?
    public let fireCount: Int
    public let actionKinds: [String]
    public let agentManageable: Bool
}

/// Full trigger record — summary plus the opaque spec JSON.
public struct AgentTriggerRecord: Codable, Sendable, Equatable, Hashable {
    public let id: String
    public let name: String
    public let kind: String
    public let enabled: Bool
    public let expired: Bool
    public let lastFiredAt: Int?
    public let fireCount: Int
    public let actionKinds: [String]
    public let agentManageable: Bool
    public let spec: JSONAny
    public let createdAt: Int
    public let updatedAt: Int
}

/// One firing event in the audit log.
public struct AgentTriggerFiring: Codable, Sendable, Equatable, Hashable {
    public let id: String
    public let triggerId: String
    public let firedAt: Int
    public let kind: String
    public let status: String
    public let batchSize: Int
    public let durationMs: Int
    public let error: String?
}

// MARK: - Streaming events

/// One event from the SSE feed. The payload variants mirror the
/// gateway-side discriminated union exactly.
///
/// `Decodable` is implemented directly off the JSON envelope:
/// `{ type, payload: {...} }`. The discriminator is `type`; the typed
/// payload is decoded once into the right associated value. Unknown
/// `type` values fall into `.unknown` so a forward-extension on the
/// gateway can't crash an older client (see protocol contract in
/// `packages/core/src/agent-protocol.ts`).
public enum AgentEvent: Decodable, Sendable, Equatable {
    /// User text just landed on the gateway, before the agent's turn
    /// begins. Fans out to every device on this session so non-originator
    /// devices can render the user bubble. Originator dedupes by the
    /// `userMessageId` it got back from `POST /agent/sessions/:id/messages`.
    case userMessage(sessionId: String, userMessageId: String, text: String)
    case messageStart(sessionId: String, messageId: String)
    case textDelta(sessionId: String, messageId: String, delta: String)
    case thinkingDelta(sessionId: String, messageId: String, delta: String)
    case usageUpdate(sessionId: String, messageId: String, usage: AgentUsage)
    /// The model has opened a tool-use content block — args haven't
    /// streamed yet. Use this to render an immediate "Running…" stub
    /// card; the corresponding `toolStart` then fills in the args.
    case toolInputStart(
        sessionId: String,
        messageId: String,
        toolCallId: String,
        tool: String
    )
    case toolStart(
        sessionId: String,
        messageId: String,
        toolCallId: String,
        tool: String,
        args: JSONAny,
        argsSummary: String?
    )
    case toolResult(
        sessionId: String,
        messageId: String,
        toolCallId: String,
        result: AgentToolResult,
        durationMs: Double
    )
    /// Live per-child progress for a batch tool call (`search_many` /
    /// `fetch_many` / `annotate_many`). `toolCallId` is the PARENT batch
    /// call; `(toolCallId, childIndex)` keys one live ephemeral card per child
    /// so the client animates N cards with concurrent lifecycles. `tool` is
    /// the SINGULAR tool name (`search_documents` / `fetch_document` /
    /// `annotate`) so the client reuses the existing per-tool card. These are
    /// live-only signals — the durable record is the single `agent.tool.result`
    /// (a `*.batch` result) the cards re-project from on reload — so a client
    /// that ignores them still reconstructs the same UI. Every production
    /// backend emits these while the batch is running.
    case toolChildStart(
        sessionId: String,
        messageId: String,
        toolCallId: String,
        childIndex: Int,
        tool: String,
        argsSummary: String?
    )
    case toolChildResult(
        sessionId: String,
        messageId: String,
        toolCallId: String,
        childIndex: Int,
        result: AgentToolResult
    )
    /// One annotate call just resolved. Carries the optional verbatim
    /// quote / note alongside the doc ref so the UI can paint the
    /// citation entry inline.
    case citation(
        sessionId: String,
        messageId: String,
        toolCallId: String,
        ref: AgentDocRef,
        quote: String?,
        note: String?,
        quoteAuthor: String?,
        quoteIsSelf: Bool
    )
    case citationsUpdate(sessionId: String, added: [AgentDocRef], removed: [String])
    /// A sub-agent the parent spawned via `spawn_subagent` just
    /// launched. Opens a compact live card on the parent's assistant turn;
    /// subsequent `subagentEvent` values update its usage and reached sources.
    case subagentSpawned(
        sessionId: String,
        subagentId: String,
        specialist: String,
        task: String,
        title: String = "",
        parentToolCallId: String?
    )
    /// One of a sub-agent's own `AgentEvent`s, wrapped one level of recursion.
    /// The compact row consumes tool/docs/usage events and ignores prose. An
    /// unknown inner type decodes to `.unknown` and degrades gracefully.
    /// `indirect` because the case holds a nested `AgentEvent` (one level of
    /// recursion) — without it the enum would have infinite size.
    indirect case subagentEvent(
        sessionId: String,
        subagentId: String,
        specialist: String,
        event: AgentEvent
    )
    /// A sub-agent finished. Finalises its card: terminal `status`, the
    /// distilled `summary`, and the authoritative token totals (this
    /// child's `usage` overrides the running tally; `treeUsage` is the
    /// whole-tree figure the report footer renders).
    case subagentResult(
        sessionId: String,
        subagentId: String,
        specialist: String,
        status: String,
        summary: String,
        citations: [AgentDocRef],
        usage: AgentUsage?,
        treeUsage: AgentUsage?,
        failure: AgentTerminalFailure? = nil
    )
    /// Additive end-of-run summary for an explicit Deep Research run,
    /// emitted ONCE just before the parent turn's `message.end`. Carries the
    /// structured terminal reason, planner decomposition, whole-tree token
    /// total, and quote-verification tally. Retained for protocol/history
    /// compatibility; the retired completion card no longer renders it.
    case deepResearchSummary(
        sessionId: String,
        messageId: String,
        stoppedReason: String,
        plan: [AgentDeepResearchPlanItem],
        treeUsage: AgentUsage?,
        verification: AgentDeepResearchVerification
    )
    case messageEnd(sessionId: String, messageId: String, stopReason: String, usage: AgentUsage? = nil)
    /// An authoritative terminal indicating that the visible answer is only
    /// partial. Unlike context exhaustion, this does not freeze the
    /// conversation; clients mark the turn and keep the composer available.
    case outputTruncated(
        sessionId: String,
        messageId: String,
        stopReason: String,
        failure: AgentTerminalFailure
    )
    /// A terminal message-end carrying the authoritative context-overflow
    /// failure. Kept distinct from ordinary ends so existing event consumers
    /// continue to handle successful and output-truncated turns unchanged.
    case contextWindowExceeded(
        sessionId: String,
        messageId: String,
        stopReason: String,
        failure: AgentTerminalFailure,
        context: AgentContextAssessment?
    )
    case error(
        sessionId: String,
        messageId: String?,
        code: String,
        message: String,
        provider: AgentProviderFailureDetail?
    )
    /// Out-of-band control event: the gateway couldn't replay the events
    /// this client missed (the gap predates its SSE buffer), so the client
    /// must reconcile by reloading the active conversation's persisted
    /// transcript. Carries no session id — it's connection-scoped, emitted
    /// only to the reconnecting client.
    case resync
    /// Forward-compat catch-all: any `type` the client doesn't know
    /// about lands here. The reducer ignores `.unknown` events.
    case unknown(type: String)

    public var sessionId: String {
        switch self {
        case .userMessage(let id, _, _),
             .messageStart(let id, _),
             .textDelta(let id, _, _),
             .thinkingDelta(let id, _, _),
             .usageUpdate(let id, _, _),
             .toolInputStart(let id, _, _, _),
             .toolStart(let id, _, _, _, _, _),
             .toolResult(let id, _, _, _, _),
             .toolChildStart(let id, _, _, _, _, _),
             .toolChildResult(let id, _, _, _, _),
             .citation(let id, _, _, _, _, _, _, _),
             .citationsUpdate(let id, _, _),
             .subagentSpawned(let id, _, _, _, _, _),
             .subagentEvent(let id, _, _, _),
             .subagentResult(let id, _, _, _, _, _, _, _, _),
             .deepResearchSummary(let id, _, _, _, _, _),
             .messageEnd(let id, _, _, _),
             .outputTruncated(let id, _, _, _),
             .contextWindowExceeded(let id, _, _, _, _),
             .error(let id, _, _, _, _):
            id
        case .resync, .unknown:
            ""
        }
    }

    private enum EnvelopeKey: String, CodingKey { case type, payload }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: EnvelopeKey.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "agent.user.message":
            let payload = try container.decode(UserMessagePayload.self, forKey: .payload)
            self = .userMessage(
                sessionId: payload.sessionId,
                userMessageId: payload.userMessageId,
                text: payload.text
            )
        case "agent.message.start":
            let payload = try container.decode(MessageStartPayload.self, forKey: .payload)
            self = .messageStart(sessionId: payload.sessionId ?? "", messageId: payload.messageId ?? "")
        case "agent.text.delta":
            let payload = try container.decode(DeltaPayload.self, forKey: .payload)
            self = .textDelta(
                sessionId: payload.sessionId ?? "",
                messageId: payload.messageId ?? "",
                delta: payload.delta
            )
        case "agent.thinking.delta":
            let payload = try container.decode(DeltaPayload.self, forKey: .payload)
            self = .thinkingDelta(
                sessionId: payload.sessionId ?? "",
                messageId: payload.messageId ?? "",
                delta: payload.delta
            )
        case "agent.usage.update":
            let payload = try container.decode(UsageUpdatePayload.self, forKey: .payload)
            self = .usageUpdate(
                sessionId: payload.sessionId ?? "",
                messageId: payload.messageId ?? "",
                usage: payload.usage
            )
        case "agent.tool.input_start":
            let payload = try container.decode(ToolInputStartPayload.self, forKey: .payload)
            self = .toolInputStart(
                sessionId: payload.sessionId ?? "",
                messageId: payload.messageId ?? "",
                toolCallId: payload.toolCallId,
                tool: payload.tool
            )
        case "agent.tool.start":
            let payload = try container.decode(ToolStartPayload.self, forKey: .payload)
            self = .toolStart(
                sessionId: payload.sessionId ?? "",
                messageId: payload.messageId ?? "",
                toolCallId: payload.toolCallId,
                tool: payload.tool,
                args: payload.args ?? JSONAny.null,
                argsSummary: payload.argsSummary
            )
        case "agent.tool.result":
            let payload = try container.decode(ToolResultPayload.self, forKey: .payload)
            self = .toolResult(
                sessionId: payload.sessionId ?? "",
                messageId: payload.messageId ?? "",
                toolCallId: payload.toolCallId,
                result: payload.result,
                durationMs: payload.durationMs ?? 0
            )
        case "agent.tool.child.start":
            let payload = try container.decode(ToolChildStartPayload.self, forKey: .payload)
            self = .toolChildStart(
                sessionId: payload.sessionId ?? "",
                messageId: payload.messageId ?? "",
                toolCallId: payload.toolCallId,
                childIndex: payload.childIndex,
                tool: payload.tool,
                argsSummary: payload.argsSummary
            )
        case "agent.tool.child.result":
            let payload = try container.decode(ToolChildResultPayload.self, forKey: .payload)
            self = .toolChildResult(
                sessionId: payload.sessionId ?? "",
                messageId: payload.messageId ?? "",
                toolCallId: payload.toolCallId,
                childIndex: payload.childIndex,
                result: payload.result
            )
        case "agent.citation":
            let payload = try container.decode(CitationPayload.self, forKey: .payload)
            self = .citation(
                sessionId: payload.sessionId ?? "",
                messageId: payload.messageId ?? "",
                toolCallId: payload.toolCallId,
                ref: payload.ref,
                quote: payload.quote,
                note: payload.note,
                quoteAuthor: payload.quoteAuthor,
                quoteIsSelf: payload.quoteIsSelf ?? false
            )
        case "agent.citations.update":
            let payload = try container.decode(CitationsUpdatePayload.self, forKey: .payload)
            self = .citationsUpdate(
                sessionId: payload.sessionId,
                added: payload.added ?? [],
                removed: payload.removed ?? []
            )
        case "agent.subagent.spawned":
            let payload = try container.decode(SubagentSpawnedPayload.self, forKey: .payload)
            self = .subagentSpawned(
                sessionId: payload.sessionId,
                subagentId: payload.subagentId,
                specialist: payload.specialist,
                task: payload.task,
                title: payload.title ?? "",
                parentToolCallId: payload.parentToolCallId
            )
        case "agent.subagent.event":
            let payload = try container.decode(SubagentEventPayload.self, forKey: .payload)
            self = .subagentEvent(
                sessionId: payload.sessionId,
                subagentId: payload.subagentId,
                specialist: payload.specialist,
                // The wrapped child event is decoded one level of recursion as
                // a full `AgentEvent`; an unknown inner `type` decodes to
                // `.unknown` (graceful degrade), never throwing.
                event: payload.event
            )
        case "agent.subagent.result":
            let payload = try container.decode(SubagentResultPayload.self, forKey: .payload)
            self = .subagentResult(
                sessionId: payload.sessionId,
                subagentId: payload.subagentId,
                specialist: payload.specialist,
                status: payload.status,
                summary: payload.summary,
                citations: payload.citations ?? [],
                usage: payload.usage,
                treeUsage: payload.treeUsage,
                failure: payload.failure
            )
        case "agent.deep_research.summary":
            let payload = try container.decode(DeepResearchSummaryPayload.self, forKey: .payload)
            self = .deepResearchSummary(
                sessionId: payload.sessionId,
                messageId: payload.messageId,
                stoppedReason: payload.stoppedReason,
                plan: payload.plan ?? [],
                treeUsage: payload.treeUsage,
                // A run that quoted nothing reports 0/0 — the badge then reads
                // "No quotes to verify" rather than a misleading green tick.
                verification: payload.verification
                    ?? AgentDeepResearchVerification(quotesChecked: 0, quotesVerified: 0)
            )
        case "agent.message.end":
            let payload = try container.decode(MessageEndPayload.self, forKey: .payload)
            if let failure = payload.failure,
               failure.code == "context_window_exceeded" {
                self = .contextWindowExceeded(
                    sessionId: payload.sessionId ?? "",
                    messageId: payload.messageId ?? "",
                    stopReason: payload.stopReason ?? "error",
                    failure: failure,
                    context: payload.context
                )
            } else if let failure = payload.failure,
                      failure.code == "output_truncated" {
                self = .outputTruncated(
                    sessionId: payload.sessionId ?? "",
                    messageId: payload.messageId ?? "",
                    stopReason: payload.stopReason ?? "max_tokens",
                    failure: failure
                )
            } else {
                self = .messageEnd(
                    sessionId: payload.sessionId ?? "",
                    messageId: payload.messageId ?? "",
                    stopReason: payload.stopReason ?? "end_turn",
                    usage: payload.usage
                )
            }
        case "agent.error":
            let payload = try container.decode(ErrorPayload.self, forKey: .payload)
            self = .error(
                sessionId: payload.sessionId,
                messageId: payload.messageId,
                code: payload.code,
                message: payload.message,
                provider: payload.provider
            )
        case "agent.resync":
            self = .resync
        default:
            self = .unknown(type: type)
        }
    }

    // MARK: - Typed payload helpers

    private struct UserMessagePayload: Decodable {
        let sessionId: String
        let userMessageId: String
        let text: String
    }

    /// sessionId / messageId are OPTIONAL on these payloads because the same
    /// event types appear as WRAPPED CHILD events inside `agent.subagent.event`,
    /// where the wire omits both (the parent envelope carries the sessionId; the
    /// child payload is thin — just `{toolCallId, result}` etc.). A non-optional
    /// field there throws `keyNotFound`, which bubbles up and discards the entire
    /// subagent event — so the researcher rows never receive live documents or
    /// usage. Defaulting to "" at the call site matches
    /// Android's tolerant decode and the portal's duck-typed read.
    private struct MessageStartPayload: Decodable {
        let sessionId: String?
        let messageId: String?
    }

    private struct DeltaPayload: Decodable {
        let sessionId: String?
        let messageId: String?
        let delta: String
    }

    private struct ToolInputStartPayload: Decodable {
        let sessionId: String?
        let messageId: String?
        let toolCallId: String
        let tool: String
    }

    private struct ToolStartPayload: Decodable {
        let sessionId: String?
        let messageId: String?
        let toolCallId: String
        let tool: String
        let args: JSONAny?
        let argsSummary: String?
    }

    private struct ToolResultPayload: Decodable {
        let sessionId: String?
        let messageId: String?
        let toolCallId: String
        let result: AgentToolResult
        let durationMs: Double?
    }

    /// sessionId / messageId are decoded optional for the same wrapped-child
    /// reason as `MessageStartPayload` above — the events also ride inside an
    /// `agent.subagent.event` envelope where the thin child payload omits them.
    private struct ToolChildStartPayload: Decodable {
        let sessionId: String?
        let messageId: String?
        let toolCallId: String
        let childIndex: Int
        let tool: String
        let argsSummary: String?
    }

    private struct ToolChildResultPayload: Decodable {
        let sessionId: String?
        let messageId: String?
        let toolCallId: String
        let childIndex: Int
        let result: AgentToolResult
    }

    private struct CitationPayload: Decodable {
        let sessionId: String?
        let messageId: String?
        let toolCallId: String
        let ref: AgentDocRef
        let quote: String?
        let note: String?
        let quoteAuthor: String?
        let quoteIsSelf: Bool?
    }

    private struct CitationsUpdatePayload: Decodable {
        let sessionId: String
        let added: [AgentDocRef]?
        let removed: [String]?
    }

    private struct MessageEndPayload: Decodable {
        let sessionId: String?
        let messageId: String?
        let stopReason: String?
        let failure: AgentTerminalFailure?
        let context: AgentContextAssessment?
        let usage: AgentUsage?
    }

    private struct UsageUpdatePayload: Decodable {
        let sessionId: String?
        let messageId: String?
        let usage: AgentUsage
    }

    private struct SubagentSpawnedPayload: Decodable {
        let sessionId: String
        let subagentId: String
        let specialist: String
        let title: String?
        let task: String
        let parentToolCallId: String?
    }

    private struct SubagentEventPayload: Decodable {
        let sessionId: String
        let subagentId: String
        let specialist: String
        /// The wrapped child event is itself an `{ type, payload }` envelope —
        /// decode it straight into `AgentEvent`, which reads exactly that shape
        /// (one level of recursion). An unknown inner `type` lands on
        /// `.unknown` rather than throwing.
        let event: AgentEvent
    }

    private struct SubagentResultPayload: Decodable {
        let sessionId: String
        let subagentId: String
        let specialist: String
        let status: String
        let summary: String
        let citations: [AgentDocRef]?
        let usage: AgentUsage?
        let treeUsage: AgentUsage?
        let failure: AgentTerminalFailure?
    }

    private struct DeepResearchSummaryPayload: Decodable {
        let sessionId: String
        let messageId: String
        let stoppedReason: String
        let plan: [AgentDeepResearchPlanItem]?
        let treeUsage: AgentUsage?
        let verification: AgentDeepResearchVerification?
    }

    private struct ErrorPayload: Decodable {
        let sessionId: String
        let messageId: String?
        let code: String
        let message: String
        /// Absent on gateways that predate the field and on errors with no
        /// upstream envelope.
        let provider: AgentProviderFailureDetail?
    }
}

// MARK: - Deep Research summary

/// One planner-decomposition row retained in Deep Research summary metadata.
public struct AgentDeepResearchPlanItem: Codable, Sendable, Equatable, Hashable {
    public let specialist: String
    public let task: String

    public init(specialist: String, task: String) {
        self.specialist = specialist
        self.task = task
    }
}

/// Quote-verification tally computed during the run's verify pass and retained
/// in summary metadata. A run that quoted nothing reports `0/0`.
public struct AgentDeepResearchVerification: Codable, Sendable, Equatable, Hashable {
    public let quotesChecked: Int
    public let quotesVerified: Int

    public init(quotesChecked: Int, quotesVerified: Int) {
        self.quotesChecked = quotesChecked
        self.quotesVerified = quotesVerified
    }
}

// MARK: - JSON helpers

/// Type-erased JSON payload — we keep tool args and SQL cell values as
/// raw JSON because their shapes are open per the protocol.
///
/// `@unchecked Sendable` because `value: Any` defeats the compiler's
/// own check, but every concrete value we put through here is one of
/// the immutable foundation JSON primitives (NSNull/Bool/Int/Double/
/// String/Array/Dictionary). The struct is immutable; we never mutate
/// `value` after construction.
public struct JSONAny: Codable, @unchecked Sendable, Equatable, Hashable {
    public let value: Any

    public static let null = JSONAny(value: NSNull())

    public init(value: Any) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let boolValue = try? container.decode(Bool.self) {
            value = boolValue
        } else if let intValue = try? container.decode(Int.self) {
            value = intValue
        } else if let doubleValue = try? container.decode(Double.self) {
            value = doubleValue
        } else if let stringValue = try? container.decode(String.self) {
            value = stringValue
        } else if let arr = try? container.decode([JSONAny].self) {
            value = arr.map(\.value)
        } else if let obj = try? container.decode([String: JSONAny].self) {
            value = obj.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try JSONAny.encodeValue(value, into: &container)
    }

    private static func encodeValue(
        _ value: Any,
        into container: inout SingleValueEncodingContainer
    ) throws {
        switch value {
        case is NSNull: try container.encodeNil()
        case let boolValue as Bool: try container.encode(boolValue)
        case let intValue as Int: try container.encode(intValue)
        case let doubleValue as Double: try container.encode(doubleValue)
        case let stringValue as String: try container.encode(stringValue)
        case let arr as [Any]:
            try container.encode(arr.map { JSONAny(value: $0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { JSONAny(value: $0) })
        default:
            try container.encodeNil()
        }
    }

    /// Equatable / Hashable via the JSON string. The actual `Any`
    /// can't conform; the string form is canonical enough for our
    /// diff/dedupe needs.
    public static func == (lhs: JSONAny, rhs: JSONAny) -> Bool {
        lhs.jsonString == rhs.jsonString
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(jsonString)
    }

    public var jsonString: String {
        let data = try? JSONSerialization.data(
            withJSONObject: value,
            options: [.fragmentsAllowed, .sortedKeys]
        )
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    public var prettyString: String {
        let data = try? JSONSerialization.data(
            withJSONObject: value,
            options: [.fragmentsAllowed, .prettyPrinted, .sortedKeys]
        )
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}

// MARK: - SSE stream item

/// One item surfaced by `AgentClient.events()`: a decoded `AgentEvent`
/// plus the SSE `id:` it arrived with (nil when the frame carried no id,
/// e.g. the `agent.resync` control event). The supervisor records the
/// last non-nil `id` so it can resume past it via `Last-Event-ID`.
public struct AgentStreamItem: Sendable, Equatable {
    public let id: String?
    public let event: AgentEvent

    public init(id: String?, event: AgentEvent) {
        self.id = id
        self.event = event
    }
}

// MARK: - Activity clock (SSE idle watchdog)

/// Thread-safe monotonic-ish "time since last activity" used by the SSE
/// idle watchdog. Touched from the byte-reading task on every byte and
/// read from the watchdog task, so it must be safe across tasks.
///
/// `@unchecked Sendable`: the single `Date` field is guarded by the lock
/// on every access; the compiler can't prove that itself.
final class ActivityClock: @unchecked Sendable {
    private let lock = NSLock()
    private var last = Date()

    func touch() {
        lock.lock()
        last = Date()
        lock.unlock()
    }

    func secondsSinceLast() -> TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        return Date().timeIntervalSince(last)
    }
}

// MARK: - SSE frame parser

/// One completed SSE frame: the joined `data:` payload plus the effective
/// event `id`. Per the SSE spec the last seen `id:` persists across
/// frames until changed, so `id` reflects the most recent id field.
struct SSEFrame: Equatable {
    let data: String
    let id: String?
}

/// Byte-level SSE frame state machine. The caller feeds one byte at a
/// time via `consume(byte:)`; when a complete frame terminates (blank
/// line per the SSE spec) the method returns the joined `data:` payload
/// plus the current event id. Multiple `data:` lines within a single
/// frame are joined with `\n` as the spec mandates.
///
/// Pulled out as a value type so the unit tests can exercise it without
/// standing up a fake URLSession. The live SSE loop in
/// `AgentClient.events()` drives this parser; nothing else should hold
/// a long-lived reference to it.
struct SSEFrameParser {
    private var lineBuf: [UInt8] = []
    private var dataBuf: String = ""
    /// Last `id:` value seen. Per the SSE spec this persists across frames
    /// until a new `id:` line changes it, so it's the effective id for
    /// every subsequent frame.
    private var lastEventId: String?

    /// Push one byte through the parser. Returns the completed frame when
    /// the byte was the LF that terminated a blank line (frame boundary)
    /// AND at least one `data:` line had been seen since the previous
    /// boundary. Returns nil otherwise.
    mutating func consume(byte: UInt8) -> SSEFrame? {
        if byte != 0x0A {
            lineBuf.append(byte)
            return nil
        }
        let line = String(decoding: lineBuf, as: UTF8.self)
        lineBuf.removeAll(keepingCapacity: true)
        let isBlank = line.isEmpty || line == "\r"
        if isBlank {
            guard !dataBuf.isEmpty else { return nil }
            // Trim the trailing `\n` that came from the last `data:`
            // line so single-line payloads (the common case) round-trip
            // byte-for-byte through JSON-decoding.
            let payload = dataBuf.hasSuffix("\n") ? String(dataBuf.dropLast()) : dataBuf
            dataBuf = ""
            return SSEFrame(data: payload, id: lastEventId)
        }
        // Trim trailing CR for CRLF servers.
        let trimmedLine = line.hasSuffix("\r") ? String(line.dropLast()) : line
        if trimmedLine.hasPrefix(":") {
            // Comment / heartbeat — ignored (but still resets the idle clock
            // upstream because every byte does).
            return nil
        }
        if trimmedLine.hasPrefix("data:") {
            let value = trimmedLine.dropFirst("data:".count)
                .drop(while: { $0 == " " })
            dataBuf += value
            dataBuf += "\n"
        } else if trimmedLine.hasPrefix("id:") {
            let value = trimmedLine.dropFirst("id:".count)
                .drop(while: { $0 == " " })
            lastEventId = String(value)
        }
        // Other SSE fields (event, retry) are unused by the gateway.
        return nil
    }

    /// Convenience for tests + tools: drive the parser over a `Data`
    /// blob and collect every frame's `data:` payload.
    static func parse(_ data: Data) -> [String] {
        parseFrames(data).map(\.data)
    }

    /// Like `parse`, but returns the full frames (data + id) so tests can
    /// assert the `id:` plumbing that drives SSE resume.
    static func parseFrames(_ data: Data) -> [SSEFrame] {
        var parser = SSEFrameParser()
        var out: [SSEFrame] = []
        for byte in data {
            if let frame = parser.consume(byte: byte) {
                out.append(frame)
            }
        }
        return out
    }
}
