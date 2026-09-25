// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest
#if canImport(HealthKit)
import HealthKit
#endif

final class HealthSampleProbeTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_756_000_000)

    private func row(_ uuid: String, _ type: String, minutesAgo: Double) -> HealthSampleProbe.Row {
        HealthSampleProbe.Row(uuid: uuid, typeIdentifier: type, endDate: base.addingTimeInterval(-60 * minutesAgo))
    }

    func testGroupsByTypeInFirstAppearanceOrderNewestFirst() {
        let rows = [
            row("A", "HKQuantityTypeIdentifierHeartRate", minutesAgo: 9),
            row("B", "HKQuantityTypeIdentifierStepCount", minutesAgo: 1),
            row("C", "HKQuantityTypeIdentifierHeartRate", minutesAgo: 4),
        ]
        let groups = HealthSampleProbe.group(rows)
        XCTAssertEqual(groups.map(\.typeIdentifier), ["HKQuantityTypeIdentifierHeartRate", "HKQuantityTypeIdentifierStepCount"])
        XCTAssertEqual(groups[0].rows.map(\.uuid), ["C", "A"])
    }

    func testReportIsLineOrientedAndTimezoneFree() {
        let rows = [
            row("7C0E5F1A-2B3D-4E5F-8A9B-0C1D2E3F4A5B", "HKQuantityTypeIdentifierHeartRate", minutesAgo: 0),
            row("0F1E2D3C-4B5A-4697-8899-AABBCCDDEEFF", "HKQuantityTypeIdentifierStepCount", minutesAgo: 30),
        ]
        XCTAssertEqual(
            HealthSampleProbe.report(rows),
            """
            HKQuantityTypeIdentifierHeartRate
            7C0E5F1A-2B3D-4E5F-8A9B-0C1D2E3F4A5B\t2025-08-24T01:46:40.000Z

            HKQuantityTypeIdentifierStepCount
            0F1E2D3C-4B5A-4697-8899-AABBCCDDEEFF\t2025-08-24T01:16:40.000Z
            """
        )
    }

    func testEmptyProbeReportsNothing() {
        XCTAssertEqual(HealthSampleProbe.report([]), "")
        XCTAssertTrue(HealthSampleProbe.group([]).isEmpty)
    }

    // MARK: - Catalog coverage

    /// The probe covers the whole catalog rather than the categories the
    /// Apple Health source happens to sync. Narrowing this would make the
    /// screen unusable on a device that hosts no source — the device whose
    /// report the comparison needs most — and would make two devices'
    /// reports comparable only when their toggles already match.
    func testProbeCoversTheWholeTypeCatalog() {
        XCTAssertEqual(
            HealthSampleProbe.catalog.map(\.identifier),
            TypeCatalog.v1.map(\.identifier)
        )
    }
}

#if canImport(HealthKit)
/// Records read-authorization requests instead of prompting. An actor, so it
/// satisfies `HealthReadAuthorizing`'s `Sendable` requirement without locking.
actor RecordingReadAuthorizer: HealthReadAuthorizing {
    func shouldRequestAuthorization(for _: Set<HKObjectType>) async -> Bool {
        false
    }

    enum Refusal: Error { case refused }

    private(set) var requests: [Set<HKObjectType>] = []
    private let failure: Error?

    init(failure: Error? = nil) {
        self.failure = failure
    }

    func requestAuthorization(for types: Set<HKObjectType>) async throws {
        requests.append(types)
        if let failure { throw failure }
    }
}

@available(iOS 17.0, *)
final class HealthSampleProbeAuthorizationTests: XCTestCase {
    func testRequestsReadAccessForEveryCatalogTypeExactlyOnce() async {
        let authorizer = RecordingReadAuthorizer()
        let completed = await HealthSampleProbe.requestReadAuthorization(authorizer)
        XCTAssertTrue(completed)
        let requests = await authorizer.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first, TypeCatalog.allObjectTypes)
    }

    /// A refused or failed request is a `false` return, not a thrown error:
    /// the screen carries on and re-reads, because a partial grant still
    /// produces rows.
    func testAFailedRequestIsReportedRatherThanThrown() async {
        let authorizer = RecordingReadAuthorizer(failure: RecordingReadAuthorizer.Refusal.refused)
        let completed = await HealthSampleProbe.requestReadAuthorization(authorizer)
        XCTAssertFalse(completed)
        let requests = await authorizer.requests
        XCTAssertEqual(requests.count, 1)
    }
}
#endif
