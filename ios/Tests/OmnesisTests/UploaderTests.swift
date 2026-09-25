// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The uploader decides, from a gateway response, whether a batch is worth
/// keeping. Both directions are expensive to get wrong: call a transient
/// failure permanent and an outage costs the user data; call a permanent one
/// transient and the batch is retried forever, pinning the delivery-health
/// warning on a queue that can never drain.
///
/// These drive the real classification through real HTTP statuses rather
/// than asserting on the enum, because the mapping from status to outcome is
/// exactly what has to hold.
final class UploaderTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-uploader-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    /// Quarantine after two failures with no grace period, so a test can
    /// reach the decision without waiting out a real window.
    private func buffer(attempts: Int = 2) -> OfflineBuffer {
        OfflineBuffer(
            directory: directory,
            config: OfflineBuffer.Config(
                maxSizeBytes: 1_000_000,
                warningSizeBytes: 500_000,
                quarantineAfterAttempts: attempts,
                quarantineGrace: 0,
                maxQuarantinedBatches: 25
            )
        )
    }

    private func gateway(status: Int, body: String = "{}") throws -> GatewayClient {
        let session = CollectorCoreTests.MockSession()
        session.responder = { req in
            let http = HTTPURLResponse(
                url: req.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), http)
        }
        return try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://gateway.invalid:7600")),
            token: "omn_test",
            session: session
        )
    }

    private func enqueueOne(_ buf: OfflineBuffer) async throws -> String {
        let id = Batch.makeId(now: Date().addingTimeInterval(-8 * 60 * 60))
        try await buf.enqueue(Batch(
            id: id,
            sourceId: "apple-health:local",
            tableName: "health_body",
            records: [["id": .string("r1"), "value": .double(70)]],
            schema: nil,
            deletedIds: [],
            createdAt: Date()
        ))
        return id
    }

    private func enqueueReplicaDeletion(_ buf: OfflineBuffer) async throws {
        _ = try await buf.enqueue(Batch(
            id: Batch.makeId(),
            sourceId: "apple-health:local",
            multiDeviceMode: .replicated,
            tableName: "health_body",
            records: [],
            schema: nil,
            deletedIds: ["sample-removed"],
            createdAt: Date()
        ))
    }

    func testReplicaDeletionWaitsWhenAnotherDeviceHoldsTheLease() async throws {
        let buf = buffer()
        try await enqueueReplicaDeletion(buf)
        let session = CollectorCoreTests.MockSession()
        session.responder = { req in
            let body = req.url?.path.hasSuffix("/lease") == true
                ? "{\"granted\":false,\"holder\":\"phone-b\",\"reason\":\"held\"}"
                : "{\"ingested\":0}"
            let response = HTTPURLResponse(
                url: req.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://gateway.invalid:7600")),
            token: "omn_test",
            session: session
        )

        let stats = try await Uploader(gateway: gateway, buffer: buf).drain()

        XCTAssertEqual(stats.remaining, 1)
        XCTAssertFalse(session.calls.contains { $0.url.hasSuffix("/analytics/ingest") })
        let quarantined = try await buf.quarantinedCount()
        XCTAssertEqual(quarantined, 0)
    }

    func testReplicaDeletionClaimsAppliesAndReleasesLease() async throws {
        let buf = buffer()
        try await enqueueReplicaDeletion(buf)
        let session = CollectorCoreTests.MockSession()
        session.responder = { req in
            let path = req.url?.path ?? ""
            let body = path.hasSuffix("/lease") && req.httpMethod == "POST"
                ? "{\"granted\":true,\"holder\":\"phone-a\",\"expiresAt\":1234}"
                : path == "/analytics/ingest" ? "{\"ingested\":0}" : "{\"released\":true}"
            let response = HTTPURLResponse(
                url: req.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://gateway.invalid:7600")),
            token: "omn_test",
            session: session
        )

        let stats = try await Uploader(gateway: gateway, buffer: buf).drain()

        XCTAssertEqual(session.calls.map(\.method), ["POST", "POST", "DELETE"])
        XCTAssertEqual(stats.remaining, 0)
        XCTAssertTrue(session.calls[0].url.hasSuffix("/lease"))
        XCTAssertTrue(session.calls[1].url.hasSuffix("/analytics/ingest"))
        XCTAssertTrue(session.calls[2].url.hasSuffix("/lease"))
    }

    func testLegacyDeletionWithoutModeClaimsLeaseAndDrains() async throws {
        let buf = buffer()
        let id = Batch.makeId()
        _ = try await buf.enqueue(Batch(
            id: id,
            sourceId: "apple-health:local",
            tableName: "health_body",
            records: [],
            schema: nil,
            deletedIds: ["sample-removed"],
            createdAt: Date()
        ))
        let file = directory.appendingPathComponent("\(id).json")
        let encoded = try Data(contentsOf: file)
        var legacyPayload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        XCTAssertNotNil(legacyPayload.removeValue(forKey: "multiDeviceMode"))
        try JSONSerialization.data(withJSONObject: legacyPayload).write(to: file, options: .atomic)

        let session = CollectorCoreTests.MockSession()
        var leaseClaimed = false
        session.responder = { req in
            let path = req.url?.path ?? ""
            let body: String
            if path.hasSuffix("/lease"), req.httpMethod == "POST" {
                leaseClaimed = true
                body = "{\"granted\":true,\"holder\":\"phone-a\"}"
            } else if path == "/analytics/ingest" {
                body = leaseClaimed
                    ? "{\"ingested\":0}"
                    : "{\"ingested\":0,\"deletionDeferred\":true}"
            } else {
                body = "{\"released\":true}"
            }
            let response = HTTPURLResponse(
                url: req.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://gateway.invalid:7600")),
            token: "omn_test",
            session: session
        )

        let stats = try await Uploader(gateway: gateway, buffer: buf).drain()

        XCTAssertEqual(session.calls.map(\.method), ["POST", "POST", "DELETE"])
        XCTAssertEqual(stats.remaining, 0)
    }

    func testGatewayDeletionDeferredSafetyNetRetainsBatch() async throws {
        let buf = buffer()
        try await enqueueReplicaDeletion(buf)
        let session = CollectorCoreTests.MockSession()
        session.responder = { req in
            let path = req.url?.path ?? ""
            let body = path.hasSuffix("/lease") && req.httpMethod == "POST"
                ? "{\"granted\":true,\"holder\":\"phone-a\"}"
                : path == "/analytics/ingest"
                ? "{\"ingested\":0,\"deletionDeferred\":true}"
                : "{\"released\":true}"
            let response = HTTPURLResponse(
                url: req.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://gateway.invalid:7600")),
            token: "omn_test",
            session: session
        )

        let stats = try await Uploader(gateway: gateway, buffer: buf).drain()

        XCTAssertEqual(stats.remaining, 1)
        let quarantined = try await buf.quarantinedCount()
        XCTAssertEqual(quarantined, 0)
    }

    func testOldGatewayWithoutLeaseEndpointKeepsExclusiveCompatibility() async throws {
        let buf = buffer()
        try await enqueueReplicaDeletion(buf)
        let session = CollectorCoreTests.MockSession()
        session.responder = { req in
            let path = req.url?.path ?? ""
            let status = path.hasSuffix("/lease") ? 404 : 200
            let body = path == "/analytics/ingest" ? "{\"ingested\":0}" : "{}"
            let response = HTTPURLResponse(
                url: req.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://gateway.invalid:7600")),
            token: "omn_test",
            session: session
        )

        let stats = try await Uploader(gateway: gateway, buffer: buf).drain()

        XCTAssertEqual(stats.remaining, 0)
        XCTAssertTrue(session.calls.contains { $0.url.hasSuffix("/analytics/ingest") })
        XCTAssertFalse(session.calls.contains { $0.method == "DELETE" })
    }

    /// The loop this exists to end: a payload the gateway will never accept
    /// must eventually leave the queue instead of being retried forever.
    func testARefusedBatchEventuallyLeavesTheQueue() async throws {
        let buf = buffer()
        _ = try await enqueueOne(buf)
        let uploader = try Uploader(gateway: gateway(status: 400), buffer: buf)

        let first = try await uploader.drain()
        XCTAssertEqual(first.skipped, 1)
        XCTAssertEqual(first.remaining, 1, "One refusal is not enough to give up")

        let second = try await uploader.drain()
        XCTAssertEqual(second.remaining, 0, "The batch is out of the queue")
        let setAside = try await buf.quarantinedCount()
        XCTAssertEqual(setAside, 1, "And kept, not destroyed")
        let age = try await buf.oldestBatchAge()
        XCTAssertNil(age, "The backlog signal it was pinning has cleared")
    }

    /// A gateway that is down must never cost data, however long it stays
    /// down — the inverse of the bug above, and the more expensive one.
    func testAnOutageNeverQuarantinesAnything() async throws {
        let buf = buffer()
        _ = try await enqueueOne(buf)
        let uploader = try Uploader(gateway: gateway(status: 503), buffer: buf)

        for _ in 0 ..< 10 {
            _ = try await uploader.drain()
        }

        let remaining = try await buf.count()
        XCTAssertEqual(remaining, 1, "The batch is still queued")
        let setAside = try await buf.quarantinedCount()
        XCTAssertEqual(setAside, 0, "5xx is the world's problem, not the payload's")
    }

    /// 408 / 425 / 429 are 4xx by number and "ask again later" by meaning. A
    /// proxy in front of the gateway emits them under load or on a slow
    /// request body, which would otherwise put the largest batches on the
    /// worst connections first in line to be discarded.
    func testRetryableClientStatusesAreNotAVerdictOnThePayload() async throws {
        for status in [408, 409, 425, 429] {
            let dir = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("omnesis-uploader-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: dir) }
            let buf = OfflineBuffer(
                directory: dir,
                config: OfflineBuffer.Config(
                    maxSizeBytes: 1_000_000,
                    warningSizeBytes: 500_000,
                    quarantineAfterAttempts: 2,
                    quarantineGrace: 0,
                    maxQuarantinedBatches: 25
                )
            )
            _ = try await enqueueOne(buf)
            let uploader = try Uploader(gateway: gateway(status: status), buffer: buf)

            for _ in 0 ..< 6 {
                _ = try await uploader.drain()
            }

            let setAside = try await buf.quarantinedCount()
            XCTAssertEqual(setAside, 0, "\(status) must not cost the batch its data")
            let remaining = try await buf.count()
            XCTAssertEqual(remaining, 1, "\(status) leaves the batch queued")
        }
    }

    /// A 403 means the device's token is missing this source's write scope.
    /// The data delivers once the grant lands, so it must survive however
    /// long the operator takes to grant it.
    func testABlockedSourceIsNeverQuarantined() async throws {
        let buf = buffer()
        _ = try await enqueueOne(buf)
        let uploader = try Uploader(gateway: gateway(status: 403), buffer: buf)

        for _ in 0 ..< 10 {
            _ = try await uploader.drain()
        }

        let stats = try await uploader.drain()
        XCTAssertEqual(stats.blocked, ["apple-health:local"])
        let setAside = try await buf.quarantinedCount()
        XCTAssertEqual(setAside, 0)
        let remaining = try await buf.count()
        XCTAssertEqual(remaining, 1)
    }

    /// A reply this app cannot parse is as likely to be a captive portal or
    /// a proxy error page as a real protocol mismatch, and those clear on
    /// their own.
    func testAnUnreadableResponseIsTransient() async throws {
        let buf = buffer()
        _ = try await enqueueOne(buf)
        let uploader = try Uploader(
            gateway: gateway(status: 200, body: "<html>Sign in to continue</html>"),
            buffer: buf
        )

        for _ in 0 ..< 6 {
            _ = try await uploader.drain()
        }

        let setAside = try await buf.quarantinedCount()
        XCTAssertEqual(setAside, 0)
        let remaining = try await buf.count()
        XCTAssertEqual(remaining, 1)
    }
}
