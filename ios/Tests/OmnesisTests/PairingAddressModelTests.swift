// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Pair a device: the gateway's address plan for a pairing code, the choice among
/// its usable addresses, and the address handed back for the QR.
final class PairingAddressModelTests: XCTestCase {
    /// A phone that reaches the gateway at its Omnesis address, on port 443.
    private let base = URL(string: "https://g-fictional.relay.example.test")!

    func testThePlanDecodesAsTheGatewaySendsIt() async throws {
        let session = AddressSession()
        let plan = try await session.client(base).pairAddresses(pairingCode: "7K3M-9QX2")

        XCTAssertEqual(session.requests.map(\.httpMethod), ["POST"])
        XCTAssertEqual(session.requests[0].url?.absoluteString, "https://g-fictional.relay.example.test/admin/devices/pair-addresses")
        XCTAssertEqual(try session.body(0)["pairingCode"] as? String, "7K3M-9QX2")

        XCTAssertEqual(plan.platform, "ios")
        XCTAssertEqual(plan.recommendedUrl, "https://gateway.tail-fictional.ts.net:7600")
        XCTAssertNil(plan.awayFromHome)
        XCTAssertEqual(plan.usable.map(\.host), ["gateway.tail-fictional.ts.net", "192.0.2.42", "g-fictional.relay.example.test"])
        XCTAssertEqual(plan.usable.map(\.systemTrust), [true, false, false])
        XCTAssertEqual(plan.usable.map(\.kind), [nil, nil, "relay"])
        XCTAssertEqual(plan.usable[2].summary, "Works from anywhere. Needs remote access to stay on.")
        XCTAssertEqual(plan.usable[1].reach, "local-network")
        XCTAssertEqual(plan.refused.map(\.host), ["198.51.100.7"])
        XCTAssertEqual(plan.refused[0].reason, "An iPhone refuses this address.")
        XCTAssertNil(plan.refused[0].summary)

        // The gateway's own words, with its recommendation marked. A refused address is never marked or selected.
        XCTAssertEqual(plan.title(plan.usable[0]), "Tailscale name · gateway.tail-fictional.ts.net (recommended)")
        XCTAssertEqual(plan.title(plan.usable[2]), "Omnesis address · g-fictional.relay.example.test")
        XCTAssertEqual(plan.title(plan.refused[0]), "Tailscale IP · 198.51.100.7")
        XCTAssertNil(plan.option(at: "https://198.51.100.7:7600"))
        XCTAssertNil(plan.option(at: nil))

        let json = #"{"platform":null,"addresses":[],"recommendedUrl":null,"awayFromHome":{"onTailnet":true,"tailscaleName":null}}"#
        let hinted = try JSONDecoder().decode(PairingAddressPlan.self, from: Data(json.utf8))
        XCTAssertNil(hinted.platform)
        XCTAssertEqual(hinted.awayFromHome, PairingAwayFromHomeHint(onTailnet: true, tailscaleName: nil))
    }

    @MainActor
    func testItOpensOnTheRecommendationAndSendsTheChosenAddressBackUnchanged() async throws {
        let session = AddressSession()
        let client = session.client(base)
        let model = PairingAddressModel(pairingCode: "7K3M-9QX2", encodesQr: true)
        XCTAssertNil(model.selected)

        await model.load(client: client)
        XCTAssertEqual(model.selected?.gatewayUrl, "https://gateway.tail-fictional.ts.net:7600")
        XCTAssertEqual(model.payload, "encoded")
        XCTAssertEqual(session.requests.map { $0.url?.path }, ["/admin/devices/pair-addresses", "/admin/devices/pair-qr"])
        XCTAssertEqual(try session.body(1)["gatewayUrl"] as? String, "https://gateway.tail-fictional.ts.net:7600")
        XCTAssertEqual(try session.body(1)["pairingCode"] as? String, "7K3M-9QX2")

        // The home address keeps the gateway's own port: nothing of the app's origin (port 443) goes into it.
        let home = try XCTUnwrap(model.plan?.usable[1])
        await model.select(home, client: client)
        XCTAssertEqual(model.selected, home)
        XCTAssertEqual(try session.body(2)["gatewayUrl"] as? String, "https://192.0.2.42:7600")

        // The Omnesis address has no port and gets none.
        let relay = try XCTUnwrap(model.plan?.usable[2])
        await model.select(relay, client: client)
        XCTAssertEqual(try session.body(3)["gatewayUrl"] as? String, "https://g-fictional.relay.example.test")

        // A refused address cannot be chosen, and choosing the current one asks nothing.
        let refused = try XCTUnwrap(model.plan?.refused.first)
        await model.select(refused, client: client)
        await model.select(relay, client: client)
        XCTAssertEqual(model.selected, relay)
        XCTAssertEqual(session.requests.count, 4)
    }

