// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// End-to-end tests for the iOS transport clients against a live gateway.
///
/// Unlike `GatewayClientTests` / `SearchClientTests` / `AdminClientTests`
/// (which inject a `MockSession` and assert on the request shape +
/// response decoding), this suite drives the same clients against a real
/// gateway process spawned by `scripts/run-ios-e2e.sh`. It catches the
/// regression class no mock can:
///
///   - gateway response payload renamed a field → Swift `Decodable`
///     bails (silent today, surfaces here)
///   - HTTP route moved or renamed → real 404, not a mock false-success
///   - auth scope tightened → real 403, not a mock that accepts anything
///
/// Skipping: the suite no-ops if `/tmp/omnesis-ios-e2e-config.json`
/// is missing or empty, so running `xcodebuild test` standalone
/// (without the shell wrapper) doesn't spuriously fail on the missing
/// gateway. The wrapper writes that file before invoking xcodebuild
/// and removes it on exit. File-based handoff (instead of env vars)
/// because xcodebuild doesn't propagate env into the simulator's test
/// process — the simulator inherits the host user's filesystem access,
/// so the test process CAN read host-side `/tmp` paths.
final class GatewayLiveE2ETests: XCTestCase {
    private var baseURL: URL!
    private var apiKey: String!
    private var session: URLSession!

    /// How long one reachability attempt waits. Long enough for a first
    /// connection on a loaded runner, which has taken over 11 s.
    private static let transportAttemptSeconds: TimeInterval = 15
    /// How long the simulator gets to start answering before a test fails. The
    /// longest stall seen lasted 103 s from app launch.
    private static let transportBudgetSeconds: TimeInterval = 240

    override func setUp() async throws {
        try await super.setUp()
        let path = "/tmp/omnesis-ios-e2e-config.json"
        guard let data = FileManager.default.contents(atPath: path) else {
            throw XCTSkip(
                "\(path) not found — skipping live-gateway E2E. " +
                    "Run `scripts/run-ios-e2e.sh` to enable."
            )
        }
        struct Config: Decodable {
            let gatewayURL: String
            let apiToken: String
        }
        let cfg = try JSONDecoder().decode(Config.self, from: data)
        guard !cfg.gatewayURL.isEmpty, !cfg.apiToken.isEmpty,
              let url = URL(string: cfg.gatewayURL)
        else {
            throw XCTSkip("\(path) has empty fields — skipping live-gateway E2E.")
        }
        baseURL = url
        apiKey = cfg.apiToken
        // The synth gateway uses an auto-generated self-signed TLS cert.
        // Production iOS pins the leaf fingerprint via PairingService +
        // OmnesisURLSession; for E2E we don't go through pairing, so we
        // accept the test cert directly. This is the ONLY place we
        // bypass cert validation — production transport keeps using
        // OmnesisURLSession.shared with its pinned trust path.
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        session = URLSession(
            configuration: config,
            delegate: LiveSessionDelegate(),
            delegateQueue: nil
        )
        try await waitForTransport()
    }

    /// Waits until this process can get an answer from the gateway, so each test
    /// judges the gateway rather than the simulator it runs in. On a loaded runner
    /// the simulator can hold every request for over a minute before opening a
    /// socket, past a single request's 60 s timeout, and then recover completely.
    ///
    /// Only a timeout is tried again. Any answer, whatever its status, and any other
    /// failure end the wait, so the test's own request still reports them.
    private func waitForTransport() async throws {
        let started = Date()
        var probe = URLRequest(url: baseURL.appendingPathComponent("health"))
        probe.timeoutInterval = Self.transportAttemptSeconds
        probing: while true {
            do {
                _ = try await session.data(for: probe)
                break probing
            } catch let error as URLError where error.code == .timedOut {
                let waited = Date().timeIntervalSince(started)
                guard waited < Self.transportBudgetSeconds else {
                    throw URLError(.timedOut, userInfo: [
                        NSLocalizedDescriptionKey: String(
                            format: "No answer from the live gateway after %.0f s of /health probes.",
                            waited
                        ),
                    ])
                }
            } catch {
                break probing
            }
        }
        let waited = Date().timeIntervalSince(started)
        if waited >= 1 {
            NSLog("[live-e2e] transport ready after %.1fs", waited)
        }
    }

    override func tearDown() {
        session?.invalidateAndCancel()
        session = nil
        super.tearDown()
    }

    // MARK: - GatewayClient (lowest-level HTTP)

