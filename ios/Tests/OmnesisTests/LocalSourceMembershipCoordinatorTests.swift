// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Outbox semantics of a phone changing which sources it hosts: a detach
/// settles on success, on a vanished source and on "not a member"; the only
/// host pauses the source instead; a resume supersedes a detach the gateway
/// never saw; an intent taken under a pairing this phone no longer holds is
/// dropped; anything inconclusive is retried on the next pass.
final class LocalSourceMembershipCoordinatorTests: XCTestCase {
    private let gateway = URL(string: "https://gateway.example.com")!
    private let deviceId = "dev_phone_1"
    private let outboxKey = "omnesis.localSourceRemoval.pending"

    private func lastMember() -> GatewayClient.Error {
        .serverError(
            status: 409,
            body: #"{"error":"device dev_phone_1 is the last host of photos:local","code":"LAST_MEMBER"}"#
        )
    }

    private func refusal(_ code: String, status: Int = 409) -> GatewayClient.Error {
        .serverError(status: status, body: #"{"error":"refused","code":"\#(code)"}"#)
    }

    private func row(
        _ id: String = "photos:local",
        enabled: Bool = true,
        owner: String = "dev_phone_9",
        members: [String] = []
    )
        -> SourceRecord {
        SourceRecord(
            id: id,
            type: "photos",
            accountId: "local",
            deviceId: owner,
            enabled: enabled,
            members: members
        )
    }

    /// Defaults that fail the test: a pass that reaches the gateway in a
    /// way the case did not set up is a failure, not a silent pass.
    private static let noListing: @Sendable () async throws -> [SourceRecord] = {
        XCTFail("unexpected source listing")
        return []
    }

    private static let noJoin: @Sendable (String, String) async throws -> Void = { _, _ in
        XCTFail("unexpected join")
    }

    private static let noDetach: @Sendable (String, String) async throws -> Void = { _, _ in
        XCTFail("unexpected detach")
    }

    private static let noPatch: @Sendable (String, Bool) async throws -> Void = { _, _ in
        XCTFail("unexpected enabled patch")
    }

    private func executor(
        sources: @escaping @Sendable () async throws -> [SourceRecord] = LocalSourceMembershipCoordinatorTests.noListing,
        create: @escaping @Sendable (String, String) async throws -> Void = { _, _ in XCTFail("unexpected registration") },
        join: @escaping @Sendable (String, String) async throws -> Void = LocalSourceMembershipCoordinatorTests.noJoin,
        detach: @escaping @Sendable (String, String) async throws -> Void = LocalSourceMembershipCoordinatorTests.noDetach,
        setEnabled: @escaping @Sendable (String, Bool) async throws -> Void = LocalSourceMembershipCoordinatorTests.noPatch
    )
        -> Executor {
        Executor(sources: sources, create: create, join: join, detach: detach, setEnabled: setEnabled)
    }

    private func makeCoordinator(
        _ defaults: DictionaryDefaults = DictionaryDefaults()
    )
        -> LocalSourceMembershipCoordinator {
        LocalSourceMembershipCoordinator(defaults: defaults)
    }

    // MARK: - Detach

    func testDetachSettlesOnSuccess() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)
        let calls = Calls()

        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { sourceId, deviceId in await calls.record("detach \(sourceId) \(deviceId)") }
        ))

        let recorded = await calls.values
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pass.settled)
        XCTAssertEqual(recorded, ["detach photos:local dev_phone_1"])
        XCTAssertTrue(pending.isEmpty)
    }

    func testDetachSettlesWhenTheSourceIsGone() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { _, _ in throw GatewayClient.Error.notFound }
        ))

        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pending.isEmpty)
    }

    func testDetachSettlesWhenThisDeviceIsNotAMember() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { [self] _, _ in throw refusal("DEVICE_NOT_MEMBER") }
        ))

        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pending.isEmpty)
    }

    func testLastMemberPausesTheSourceInstead() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)
        let calls = Calls()

        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { [self] sourceId, _ in
                await calls.record("detach \(sourceId)")
                throw lastMember()
            },
            setEnabled: { sourceId, enabled in await calls.record("enabled=\(enabled) \(sourceId)") }
        ))

        let recorded = await calls.values
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pass.settled)
        XCTAssertEqual(recorded, ["detach photos:local", "enabled=false photos:local"])
        XCTAssertTrue(pending.isEmpty)
    }

    func testFailedPauseKeepsTheIntentAndRetriesFromDetach() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)
        let calls = Calls()

        let firstPass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { [self] _, _ in throw lastMember() },
            setEnabled: { _, _ in throw URLError(.notConnectedToInternet) }
        ))
        let stillPending = await coordinator.pending(gateway: gateway)
        XCTAssertFalse(firstPass.settled)
        XCTAssertEqual(stillPending.map(\.sourceId), ["photos:local"])

        await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { [self] sourceId, _ in
                await calls.record("detach \(sourceId)")
                throw lastMember()
            },
            setEnabled: { sourceId, enabled in await calls.record("enabled=\(enabled) \(sourceId)") }
        ))
        let recorded = await calls.values
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(recorded, ["detach photos:local", "enabled=false photos:local"])
        XCTAssertTrue(pending.isEmpty)
    }

    func testOfflineDisableRetriesAfterReconnect() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        let offlinePass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { _, _ in throw URLError(.notConnectedToInternet) }
        ))
        let offlinePending = await coordinator.pending(gateway: gateway)
        XCTAssertFalse(offlinePass.settled)
        XCTAssertEqual(offlinePending.map(\.sourceId), ["photos:local"])

        let calls = Calls()
        await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { sourceId, _ in await calls.record(sourceId) }
        ))
        let recorded = await calls.values
        let finalPending = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(recorded, ["photos:local"])
        XCTAssertTrue(finalPending.isEmpty)
    }

    func testOtherServerErrorsRetry() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { [self] _, _ in throw refusal("BUSY", status: 503) }
        ))

        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(pending.map(\.sourceId), ["photos:local"])
    }

    /// A revoked device is refused identically on every pass, so the intent
    /// is dropped rather than retried on every foreground for good.
    func testATerminalRefusalDropsTheIntentInsteadOfRetryingForever() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)
        let attempts = Calls()

        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { [self] sourceId, _ in
                await attempts.record(sourceId)
                throw refusal("DEVICE_REVOKED")
            }
        ))

        let pending = await coordinator.pending(gateway: gateway)
        let tried = await attempts.values
        XCTAssertTrue(pass.settled)
        XCTAssertEqual(tried, ["photos:local"])
        XCTAssertTrue(pending.isEmpty)
    }

    func testIntentDoesNotLeakToAnotherGateway() async throws {
        let coordinator = makeCoordinator()
        let oldGateway = try XCTUnwrap(URL(string: "https://old.example.com"))
        let newGateway = try XCTUnwrap(URL(string: "https://new.example.com"))
        await coordinator.record(.detach, sourceId: "photos:local", gateway: oldGateway, deviceId: deviceId)

        await coordinator.reconcile(gateway: newGateway, deviceId: deviceId, using: executor())

        let oldPending = await coordinator.pending(gateway: oldGateway)
        XCTAssertEqual(oldPending.map(\.sourceId), ["photos:local"])
    }

    // MARK: - Resume supersedes a queued detach

    /// The offline off-then-on sequence. Without supersession the detach the
    /// gateway never accepted runs once the network returns, pausing a source
    /// whose switch reads on and leaving nothing to unpause it.
    func testResumeSupersedesADetachTheGatewayNeverAccepted() async {
        let coordinator = makeCoordinator()
        let calls = Calls()

        // Switch off while offline: the detach is recorded and deferred.
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)
        await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { _, _ in throw URLError(.notConnectedToInternet) }
        ))
        let afterOffline = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(afterOffline.map(\.operation), [.detach])

        // Switch back on, still offline: the resume replaces the detach.
        await coordinator.record(.resume, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)
        let afterResume = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(afterResume.map(\.operation), [.resume])

        // Network returns: only the resume is carried out, and it puts the
        // source back — the detach never reaches the gateway.
        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            sources: { [self] in [row(enabled: false)] },
            join: { sourceId, deviceId in await calls.record("join \(sourceId) \(deviceId)") },
            setEnabled: { sourceId, enabled in await calls.record("enabled=\(enabled) \(sourceId)") }
        ))

        let recorded = await calls.values
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pass.settled)
        XCTAssertEqual(recorded, ["join photos:local dev_phone_1", "enabled=true photos:local"])
        XCTAssertTrue(pending.isEmpty)
    }

    func testSupersessionIsScopedToOneGateway() async throws {
        let coordinator = makeCoordinator()
        let other = try XCTUnwrap(URL(string: "https://other.example.com"))
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)
        await coordinator.record(.resume, sourceId: "photos:local", gateway: other, deviceId: deviceId)

        let here = await coordinator.pending(gateway: gateway)
        let there = await coordinator.pending(gateway: other)
        XCTAssertEqual(here.map(\.operation), [.detach])
        XCTAssertEqual(there.map(\.operation), [.resume])
    }

    // MARK: - Resume

    func testResumeLeavesAnEnabledSourceThisDeviceAlreadyHostsAlone() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.resume, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            sources: { [self] in [row(owner: deviceId)] }
        ))

        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pass.settled)
        XCTAssertTrue(pending.isEmpty)
    }

    func testResumeUnpausesWithoutRejoiningAMembershipItAlreadyHas() async {
        let coordinator = makeCoordinator()
        let calls = Calls()
        await coordinator.record(.resume, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            sources: { [self] in [row(enabled: false, members: [deviceId])] },
            setEnabled: { sourceId, enabled in await calls.record("enabled=\(enabled) \(sourceId)") }
        ))

        let recorded = await calls.values
        XCTAssertEqual(recorded, ["enabled=true photos:local"])
    }

    func testAResumeTheGatewayRefusesForGoodIsDropped() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.resume, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            sources: { [self] in [row()] },
            join: { [self] _, _ in throw refusal("SOURCE_ALREADY_HOSTED") }
        ))

        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pass.settled)
        XCTAssertTrue(pending.isEmpty)
        // The switch that asked has to hear about it: dropping the intent
        // silently would leave an on switch feeding nothing.
        XCTAssertEqual(pass.refusals.map(\.sourceId), ["photos:local"])
        XCTAssertEqual(pass.refusals.map(\.operation), [.resume])
        XCTAssertEqual(pass.refusals.map(\.code), ["SOURCE_ALREADY_HOSTED"])
    }

    func testASettledResumeReportsNoRefusal() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.resume, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            sources: { [self] in [row(owner: deviceId)] }
        ))

        XCTAssertTrue(pass.refusals.isEmpty)
    }

    func testADetachRefusedForGoodIsReportedToo() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { [self] _, _ in throw refusal("DEVICE_REVOKED") }
        ))

        XCTAssertEqual(pass.refusals.map(\.operation), [.detach])
        XCTAssertEqual(pass.refusals.map(\.code), ["DEVICE_REVOKED"])
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pending.isEmpty)
    }

    func testAnUnreachableGatewayKeepsTheResumeQueued() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.resume, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            sources: { throw URLError(.notConnectedToInternet) }
        ))

        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertFalse(pass.settled)
        XCTAssertEqual(pending.map(\.operation), [.resume])
    }

    // MARK: - Pairing scope

    /// `unpair()` queues a detach for every enabled source. Pairing the same
    /// gateway again under a different device id must not replay it against
    /// the sources the new pairing has just registered.
    func testAnIntentFromAPreviousPairingIsDroppedNotReplayed() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: "dev_phone_old")

        let pass = await coordinator.reconcile(
            gateway: gateway,
            deviceId: "dev_phone_new",
            using: executor()
        )

        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertFalse(pass.settled, "dropping a stale intent changes nothing on the gateway")
        XCTAssertTrue(pending.isEmpty)
    }

    func testAnIntentRecordedUnderTheCurrentPairingSurvives() async {
        let coordinator = makeCoordinator()
        await coordinator.record(.detach, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)
        let calls = Calls()

        await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { sourceId, _ in await calls.record(sourceId) }
        ))

        let recorded = await calls.values
        XCTAssertEqual(recorded, ["photos:local"])
    }

    func testAnIntentFromAnOlderGenerationOfTheSameDeviceIsDropped() async {
        let coordinator = makeCoordinator()
        await coordinator.record(
            .detach,
            sourceId: "photos:local",
            gateway: gateway,
            deviceId: deviceId,
            pairingGeneration: "generation-old"
        )
        let calls = Calls()

        await coordinator.reconcile(
            gateway: gateway,
            deviceId: deviceId,
            pairingGeneration: "generation-new",
            using: executor(detach: { sourceId, _ in await calls.record(sourceId) })
        )

        let recorded = await calls.values
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(recorded, [])
        XCTAssertTrue(pending.isEmpty)
    }

    func testLegacyIntentIsDroppedOnceTheCurrentPairingHasAGeneration() async {
        let defaults = DictionaryDefaults()
        defaults.set(
            Data(#"[{"gateway":"https://gateway.example.com","sourceId":"photos:local"}]"#.utf8),
            forKey: outboxKey
        )
        let coordinator = makeCoordinator(defaults)
        let calls = Calls()

        await coordinator.reconcile(
            gateway: gateway,
            deviceId: deviceId,
            pairingGeneration: "generation-new",
            using: executor(detach: { sourceId, _ in await calls.record(sourceId) })
        )

        let recorded = await calls.values
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(recorded, [])
        XCTAssertTrue(pending.isEmpty)
    }

    // MARK: - Persisted blobs

    /// The shape an earlier build wrote: no operation, no device id. It is a
    /// detach, and it is carried out under whatever pairing is current —
    /// dropping it would abandon a departure the user asked for.
    func testABlobWithoutAnOperationOrDeviceIdIsADetachUnderTheCurrentPairing() async {
        let defaults = DictionaryDefaults()
        defaults.set(
            Data(#"[{"gateway":"https://gateway.example.com","sourceId":"photos:local"}]"#.utf8),
            forKey: outboxKey
        )
        let coordinator = makeCoordinator(defaults)
        let queued = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(queued.map(\.operation), [.detach])
        XCTAssertNil(queued.first?.deviceId)

        let calls = Calls()
        await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            detach: { sourceId, deviceId in await calls.record("detach \(sourceId) \(deviceId)") }
        ))

        let recorded = await calls.values
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(recorded, ["detach photos:local dev_phone_1"])
        XCTAssertTrue(pending.isEmpty)
    }

    func testAnUnreadableBlobIsDiscardedRatherThanLeftInPlace() async {
        let defaults = DictionaryDefaults()
        defaults.set(Data("not json".utf8), forKey: outboxKey)
        let coordinator = makeCoordinator(defaults)

        let queued = await coordinator.pending(gateway: gateway)

        XCTAssertTrue(queued.isEmpty)
        XCTAssertNil(defaults.object(forKey: outboxKey))
    }

    func testAQueuedIntentSurvivesARelaunch() async {
        let defaults = DictionaryDefaults()
        let first = makeCoordinator(defaults)
        await first.record(.resume, sourceId: "photos:local", gateway: gateway, deviceId: deviceId)

        let second = makeCoordinator(defaults)
        let queued = await second.pending(gateway: gateway)

        XCTAssertEqual(queued.map(\.operation), [.resume])
        XCTAssertEqual(queued.first?.deviceId, deviceId)
    }
}

