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

    override func setUpWithError() throws {
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
            delegate: AcceptAnyCertDelegate(),
            delegateQueue: nil
        )
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

// MARK: - Helpers

/// `URLSessionDelegate` that accepts any server TLS cert. Test-only —
/// production uses `OmnesisURLSession.shared`, which pins the gateway's
/// leaf fingerprint via Keychain.
private final class AcceptAnyCertDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
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
}