    /// `GET /health` — no auth required, simplest reachability probe.
    func testHealthProbeReturnsOk() async throws {
        let client = GatewayClient(baseURL: baseURL, token: apiKey, session: session)
        let ok = try await client.health()
        XCTAssertTrue(ok, "Gateway /health should return ok=true")
    }

    /// `GET /status` — auth required, exercises the bearer-token path.
    /// A 401 here means the token the shell script captured doesn't
    /// match the gateway's expected scope.
    func testAuthedPingAcceptsBootstrapToken() async throws {
        let client = GatewayClient(baseURL: baseURL, token: apiKey, session: session)
        try await client.authedPing()
    }

    /// Privacy's Activity pane loads these two routes together on every refresh.
    /// Keep the real gateway payload and the iOS Decodable contract covered as
    /// one path.
    func testPrivacyActivityRefreshDecodesCleanly() async throws {
        let client = PrivacyClient(baseURL: baseURL, token: apiKey, session: session)

        async let feed = client.listExchangeFeed(limit: 50)
        async let watchRequests = client.listSubscriptionApprovals(status: "pending", limit: 50)
        _ = try await (feed, watchRequests)
    }

    // MARK: - SearchClient (read paths the iOS Search tab uses)

    /// Status snapshot decode round-trip. Catches "gateway changed a
    /// field name in the response and Swift Decodable no longer parses".
    func testStatusSnapshotDecodesCleanly() async throws {
        let client = SearchClient(baseURL: baseURL, token: apiKey, session: session)
        let snap = try await client.getStatus()
        // The e2e-minimal universe registers 19 sources. We don't assert
        // a specific count (the synth E2E harness doesn't always have
        // /admin/sources populated — see cli.e2e.test.ts comment),
        // but the snapshot should at least be decodable and structured.
        XCTAssertNotNil(snap, "status snapshot decoded into the iOS shape")
    }

    /// `listPeople` against the live people graph. Decode-path coverage
    /// for `Page<PersonSummary>` and the underlying `PersonSummary` shape.
    /// `aliasCount` is a known field consumers depend on — flag explicitly.
    func testListPeopleSearchByName() async throws {
        let client = SearchClient(baseURL: baseURL, token: apiKey, session: session)
        let hits = try await client.listPeople(query: "Jane Doe", limit: 5)
        XCTAssertFalse(hits.isEmpty, "Jane Doe should resolve in the people graph")
        // Some hit's alias count should be > 0 — the resolver attaches
        // email + name aliases for every persona that appears in any doc.
        let hasAliases = hits.contains { $0.aliasCount > 0 }
        XCTAssertTrue(hasAliases, "at least one matching person should have aliases")
    }

    /// Per-person detail decode + alias enumeration. Catches schema
    /// breakage in `PersonDetail` (large, deeply-nested type — likely
    /// place for a Codable mismatch to land).
    func testGetPersonDetailDecodes() async throws {
        let search = SearchClient(baseURL: baseURL, token: apiKey, session: session)
        let hits = try await search.listPeople(query: "Jane Doe", limit: 1)
        guard let summary = hits.first else {
            XCTFail("Jane Doe should be resolvable")
            return
        }
        let detail = try await search.getPerson(id: summary.id)
        XCTAssertEqual(detail.id, summary.id)
        XCTAssertGreaterThan(
            detail.aliases.count,
            0,
            "Jane Doe should have at least one alias on the live gateway"
        )
    }

    /// The widget reads the gateway's real task DTO and completes the same
    /// task through its compact transport, without invoking a model.
    func testWidgetFetchAndCompleteTask() async throws {
        let day = TaskWidgetSchedule.dayString(Date())
        var create = URLRequest(url: baseURL.appendingPathComponent("tasks"))
        create.httpMethod = "POST"
        create.setValue("Bearer \(apiKey!)", forHTTPHeaderField: "Authorization")
        create.setValue("application/json", forHTTPHeaderField: "Content-Type")
        create.httpBody = try JSONSerialization.data(withJSONObject: [
            "title": "Outline a community workshop",
            "scheduledFor": day,
        ])
        let (body, response) = try await session.data(for: create)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        struct Created: Decodable { let task: TaskWidgetTask }
        let task = try JSONDecoder().decode(Created.self, from: body).task
        let credential = TaskWidgetCredential(
            url: baseURL,
            token: apiKey,
            deviceId: "widget-test-device",
            tlsMode: "system"
        )
        let testSession = try XCTUnwrap(session)
        let widget = TaskWidgetClient(credential: credential, request: { try await testSession.data(for: $0) })
        let before = try await widget.fetch()
        XCTAssertTrue(before.tasks.contains { $0.id == task.id })
        try await widget.complete(id: task.id)
        let after = try await widget.fetch()
        XCTAssertFalse(after.tasks.contains { $0.id == task.id })
        let tasks = TasksClient(baseURL: baseURL, token: apiKey, session: testSession)
        let detail = try await tasks.detail(id: task.id)
        XCTAssertEqual(detail.task.state, .done)
        _ = try await tasks.perform(.delete, on: task.id)
    }