private typealias Executor = LocalSourceMembershipCoordinator.Executor

private actor Calls {
    private(set) var values: [String] = []
    func record(_ value: String) {
        values.append(value)
    }
}

final class LocalSourceDepartureRequestTests: XCTestCase {
    private let deviceId = "dev_phone_1"

    func testCancelledDepartureCannotQueueADetach() async throws {
        let gateway = try XCTUnwrap(URL(string: "https://gateway.example.com"))
        var request = LocalSourceDepartureRequest()
        let coordinator = LocalSourceMembershipCoordinator(defaults: DictionaryDefaults())
        request.propose("activity-segments:local")
        request.cancel()
        if let sourceId = request.confirm() {
            await coordinator.record(.detach, sourceId: sourceId, gateway: gateway, deviceId: deviceId)
        }
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pending.isEmpty)
    }

    func testConfirmedDepartureIsConsumedOnceAndPersistsOffline() async throws {
        let gateway = try XCTUnwrap(URL(string: "https://gateway.example.com"))
        var request = LocalSourceDepartureRequest()
        let coordinator = LocalSourceMembershipCoordinator(defaults: DictionaryDefaults())
        request.propose("activity-segments:local")
        let sourceId = request.confirm()
        XCTAssertEqual(sourceId, "activity-segments:local")
        XCTAssertNil(request.confirm())
        try await coordinator.record(.detach, sourceId: XCTUnwrap(sourceId), gateway: gateway, deviceId: deviceId)
        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: Executor(
            sources: { XCTFail("unexpected source read")
                return []
            },
            create: { _, _ in XCTFail("unexpected registration") },
            join: { _, _ in XCTFail("unexpected join") },
            detach: { _, _ in throw URLError(.notConnectedToInternet) },
            setEnabled: { _, _ in XCTFail("unexpected pause") }
        ))
        XCTAssertFalse(pass.settled)
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(pending.map(\.sourceId), ["activity-segments:local"])
    }
}

