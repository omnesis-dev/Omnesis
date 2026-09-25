// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@available(iOS 17.0, macOS 14.0, *)
final class DeviceSocketTests: XCTestCase {
    // DeviceSocket's actual WebSocket loop is hard to unit-test without a
    // live server. We cover the URL derivation + initial disconnected state
    // here; integration testing is left to the TestFlight manual plan.

    func testInitialStateIsDisconnected() async throws {
        let socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_t"
        )
        let state = await socket.state()
        XCTAssertEqual(state, .disconnected)
    }

    func testStopIsIdempotent() async throws {
        let socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_t"
        )
        await socket.stop()
        await socket.stop()
        let state = await socket.state()
        XCTAssertEqual(state, .disconnected)
    }

    func testStopBeforeStartPreventsLateStartup() async throws {
        let socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_t"
        )

        await socket.stop()
        await socket.start()

        let isRunning = await socket.runnerActiveForTesting()
        let state = await socket.state()
        XCTAssertFalse(isRunning)
        XCTAssertEqual(state, .disconnected)
    }

    func testHelloProtocolVersionMatchesGatewayContract() {
        XCTAssertEqual(DeviceSocket.protocolVersion, 1)
    }

    func testWaitUntilConnectedTimesOutWhenHelloNeverLands() async throws {
        let socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_t"
        )
        // Never started: no hello can complete, so the wait must resolve
        // false instead of hanging the consent tap forever.
        let connected = await socket.waitUntilConnected(timeout: .milliseconds(300))
        XCTAssertFalse(connected)
    }

    func testEveryHelloCarriesTheCompleteNativeSourceContract() {
        let command = DeviceSocket.helloCommand(
            id: "hello-1",
            capabilities: .ios(pushAppId: "dev.omnesis.ios")
        )
        guard case .object(let payload)? = command["payload"],
              case .object(let capabilities)? = payload["capabilities"]
        else { return XCTFail("expected hello capabilities") }

        XCTAssertEqual(capabilities["platform"], .string("ios"))
        XCTAssertEqual(
            capabilities["multiDeviceModes"],
            .object([
                "apple-health": .string("replicated"),
                "activity-segments": .string("partitioned"),
                "photos": .string("partitioned"),
                "core-location-visits": .string("partitioned"),
            ])
        )
        XCTAssertEqual(
            capabilities["replicaVersionPolicies"],
            .object(["apple-health": .string("source-updated-at")])
        )
        XCTAssertEqual(capabilities["syncLease"], .bool(true))
        XCTAssertEqual(capabilities["pushAppId"], .string("dev.omnesis.ios"))
    }

    /// The gateway's version ledger reads `version` out of the hello. A build
    /// that stops sending it does not fail a handshake — the field is
    /// deliberately optional — so nothing but this test would notice the app
    /// going silent about which release it is.
    func testEveryHelloDeclaresTheAppVersion() {
        let command = DeviceSocket.helloCommand(
            id: "hello-1",
            capabilities: .ios(version: "9.8.7")
        )
        guard case .object(let payload)? = command["payload"],
              case .object(let capabilities)? = payload["capabilities"]
        else { return XCTFail("expected hello capabilities") }

        XCTAssertEqual(capabilities["version"], .string("9.8.7"))
    }

    /// The version reaches the wire through the capability struct, so a
    /// caller that supplies one must see exactly it — never the ambient
    /// bundle's — and the bundle read must yield something rather than
    /// crashing on a host that declares no version.
    func testAppVersionIsCarriedByTheCapabilityStruct() {
        XCTAssertEqual(PairingCapabilities.ios(version: "1.2.3").version, "1.2.3")
        XCTAssertFalse(omnesisAppVersion().isEmpty)
    }

    // MARK: - Gateway-originated command acknowledgements

    //
    // The gateway validates a successful response's `result` against that
    // command's schema in `ws-messages.ts`. A payload missing a declared field
    // is rejected as a protocol error, which `/admin/sources/:id/sync` maps to
    // a 502 — so these assert the shapes, not just that a reply happened.

    private func socket() throws -> DeviceSocket {
        try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_t"
        )
    }

    private func command(_ type: String, sourceId: String? = nil) -> WsCommandFrame {
        WsCommandFrame(
            id: "cmd-1",
            type: type,
            payload: sourceId.map { .object(["sourceId": .string($0)]) } ?? .object([:])
        )
    }

    func testHostedSyncAcksWithTheFieldsItsSchemaDeclares() async throws {
        let socket = try socket()
        await socket.setOnSyncRequested { _ in .triggered }

        let outcome = await socket.run(command("source.sync", sourceId: "apple-health:local"))

        guard case .success(let result) = outcome else {
            return XCTFail("a hosted source must ack successfully; got \(outcome)")
        }
        guard case .object(let fields) = result else { return XCTFail("expected an object") }
        XCTAssertEqual(fields["ok"], .bool(true))
        XCTAssertEqual(fields["triggered"], .int(1))
    }

    func testASkippedSyncAcksHonestlyRatherThanClaimingItRan() async throws {
        // The collector is rebuilt on every pairing change and source toggle.
        // Reporting "not hosted" for that window would send the operator
        // looking for a source that is present; claiming `triggered` would
        // report a sync that never started.
        let socket = try socket()
        await socket.setOnSyncRequested { _ in .skipped(reason: "still starting up") }

        let outcome = await socket.run(command("source.sync", sourceId: "apple-health:local"))

        guard case .success(let result) = outcome, case .object(let fields) = result else {
            return XCTFail("a skip is a valid acknowledgement; got \(outcome)")
        }
        XCTAssertEqual(fields["ok"], .bool(true))
        XCTAssertEqual(fields["triggered"], .int(0))
        XCTAssertEqual(fields["skipped"], .int(1))
        XCTAssertEqual(fields["error"], .string("still starting up"))
    }

    func testSyncForAnUnhostedSourceIsRefusedRatherThanFalselyAcked() async throws {
        // A blanket ok:true would report a completed sync for a source this
        // device cannot touch. The refusal reaches the operator as a 502.
        let socket = try socket()
        await socket.setOnSyncRequested { _ in .notHosted }

        let outcome = await socket.run(command("source.sync", sourceId: "gmail:someone@example.com"))

        guard case .failure(let code, _) = outcome else {
            return XCTFail("an unhosted source must be refused; got \(outcome)")
        }
        XCTAssertEqual(code, "not_hosted")
    }

    func testSyncWithoutACollectorIsRefused() async throws {
        let socket = try socket()

        let outcome = await socket.run(command("source.sync", sourceId: "apple-health:local"))

        guard case .failure(let code, _) = outcome else {
            return XCTFail("expected a refusal; got \(outcome)")
        }
        XCTAssertEqual(code, "unsupported")
    }

    func testSyncWithoutASourceIdIsRefused() async throws {
        let socket = try socket()
        await socket.setOnSyncRequested { _ in .triggered }

        let outcome = await socket.run(command("source.sync"))

        guard case .failure(let code, _) = outcome else {
            return XCTFail("expected a refusal; got \(outcome)")
        }
        XCTAssertEqual(code, "invalid_payload")
    }

    func testSourceChangeCommandsAckWithOk() async throws {
        let socket = try socket()

        for type in ["source.added", "source.updated", "source.removed", "sources.snapshot"] {
            let outcome = await socket.run(command(type, sourceId: "apple-health:local"))
            guard case .success(let result) = outcome, case .object(let fields) = result else {
                return XCTFail("\(type) must ack successfully; got \(outcome)")
            }
            XCTAssertEqual(fields["ok"], .bool(true), "\(type) must carry ok")
        }
    }

    func testRemovalCommandReachesTheLocalLifecycleConsumer() async throws {
        let socket = try socket()
        let sourceId = "notes-synth:local"
        _ = await socket.run(command("source.removed", sourceId: sourceId))
        await socket.stop()
        var events = socket.events.makeAsyncIterator()
        let event = await events.next()
        XCTAssertEqual(event?.type, "source.removed")
        XCTAssertEqual(event?.payload, .object(["sourceId": .string(sourceId)]))
    }

    func testSourceDebugAcksWithTheStatusFieldItsSchemaDeclares() async throws {
        let socket = try socket()

        let outcome = await socket.run(command("source.debug", sourceId: "apple-health:local"))

        guard case .success(let result) = outcome, case .object(let fields) = result,
              case .object(let status)? = fields["status"]
        else {
            return XCTFail("expected a status object; got \(outcome)")
        }
        XCTAssertEqual(status["sourceId"], .string("apple-health:local"))
    }

    func testAnUnhandledCommandIsRefusedWithAStructuredError() async throws {
        let socket = try socket()

        let outcome = await socket.run(command("credentials.set"))

        guard case .failure(let code, _) = outcome else {
            return XCTFail("expected a refusal; got \(outcome)")
        }
        XCTAssertEqual(code, "unsupported")
    }
}
