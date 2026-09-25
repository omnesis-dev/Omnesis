// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PairingErrorMessageTests: XCTestCase {
    private let payload = #"{"v":2,"gatewayUrl":"https://gateway.example.com:7600","pairingCode":"AA-BB"}"#
    private let pinnedPayload =
        #"{"v":3,"gatewayUrl":"https://gateway.example.com:7600","pairingCode":"AA-BB","fingerprint":"aabbcc"}"#

    func testAnInvalidOrExpiredCodeSaysToCreateANewOne() {
        let error = GatewayClient.Error.serverError(status: 400, body: #"{"error":"invalid or expired pairing code"}"#)

        XCTAssertEqual(
            PairingErrorMessage.message(for: error, payload: payload),
            "This pairing code has already been used or has expired. Create a new one on your gateway and scan it again."
        )
    }

    func testACertificateFailureNamesTheCertificate() {
        let expected =
            "Couldn't verify your gateway's certificate. Check that the QR code uses a hostname covered by the certificate. If using Tailscale, choose its hostname instead of its IP address."

        XCTAssertEqual(PairingErrorMessage.message(for: URLError(.serverCertificateUntrusted), payload: payload), expected)
        XCTAssertEqual(PairingErrorMessage.message(for: URLError(.secureConnectionFailed), payload: payload), expected)
    }

    func testACancelledConnectionIsACertificateMismatchOnlyWhenTheCodePinsOne() {
        XCTAssertEqual(
            PairingErrorMessage.message(for: URLError(.cancelled), payload: pinnedPayload),
            "The gateway certificate does not match the fingerprint in this QR code. Create a new pairing code on your gateway and scan it again."
        )
        XCTAssertEqual(
            PairingErrorMessage.message(for: URLError(.cancelled), payload: payload),
            "Pairing didn't finish. Try again."
        )
    }

    func testAnUnreachableGatewayNamesItsHost() {
        let expected = "Couldn't reach your gateway at gateway.example.com. "
            + "Check that the gateway is running and this phone can reach it. Away from home, connect Tailscale on both devices and use the gateway's Tailscale hostname when creating the QR code."

        XCTAssertEqual(PairingErrorMessage.message(for: URLError(.cannotConnectToHost), payload: payload), expected)
        XCTAssertEqual(PairingErrorMessage.message(for: URLError(.timedOut), payload: payload), expected)
    }

    func testAnyOtherGatewayMessageIsPassedOnAsASentence() {
        let error = GatewayClient.Error.serverError(
            status: 500,
            body: #"{"error":"gateway is upgrading","code":"UPGRADING"}"#
        )

        XCTAssertEqual(
            PairingErrorMessage.message(for: error, payload: payload),
            "Your gateway couldn't pair this phone: Gateway is upgrading."
        )
    }

    func testEveryUnreadableCodeGetsPlainCopy() {
        let notAPairingCode = "That code isn't an Omnesis pairing code. Scan the QR code shown by your gateway."
        let unreadable: [PairingPayloadError] = [
            .invalidJSON,
            .invalidShape("pairingCode"),
            .missingField("gatewayUrl"),
            .invalidURL,
            .invalidFingerprint,
        ]

        for error in unreadable {
            XCTAssertEqual(PairingErrorMessage.message(for: error, payload: "not a payload"), notAPairingCode, "\(error)")
        }
        XCTAssertEqual(
            PairingErrorMessage.message(for: PairingPayloadError.unsupportedVersion(9), payload: payload),
            "This pairing code is for a different version of Omnesis. Update the app, then create a new code on your gateway."
        )
        XCTAssertEqual(
            PairingErrorMessage.message(for: PairingPayloadError.invalidScheme("http"), payload: payload),
            "That code points to a gateway without HTTPS. Omnesis only pairs with a gateway over HTTPS."
        )
    }

    func testAnythingElseIsAPlainSentence() {
        struct Opaque: Error {}

        XCTAssertEqual(PairingErrorMessage.message(for: Opaque(), payload: payload), "Couldn't pair with your gateway. Try again.")
        XCTAssertEqual(
            PairingErrorMessage.message(for: GatewayClient.Error.invalidResponse, payload: payload),
            "Couldn't pair with your gateway. Try again."
        )
    }

    func testTheHostAndPinningComeFromTheScannedPayload() {
        XCTAssertEqual(PairingErrorMessage.gatewayHost(inPayload: payload), "gateway.example.com")
        XCTAssertNil(PairingErrorMessage.gatewayHost(inPayload: "not a payload"))
        XCTAssertTrue(PairingErrorMessage.pinsCertificate(inPayload: pinnedPayload))
        XCTAssertTrue(PairingErrorMessage.pinsCertificate(
            inPayload: #"{"v":4,"gatewayUrl":"https://gateway.example.com","tls":{"mode":"pinnedLeaf","fingerprint":"aabbcc"}}"#
        ))
        XCTAssertFalse(PairingErrorMessage.pinsCertificate(inPayload: payload))
    }
}