    func testPairedOwnerCanCreateReopenAndEditASourceFilteredLevel() async throws {
        let access = AccessClient(baseURL: baseURL, token: apiKey, session: session)
        var source: AccessSourceInstance?
        var field: FilterEditorField?
        for _ in 0 ..< 60 {
            let overview = try await access.overview()
            XCTAssertTrue(overview.sourceFilters?.enabled == true)
            for candidate in overview.sources where candidate.filterable == true {
                let editor = try await access.filterEditor(sourceId: candidate.id)
                if let ready = editor.fields.first(where: { $0.capability == "membership" && $0.state.isReady }) {
                    source = candidate
                    field = ready
                    break
                }
            }
            if source != nil { break }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        let selectedSource = try XCTUnwrap(source, "No account offered a ready filter field")
        let options = try await access.scopeOptions(sourceId: selectedSource.id, field: XCTUnwrap(field).field)
        let selected = try XCTUnwrap(options.items.first)
        var policy = ScopePolicy.empty(sourceId: selectedSource.id, levelId: "new", capability: "direct")
        policy.rules = [.init(match: [selected.ref], action: "share")]
        policy.otherwise = "hide"
        let boundary = AccessSourceBoundary(mode: .allowlist, sourceIds: [selectedSource.id])
        let created = try await access.createLevel(
            name: "native scope editor \(UUID().uuidString)",
            rules: [.direct(sources: boundary, filterRevision: 0, scopePolicies: [policy])]
        )
        let reopened = try await access.overview().levels.first { $0.id == created.id }
        let savedPolicy = try XCTUnwrap(reopened?.rules.first?.scopePolicies.first)
        XCTAssertEqual(savedPolicy.rules[0].match, [selected.ref])
        XCTAssertEqual(savedPolicy.audience.accessLevel, created.id)
        var counted: ScopePreview?
        for _ in 0 ..< 60 {
            if case .ready(let value) = try await access.scopePreview(savedPolicy) {
                counted = value
                break
            }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        let preview = try XCTUnwrap(counted, "The filter's counts never arrived")
        XCTAssertEqual(preview.total, preview.visible + preview.hidden)
        XCTAssertLessThanOrEqual(preview.tooOld + preview.unmatched, preview.hidden)
        policy = savedPolicy
        policy.rules[0].action = "hide"
        policy.otherwise = "share"
        let revision = created.rules.first?.filterRevision ?? 0
        let updated = try await access.updateLevel(
            id: created.id,
            name: created.name,
            rules: [.direct(sources: boundary, filterRevision: revision, scopePolicies: [policy])],
            expectedRevision: created.revision,
            expectedFilterRevisions: ["direct": revision]
        )
        XCTAssertGreaterThan(updated.revision, created.revision)
        do {
            _ = try await access.updateLevel(
                id: created.id,
                name: created.name,
                rules: created.rules,
                expectedRevision: created.revision,
                expectedFilterRevisions: ["direct": revision]
            )
            XCTFail("A stale native save must not erase a newer filter")
        } catch GatewayClient.Error.serverError(let status, _) { XCTAssertEqual(status, 409) }
    }

    // MARK: - AdminClient (admin-scope paths)

    /// Lists registered devices — should at least return a parseable
    /// empty page (the synth harness doesn't register a device).
    func testListDevicesReturnsParseableShape() async throws {
        let admin = AdminClient(baseURL: baseURL, token: apiKey, session: session)
        // Decode-only assertion: if the response shape drifts and Swift
        // can't parse it, this throws. Content can be empty.
        let devices = try await admin.listDevices()
        XCTAssertNotNil(devices, "device list decoded into iOS shape")
    }

    /// Decode-shape coverage for `/admin/source-descriptors`. The
    /// gateway emits `Page<SerializedDescriptor>`; this test confirms
    /// the iOS struct in `AdminClient.swift` still parses the live
    /// payload. Originally caught a real bug where the Swift struct
    /// declared `importBased: Bool` and `pushBased: Bool` as
    /// non-optional but the gateway never emitted those keys — both
    /// fields were unused in iOS and have since been deleted.
    func testListDescriptorsDecodesCleanly() async throws {
        let admin = AdminClient(baseURL: baseURL, token: apiKey, session: session)
        let descriptors = try await admin.listDescriptors()
        XCTAssertNotNil(descriptors, "descriptor list decoded into iOS shape")
    }
}

// MARK: - DeviceSocket lifecycle

/// Drives the real `DeviceSocket`, `URLSession` WebSocket stack and TLS against
/// the live gateway. The simulator shares its host's network, so the outage comes
/// from `LoopbackForwarder` and the matching path reports are scripted; the real
/// `NWPathMonitor` wrapper is exercised by its own smoke test.
@available(iOS 17.0, *)
extension GatewayLiveE2ETests {
    private final class ScriptedPaths: NetworkPathObserving, @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: AsyncStream<NetworkPathSnapshot>.Continuation?

        func paths() -> AsyncStream<NetworkPathSnapshot> {
            AsyncStream { continuation in
                self.lock.withLock { self.continuation = continuation }
            }
        }

        var isObserved: Bool {
            lock.withLock { continuation != nil }
        }

        func send(_ path: NetworkPathSnapshot) {
            lock.withLock { continuation }?.yield(path)
        }
    }

    /// Longer than any wait below, so a reconnect that happens proves the wake
    /// signal rather than the timer.
    private static var longBackoff: DeviceSocketReconnectPolicy.Limits {
        var limits = DeviceSocketReconnectPolicy.Limits()
        limits.baseDelay = .seconds(600)
        limits.maxDelay = .seconds(600)
        limits.probeTimeout = .seconds(1)
        return limits
    }

    private static let wifi = NetworkPathSnapshot(isUsable: true, interfaces: [.wifi])
    private static let cellular = NetworkPathSnapshot(isUsable: true, interfaces: [.cellular])
    private static let noNetwork = NetworkPathSnapshot(isUsable: false, interfaces: [])

    /// Mints a device the way `omnesis devices pair` and the app do.
    private func pairDeviceToken() async throws -> String {
        var mint = URLRequest(url: baseURL.appendingPathComponent("admin/devices/pair"))
        mint.httpMethod = "POST"
        mint.setValue("Bearer \(apiKey!)", forHTTPHeaderField: "Authorization")
        mint.setValue("application/json", forHTTPHeaderField: "Content-Type")
        mint.httpBody = Data(#"{"kind":"ios"}"#.utf8)
        let (minted, _) = try await session.data(for: mint)
        struct Minted: Decodable { let pairingCode: String }
        let code = try JSONDecoder().decode(Minted.self, from: minted).pairingCode

        var redeem = URLRequest(url: baseURL.appendingPathComponent("devices/pair"))
        redeem.httpMethod = "POST"
        redeem.setValue("application/json", forHTTPHeaderField: "Content-Type")
        redeem.httpBody = try JSONEncoder().encode(JSONValue.object([
            "pairingCode": .string(code),
            "capabilities": .object(PairingCapabilities.ios().jsonObject),
        ]))
        let (paired, _) = try await session.data(for: redeem)
        return try JSONDecoder().decode(DevicePairResponse.self, from: paired).token
    }

    private func forwarder() throws -> LoopbackForwarder {
        try LoopbackForwarder(
            targetHost: XCTUnwrap(baseURL.host),
            targetPort: UInt16(XCTUnwrap(baseURL.port))
        )
    }

    private func socket(
        port: UInt16,
        token: String,
        paths: ScriptedPaths,
        session: URLSession? = nil
    ) throws
        -> DeviceSocket {
        try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "https://127.0.0.1:\(port)")),
            token: token,
            connector: URLSessionDeviceSocketConnector(session: session ?? self.session),
            pathObserver: paths,
            clock: ContinuousDeviceSocketClock(),
            limits: Self.longBackoff
        )
    }

    private func start(_ socket: DeviceSocket, paths: ScriptedPaths, initial: NetworkPathSnapshot) async throws {
        await socket.start()
        try await waitUntil("the path observer") { paths.isObserved }
        paths.send(initial)
    }

    private func waitUntil(
        _ what: String,
        // A loaded simulator can hold requests for over a minute and then recover.
        timeout: Duration = .seconds(240),
        _ condition: () async -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("timed out waiting for \(what)")
        throw GatewayClient.Error.invalidResponse
    }

    private func isConnected(_ socket: DeviceSocket) async -> Bool {
        if case .connected = await socket.state() { return true }
        return false
    }

    func testDeviceSocketReconnectsWhenTheNetworkReturnsDuringALongBackoff() async throws {
        let token = try await pairDeviceToken()
        let forwarder = try forwarder()
        defer { forwarder.stop() }
        let port = try await forwarder.start()
        let paths = ScriptedPaths()
        let socket = try socket(port: port, token: token, paths: paths)
        try await start(socket, paths: paths, initial: Self.wifi)
        try await waitUntil("the first connection") { await self.isConnected(socket) }

        paths.send(Self.noNetwork)
        forwarder.stop()
        try await waitUntil("the drop to be reported as temporary") {
            guard case .reconnecting(let status) = await socket.state() else { return false }
            return status.network == .unavailable && status.lastError != nil
        }

        _ = try await forwarder.start(port: port)
        let restoredAt = ContinuousClock.now
        paths.send(Self.wifi)
        try await waitUntil("the reconnection") { await self.isConnected(socket) }
        XCTAssertLessThan(restoredAt.duration(to: .now), .seconds(300), "the 600s timer must not have been needed")
        XCTAssertEqual(forwarder.acceptedConnections, 2)
        await socket.stop()
    }

    func testDeviceSocketReportsARefusedConnectionAsTemporaryWithItsDiagnostic() async throws {
        let token = try await pairDeviceToken()
        let forwarder = try forwarder()
        defer { forwarder.stop() }
        let port = try await forwarder.start()
        forwarder.stop()
        let paths = ScriptedPaths()
        let socket = try socket(port: port, token: token, paths: paths)
        try await start(socket, paths: paths, initial: Self.wifi)

        // A refused attempt can fail before the first path arrives, so the state
        // settles on this once both have, in either order.
        let temporaryFailure = DeviceSocket.ConnectionState.reconnecting(.init(
            network: .available,
            lastError: "Could not connect to the server.",
            failedAttemptsOnNetwork: 1
        ))
        try await waitUntil("the failed attempt") { await socket.state() == temporaryFailure }

        // A usable-looking path is only a hint: this one wakes a retry that
        // fails too, and the state stays temporary rather than alarming.
        paths.send(Self.cellular)
        try await Task.sleep(for: .seconds(1))
        try await waitUntil("the woken retry's failure") { await socket.state() == temporaryFailure }

        _ = try await forwarder.start(port: port)
        paths.send(Self.wifi)
        try await waitUntil("the reconnection") { await self.isConnected(socket) }
        await socket.stop()
    }

    func testDeviceSocketTreatsARejectedTokenAsAuthenticationFailure() async throws {
        let forwarder = try forwarder()
        defer { forwarder.stop() }
        let port = try await forwarder.start()
        let paths = ScriptedPaths()
        let socket = try socket(port: port, token: "omn_invalid_for_this_test", paths: paths)
        try await start(socket, paths: paths, initial: Self.wifi)

        try await waitUntil("the refusal") {
            if case .failed = await socket.state() { return true }
            return false
        }
        let state = await socket.state()
        guard case .failed(let failure) = state else { return XCTFail("got \(state)") }
        XCTAssertEqual(failure.kind, .authentication)
        await socket.stop()
    }

    func testDeviceSocketFailsClosedWhenTheCertificateDoesNotMatchThePin() async throws {
        let token = try await pairDeviceToken()
        let pinned = PinnedSession(fingerprintHex: String(repeating: "0", count: 64))
        let forwarder = try forwarder()
        defer { forwarder.stop() }
        let port = try await forwarder.start()
        let paths = ScriptedPaths()
        let socket = try socket(
            port: port,
            token: token,
            paths: paths,
            session: pinned.session
        )
        try await start(socket, paths: paths, initial: Self.wifi)

        try await waitUntil("the refusal") {
            if case .failed = await socket.state() { return true }
            return false
        }
        let state = await socket.state()
        guard case .failed(let failure) = state else { return XCTFail("got \(state)") }
        XCTAssertEqual(failure.kind, .certificate)

        // A network change retries, and through the same pinned session.
        paths.send(Self.cellular)
        try await waitUntil("the retry") { forwarder.acceptedConnections >= 2 }
        try await Task.sleep(for: .milliseconds(500))
        let afterRetry = await socket.state()
        guard case .failed(let retried) = afterRetry else { return XCTFail("got \(afterRetry)") }
        XCTAssertEqual(retried.kind, .certificate)
        await socket.stop()
    }

    func testDeviceSocketReplacesAConnectionThatStoppedAnsweringOnForeground() async throws {
        let token = try await pairDeviceToken()
        let forwarder = try forwarder()
        defer { forwarder.stop() }
        let port = try await forwarder.start()
        let paths = ScriptedPaths()
        let socket = try socket(port: port, token: token, paths: paths)
        try await start(socket, paths: paths, initial: Self.wifi)
        try await waitUntil("the first connection") { await self.isConnected(socket) }

        forwarder.muteExistingConnections()
        await socket.appDidBecomeActive()
        try await waitUntil("a second connection after the unanswered ping") {
            forwarder.acceptedConnections == 2
        }
        try await waitUntil("the reconnection") { await self.isConnected(socket) }
        await socket.stop()
    }

    func testDeviceSocketKeepsAHealthyConnectionThroughAForegroundProbe() async throws {
        let token = try await pairDeviceToken()
        let forwarder = try forwarder()
        defer { forwarder.stop() }
        let port = try await forwarder.start()
        let paths = ScriptedPaths()
        let socket = try socket(port: port, token: token, paths: paths)
        try await start(socket, paths: paths, initial: Self.wifi)
        try await waitUntil("the first connection") { await self.isConnected(socket) }

        await socket.appDidBecomeActive()
        // Past the probe timeout, so a missing pong would already have replaced it.
        try await Task.sleep(for: .seconds(2))
        let connected = await isConnected(socket)
        XCTAssertTrue(connected)
        XCTAssertEqual(forwarder.acceptedConnections, 1)

        await socket.stop()
        paths.send(Self.cellular)
        await socket.appDidBecomeActive()
        try await Task.sleep(for: .seconds(1))
        XCTAssertEqual(forwarder.acceptedConnections, 1, "a stopped socket stays down")
    }

    /// The simulator's path is its host's, so this proves the wrapper runs and
    /// reports a path; only a device can show one changing.
    func testSystemPathObserverReportsTheCurrentPath() async {
        let first = await withTaskGroup(of: NetworkPathSnapshot?.self) { group -> NetworkPathSnapshot? in
            group.addTask {
                for await path in SystemNetworkPathObserver().paths() {
                    return path
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(10))
                return nil
            }
            defer { group.cancelAll() }
            guard let result = await group.next() else { return nil }
            return result
        }
        XCTAssertNotNil(first, "NWPathMonitor reports the current path as soon as it starts")
    }
}

