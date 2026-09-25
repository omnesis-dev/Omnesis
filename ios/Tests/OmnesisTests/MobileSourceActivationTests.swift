// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest
#if os(iOS) && canImport(HealthKit)
import HealthKit
#endif

final class MobileSourceActivationTests: XCTestCase {
    private let thisPhone = "11111111-1111-4111-8111-111111111111"
    private let otherPhone = "22222222-2222-4222-8222-222222222222"

    func testNewSourceAndExistingMembershipNeedNoChoice() {
        XCTAssertEqual(MobileSourceActivation.plan(source: nil, deviceId: thisPhone, desiredMode: .replicated), .ready)
        XCTAssertEqual(
            MobileSourceActivation.plan(
                source: source(mode: "replicated", members: [otherPhone, thisPhone]),
                deviceId: thisPhone,
                desiredMode: .replicated
            ),
            .ready
        )
    }

    func testLegacyExclusiveReplicatedSourceOffersKeepBothOrTransfer() {
        XCTAssertEqual(
            MobileSourceActivation.plan(
                source: source(mode: "exclusive"),
                deviceId: thisPhone,
                desiredMode: .replicated
            ),
            .choose(.replicated)
        )
    }

    func testPartitionedSourceAddsThisDevicesIndependentStream() {
        XCTAssertEqual(
            MobileSourceActivation.plan(
                source: source(mode: "exclusive"),
                deviceId: thisPhone,
                desiredMode: .partitioned
            ),
            .addPartition
        )
        XCTAssertEqual(
            MobileSourceActivation.plan(
                source: source(mode: "partitioned"),
                deviceId: thisPhone,
                desiredMode: .partitioned
            ),
            .join
        )
    }

    func testExclusiveSourceOffersKeepOrTransferOnly() {
        XCTAssertEqual(
            MobileSourceActivation.plan(
                source: source(mode: "exclusive"),
                deviceId: thisPhone,
                desiredMode: .exclusive
            ),
            .choose(.exclusive)
        )
    }

    func testExistingExclusiveOwnerExplicitlyAdoptsPartitionedStorage() async throws {
        let calls = Calls()
        let legacy = source(mode: "exclusive")
        XCTAssertEqual(
            MobileSourceActivation.plan(source: legacy, deviceId: otherPhone, desiredMode: .partitioned),
            .addPartition
        )
        let result = try await MobileSourceActivation.execute(
            source: legacy,
            deviceId: otherPhone,
            desiredMode: .partitioned,
            operations: .init(
                setMode: { _, mode in await calls.record("mode:\(mode.rawValue)") },
                join: { _, _ in await calls.record("join") },
                transfer: { _, _ in await calls.record("transfer") }
            )
        )
        XCTAssertEqual(result, .ready)
        let values = await calls.values
        XCTAssertEqual(values, ["mode:partitioned", "join"])
    }

    func testHostedPartitionPreparationMigratesOnlyExistingExclusiveHost() async throws {
        let calls = Calls()
        try await MobileSourceActivation.prepareHostedPartition(
            source: source(mode: "exclusive"),
            deviceId: otherPhone,
            setMode: { _, mode in await calls.record(mode.rawValue) }
        )
        try await MobileSourceActivation.prepareHostedPartition(
            source: source(mode: "partitioned"),
            deviceId: otherPhone,
            setMode: { _, mode in await calls.record(mode.rawValue) }
        )
        let values = await calls.values
        XCTAssertEqual(values, ["partitioned"])
    }

    func testHostedPartitionPreparationDoesNotRejoinAbsentOrIncompatibleMember() async {
        for existing in [nil, source(mode: "exclusive"), source(mode: "partitioned")] {
            do {
                try await MobileSourceActivation.prepareHostedPartition(
                    source: existing,
                    deviceId: thisPhone,
                    setMode: { _, _ in XCTFail("a detached phone must not mutate membership or mode") }
                )
                XCTFail("expected preparation to refuse a nonmember")
            } catch {
                XCTAssertEqual(error as? MobileSourceActivationError, .notContributing)
            }
        }
        do {
            try await MobileSourceActivation.prepareHostedPartition(
                source: source(mode: "replicated"),
                deviceId: otherPhone,
                setMode: { _, _ in XCTFail("must not migrate incompatible storage") }
            )
            XCTFail("expected incompatible mode rejection")
        } catch {
            XCTAssertEqual(error as? MobileSourceActivationError, .incompatibleMode(.replicated, .partitioned))
        }
    }

