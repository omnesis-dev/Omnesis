// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import Foundation
@testable import Omnesis
import UIKit
import XCTest

@MainActor
final class GoogleDefaultPairingCompositionTests: XCTestCase {
    func testDefaultCompositionBuildsFreshNativeChallengesWithoutSendingTheirSecretToGoogle() throws {
        let coordinator = GoogleCloudPairingCoordinator()
        XCTAssertEqual(coordinator.phase, .idle)
        let first = try GooglePairingProductionDefaults.challenge()
        let second = try GooglePairingProductionDefaults.challenge()
        XCTAssertNotNil(UUID(uuidString: first.requestId))
        XCTAssertNotEqual(first.requestId, second.requestId)
        XCTAssertNotEqual(first.secret, second.secret)
        XCTAssertEqual(first.name, UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines))
        let nonce = try first.nonce
        let authorization = try GoogleNativeAuthorization(clientId: "fixture-native.apps.googleusercontent.com", nonce: nonce)
        let query = try XCTUnwrap(URLComponents(url: authorization.url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(query.first { $0.name == "nonce" }?.value, nonce)
        XCTAssertFalse(authorization.url.absoluteString.contains(first.secret))
        XCTAssertNotEqual(nonce, try second.nonce)
    }

    func testRealDefaultClientValidatesConfigurationAndClosesItsTransportBeforeAnotherRequest() async throws {
        let direct = GooglePairingProductionDefaults.transport()
        defer { direct.close() }
        let invalidOrigin = try GoogleCloudPairingConfiguration(
            clientId: "fixture-native.apps.googleusercontent.com",
            relayOrigin: XCTUnwrap(URL(string: "http://relay.example.test"))
        )
        let invalidAudience = try GoogleCloudPairingConfiguration(
            clientId: "unregistered",
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test"))
        )
        for configuration in [invalidOrigin, invalidAudience] {
            XCTAssertThrowsError(try GooglePairingProductionDefaults.client(configuration, direct)) {
                XCTAssertEqual($0 as? CloudPairingError, .configuration)
            }
        }
        let configuration = try GoogleCloudPairingConfiguration(
            clientId: "fixture-native.apps.googleusercontent.com",
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test"))
        )
        let client = try GooglePairingProductionDefaults.client(configuration, direct)
        await client.close()
        do {
            _ = try await direct.requestData(
                url: XCTUnwrap(URL(string: "https://relay.example.test/closed")),
                method: "GET",
                body: nil,
                bearer: nil,
                form: false
            )
            XCTFail("A closed production pairing transport started another request")
        } catch {
            XCTAssertEqual(error as? CloudPairingError, .cancelled)
        }
    }

    func testProductionPollDelayHonorsCancellationAndClockUsesCurrentEpochSeconds() async throws {
        let before = Date().timeIntervalSince1970
        let current = GooglePairingProductionDefaults.now()
        let after = Date().timeIntervalSince1970
        XCTAssertGreaterThanOrEqual(current, min(before, after) - 1)
        XCTAssertLessThanOrEqual(current, max(before, after) + 1)
        let waiting = Task { try await GooglePairingProductionDefaults.wait() }
        waiting.cancel()
        do {
            try await waiting.value
            XCTFail("Production poll delay ignored task cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        // A healthy tick must also complete, so polling progresses after the delay.
        try await GooglePairingProductionDefaults.wait()
    }
}
#endif