final class LocalSourceResumeRegistrationTests: XCTestCase {
    private let sourceId = "notes-synth:local"
    private let deviceId = "fixture-phone"

    private func executor(create: @escaping @Sendable (String, String) async throws -> Void) -> Executor {
        Executor(
            sources: { [] },
            create: create,
            join: { _, _ in XCTFail("unexpected join") },
            detach: { _, _ in XCTFail("unexpected detach") },
            setEnabled: { _, _ in XCTFail("unexpected pause") }
        )
    }

    func testResumeRegistersTheAbsentSourceBeforeRetiringItsIntent() async throws {
        let gateway = try XCTUnwrap(URL(string: "https://gateway.example.com"))
        let coordinator = LocalSourceMembershipCoordinator(defaults: DictionaryDefaults())
        await coordinator.record(.resume, sourceId: sourceId, gateway: gateway, deviceId: deviceId)
        let calls = Calls()
        let pass = await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            create: { sourceId, deviceId in await calls.record("create \(sourceId) \(deviceId)") }
        ))
        let recorded = await calls.values
        XCTAssertEqual(recorded, ["create \(sourceId) \(deviceId)"])
        XCTAssertTrue(pass.settled)
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pending.isEmpty)
    }

    func testPendingCleanupKeepsExplicitResumeAcrossRelaunchUntilCreationSucceeds() async throws {
        let gateway = try XCTUnwrap(URL(string: "https://gateway.example.com"))
        let defaults = DictionaryDefaults()
        let first = LocalSourceMembershipCoordinator(defaults: defaults)
        await first.record(.resume, sourceId: sourceId, gateway: gateway, deviceId: deviceId)
        let blocked = await first.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            create: { _, _ in
                throw GatewayClient.Error.serverError(status: 409, body: #"{"code":"SOURCE_REMOVAL_IN_PROGRESS"}"#)
            }
        ))
        XCTAssertFalse(blocked.settled)
        let restored = LocalSourceMembershipCoordinator(defaults: defaults)
        let before = await restored.pending(gateway: gateway)
        XCTAssertEqual(before.map(\.operation), [.resume])
        let calls = Calls()
        let done = await restored.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
            create: { sourceId, _ in await calls.record(sourceId) }
        ))
        XCTAssertTrue(done.settled)
        let recorded = await calls.values
        XCTAssertEqual(recorded, [sourceId])
        let after = await restored.pending(gateway: gateway)
        XCTAssertTrue(after.isEmpty)
    }
}

