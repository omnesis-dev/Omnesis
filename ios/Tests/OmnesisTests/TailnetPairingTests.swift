// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A pairing QR code may mark its gateway URL as an address on the owner's Tailscale network
/// (`"tailnet": true`). The marker is optional on every payload version that names a gateway
/// URL, older payloads read as before, and only a phone that cannot reach that address sees
/// the Tailscale state in place of the generic unreachable sentence.
final class TailnetPairingTests: XCTestCase {
    private let pin = String(repeating: "ab", count: 32)
    private let host = "omnesis-gateway.tail0a1b2c.ts.net"

    private func v4(tailnet: String? = nil, extra: String = "") -> String {
        let marker = tailnet.map { #","tailnet":\#($0)"# } ?? ""
        return #"{"v":4,"gatewayUrl":"https://\#(host)","pairingCode":"AAAA-BBBB","tls":{"mode":"system"}\#(marker)\#(extra)}"#
    }

    // MARK: - Decoding

    func testEachGatewayURLVersionReadsTheMarker() throws {
        let v3 = #"{"v":3,"gatewayUrl":"https://\#(host)","pairingCode":"AA-BB","fingerprint":"\#(pin)","tailnet":true}"#
        let v2 = #"{"v":2,"gatewayUrl":"https://\#(host)","pairingCode":"AA-BB","tailnet":true}"#

        guard case .v4(let four) = try PairingPayload.decode(from: v4(tailnet: "true")) else { return XCTFail("expected v4") }
        guard case .v3(let three) = try PairingPayload.decode(from: v3) else { return XCTFail("expected v3") }
        guard case .v2(let two) = try PairingPayload.decode(from: v2) else { return XCTFail("expected v2") }
        XCTAssertEqual([four.tailnet, three.tailnet, two.tailnet], [true, true, true])
        for raw in [v4(tailnet: "true"), v3, v2] {
            XCTAssertTrue(try PairingPayload.decode(from: raw).isTailnetAddress, raw)
        }
    }

    func testAPayloadWithoutTheMarkerIsNotATailnetAddress() throws {
        let payload = try PairingPayload.decode(from: v4())
        guard case .v4(let four) = payload else { return XCTFail("expected v4") }
        XCTAssertNil(four.tailnet)
        XCTAssertFalse(payload.isTailnetAddress)
        XCTAssertFalse(try PairingPayload.decode(from: v4(tailnet: "false")).isTailnetAddress)
    }

    /// What lets an app that predates the marker pair from a QR code carrying it: the
    /// decoder ignores every key it does not know.
    func testUnknownKeysAreIgnored() throws {
        let payload = try PairingPayload.decode(from: v4(extra: #","futureField":{"nested":[1,2]},"anotherFlag":true"#))
        XCTAssertEqual(payload, .v4(.init(gatewayUrl: "https://\(host)", pairingCode: "AAAA-BBBB", tls: .system)))
        let legacy = #"{"v":1,"url":"https://\#(host)","token":"t","accountId":"a","name":"n","tailnet":true}"#
        XCTAssertFalse(try PairingPayload.decode(from: legacy).isTailnetAddress, "V1 carries a token, not a gateway exchange")
    }

    func testAMarkerOfTheWrongTypeIsRefusedLikeAnyMalformedField() {
        XCTAssertThrowsError(try PairingPayload.decode(from: v4(tailnet: #""yes""#))) { error in
            guard case PairingPayloadError.invalidShape = error else { return XCTFail("\(error)") }
        }
    }

    /// The pairing screen re-encodes the confirmed payload before pairing, so the marker
    /// must survive that trip, and a payload without it must stay byte-for-byte as it was.
    func testReEncodingKeepsTheMarkerAndOmitsItWhenAbsent() throws {
        let marked = try JSONEncoder().encode(PairingPayload.V4(
            gatewayUrl: "https://\(host)",
            pairingCode: "A",
            tls: .system,
            tailnet: true
        ))
        let markedObject = try XCTUnwrap(JSONSerialization.jsonObject(with: marked) as? [String: Any])
        XCTAssertEqual(markedObject["tailnet"] as? Bool, true)
        XCTAssertTrue(try PairingPayload.decode(from: XCTUnwrap(String(data: marked, encoding: .utf8))).isTailnetAddress)

        let plain = try JSONEncoder().encode(PairingPayload.V2(gatewayUrl: "https://\(host)", pairingCode: "A"))
        let plainObject = try XCTUnwrap(JSONSerialization.jsonObject(with: plain) as? [String: Any])
        XCTAssertEqual(Set(plainObject.keys), ["v", "gatewayUrl", "pairingCode"])
    }

    // MARK: - Failure mapping

    func testAnUnreachableTailnetAddressIsTheTailscaleState() {
        for code in [URLError.Code.cannotConnectToHost, .timedOut, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet] {
            XCTAssertEqual(PairingErrorMessage.failure(for: URLError(code), payload: v4(tailnet: "true")), .tailnetUnreachable)
        }
        // Surfaces that show only a sentence get this one.
        XCTAssertEqual(
            PairingErrorMessage.failure(for: URLError(.cannotConnectToHost), payload: v4(tailnet: "true")).message,
            "This gateway's address is on your Tailscale network, and this phone isn't connected to it."
        )
    }

    func testWithoutTheMarkerAnUnreachableGatewayKeepsItsSentence() {
        for raw in [v4(), v4(tailnet: "false")] {
            XCTAssertEqual(
                PairingErrorMessage.failure(for: URLError(.cannotConnectToHost), payload: raw),
                .message(PairingErrorMessage.unreachable(host: host))
            )
        }
    }

    func testOtherFailuresOfATailnetPayloadKeepTheirSentences() {
        let marked = v4(tailnet: "true")
        XCTAssertEqual(
            PairingErrorMessage.failure(for: URLError(.serverCertificateUntrusted), payload: marked),
            .message(PairingErrorMessage.certificate)
        )
        let refused = GatewayClient.Error.serverError(status: 410, body: #"{"error":"pairing code expired"}"#)
        XCTAssertEqual(PairingErrorMessage.failure(for: refused, payload: marked), .message(PairingErrorMessage.usedOrExpiredCode))
        XCTAssertEqual(PairingErrorMessage.failure(for: URLError(.cancelled), payload: marked), .message(PairingErrorMessage.unfinished))
    }

    func testTheMarkerIsReadFromTheRawPayload() {
        XCTAssertTrue(PairingErrorMessage.marksTailnetAddress(inPayload: v4(tailnet: "true")))
        XCTAssertFalse(PairingErrorMessage.marksTailnetAddress(inPayload: v4()))
        XCTAssertFalse(PairingErrorMessage.marksTailnetAddress(inPayload: v4(tailnet: "1")))
        XCTAssertFalse(PairingErrorMessage.marksTailnetAddress(inPayload: "not json"))
    }

    // MARK: - Coordinator

    @MainActor
    func testTheCoordinatorRecordsTheTailscaleStateBesideItsSentence() async {
        let exchange = StubExchange()
        exchange.response = .failure(URLError(.cannotConnectToHost))
        let coordinator = PairingCoordinator(service: PairingService(store: InMemoryStore(), exchange: exchange, cloudRelayEnabled: false))
        var sentences: [String?] = []
        coordinator.setOnError { sentences.append($0) }

        let failed = await coordinator.pairAsync(raw: v4(tailnet: "true"))
        XCTAssertNil(failed)
        XCTAssertEqual(coordinator.lastFailure, .tailnetUnreachable)
        XCTAssertEqual(sentences, [PairingErrorMessage.tailnetUnreachable])
        XCTAssertEqual(exchange.lastGatewayUrl?.host, host, "The retry pairs with the same gateway")

        _ = await coordinator.pairAsync(raw: v4())
        XCTAssertEqual(coordinator.lastFailure, .message(PairingErrorMessage.unreachable(host: host)))
    }

    @MainActor
    func testASuccessfulPairingClearsTheLastFailure() async {
        let exchange = StubExchange()
        exchange.response = .failure(URLError(.timedOut))
        let coordinator = PairingCoordinator(service: PairingService(store: InMemoryStore(), exchange: exchange, cloudRelayEnabled: false))
        _ = await coordinator.pairAsync(raw: v4(tailnet: "true"))
        XCTAssertEqual(coordinator.lastFailure, .tailnetUnreachable)

        exchange.response = .success(DevicePairResponse(
            device: .init(id: "test-phone", name: "Test phone", kind: "ios"),
            tokenId: "generation",
            token: "omn_new",
            scopes: ["read"]
        ))
        let paired = await coordinator.pairAsync(raw: v4(tailnet: "true"))
        XCTAssertNotNil(paired)
        XCTAssertNil(coordinator.lastFailure)
    }
}