    @MainActor
    func testManualEntryIsOfferedOnlyWhereThePhoneTrustsTheAddress() async throws {
        let session = AddressSession()
        let client = session.client(base)
        let model = PairingAddressModel(pairingCode: "7K3M-9QX2", encodesQr: true)
        XCTAssertFalse(model.offersManualEntry)
        await model.load(client: client)
        XCTAssertTrue(model.offersManualEntry, "The Tailscale name has a certificate the phone trusts")
        for index in [1, 2] {
            try await model.select(XCTUnwrap(model.plan?.usable[index]), client: client)
            XCTAssertFalse(model.offersManualEntry, "A pinned address needs the JSON, which carries the pin")
        }
    }

    @MainActor
    func testAnAgentGetsTheAddressWithoutAQrAndFailuresAreKept() async {
        let session = AddressSession()
        let client = session.client(base)
        let agent = PairingAddressModel(pairingCode: "7K3M-9QX2", encodesQr: false)
        await agent.load(client: client)
        XCTAssertEqual(agent.selected?.gatewayUrl, "https://gateway.tail-fictional.ts.net:7600")
        XCTAssertNil(agent.payload)
        XCTAssertEqual(session.requests.count, 1)

        session.planStatus = 503
        let failed = PairingAddressModel(pairingCode: "7K3M-9QX2", encodesQr: true)
        await failed.load(client: client)
        XCTAssertNotNil(failed.planError)
        XCTAssertNil(failed.selected)

        session.planStatus = 200
        session.qrStatus = 400
        let unencoded = PairingAddressModel(pairingCode: "7K3M-9QX2", encodesQr: true)
        await unencoded.load(client: client)
        XCTAssertNotNil(unencoded.selected)
        XCTAssertNil(unencoded.payload)
        XCTAssertNotNil(unencoded.qrError)

        // No usable address: nothing is selected and no QR is asked for.
        session.qrStatus = 200
        session.plan = #"{"platform":"ios","addresses":[{"gatewayUrl":"https://198.51.100.7:7600","host":"198.51.100.7","#
            + #""label":"Tailscale IP","usable":false,"reason":"An iPhone refuses this address."}],"recommendedUrl":null,"#
            + #""awayFromHome":{"onTailnet":false,"tailscaleName":null}}"#
        let before = session.requests.count
        let none = PairingAddressModel(pairingCode: "7K3M-9QX2", encodesQr: true)
        await none.load(client: client)
        XCTAssertNil(none.selected)
        XCTAssertEqual(none.plan?.awayFromHome?.onTailnet, false)
        XCTAssertEqual(session.requests.count, before + 1)
    }