// MARK: - Helpers

/// The live suite's session delegate. Test-only — production uses
/// `OmnesisURLSession.shared`, which pins the gateway's leaf fingerprint via
/// Keychain.
///
/// It accepts any server TLS cert, and logs where each request spent its time.
/// A request that times out says nothing about how far it got, so this line is
/// what separates a client that never connected from a gateway that never
/// answered: a phase that started and did not finish reads `unfinished`, and one
/// never reached reads `-`.
private final class LiveSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didFinishCollecting metrics: URLSessionTaskMetrics
    ) {
        let request = "\(task.originalRequest?.httpMethod ?? "?") \(task.originalRequest?.url?.path ?? "?")"
        let total = String(format: "%.2fs", metrics.taskInterval.duration)
        for transaction in metrics.transactionMetrics {
            let phases = [
                "reused=\(transaction.isReusedConnection)",
                "dns=\(span(transaction.domainLookupStartDate, transaction.domainLookupEndDate))",
                "connect=\(span(transaction.connectStartDate, transaction.connectEndDate))",
                "tls=\(span(transaction.secureConnectionStartDate, transaction.secureConnectionEndDate))",
                "wait=\(span(transaction.requestEndDate, transaction.responseStartDate))",
                "body=\(span(transaction.responseStartDate, transaction.responseEndDate))",
                "peer=\(transaction.remoteAddress ?? "-")",
            ].joined(separator: " ")
            NSLog("[live-e2e] %@ total=%@ %@", request, total, phases)
        }
    }

    private func span(_ start: Date?, _ end: Date?) -> String {
        guard let start else { return "-" }
        guard let end else { return "unfinished" }
        return String(format: "%.2fs", end.timeIntervalSince(start))
    }
}
