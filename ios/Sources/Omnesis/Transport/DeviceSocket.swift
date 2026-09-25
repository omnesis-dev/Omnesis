// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Bidirectional WebSocket client for the gateway's `/device/ws` endpoint.
///
/// Protocol (see `packages/core/src/ws-messages.ts` for the typed registry):
///   1. Connect with `Authorization: Bearer <token>` on the HTTP upgrade.
///   2. Send command `{kind:"command", id, type:"hello",
///      payload:{capabilities?, protocolVersion: 1}}`.
///   3. Await `{kind:"response", correlationId, ok:true,
///      result:{deviceId, scopes, deviceName, deviceKind, protocolVersion}}`.
///      `protocolVersion` mismatch yields `ok:false`,
///      `error.code = "protocol_version_mismatch"`.
///   4. Receive events: `{kind:"event", type, payload}` — route to the UI.
///
/// Auto-reconnects with exponential backoff (1s, 2s, 4s, …, capped at 30s)
/// when the socket drops. The `events` AsyncStream keeps yielding as new
/// events arrive across reconnects.
@available(iOS 17.0, *)
public actor DeviceSocket {
    public enum ConnectionState: Equatable, Sendable {
        case disconnected
        case connecting
        case authenticating
        case connected(deviceId: String, deviceName: String, scopes: [String])
        case failed(String)
    }

    /// A raw event from the gateway. The `type` field routes to a handler;
    /// `payload` is the parsed JSON value (caller decodes further).
    public struct Event: Sendable, Equatable {
        public let type: String
        public let payload: JSONValue
    }

    /// Wire protocol version this client speaks. Must match the gateway's
    /// `PROTOCOL_VERSION` exported from `@omnesis/core/ws-messages.ts`. Bump
    /// in lockstep with the gateway when the registry shape changes
    /// incompatibly.
    static let protocolVersion: Int = 1 // PARITY:device-ws-protocol-version

    private let url: URL
    private let token: String
    private let session: URLSession
    private let capabilities: PairingCapabilities

    /// Public channel of events. The single consumer is typically the app
    /// store; callers iterate with `for await event in socket.events`.
    /// `nonisolated` so callers can subscribe without awaiting actor state.
    public nonisolated let events: AsyncStream<Event>
    private let eventsContinuation: AsyncStream<Event>.Continuation

    public nonisolated let stateChanges: AsyncStream<ConnectionState>
    private let stateContinuation: AsyncStream<ConnectionState>.Continuation

    private var task: URLSessionWebSocketTask?
    private var runner: Task<Void, Never>?
    private var reconnectAttempt = 0
    private var currentState: ConnectionState = .disconnected
    private var stopped = false

    private let log = AppLog.make(category: "transport.ws")

    public init(
        gatewayUrl: URL,
        token: String,
        session: URLSession = OmnesisURLSession.shared,
        capabilities: PairingCapabilities = .ios()
    ) {
        self.url = DeviceSocket.deriveWsURL(from: gatewayUrl)
        self.token = token
        // OmnesisURLSession.shared pins the gateway's TLS leaf cert when a
        // fingerprint is in Keychain (post-pair) and falls through to
        // URLSession.shared otherwise. URLSessionWebSocketTask is supported
        // by both shapes — both .ephemeral (PinnedSession) and .default.
        self.session = session
        self.capabilities = capabilities

        var econt: AsyncStream<Event>.Continuation!
        self.events = AsyncStream { econt = $0 }
        self.eventsContinuation = econt

        var scont: AsyncStream<ConnectionState>.Continuation!
        self.stateChanges = AsyncStream { scont = $0 }
        self.stateContinuation = scont
    }

    deinit {
        eventsContinuation.finish()
        stateContinuation.finish()
    }

    /// Start the connect / reconnect loop. Safe to call once — subsequent
    /// calls are no-ops. A stopped socket is terminal; pairing rebuilds create
    /// a new instance. This also makes stop-before-start safe when teardown
    /// races the coordinator's asynchronous startup task.
    public func start() {
        guard !stopped, runner == nil else { return }
        runner = Task { [weak self] in
            await self?.runLoop()
        }
    }

    /// Close the socket and stop reconnecting.
    public func stop() {
        stopped = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        runner?.cancel()
        runner = nil
        updateState(.disconnected)
    }

    public func state() -> ConnectionState {
        currentState
    }

    /// Resolves true once the socket has completed a hello. The gateway
    /// refreshes the device's stored capabilities before it acknowledges the
    /// hello, so a connected socket means the capability row is fresh — a
    /// consent tap that waits for this can no longer outrun it. Polls the
    /// actor-isolated state rather than the stateChanges stream so a stale
    /// buffered event can never satisfy the wait.
    public func waitUntilConnected(timeout: Duration = .seconds(10)) async -> Bool {
        if case .connected = currentState { return true }
        let start = ContinuousClock().now
        while !Task.isCancelled {
            if case .connected = currentState { return true }
            if ContinuousClock().now - start >= timeout { break }
            try? await Task.sleep(for: .milliseconds(200))
        }
        // A cancel racing a connect must not satisfy the wait: the caller's
        // tap is dead, and no retry may be issued on its behalf.
        if Task.isCancelled { return false }
        if case .connected = currentState { return true }
        return false
    }

    #if DEBUG
    func runnerActiveForTesting() -> Bool {
        runner != nil
    }
    #endif

    /// Send an event frame upstream to the gateway.
    ///
    /// Mirror of the desktop collector's `wsClient.emitEvent(type, payload)`:
    /// produces a `{kind:"event", type, payload}` frame that the gateway
    /// routes through `onDeviceEvent`. Used by CollectorCore to publish
    /// `sync.status` lifecycle events so the gateway's SyncStatusRegistry
    /// (and therefore `/admin/sync/status` + the portal / CLI)
    /// reflect the iOS-side sync in real time.
    ///
    /// Drops silently if the socket isn't currently connected — the gateway
    /// maintains last-known state, a missed frame just means the portal
    /// shows stale info until the next sync lifecycle event lands.
    public func emitEvent(type: String, payload: [String: JSONValue]) async {
        guard let task else {
            log.debug("emitEvent dropped (no active socket): \(type, privacy: .public)")
            return
        }
        let frame: [String: JSONValue] = [
            "kind": .string("event"),
            "type": .string(type),
            "payload": .object(payload),
        ]
        do {
            try await send(object: frame, via: task)
        } catch {
            log.warning("emitEvent(\(type, privacy: .public)) failed: \(String(describing: error), privacy: .private)")
        }
    }

    nonisolated static func helloCommand(
        id: String,
        capabilities: PairingCapabilities = .ios()
    )
        -> [String: JSONValue] {
        [
            "kind": .string("command"),
            "id": .string(id),
            "type": .string("hello"),
            "payload": .object([
                "capabilities": .object(capabilities.jsonObject),
                "protocolVersion": .int(Int64(protocolVersion)),
            ]),
        ]
    }

    // MARK: - Main loop

    private func runLoop() async {
        while !Task.isCancelled, !stopped {
            updateState(.connecting)
            do {
                try await connectOnce()
                // connectOnce returns when the socket errors/closes; loop to
                // reconnect after backing off.
            } catch {
                log.warning("WS connection failed: \(String(describing: error), privacy: .private)")
                updateState(.failed("\(error.localizedDescription)"))
            }
            if stopped { break }
            let delay = backoffDelay()
            reconnectAttempt += 1
            log.info("WS reconnect in \(delay, privacy: .public)ms (attempt \(self.reconnectAttempt, privacy: .public))")
            try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
        }
    }

    private func connectOnce() async throws {
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()

        // Send hello.
        updateState(.authenticating)
        let helloId = UUID().uuidString
        let helloCmd = Self.helloCommand(id: helloId, capabilities: capabilities)
        try await send(object: helloCmd, via: task)

        // Read messages. First must be the hello response.
        var authenticated = false
        while !Task.isCancelled, !stopped {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                log.warning("WS receive error: \(String(describing: error), privacy: .private)")
                throw error
            }

            guard let frame = decodeFrame(message) else { continue }

            if !authenticated {
                // Expect a response envelope correlated to helloId.
                if case .response(let resp) = frame, resp.correlationId == helloId {
                    switch resp.body {
                    case .ok(let result):
                        let deviceId = extractString(result["deviceId"]) ?? ""
                        let deviceName = extractString(result["deviceName"]) ?? ""
                        let scopes = extractStringArray(result["scopes"]) ?? []
                        reconnectAttempt = 0
                        authenticated = true
                        updateState(.connected(deviceId: deviceId, deviceName: deviceName, scopes: scopes))
                        log.info("WS authenticated as \(deviceName, privacy: .public) (\(deviceId, privacy: .public))")
                        continue
                    case .err(let err):
                        updateState(.failed(err.message))
                        throw GatewayClient.Error.unauthorized
                    }
                }
                // Ignore anything else before auth — shouldn't happen in practice.
                continue
            }

            // Post-auth: one switch covers all three frame kinds.
            //   * `event`   → forward to the app's event stream.
            //   * `command` → gateway wants us to act (source.debug /
            //                 source.sync / sources.snapshot / …). We
            //                 MUST respond — even with ok:false — or the
            //                 gateway's sendCommand hangs for 30s and
            //                 surfaces a timeout to whichever admin
            //                 client called us.
            //   * `response`→ reply to a command we sent (currently only
            //                 `hello`, already handled above). Ignore.
            switch frame {
            case .event(let event):
                if event.type == "ping" { continue }
                eventsContinuation.yield(Event(type: event.type, payload: event.payload))
            case .command(let command):
                await handleIncomingCommand(command, via: task)
            case .response:
                continue
            }
        }
    }

    /// Outcome of running a gateway-originated command locally.
    ///
    /// The gateway validates a successful response's `result` against that
    /// command's schema in `ws-messages.ts` and rejects a payload that doesn't
    /// match, so an ack has to carry the fields its command declares — an
    /// empty object reads as a protocol error, not as "done". A `.failure`
    /// travels as an error envelope instead, which the gateway surfaces as a
    /// structured `WsCommandError` rather than a schema complaint.
    enum CommandOutcome {
        case success(JSONValue)
        case failure(code: String, message: String)
    }

    /// What happened when a gateway-requested sync reached the collector.
    ///
    /// Mirrors the desktop collector's `{ok, triggered, skipped}` acknowledgement
    /// (`packages/collector/src/main.ts`) rather than collapsing to a Bool: an
    /// operator who taps "Sync now" twice, or before the collector exists,
    /// gets an answer that says which of those happened instead of a blanket
    /// success or a misleading "not hosted".
    public enum SyncDispatch: Sendable {
        /// A sync is now running for this source.
        case triggered
        /// The source is hosted here but no sync started — already in flight,
        /// or its collector hasn't been built yet.
        case skipped(reason: String)
        /// No source with this id lives on this device.
        case notHosted
    }

    /// Runs a `source.sync` for the named source. Late-bound by
    /// `AdminCoordinator` because the collector lives on the other side of the
    /// app; unset (previews, tests) means this build hosts nothing.
    private var onSyncRequested: (@Sendable (String) async -> SyncDispatch)?

    /// Wire the sync dispatcher. Called once per socket, before `start()`.
    public func setOnSyncRequested(_ handler: (@Sendable (String) async -> SyncDispatch)?) {
        self.onSyncRequested = handler
    }

    /// Reply to a gateway-originated command. The gateway's
    /// `sendCommand(deviceId, type, payload)` awaits a response envelope with
    /// a matching `correlationId`; without this, admin APIs like
    /// `GET /admin/sources/:id/debug` time out against iOS-hosted sources.
    private func handleIncomingCommand(_ command: WsCommandFrame, via task: URLSessionWebSocketTask) async {
        let outcome = await run(command)

        let response: [String: JSONValue] = switch outcome {
        case .success(let result):
            [
                "kind": .string("response"),
                "correlationId": .string(command.id),
                "ok": .bool(true),
                "result": result,
            ]
        case .failure(let code, let message):
            [
                "kind": .string("response"),
                "correlationId": .string(command.id),
                "ok": .bool(false),
                "error": .object(["code": .string(code), "message": .string(message)]),
            ]
        }

        do {
            try await send(object: response, via: task)
        } catch {
            log.warning("WS respond failed for command \(command.type, privacy: .public): \(String(describing: error), privacy: .private)")
        }
    }

    func run(_ command: WsCommandFrame) async -> CommandOutcome {
        switch command.type {
        case "source.sync":
            guard let sourceId = Self.sourceId(from: command.payload), !sourceId.isEmpty else {
                return .failure(code: "invalid_payload", message: "source.sync requires a sourceId")
            }
            guard let onSyncRequested else {
                return .failure(code: "unsupported", message: "this device hosts no collector")
            }
            // `triggered` counts syncs started, not finished: a full Apple
            // Health cycle far outruns the gateway's 30s command timeout, so
            // acking on completion would time out every call.
            switch await onSyncRequested(sourceId) {
            case .triggered:
                return .success(.object(["ok": .bool(true), "triggered": .int(1), "skipped": .int(0)]))
            case .skipped(let reason):
                // A valid, honest "nothing started" — the schema carries it, so
                // the operator sees the reason rather than a false success.
                return .success(.object([
                    "ok": .bool(true), "triggered": .int(0), "skipped": .int(1), "error": .string(reason),
                ]))
            case .notHosted:
                return .failure(code: "not_hosted", message: "\(sourceId) is not hosted on this device")
            }

        case "source.added", "source.updated", "sources.snapshot":
            // The gateway owns the source registry and the app re-reads it
            // via `refreshSources()` on reconnect, so this acks receipt
            // without claiming to have applied the delta. See #54.
            return .success(.object(["ok": .bool(true), "applied": .bool(false)]))

        case "source.removed":
            // Removal commands also withdraw local opt-in, including a member
            // detach whose logical source survives on sibling devices.
            eventsContinuation.yield(Event(type: command.type, payload: command.payload))
            return .success(.object(["ok": .bool(true), "applied": .bool(false), "deleted": .array([])]))

        case "source.debug":
            // Minimal: confirm the source id is recognized. Full cursor +
            // stats snapshot can come later — today the app doesn't expose
            // that plumbing to the socket layer.
            let sourceId = Self.sourceId(from: command.payload) ?? ""
            return .success(.object([
                "status": .object([
                    "sourceId": .string(sourceId),
                    "note": .string("Live debug not yet implemented on iOS — source is hosted here"),
                ]),
            ]))

        default:
            // Refuse honestly rather than acking a command we didn't run: a
            // blanket `{ok: true}` would report success for work that never
            // happened.
            return .failure(code: "unsupported", message: "\(command.type) is not handled on iOS")
        }
    }

    static func sourceId(from payload: JSONValue) -> String? {
        guard case .object(let p) = payload, case .string(let sid)? = p["sourceId"] else { return nil }
        return sid
    }

    // MARK: - State transitions

    private func updateState(_ s: ConnectionState) {
        currentState = s
        stateContinuation.yield(s)
    }

    // MARK: - Send helpers

    private func send(object: [String: JSONValue], via task: URLSessionWebSocketTask) async throws {
        let data = try JSONEncoder().encode(JSONValue.object(object))
        guard let text = String(data: data, encoding: .utf8) else {
            throw GatewayClient.Error.decoding("ws encode")
        }
        try await task.send(.string(text))
    }

    // MARK: - Decoding

    /// Parse a raw WebSocket message into a typed `WsFrame`. Returns nil
    /// (and logs at debug) for non-JSON or unknown-shape frames.
    private func decodeFrame(_ m: URLSessionWebSocketTask.Message) -> WsFrame? {
        let data: Data
        switch m {
        case .data(let d): data = d
        case .string(let s): data = Data(s.utf8)
        @unknown default: return nil
        }
        do {
            return try JSONDecoder().decode(WsFrame.self, from: data)
        } catch {
            log.debug("WS drop non-JSON frame: \(String(describing: error), privacy: .private)")
            return nil
        }
    }

    private func extractString(_ v: JSONValue?) -> String? {
        if case .string(let s)? = v { return s }
        return nil
    }

    private func extractStringArray(_ v: JSONValue?) -> [String]? {
        guard case .array(let arr)? = v else { return nil }
        var out: [String] = []
        for item in arr {
            if case .string(let s) = item { out.append(s) }
        }
        return out
    }

    // MARK: - Backoff

    private func backoffDelay() -> Int {
        // 1s, 2s, 4s, 8s, 16s, 30s cap. Random jitter to avoid thundering herd.
        let base = min(1000 * (1 << min(reconnectAttempt, 5)), 30000)
        let jitter = Int.random(in: 0 ... (base / 4))
        return base + jitter
    }

    // MARK: - URL munging

    /// Converts an `http(s)://` gateway URL into the matching `ws(s)://` URL
    /// for the `/device/ws` endpoint. Preserves host, port, and any base path.
    private static func deriveWsURL(from gatewayUrl: URL) -> URL {
        guard var comps = URLComponents(url: gatewayUrl, resolvingAgainstBaseURL: false) else {
            return gatewayUrl
        }
        switch comps.scheme?.lowercased() {
        case "https": comps.scheme = "wss"
        case "http": comps.scheme = "ws"
        default: break
        }
        let basePath = comps.path.hasSuffix("/") ? comps.path : (comps.path + "/")
        comps.path = basePath + "device/ws"
        comps.percentEncodedQuery = nil
        return comps.url ?? gatewayUrl
    }
}

