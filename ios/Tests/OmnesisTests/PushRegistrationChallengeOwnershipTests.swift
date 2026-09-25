// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PushRegistrationChallengeOwnershipTests: XCTestCase {
    func testSameRegistrationAwaitsChallengeThatAlreadyOwnsVerification() async throws {
        let verifyStarted = AsyncLatch()
        let releaseVerify = AsyncLatch()
        let plans = AsyncCounter()
        let verifies = AsyncCounter()
        let registrations = AsyncCounter()
        let coordinator = makeCoordinator(
            verifyStarted: verifyStarted,
            releaseVerify: releaseVerify,
            plans: plans,
            verifies: verifies,
            registrations: registrations
        )
        let token = String(repeating: "c", count: 64)
        let pairing = try makePairing()

        try await register(coordinator, pairing: pairing, token: token)
        let challenge = Task {
            try await coordinator.receiveRelayChallenge(nonce: "nonce-owned", pairing: pairing)
        }
        await verifyStarted.wait()
        let registration = Task {
            try await self.register(coordinator, pairing: pairing, token: token)
        }

        await releaseVerify.open()
        let accepted = try await challenge.value
        XCTAssertTrue(accepted)
        try await registration.value

        let planCount = await plans.value
        let verifyCount = await verifies.value
        let registrationCount = await registrations.value
        XCTAssertEqual(planCount, 2)
        XCTAssertEqual(verifyCount, 1)
        XCTAssertEqual(registrationCount, 1)
    }

    func testLegacyProbeAwaitsSameOwnerChallengeWithoutCancelingIt() async throws {
        let verifyStarted = AsyncLatch()
        let releaseVerify = AsyncLatch()
        let plans = AsyncCounter()
        let verifies = AsyncCounter()
        let registrations = AsyncCounter()
        let coordinator = makeCoordinator(
            verifyStarted: verifyStarted,
            releaseVerify: releaseVerify,
            plans: plans,
            verifies: verifies,
            registrations: registrations
        )
        let tokenData = Data(repeating: 0xAB, count: 32)
        let pairing = try makePairing()

        try await register(
            coordinator,
            pairing: pairing,
            token: String(repeating: "ab", count: 32)
        )
        let challenge = Task {
            try await coordinator.receiveRelayChallenge(nonce: "nonce-owned", pairing: pairing)
        }
        await verifyStarted.wait()
        let legacyProbe = Task {
            try await coordinator.registerLegacyIfPushPlanUnavailable(
                pairing: pairing,
                tokenData: tokenData,
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }

        await releaseVerify.open()
        let accepted = try await challenge.value
        let usedLegacy = try await legacyProbe.value
        XCTAssertTrue(accepted)
        XCTAssertFalse(usedLegacy)

        let planCount = await plans.value
        let verifyCount = await verifies.value
        let registrationCount = await registrations.value
        XCTAssertEqual(planCount, 2)
        XCTAssertEqual(verifyCount, 1)
        XCTAssertEqual(registrationCount, 1)
    }

    func testDifferentRegistrationStillSupersedesActiveChallenge() async throws {
        let verifyStarted = AsyncLatch()
        let releaseVerify = AsyncLatch()
        let plans = AsyncCounter()
        let pairing = try makePairing()
        let store = InMemoryStore()
        let coordinator = PushRegistrationCoordinator(
            store: store,
            gatewayRequest: { _, request in
                if request.url?.path.hasSuffix("/push-plan") == true {
                    await plans.increment()
                    let ordinal = await plans.value
                    if ordinal < 3 {
                        return response(
                            request,
                            200,
                            #"{"transport":"relay","relayUrl":"https://push.example.test"}"#
                        )
                    }
                    return response(request, 200, #"{"transport":"direct-apns"}"#)
                }
                return response(request, 200, #"{"ok":true}"#)
            },
            relayRequest: { request in
                if request.url?.path == "/v1/enrol" {
                    return response(request, 202, #"{"challengeId":"challenge-older"}"#)
                }
                await verifyStarted.open()
                await releaseVerify.wait()
                return response(request, 200, #"{"credential":"credential-older"}"#)
            }
        )

        try await register(coordinator, pairing: pairing, token: String(repeating: "d", count: 64))
        let challenge = Task {
            try await coordinator.receiveRelayChallenge(nonce: "nonce-older", pairing: pairing)
        }
        await verifyStarted.wait()

        try await register(coordinator, pairing: pairing, token: String(repeating: "e", count: 64))
        await releaseVerify.open()
        await XCTAssertPushThrowsErrorAsync { _ = try await challenge.value }

        let rawState = try XCTUnwrap(try store.get("push.registration.state.v1"))
        XCTAssertTrue(rawState.contains(String(repeating: "e", count: 64)))
        XCTAssertTrue(rawState.contains("direct-apns"))
        XCTAssertFalse(rawState.contains("credential-older"))
    }

    private func makeCoordinator(
        verifyStarted: AsyncLatch,
        releaseVerify: AsyncLatch,
        plans: AsyncCounter,
        verifies: AsyncCounter,
        registrations: AsyncCounter
    )
        -> PushRegistrationCoordinator {
        PushRegistrationCoordinator(
            store: InMemoryStore(),
            gatewayRequest: { _, request in
                if request.url?.path.hasSuffix("/push-plan") == true {
                    await plans.increment()
                    return response(
                        request,
                        200,
                        #"{"transport":"relay","relayUrl":"https://push.example.test"}"#
                    )
                }
                await registrations.increment()
                return response(request, 200, #"{"ok":true}"#)
            },
            relayRequest: { request in
                if request.url?.path == "/v1/enrol" {
                    return response(request, 202, #"{"challengeId":"challenge-owned"}"#)
                }
                await verifies.increment()
                await verifyStarted.open()
                await releaseVerify.wait()
                return response(request, 200, #"{"credential":"credential-owned"}"#)
            }
        )
    }

    private func makePairing() throws -> Pairing {
        try Pairing(
            url: XCTUnwrap(URL(string: "https://gateway.example.test")),
            token: "broad-token",
            pairingGeneration: "pairing-generation",
            accountId: "local",
            deviceId: "device-example",
            gatewayName: "Example gateway",
            fingerprint: String(repeating: "a", count: 64)
        )
    }

    private func register(
        _ coordinator: PushRegistrationCoordinator,
        pairing: Pairing,
        token: String
    ) async throws {
        try await coordinator.register(
            pairing: pairing,
            tokenHex: token,
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )
    }
}