    func testExistingOwnerCannotBypassAnIncompatiblePartitionContract() {
        XCTAssertEqual(
            MobileSourceActivation.plan(source: source(mode: "replicated"), deviceId: otherPhone, desiredMode: .partitioned),
            .incompatible(current: .replicated, desired: .partitioned)
        )
    }

    func testBackgroundRegistrationCannotCreateFromAnAbsentOrStaleLiveRow() {
        XCTAssertFalse(MobileSourceActivation.mayCreateRegistration(source: source(mode: "partitioned"), deviceId: thisPhone))
        XCTAssertFalse(MobileSourceActivation.mayCreateRegistration(source: source(mode: "partitioned"), deviceId: otherPhone))
        XCTAssertFalse(MobileSourceActivation.mayCreateRegistration(source: nil, deviceId: thisPhone))
        XCTAssertTrue(MobileSourceActivation.mayCreateRegistration(
            source: nil, deviceId: thisPhone, sourceId: "fictional:local", allowCreationFor: "fictional:local"
        ))
        XCTAssertFalse(MobileSourceActivation.mayCreateRegistration(
            source: nil, deviceId: thisPhone, sourceId: "fictional-other:local", allowCreationFor: "fictional:local"
        ))
    }

    func testAutomaticRegistrationDoesNotUnpauseAnotherSource() {
        let paused = source(mode: "partitioned", enabled: false)
        XCTAssertFalse(MobileSourceActivation.mayCreateRegistration(source: paused, deviceId: otherPhone))
        XCTAssertFalse(MobileSourceActivation.mayCreateRegistration(
            source: paused, deviceId: otherPhone, allowCreationFor: "fictional-other:local"
        ))
        XCTAssertTrue(MobileSourceActivation.mayCreateRegistration(
            source: paused, deviceId: otherPhone, allowCreationFor: paused.id
        ))
    }

