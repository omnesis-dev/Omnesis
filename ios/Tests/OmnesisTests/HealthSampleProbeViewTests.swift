// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit) && canImport(HealthKit)
import HealthKit
@testable import Omnesis
import XCTest

/// The developer sample probe has to be usable on a device the gateway has
/// refused as a host of the Apple Health source — that refusal is the very
/// question the probe is run to inform. So its authorization action is the
/// narrow `HealthReadAuthorizing` request and nothing more.
///
/// `AppStore.requestHealthKitAuthorization()` is the wrong call here and these
/// tests are what say so. It persists "Apple Health has been set up", starts
/// observer queries and background delivery, and piggybacks a notification
/// prompt — sync-adjacent work on a device that hosts nothing. It also reads
/// `AppStore.healthKitClient`, which is nil unless Apple Health is already
/// enabled and paired, so on the refused device it would return false having
/// asked for nothing at all.
///
/// `authorize()` takes its authorizer as a dependency and reads no environment
/// value, so these tests drive the shipped path directly rather than a stand-in
/// of it. Routing the request through the store instead would leave the
/// recorder below with nothing to show.
@available(iOS 17.0, *)
@MainActor
final class HealthSampleProbeViewTests: XCTestCase {
    func testAuthorizeAsksOnlyForReadAccessToTheWholeCatalog() async {
        let authorizer = RecordingReadAuthorizer()
        let view = HealthSampleProbeView(previewRows: [], authorizer: authorizer)

        await view.authorize()

        let requests = await authorizer.requests
        XCTAssertEqual(
            requests.count,
            1,
            "The probe's authorization action must issue exactly one read request of its own — "
                + "routing it through AppStore.requestHealthKitAuthorization() issues none here"
        )
        XCTAssertEqual(requests.first, TypeCatalog.allObjectTypes)
    }

    /// Tapping twice re-asks rather than latching on a remembered "already
    /// requested" flag: the probe keeps no such state, and iOS re-shows the
    /// sheet for any type still undecided.
    func testAuthorizeCanBeRepeated() async {
        let authorizer = RecordingReadAuthorizer()
        let view = HealthSampleProbeView(previewRows: [], authorizer: authorizer)

        await view.authorize()
        await view.authorize()

        let requests = await authorizer.requests
        XCTAssertEqual(requests.count, 2)
    }
}
#endif
