// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class GatewayDirectDiscoveryTests: XCTestCase {
    private let origin = URL(string: "https://gateway.example.test")!
    private let key = String(repeating: "ab", count: 32)

    func testOnlyAuthenticatedCanonicalKeyChannelSuppliesOptionalPrivateFacts() async throws {
        let transport =
            RecordingTransport(
                data: Data(#"{"version":1,"candidates":[{"address":"192.168.1.2","port":7600},{"address":"fd00::12","port":443}]}"#
                    .utf8)
            )
        let discovery = GatewayDirectDiscovery(transports: transport)
        let candidates = try await discovery.fetch(origin: origin, token: "device-test-token", spkiFingerprint: key)
        XCTAssertEqual(candidates, [.init(address: "192.168.1.2", port: 7600), .init(address: "fd00::12", port: 443)])
        XCTAssertEqual(transport.snapshot().hosts, ["gateway.example.test"])
        XCTAssertEqual(transport.snapshot().keys, [key])
        XCTAssertEqual(transport.snapshot().closed, 1)
        XCTAssertEqual(transport.snapshot().urls, [origin.appendingPathComponent("devices/direct-candidates")])
        XCTAssertEqual(transport.snapshot().tokens, ["device-test-token"])
    }

    func testMalformedConfigurationNeverCreatesTransportOrReleasesBearer() async {
        let transport = RecordingTransport(data: Data())
        let discovery = GatewayDirectDiscovery(transports: transport)
        let badOrigins = [
            "http://gateway.example.test",
            "https://user@gateway.example.test",
            "https://u:p@gateway.example.test",
            "https://gateway.example.test/path",
            "https://gateway.example.test?query",
            "https://gateway.example.test#fragment",
            "https://gateway.example.test:0",
            "https://gateway.example.test:65536",
            "file:///tmp/example",
        ]
        for raw in badOrigins {
            await rejects { _ = try await discovery.fetch(origin: URL(string: raw)!, token: "synthetic", spkiFingerprint: self.key) }
        }
        for token in ["", String(repeating: "x", count: 8193)] {
            await rejects { _ = try await discovery.fetch(origin: self.origin, token: token, spkiFingerprint: self.key) }
        }
        for pin in ["", "bad", String(repeating: "AB", count: 32)] {
            await rejects { _ = try await discovery.fetch(origin: self.origin, token: "synthetic", spkiFingerprint: pin) }
        }
        XCTAssertTrue(transport.snapshot().hosts.isEmpty)
        XCTAssertEqual(transport.snapshot().closed, 0)
    }

    func testBodyVersionSizeAndCandidateErrorsAlwaysCloseTransport() async {
        let invalid = [
            Data("{}".utf8),
            Data("{".utf8),
            Data(#"{"version":2,"candidates":[]}"#.utf8),
            Data(#"{"version":1,"candidates":[{"address":"8.8.8.8","port":443}]}"#.utf8),
            Data(repeating: 32, count: 65537),
        ]
        for data in invalid {
            let transport = RecordingTransport(data: data)
            await rejects {
                _ = try await GatewayDirectDiscovery(transports: transport).fetch(
                    origin: self.origin,
                    token: "synthetic",
                    spkiFingerprint: self.key
                )
            }
            XCTAssertEqual(transport.snapshot().closed, 1)
        }
        let transport = RecordingTransport(data: Data(), failure: true)
        await rejects {
            _ = try await GatewayDirectDiscovery(transports: transport).fetch(
                origin: self.origin,
                token: "synthetic",
                spkiFingerprint: self.key
            )
        }
        XCTAssertEqual(transport.snapshot().closed, 1)
    }

    func testEmptyHintsAndExplicitHTTPSPortAreValid() async throws {
        let transport = RecordingTransport(data: Data(#"{"version":1,"candidates":[]}"#.utf8))
        let candidates = try await GatewayDirectDiscovery(transports: transport).fetch(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test:8443/")), token: "synthetic", spkiFingerprint: key
        )
        XCTAssertTrue(candidates.isEmpty)
        XCTAssertEqual(transport.snapshot().closed, 1)
    }

    private func rejects(_ work: () async throws -> Void) async {
        do { try await work()
            XCTFail("Invalid discovery accepted")
        } catch {}
    }

    struct Snapshot {
        var hosts: [String] = []
        var keys: [String] = []
        var urls: [URL] = []
        var tokens: [String?] = []
        var closed = 0
    }

    private final class RecordingTransport: CloudPairingTransport, CloudPairingKeyTransportFactory, @unchecked Sendable {
        private let lock = NSLock()
        private var state = Snapshot()
        private let data: Data
        private let failure: Bool
        init(data: Data, failure: Bool = false) {
            self.data = data
            self.failure = failure
        }

        func snapshot() -> Snapshot {
            lock.lock()
            defer { lock.unlock() }
            return state
        }

        func pinnedKey(_ spkiFingerprint: String, host: String) -> any CloudPairingTransport {
            lock.lock()
            defer { lock.unlock() }
            state.keys.append(spkiFingerprint)
            state.hosts.append(host)
            return self
        }

        func requestData(url: URL, method: String, body: Data?, bearer: String?, form: Bool) async throws -> Data {
            record(url: url, token: bearer)
            XCTAssertEqual(method, "GET")
            XCTAssertNil(body)
            XCTAssertFalse(form)
            if failure { throw URLError(.cannotConnectToHost) }
            return data
        }

        private func record(url: URL, token: String?) {
            lock.lock()
            defer { lock.unlock() }
            state.urls.append(url)
            state.tokens.append(token)
        }

        func close() {
            lock.lock()
            defer { lock.unlock() }
            state.closed += 1
        }
    }
}