// MARK: - Wire envelope (mirrors `packages/core/src/ws-protocol.ts`)

/// A typed gateway-pushed command. Mirrors `WsCommand` on the producer side.
struct WsCommandFrame: Decodable {
    let id: String
    let type: String
    let payload: JSONValue

    init(id: String, type: String, payload: JSONValue) {
        self.id = id
        self.type = type
        self.payload = payload
    }

    enum CodingKeys: String, CodingKey { case id, type, payload }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.type = try c.decode(String.self, forKey: .type)
        self.payload = (try? c.decode(JSONValue.self, forKey: .payload)) ?? .null
    }
}

/// A typed gateway-pushed event. Mirrors `WsEvent` on the producer side.
struct WsEventFrame: Decodable {
    let type: String
    let payload: JSONValue

    enum CodingKeys: String, CodingKey { case type, payload }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.type = try c.decode(String.self, forKey: .type)
        self.payload = (try? c.decode(JSONValue.self, forKey: .payload)) ?? .null
    }
}

/// A typed response envelope. Mirrors `WsResponseOk | WsResponseErr` on the
/// producer side: when `ok:true`, `result` is present; when `ok:false`,
/// `error: { code, message }` is present.
struct WsResponseFrame: Decodable {
    let correlationId: String
    let body: Body

