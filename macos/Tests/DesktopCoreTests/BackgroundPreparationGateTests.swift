// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

final class BackgroundPreparationGateTests: XCTestCase {
    @MainActor
    func testDeferredPreparationCannotPublishAfterShutdownAndLocalResourceReleases() async throws {
        let gate = DesktopBackgroundPreparationGate()
        let operation = try gate.begin()
        let released = expectation(description: "Rejected local resource is released")
        final class Resource {
            private let release: () -> Void
            init(_ release: @escaping () -> Void) {
                self.release = release
            }

            deinit { release() }
        }
        let waiting = expectation(description: "Deferred preparation has reached its publication boundary")
        var resume: CheckedContinuation<Void, Never>?
        var published = false
        let task = Task { @MainActor in
            let resource = Resource { released.fulfill() }
            await withCheckedContinuation { resume = $0
                waiting.fulfill()
            }
            guard gate.accepts(operation) else { return }
            withExtendedLifetime(resource) { published = true }
        }
        await fulfillment(of: [waiting], timeout: 1)
        gate.close()
        resume?.resume()
        await task.value
        XCTAssertFalse(published)
        XCTAssertThrowsError(try gate.begin())
        await fulfillment(of: [released], timeout: 1)
    }

    @MainActor
    func testSupersededPreparationCannotPublishForNewIncarnation() throws {
        let gate = DesktopBackgroundPreparationGate()
        let old = try gate.begin()
        let current = try gate.begin()
        XCTAssertFalse(gate.accepts(old))
        XCTAssertTrue(gate.accepts(current))
        gate.close()
        XCTAssertFalse(gate.accepts(current))
    }
}
