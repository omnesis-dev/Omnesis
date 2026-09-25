// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PushRegistrationConcurrencyTests: XCTestCase {
    private let pairing = Pairing(
        url: URL(string: "https://gateway.example.test")!,
        token: "broad-token",
        accountId: "local",
        deviceId: "device-example",
        gatewayName: "Example gateway",
        fingerprint: String(repeating: "a", count: 64)
    )

    func testSameRegistrationCoalescesWhilePlanIsInFlight() async throws {
        let planStarted = AsyncLatch()
        let releasePlan = AsyncLatch()
        let log = AsyncRequestLog()
        let coordinator = PushRegistrationCoordinator(
            store: InMemoryStore(),
            gatewayRequest: { _, request in
                let ordinal = await log.record(request)
                if request.url?.path.hasSuffix("/push-plan") == true {
                    await planStarted.open()
                    await releasePlan.wait()
                    return response(request, 200, #"{"transport":"direct-apns"}"#)
                }
                XCTAssertEqual(ordinal, 0)
                return response(request, 200, #"{"ok":true}"#)
            },
            relayRequest: { request in response(request, 500, "") }
        )
        let register = {
            try await coordinator.register(
                pairing: self.pairing,
                tokenHex: String(repeating: "a", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }

        let first = Task { try await register() }
        await planStarted.wait()
        let second = Task { try await register() }
        await Task.yield()
        let plansBeforeRelease = await log.planCount
        XCTAssertEqual(plansBeforeRelease, 1)
        await releasePlan.open()
        try await first.value
        try await second.value

        let planCount = await log.planCount
        let registrationCount = await log.registrationCount
        XCTAssertEqual(planCount, 1)
        XCTAssertEqual(registrationCount, 1)
    }

    func testNewIdentitySupersedesDelayedOlderPlan() async throws {
        let firstPlanStarted = AsyncLatch()
        let releaseFirstPlan = AsyncLatch()
        let log = AsyncRequestLog()
        let relayCalls = AsyncCounter()
        let store = InMemoryStore()
        let coordinator = PushRegistrationCoordinator(
            store: store,
            gatewayRequest: { _, request in
                let ordinal = await log.record(request)
                guard request.url?.path.hasSuffix("/push-plan") == true else {
                    return response(request, 200, #"{"ok":true}"#)
                }
                if ordinal == 1 {
                    await firstPlanStarted.open()
                    await releaseFirstPlan.wait()
                    return response(
                        request,
                        200,
                        #"{"transport":"relay","relayUrl":"https://push.example.test"}"#
                    )
                }
                return response(request, 200, #"{"transport":"direct-apns"}"#)
            },
            relayRequest: { request in
                await relayCalls.increment()
                return response(request, 202, #"{"challengeId":"stale"}"#)
            }
        )

        let older = Task {
            try await coordinator.register(
                pairing: pairing,
                tokenHex: String(repeating: "1", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }
        await firstPlanStarted.wait()
        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "2", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )
        await releaseFirstPlan.open()
        await XCTAssertPushThrowsErrorAsync { try await older.value }

        let relayCallCount = await relayCalls.value
        XCTAssertEqual(relayCallCount, 0)
        let rawState = try XCTUnwrap(try store.get("push.registration.state.v1"))
        XCTAssertTrue(rawState.contains(String(repeating: "2", count: 64)))
        XCTAssertTrue(rawState.contains("direct-apns"))
        XCTAssertFalse(rawState.contains("stale"))
    }

    func testNewIdentitySupersedesDelayedRelayEnrollment() async throws {
        let enrolStarted = AsyncLatch()
        let releaseEnrol = AsyncLatch()
        let log = AsyncRequestLog()
        let store = InMemoryStore()
        let coordinator = PushRegistrationCoordinator(
            store: store,
            gatewayRequest: { _, request in
                let ordinal = await log.record(request)
                guard request.url?.path.hasSuffix("/push-plan") == true else {
                    return response(request, 200, #"{"ok":true}"#)
                }
                if ordinal == 1 {
                    return response(
                        request,
                        200,
                        #"{"transport":"relay","relayUrl":"https://push.example.test"}"#
                    )
                }
                return response(request, 200, #"{"transport":"direct-apns"}"#)
            },
            relayRequest: { request in
                await enrolStarted.open()
                await releaseEnrol.wait()
                return response(request, 202, #"{"challengeId":"stale-enrolment"}"#)
            }
        )

        let older = Task {
            try await coordinator.register(
                pairing: pairing,
                tokenHex: String(repeating: "3", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }
        await enrolStarted.wait()
        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "4", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )
        await releaseEnrol.open()
        await XCTAssertPushThrowsErrorAsync { try await older.value }

        let rawState = try XCTUnwrap(try store.get("push.registration.state.v1"))
        XCTAssertTrue(rawState.contains(String(repeating: "4", count: 64)))
        XCTAssertTrue(rawState.contains("direct-apns"))
        XCTAssertFalse(rawState.contains("stale-enrolment"))
    }

    func testClearDuringPlanPreventsRelayEnrollmentAndStateRestore() async throws {
        let planStarted = AsyncLatch()
        let releasePlan = AsyncLatch()
        let relayCalls = AsyncCounter()
        let store = InMemoryStore()
        let coordinator = PushRegistrationCoordinator(
            store: store,
            gatewayRequest: { _, request in
                await planStarted.open()
                await releasePlan.wait()
                return response(
                    request,
                    200,
                    #"{"transport":"relay","relayUrl":"https://push.example.test"}"#
                )
            },
            relayRequest: { request in
                await relayCalls.increment()
                return response(request, 202, #"{"challengeId":"must-not-exist"}"#)
            }
        )
        let registration = Task {
            try await coordinator.register(
                pairing: pairing,
                tokenHex: String(repeating: "5", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }

        await planStarted.wait()
        try await coordinator.clear()
        await releasePlan.open()
        await XCTAssertPushThrowsErrorAsync { try await registration.value }

        let relayCallCount = await relayCalls.value
        XCTAssertEqual(relayCallCount, 0)
        XCTAssertNil(try store.get("push.registration.state.v1"))
    }

    func testRelayCallbackJoinsFastNonceRegistrationWithoutVerifyingTwice() async throws {
        let verifyStarted = AsyncLatch()
        let releaseVerify = AsyncLatch()
        let verifyCalls = AsyncCounter()
        let registrations = AsyncCounter()
        let store = InMemoryStore()
        try store.set("nonce-fast", forKey: "push.registration.challenge-nonce.v1")
        let coordinator = PushRegistrationCoordinator(
            store: store,
            gatewayRequest: { _, request in
                if request.url?.path.hasSuffix("/push-plan") == true {
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
                    return response(request, 202, #"{"challengeId":"challenge-fast"}"#)
                }
                await verifyCalls.increment()
                await verifyStarted.open()
                await releaseVerify.wait()
                return response(request, 200, #"{"credential":"credential-fast"}"#)
            }
        )

        let registration = Task {
            try await coordinator.register(
                pairing: pairing,
                tokenHex: String(repeating: "6", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }
        await verifyStarted.wait()
        let callback = Task {
            try await coordinator.receiveRelayChallenge(nonce: "nonce-fast", pairing: pairing)
        }
        await Task.yield()
        let callsBeforeRelease = await verifyCalls.value
        XCTAssertEqual(callsBeforeRelease, 1)

        await releaseVerify.open()
        try await registration.value
        let accepted = try await callback.value

        XCTAssertTrue(accepted)
        let verifyCallCount = await verifyCalls.value
        let registrationCount = await registrations.value
        XCTAssertEqual(verifyCallCount, 1)
        XCTAssertEqual(registrationCount, 1)
        XCTAssertNil(try store.get("push.registration.challenge-nonce.v1"))
    }

    func testOlderChallengeCannotCancelNewerTokenRegistration() async throws {
        let newerPlanStarted = AsyncLatch()
        let releaseNewerPlan = AsyncLatch()
        let log = AsyncRequestLog()
        let verifyCalls = AsyncCounter()
        let store = InMemoryStore()
        let coordinator = PushRegistrationCoordinator(
            store: store,
            gatewayRequest: { _, request in
                let ordinal = await log.record(request)
                guard request.url?.path.hasSuffix("/push-plan") == true else {
                    return response(request, 200, #"{"ok":true}"#)
                }
                if ordinal == 1 {
                    return response(
                        request,
                        200,
                        #"{"transport":"relay","relayUrl":"https://push.example.test"}"#
                    )
                }
                await newerPlanStarted.open()
                await releaseNewerPlan.wait()
                return response(request, 200, #"{"transport":"direct-apns"}"#)
            },
            relayRequest: { request in
                if request.url?.path == "/v1/enrol/verify" {
                    await verifyCalls.increment()
                    return response(request, 200, #"{"credential":"must-not-be-used"}"#)
                }
                return response(request, 202, #"{"challengeId":"challenge-older"}"#)
            }
        )
        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "7", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )

        let newer = Task {
            try await coordinator.register(
                pairing: pairing,
                tokenHex: String(repeating: "8", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }
        await newerPlanStarted.wait()
        try store.set("nonce-older", forKey: "push.registration.challenge-nonce.v1")
        let accepted = try await coordinator.receiveRelayChallenge(
            nonce: "nonce-older",
            pairing: pairing
        )
        XCTAssertFalse(accepted)
        XCTAssertNil(try store.get("push.registration.challenge-nonce.v1"))

        await releaseNewerPlan.open()
        try await newer.value

        let verifyCallCount = await verifyCalls.value
        XCTAssertEqual(verifyCallCount, 0)
        let rawState = try XCTUnwrap(try store.get("push.registration.state.v1"))
        XCTAssertTrue(rawState.contains(String(repeating: "8", count: 64)))
        XCTAssertTrue(rawState.contains("direct-apns"))
        XCTAssertFalse(rawState.contains("challenge-older"))
    }

    func testSupersedingRegistrationWriteWaitsForIssuedOlderWrite() async throws {
        let olderWriteStarted = AsyncLatch()
        let releaseOlderWrite = AsyncLatch()
        let requests = AsyncRequestRecorder()
        let coordinator = PushRegistrationCoordinator(
            store: InMemoryStore(),
            gatewayRequest: { _, request in
                if request.url?.path.hasSuffix("/push-plan") == true {
                    return response(request, 200, #"{"transport":"direct-apns"}"#)
                }
                let ordinal = await requests.record(request)
                if ordinal == 1 {
                    await olderWriteStarted.open()
                    await releaseOlderWrite.wait()
                }
                return response(request, 200, #"{"ok":true}"#)
            },
            relayRequest: { request in response(request, 500, "") }
        )

        let older = Task {
            try await coordinator.register(
                pairing: pairing,
                tokenHex: String(repeating: "9", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }
        await olderWriteStarted.wait()
        let newer = Task {
            try await coordinator.register(
                pairing: pairing,
                tokenHex: String(repeating: "a", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }
        await Task.yield()
        let writesBeforeRelease = await requests.count
        XCTAssertEqual(writesBeforeRelease, 1)

        await releaseOlderWrite.open()
        await XCTAssertPushThrowsErrorAsync { try await older.value }
        try await newer.value

        let tokens = await requests.jsonValues(named: "deviceToken")
        XCTAssertEqual(tokens, [
            String(repeating: "9", count: 64),
            String(repeating: "a", count: 64),
        ])
    }
}

final class PushRegistrationGateTests: XCTestCase {
    private let pairing = Pairing(
        url: URL(string: "https://gateway.example.test")!,
        token: "broad-token",
        accountId: "local",
        deviceId: "device-example",
        gatewayName: "Example gateway",
        fingerprint: String(repeating: "a", count: 64)
    )

    func testAttemptGateRejectsDelayedOlderResultAndExplicitInvalidation() async {
        let releaseOlder = AsyncLatch()
        var gate = PushRegistrationAttemptGate()
        let olderAttempt = gate.begin()
        let delayedResult = Task {
            await releaseOlder.wait()
            return olderAttempt
        }

        let newerAttempt = gate.begin()
        await releaseOlder.open()
        let returnedAttempt = await delayedResult.value
        XCTAssertFalse(gate.isCurrent(returnedAttempt))
        XCTAssertTrue(gate.isCurrent(newerAttempt))

        gate.invalidate()
        XCTAssertFalse(gate.isCurrent(newerAttempt))
    }

    func testAPNsCallbackRequestConsumesFailureAndRetrySuccessForCurrentPairing() {
        var gate = PushCallbackRequestGate()
        gate.begin(pairing: nil)
        XCTAssertFalse(gate.consume(pairing: nil)) // no diagnosis before pairing
        gate.begin(pairing: pairing)
        XCTAssertTrue(gate.consume(pairing: pairing)) // iOS registration failed
        XCTAssertFalse(gate.consume(pairing: pairing)) // duplicate callback

        gate.begin(pairing: pairing) // user retries after fixing provisioning
        XCTAssertTrue(gate.consume(pairing: pairing)) // iOS returns a token

        gate.begin(pairing: pairing)
        gate.invalidate() // unpair or switch gateways before the callback
        XCTAssertFalse(gate.consume(pairing: pairing))

        let otherPairing = Pairing(
            url: pairing.url,
            token: "new-pairing-token",
            accountId: pairing.accountId,
            deviceId: pairing.deviceId,
            gatewayName: pairing.gatewayName,
            fingerprint: pairing.fingerprint
        )
        gate.begin(pairing: otherPairing)
        // APNs gives no request ID. A callback after this point describes the
        // app's registration state, regardless of which request produced it.
        XCTAssertTrue(gate.consume(pairing: otherPairing))
    }

    #if canImport(UIKit)
    @MainActor
    func testAPNsFailureIsVisibleAndClearsWhenRetryReceivesAToken() {
        let store = AppStore.preview(pairedDeviceId: "device-example")
        let failure = NSError(
            domain: "APNs",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "No valid push entitlement"]
        )

        store.beginPushCallbackRequest()
        store.recordPushRegistrationFailure(failure)
        XCTAssertEqual(store.pushRegistrationFailure, "No valid push entitlement")
        store.recordPushRegistrationFailure(failure) // duplicate failure is ignored

        store.beginPushCallbackRequest() // retry after provisioning repair
        XCTAssertTrue(store.acceptPushTokenCallback())
        XCTAssertNil(store.pushRegistrationFailure)
        XCTAssertFalse(store.acceptPushTokenCallback())
    }
    #endif

    func testConfigurationCheckRejectsLateResponseForAnotherPairingOrApp() {
        var gate = PushConfigurationCheckGate()
        let first = gate.begin(pairing: pairing, appId: "com.example.myomnesis")
        XCTAssertTrue(gate.isCurrent(first, pairing: pairing, appId: "com.example.myomnesis"))
        XCTAssertFalse(gate.isCurrent(first, pairing: pairing, appId: "com.example.other"))

        let otherPairing = Pairing(
            url: pairing.url,
            token: "new-pairing-token",
            accountId: pairing.accountId,
            deviceId: pairing.deviceId,
            gatewayName: pairing.gatewayName,
            fingerprint: pairing.fingerprint
        )
        XCTAssertFalse(gate.isCurrent(first, pairing: otherPairing, appId: "com.example.myomnesis"))

        let second = gate.begin(pairing: otherPairing, appId: "com.example.myomnesis")
        XCTAssertFalse(gate.isCurrent(first, pairing: pairing, appId: "com.example.myomnesis"))
        XCTAssertTrue(gate.isCurrent(second, pairing: otherPairing, appId: "com.example.myomnesis"))
        gate.invalidate()
        XCTAssertFalse(gate.isCurrent(second, pairing: otherPairing, appId: "com.example.myomnesis"))
    }
}

actor AsyncLatch {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func open() {
        guard !isOpen else { return }
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }
}

actor AsyncCounter {
    private(set) var value = 0

    func increment() {
        value += 1
    }
}

actor AsyncRequestLog {
    private(set) var planCount = 0
    private(set) var registrationCount = 0

    func record(_ request: URLRequest) -> Int {
        if request.url?.path.hasSuffix("/push-plan") == true {
            planCount += 1
            return planCount
        }
        if request.url?.path.hasSuffix("/push-registration") == true {
            registrationCount += 1
        }
        return 0
    }
}

actor AsyncRequestRecorder {
    private var requests: [URLRequest] = []

    var count: Int {
        requests.count
    }

    var paths: [String] {
        requests.compactMap { $0.url?.path }
    }

    var authorisations: [String] {
        requests.compactMap { $0.value(forHTTPHeaderField: "Authorization") }
    }

    func record(_ request: URLRequest) -> Int {
        requests.append(request)
        return requests.count
    }

    func jsonValues(named name: String) -> [String] {
        requests.compactMap { request in
            guard let body = request.httpBody,
                  let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
            else { return nil }
            return object[name] as? String
        }
    }
}

func response(_ request: URLRequest, _ status: Int, _ body: String) -> (Data, URLResponse) {
    (
        Data(body.utf8),
        HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
    )
}

func XCTAssertPushThrowsErrorAsync(
    _ expression: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await expression()
        XCTFail("expected error", file: file, line: line)
    } catch {}
}