    enum Body {
        case ok(result: [String: JSONValue])
        case err(WsResponseError)
    }

    struct WsResponseError: Decodable {
        let code: String
        let message: String
    }

    enum CodingKeys: String, CodingKey { case correlationId, ok, result, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.correlationId = try c.decode(String.self, forKey: .correlationId)
        let ok = try c.decode(Bool.self, forKey: .ok)
        if ok {
            // Tolerate non-object results by falling back to an empty
            // dict — matches the previous string-typed pattern matcher
            // which only succeeded when `result` was a JSON object.
            let result = (try? c.decode([String: JSONValue].self, forKey: .result)) ?? [:]
            self.body = .ok(result: result)
        } else {
            let err = try c.decode(WsResponseError.self, forKey: .error)
            self.body = .err(err)
        }
    }
}

/// A single inbound WS frame. The `kind` discriminator lives at the top
/// level of the JSON object alongside the rest of the fields (flat
/// shape — see `packages/core/src/ws-protocol.ts`); we read it first and
/// then re-decode the remaining fields into the matching frame type.
enum WsFrame: Decodable {
    case event(WsEventFrame)
    case command(WsCommandFrame)
    case response(WsResponseFrame)

    private enum CodingKeys: String, CodingKey { case kind }
    private enum Kind: String, Decodable { case event, command, response }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(Kind.self, forKey: .kind)
        switch kind {
        case .event: self = try .event(WsEventFrame(from: decoder))
        case .command: self = try .command(WsCommandFrame(from: decoder))
        case .response: self = try .response(WsResponseFrame(from: decoder))
        }
    }
}
