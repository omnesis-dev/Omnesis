// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PushRegistrationPairingGenerationTests: XCTestCase {
    func testPairingGenerationPreventsCoalescingSamePushIdentity() async throws {
        let olderPlanStarted = AsyncLatch()
        let releaseOlderPlan = AsyncLatch()
        let requests = AsyncRequestRecorder()
        let olderPairing = try pairing(generation: "generation-older", token: "token-older")
        let newerPairing = try pairing(generation: "generation-newer", token: "token-newer")
        let coordinator = PushRegistrationCoordinator(
            store: InMemoryStore(),
            gatewayRequest: { _, request in
                let ordinal = await requests.record(request)
                if request.url?.path.hasSuffix("/push-plan") == true, ordinal == 1 {
                    await olderPlanStarted.open()
                    await releaseOlderPlan.wait()
                }
                if request.url?.path.hasSuffix("/push-plan") == true {
                    return response(request, 200, #"{"transport":"direct-apns"}"#)
                }
                return response(request, 200, #"{"ok":true}"#)
            },
            relayRequest: { request in response(request, 500, "") }
        )
        let token = String(repeating: "b", count: 64)

        let older = Task {
            try await coordinator.register(
                pairing: olderPairing,
                tokenHex: token,
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }
        await olderPlanStarted.wait()
        try await coordinator.register(
            pairing: newerPairing,
            tokenHex: token,
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )
        await releaseOlderPlan.open()
        await XCTAssertPushThrowsErrorAsync { try await older.value }

        let paths = await requests.paths
        XCTAssertEqual(paths.filter { $0.hasSuffix("/push-plan") }.count, 2)
        let authorisations = await requests.authorisations
        XCTAssertTrue(authorisations.contains("Bearer token-newer"))
    }

    private func pairing(generation: String, token: String) throws -> Pairing {
        try Pairing(
            url: XCTUnwrap(URL(string: "https://gateway.example.test")),
            token: token,
            pairingGeneration: generation,
            accountId: "local",
            deviceId: "device-example",
            gatewayName: "Example gateway",
            fingerprint: String(repeating: "a", count: 64)
        )
    }
}