final class LocalSourceIntentRaceTests: XCTestCase {
    private actor DelayedCreate {
        private var released: CheckedContinuation<Void, Never>?
        private var started: CheckedContinuation<Void, Never>?
        private(set) var calls = 0
        private(set) var current = true

        func run(refuseFirst: Bool = false) async throws {
            calls += 1
            guard calls == 1 else { throw URLError(.notConnectedToInternet) }
            await withCheckedContinuation { continuation in
                released = continuation
                started?.resume()
                started = nil
            }
            if refuseFirst {
                throw GatewayClient.Error.serverError(status: 409, body: #"{"code":"DEVICE_REVOKED"}"#)
            }
        }

        func waitUntilStarted() async {
            if released != nil { return }
            await withCheckedContinuation { started = $0 }
        }

        func release(invalidate: Bool = false) {
            if invalidate { current = false }
            released?.resume()
            released = nil
        }
    }

    private func executor(
        current: @escaping @Sendable () async -> Bool = { true },
        create: @escaping @Sendable (String, String) async throws -> Void
    )
        -> Executor {
        Executor(
            isCurrentSession: current,
            sources: { [] },
            create: create,
            join: { _, _ in XCTFail("unexpected join") },
            detach: { _, _ in XCTFail("unexpected detach") },
            setEnabled: { _, _ in XCTFail("unexpected pause") }
        )
    }

    private func assertLatestResumeSurvivesABA(refuseFirst: Bool) async throws {
        let gateway = try XCTUnwrap(URL(string: "https://gateway.example.com"))
        let coordinator = LocalSourceMembershipCoordinator(defaults: DictionaryDefaults())
        let sourceId = "notes-synth:local"
        let deviceId = "fixture-phone"
        await coordinator.record(.resume, sourceId: sourceId, gateway: gateway, deviceId: deviceId)
        let first = await coordinator.pending(gateway: gateway)
        let gate = DelayedCreate()
        let pass = Task {
            await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
                create: { _, _ in try await gate.run(refuseFirst: refuseFirst) }
            ))
        }
        await gate.waitUntilStarted()
        await coordinator.record(.detach, sourceId: sourceId, gateway: gateway, deviceId: deviceId)
        await coordinator.record(.resume, sourceId: sourceId, gateway: gateway, deviceId: deviceId)
        let latest = await coordinator.pending(gateway: gateway)
        XCTAssertNotEqual(first.first?.operationId, latest.first?.operationId)
        await gate.release()
        let result = await pass.value
        XCTAssertTrue(result.refusals.isEmpty)
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertEqual(pending, latest)
        let count = await gate.calls
        XCTAssertEqual(count, 2, "the newest resume gets its own attempt")
    }

    func testOldSuccessCannotRetireANewerIdenticalResume() async throws {
        try await assertLatestResumeSurvivesABA(refuseFirst: false)
    }

    func testOldRefusalCannotDisableANewerIdenticalResume() async throws {
        try await assertLatestResumeSurvivesABA(refuseFirst: true)
    }

    func testOldDrainCannotDropNewPairingWorkAndTheWaitingDrainRunsIt() async throws {
        let gateway = try XCTUnwrap(URL(string: "https://gateway.example.com"))
        let coordinator = LocalSourceMembershipCoordinator(defaults: DictionaryDefaults())
        let sourceId = "notes-synth:local"
        let deviceId = "fixture-phone"
        await coordinator.record(.resume, sourceId: sourceId, gateway: gateway, deviceId: deviceId, pairingGeneration: "old")
        let gate = DelayedCreate()
        let old = Task {
            await coordinator.reconcile(gateway: gateway, deviceId: deviceId, pairingGeneration: "old", using: executor(
                current: { await gate.current },
                create: { _, _ in try await gate.run() }
            ))
        }
        await gate.waitUntilStarted()
        await coordinator.record(.resume, sourceId: sourceId, gateway: gateway, deviceId: deviceId, pairingGeneration: "new")
        let calls = Calls()
        let newer = Task {
            await coordinator.reconcile(gateway: gateway, deviceId: deviceId, pairingGeneration: "new", using: executor(
                create: { sourceId, _ in await calls.record(sourceId) }
            ))
        }
        await gate.release(invalidate: true)
        let oldResult = await old.value
        let newResult = await newer.value
        XCTAssertTrue(oldResult.refusals.isEmpty)
        XCTAssertTrue(newResult.settled)
        let recorded = await calls.values
        XCTAssertEqual(recorded, [sourceId])
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pending.isEmpty)
    }

    func testOldRefusalDoesNotSurviveANewerSuccessfulResumeDuringAnotherSource() async throws {
        let gateway = try XCTUnwrap(URL(string: "https://gateway.example.com"))
        let coordinator = LocalSourceMembershipCoordinator(defaults: DictionaryDefaults())
        let firstSource = "notes-synth:first"
        let secondSource = "notes-synth:second"
        let deviceId = "fixture-phone"
        await coordinator.record(.resume, sourceId: firstSource, gateway: gateway, deviceId: deviceId)
        await coordinator.record(.resume, sourceId: secondSource, gateway: gateway, deviceId: deviceId)
        let gate = DelayedCreate()
        let calls = Calls()
        let pass = Task {
            await coordinator.reconcile(gateway: gateway, deviceId: deviceId, using: executor(
                create: { sourceId, _ in
                    if sourceId == secondSource {
                        try await gate.run()
                    } else {
                        let prior = await calls.values
                        await calls.record(sourceId)
                        if prior.isEmpty {
                            throw GatewayClient.Error.serverError(status: 409, body: #"{"code":"DEVICE_REVOKED"}"#)
                        }
                    }
                }
            ))
        }
        await gate.waitUntilStarted()
        await coordinator.record(.resume, sourceId: firstSource, gateway: gateway, deviceId: deviceId)
        await gate.release()
        let result = await pass.value
        XCTAssertTrue(result.refusals.isEmpty)
        let recorded = await calls.values
        XCTAssertEqual(recorded, [firstSource, firstSource])
        let pending = await coordinator.pending(gateway: gateway)
        XCTAssertTrue(pending.isEmpty)
    }
}
