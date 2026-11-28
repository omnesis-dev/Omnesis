// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation
import XCTest

/// Pure selection/trigger policy and unarmed closure; no timer or sampler starts here.
final class DataParentObservationTests: XCTestCase {
    private let names = [
        "DataUsageLeaseTests.testActualPinnedOwnedNodeSamplerPublishesOnlyJoinedBoundedPrivateStack",
        "DesktopCoreTests.DataUsageLeaseTests.testActualPinnedOwnedNodeSamplerPublishesOnlyJoinedBoundedPrivateStack",
        "-[DesktopCoreTests.DataUsageLeaseTests testActualPinnedOwnedNodeSamplerPublishesOnlyJoinedBoundedPrivateStack]",
    ]

    func testOnlyExactPositiveControlNamesSelectTheParentWindow() {
        for name in names {
            XCTAssertEqual(DesktopOwnedUIObservation.dataParentSelection(name), .dataNodeCleanup)
            XCTAssertNil(DesktopOwnedUIObservation.dataParentSelection("prefix" + name))
            XCTAssertNil(DesktopOwnedUIObservation.dataParentSelection(name + "suffix"))
            XCTAssertNil(DesktopOwnedUIObservation.dataParentSelection(" " + name))
        }
        for name in [
            "",
            "testActualPinnedOwnedNodeSamplerPublishesOnlyJoinedBoundedPrivateStack",
            "OtherTests.testActualPinnedOwnedNodeSamplerPublishesOnlyJoinedBoundedPrivateStack",
            "DataUsageLeaseTests.testSharedDataDescriptorCannotScrubEnvironmentAndEnterBackgroundControl",
            "-[OtherModule.DataUsageLeaseTests testActualPinnedOwnedNodeSamplerPublishesOnlyJoinedBoundedPrivateStack]",
        ] {
            XCTAssertNil(DesktopOwnedUIObservation.dataParentSelection(name))
        }
    }

    func testParentWindowUsesTheExistingAbsoluteFiveSecondTrigger() {
        let began = ContinuousClock.now
        let trigger = DesktopOwnedUIObservation.Trigger(.dataNodeCleanup, began: began)
        XCTAssertEqual(trigger.deadline, began.advanced(by: .seconds(5)))
        XCTAssertFalse(trigger.isDue(at: began.advanced(by: .milliseconds(4999))))
        XCTAssertTrue(trigger.isDue(at: began.advanced(by: .seconds(5))))
        XCTAssertTrue(trigger.isDue(at: began.advanced(by: .seconds(6))))
        XCTAssertEqual(trigger.deadline, began.advanced(by: .seconds(5)))
    }

    func testUnarmedCloseRemainsConfirmedAndRefusesEveryLaterAdmission() async {
        let observation = DesktopOwnedUIObservation(.dataNodeCleanup)
        let initial = await observation.close()
        XCTAssertTrue(initial)
        let refused = observation.begin(.dataNodeCleanup)
        XCTAssertEqual(observation.begin(.dataNodeCleanup), refused)
        observation.end(refused)
        observation.record(.dataTeardown, .entered)
        let repeated = await observation.close()
        XCTAssertTrue(repeated)
        XCTAssertEqual(observation.begin(.dataNodeCleanup), refused)
    }

    func testNameProjectionKeepsOnlyTheFixedSelectedCase() throws {
        for name in names {
            let data = try JSONEncoder().encode(DesktopOwnedUIObservation.dataParentSelection(name))
            XCTAssertEqual(String(decoding: data, as: UTF8.self), "\"dataNodeCleanup\"")
            XCTAssertLessThanOrEqual(data.count, 32)
        }
        let secret = "invented-private-observation-name"
        for name in [secret, names[0] + secret, secret + names[0]] {
            let data = try JSONEncoder().encode(DesktopOwnedUIObservation.dataParentSelection(name))
            XCTAssertEqual(String(decoding: data, as: UTF8.self), "null")
            XCTAssertFalse(String(decoding: data, as: UTF8.self).contains(secret))
        }
    }

    func testReaderRetirementNeverSubstitutesForObserverJoin() {
        XCTAssertTrue(DesktopOwnedUIObservation.requiresFixtureRetention(readersRetired: false, observerJoined: false))
        XCTAssertTrue(DesktopOwnedUIObservation.requiresFixtureRetention(readersRetired: false, observerJoined: true))
        XCTAssertTrue(DesktopOwnedUIObservation.requiresFixtureRetention(readersRetired: true, observerJoined: false))
        XCTAssertFalse(DesktopOwnedUIObservation.requiresFixtureRetention(readersRetired: true, observerJoined: true))
    }