    func testPartitionMigrationFailureDoesNotJoin() async {
        let calls = Calls()
        do {
            _ = try await MobileSourceActivation.execute(
                source: source(mode: "exclusive"),
                deviceId: thisPhone,
                desiredMode: .partitioned,
                operations: .init(
                    setMode: { _, _ in throw URLError(.cannotConnectToHost) },
                    join: { _, _ in await calls.record("join") },
                    transfer: { _, _ in await calls.record("transfer") }
                )
            )
            XCTFail("migration must fail closed")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .cannotConnectToHost)
        }
        let values = await calls.values
        XCTAssertTrue(values.isEmpty)
    }

    func testExistingNonexclusiveModeMismatchIsIncompatible() {
        XCTAssertEqual(
            MobileSourceActivation.plan(
                source: source(mode: "partitioned"),
                deviceId: thisPhone,
                desiredMode: .replicated
            ),
            .incompatible(current: .partitioned, desired: .replicated)
        )
    }

    func testInspectionResolvesChoiceWithoutMutatingGateway() throws {
        XCTAssertEqual(
            try MobileSourceActivation.inspect(
                source: source(mode: "exclusive"),
                deviceId: thisPhone,
                desiredMode: .replicated,
                choice: .takeOver
            ),
            .ready
        )
    }

    func testUseBothTransitionsBeforeJoining() async throws {
        let calls = Calls()
        let outcome = try await MobileSourceActivation.execute(
            source: source(mode: "exclusive"),
            deviceId: thisPhone,
            desiredMode: .replicated,
            choice: .useBoth,
            operations: .init(
                setMode: { _, mode in await calls.record("mode:\(mode.rawValue)") },
                join: { _, _ in await calls.record("join") },
                transfer: { _, _ in await calls.record("transfer") }
            )
        )
        XCTAssertEqual(outcome, .ready)
        let values = await calls.values
        XCTAssertEqual(values, ["mode:replicated", "join"])
    }

    func testTakeOverDoesNotJoinOrChangeMode() async throws {
        let calls = Calls()
        let outcome = try await MobileSourceActivation.execute(
            source: source(mode: "exclusive"),
            deviceId: thisPhone,
            desiredMode: .replicated,
            choice: .takeOver,
            operations: .init(
                setMode: { _, _ in await calls.record("mode") },
                join: { _, _ in await calls.record("join") },
                transfer: { _, _ in await calls.record("transfer") }
            )
        )
        XCTAssertEqual(outcome, .ready)
        let values = await calls.values
        XCTAssertEqual(values, ["transfer"])
    }

    func testKeepOtherDoesNothing() async throws {
        let calls = Calls()
        let outcome = try await MobileSourceActivation.execute(
            source: source(mode: "exclusive"),
            deviceId: thisPhone,
            desiredMode: .replicated,
            choice: .keepOther,
            operations: .init(
                setMode: { _, _ in await calls.record("mode") },
                join: { _, _ in await calls.record("join") },
                transfer: { _, _ in await calls.record("transfer") }
            )
        )
        XCTAssertEqual(outcome, .keptOther)
        let values = await calls.values
        XCTAssertEqual(values, [])
    }

    #if os(iOS) && canImport(HealthKit)
    @MainActor
    @available(iOS 17.0, *)
    func testDisabledAppleHealthCanAuthorizeBeforeItsCollectorClientExists() async {
        let settings = HealthSettings(defaults: DictionaryDefaults())
        let store = AppStore(healthSettings: settings, localSourceOwner: LocalSourceOwnerRecord(defaults: DictionaryDefaults()))
        let authorizer = RecordingHealthAuthorizer()

        let granted = await store.requestHealthKitAuthorization(using: authorizer)

        XCTAssertTrue(granted)
        XCTAssertTrue(settings.hasRequestedHealthKitAuthorization)
        let requested = await authorizer.requestedTypes
        XCTAssertEqual(requested.count, 1)
    }

    @MainActor
    @available(iOS 17.0, *)
    func testHealthKitIsAskedOnlyForTheCategoriesThatAreOn() async {
        let settings = HealthSettings(defaults: DictionaryDefaults())
        settings.enabledCategories = [.sleep, .workouts]
        let store = AppStore(healthSettings: settings, localSourceOwner: LocalSourceOwnerRecord(defaults: DictionaryDefaults()))
        let authorizer = RecordingHealthAuthorizer()

        _ = await store.requestHealthKitAuthorization(using: authorizer)

        let requested = await authorizer.requestedTypes
        let expected = TypeCatalog.readObjectTypes(in: [.sleep, .workouts])
        XCTAssertEqual(requested, [expected])
        XCTAssertFalse(expected.isEmpty)
        XCTAssertLessThan(expected.count, TypeCatalog.allObjectTypes.count)
    }
    #endif

    private func source(mode: String, members: [String]? = nil, enabled: Bool = true) -> SourceRecord {
        SourceRecord(
            id: "fictional-mobile:local",
            type: "fictional-mobile",
            accountId: "local",
            deviceId: otherPhone,
            enabled: enabled,
            members: members ?? [otherPhone],
            multiDeviceMode: mode
        )
    }
}

#if os(iOS) && canImport(HealthKit)
@available(iOS 17.0, *)
private actor RecordingHealthAuthorizer: HealthReadAuthorizing {
    func shouldRequestAuthorization(for _: Set<HKObjectType>) async -> Bool {
        false
    }

    private(set) var requestedTypes: [Set<HKObjectType>] = []

    func requestAuthorization(for types: Set<HKObjectType>) async throws {
        requestedTypes.append(types)
    }
}
#endif

private actor Calls {
    private(set) var values: [String] = []
    func record(_ value: String) {
        values.append(value)
    }
}