    func testTheWordsAroundThePlanMatchThePortal() {
        typealias Words = PairingAddressPresentation
        XCTAssertEqual(Words.noun(kind: "ios"), "iPhone")
        XCTAssertEqual(Words.withArticle(Words.noun(kind: "android")), "an Android phone")
        XCTAssertEqual(Words.withArticle(Words.noun(kind: "agent")), "a device")

        let certificate = "Turn on HTTPS certificates for your tailnet, then run omnesis tls provision on the gateway computer. "
        let last = "Create a new pairing code here and scan it."
        XCTAssertEqual(
            Words.awayFromHomeSteps(PairingAwayFromHomeHint(onTailnet: false), platform: "ios", noun: "iPhone"),
            [
                "Install Tailscale on the gateway computer and on the iPhone, and sign both in to the same tailnet.",
                certificate + "It gets a certificate from Tailscale. Any phone you paired before this step will need to pair again.",
                last,
            ]
        )
        XCTAssertEqual(
            Words.awayFromHomeSteps(PairingAwayFromHomeHint(onTailnet: true), platform: "ios", noun: "iPhone").first,
            "Turn on MagicDNS for your tailnet in the Tailscale admin console."
        )
        let named = PairingAwayFromHomeHint(onTailnet: true, tailscaleName: "gateway.tail-fictional.ts.net")
        XCTAssertEqual(
            Words.awayFromHomeSteps(named, platform: "ios", noun: "iPhone").first,
            certificate + "It gets a certificate for gateway.tail-fictional.ts.net from Tailscale. "
                + "Any phone you paired before this step will need to pair again."
        )
        XCTAssertEqual(Words.awayFromHomeSteps(named, platform: "android", noun: "Android phone"), [last])

        let one = PairingAddressOption(gatewayUrl: "https://192.0.2.42:7600", host: "192.0.2.42", label: "Local network")
        let other = PairingAddressOption(gatewayUrl: "https://192.0.2.43:7600", host: "192.0.2.43", label: "Local network")
        let refused = PairingAddressOption(gatewayUrl: "https://198.51.100.7", host: "198.51.100.7", label: "Tailscale IP", usable: false)
        func plan(_ addresses: [PairingAddressOption]) -> PairingAddressPlan {
            PairingAddressPlan(platform: "ios", addresses: addresses, recommendedUrl: one.gatewayUrl)
        }
        XCTAssertNil(Words.alternativesTitle(plan([one])))
        XCTAssertEqual(Words.alternativesTitle(plan([one, other, refused])), "Use a different address")
        XCTAssertEqual(Words.alternativesTitle(plan([one, refused])), "Why other addresses aren't offered")
    }
}

/// Answers the address plan and the QR as the gateway does, recording what was asked.
private final class AddressSession: URLSessionLike, @unchecked Sendable {
    var requests: [URLRequest] = []
    var planStatus = 200
    var qrStatus = 200
    var plan = #"{"platform":"ios","addresses":["#
        + #"{"gatewayUrl":"https://gateway.tail-fictional.ts.net:7600","host":"gateway.tail-fictional.ts.net","label":"Tailscale name","#
        + #""usable":true,"reach":"tailnet","systemTrust":true,"summary":"Works anywhere, while Tailscale is connected on the phone."},"#
        + #"{"gatewayUrl":"https://192.0.2.42:7600","host":"192.0.2.42","label":"Local network","usable":true,"#
        + #""reach":"local-network","systemTrust":false,"summary":"Works on the gateway's own network."},"#
        + #"{"gatewayUrl":"https://g-fictional.relay.example.test","host":"g-fictional.relay.example.test","label":"Omnesis address","#
        + #""kind":"relay","usable":true,"reach":"anywhere","systemTrust":false,"#
        + #""summary":"Works from anywhere. Needs remote access to stay on."},"#
        + #"{"gatewayUrl":"https://198.51.100.7:7600","host":"198.51.100.7","label":"Tailscale IP","usable":false,"#
        + #""reason":"An iPhone refuses this address."}],"#
        + #""recommendedUrl":"https://gateway.tail-fictional.ts.net:7600","awayFromHome":null,"somethingNew":1}"#

    func client(_ base: URL) -> AdminClient {
        AdminClient(baseURL: base, token: "synthetic-token", session: self)
    }

    func body(_ index: Int) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[index].httpBody)) as? [String: Any])
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let asksPlan = request.url?.path == "/admin/devices/pair-addresses"
        let status = asksPlan ? planStatus : qrStatus
        let body = status != 200 ? #"{"error":"refused","code":"REFUSED"}"# : asksPlan ? plan : #"{"qrPayload":"encoded"}"#
        let url = try XCTUnwrap(request.url)
        let answer = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
        return (Data(body.utf8), answer)
    }
}