    func testChildIsolationVerifiesExactFlagsAndDisposesAttributesWithoutLaunchingAChild() throws {
        var calls = DesktopDiagnosticSpawnAttributes.Calls()
        var destructions = 0
        var destructionBegan: ContinuousClock.Instant?
        calls.destroy = { attributes in destructionBegan = .now
            destructions += 1
            return posix_spawnattr_destroy(attributes)
        }
        let result = DesktopDiagnosticSpawnAttributes.withIsolation(calls: calls) { attributes in
            var flags: Int16 = 0
            XCTAssertEqual(posix_spawnattr_getflags(attributes, &flags), 0)
            XCTAssertEqual(flags, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
            return EAGAIN // Operation outcome only; no process is created in this policy test.
        }
        XCTAssertEqual(result.spawnStatus, EAGAIN)
        XCTAssertNil(result.refusal)
        XCTAssertTrue(result.destructionConfirmed)
        XCTAssertEqual(destructions, 1)
        XCTAssertLessThanOrEqual(
            result.lifecycleAnchor,
            try XCTUnwrap(destructionBegan),
            "Attribute disposal cannot renew a spawned child's budget"
        )
    }

    func testChildIsolationInitializationFailureNeverUsesOrDestroysAbsentAttributes() {
        var calls = DesktopDiagnosticSpawnAttributes.Calls()
        calls.initialize = { _ in EIO }
        calls.setFlags = { _, _ in XCTFail("Uninitialized attributes must not be used")
            return EIO
        }
        calls.getFlags = { _, _ in XCTFail("Uninitialized attributes must not be read")
            return EIO
        }
        calls.destroy = { _ in XCTFail("Absent attributes must not be destroyed")
            return EIO
        }
        let result = DesktopDiagnosticSpawnAttributes.withIsolation(calls: calls) { _ in
            XCTFail("Initialization failure must not admit a spawn")
            return 0
        }
        XCTAssertNil(result.spawnStatus)
        XCTAssertEqual(result.refusal, .initialize)
        XCTAssertTrue(result.destructionConfirmed)
    }

    func testChildIsolationSetReadAndMismatchFailuresDestroyAttributesWithoutSpawning() {
        for refused in [DesktopDiagnosticSpawnAttributes.Refusal.setFlags, .getFlags, .flagsMismatch] {
            var calls = DesktopDiagnosticSpawnAttributes.Calls()
            var destructions = 0
            calls.destroy = { attributes in destructions += 1
                return posix_spawnattr_destroy(attributes)
            }
            if refused == .setFlags { calls.setFlags = { _, _ in EIO } }
            else if refused == .getFlags { calls.getFlags = { _, _ in EIO } }
            else { calls.getFlags = { _, flags in flags.pointee = 0
                return 0
            } }
            let result = DesktopDiagnosticSpawnAttributes.withIsolation(calls: calls) { _ in
                XCTFail("Unverified descriptor policy must not admit a spawn")
                return 0
            }
            XCTAssertNil(result.spawnStatus)
            XCTAssertEqual(result.refusal, refused)
            XCTAssertTrue(result.destructionConfirmed)
            XCTAssertEqual(destructions, 1)
        }
    }

    func testAttributeDisposalRefusalPreservesSuccessfulSpawnOutcomeForExactChildDrain() {
        var calls = DesktopDiagnosticSpawnAttributes.Calls()
        calls.destroy = { attributes in
            XCTAssertEqual(posix_spawnattr_destroy(attributes), 0)
            return EIO // Retain failure semantics without leaking a native attribute object.
        }
        let result = DesktopDiagnosticSpawnAttributes.withIsolation(calls: calls) { _ in
            0 // No child: this tests only that cleanup failure cannot erase a spawn receipt.
        }
        XCTAssertEqual(result.spawnStatus, 0)
        XCTAssertEqual(result.refusal, .destroy)
        XCTAssertFalse(result.destructionConfirmed)

        calls.setFlags = { _, _ in EINVAL }
        let original = DesktopDiagnosticSpawnAttributes.withIsolation(calls: calls) { _ in
            XCTFail("Rejected isolation must not spawn")
            return 0
        }
        XCTAssertNil(original.spawnStatus)
        XCTAssertEqual(original.refusal, .setFlags, "A cleanup refusal must not replace the original construction error")
        XCTAssertFalse(original.destructionConfirmed)
    }
}
