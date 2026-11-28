// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import OmnesisDesktop
import XCTest

@MainActor
final class MacServerPowerWatcherTests: XCTestCase {
    func testRepeatedStartHasOneRegistrationAndStopRejectsLateEvents() {
        let events = Events()
        var changes = 0
        let watcher = DesktopMacServerPowerWatcher(onChange: { changes += 1 }, subscribe: events.subscribe)
        XCTAssertTrue(watcher.start())
        XCTAssertTrue(watcher.start())
        XCTAssertEqual(events.callbacks.count, 1)
        events.callbacks[0]()
        XCTAssertEqual(changes, 1)
        watcher.stop()
        watcher.stop()
        XCTAssertEqual(events.cancellations.value, 1)
        events.callbacks[0]()
        XCTAssertEqual(changes, 1)
        XCTAssertTrue(watcher.start())
        XCTAssertEqual(events.callbacks.count, 2)
        events.callbacks[0]()
        XCTAssertEqual(changes, 1)
        events.callbacks[1]()
        XCTAssertEqual(changes, 2)
        watcher.stop()
        XCTAssertEqual(events.cancellations.value, 2)
    }

    func testUnavailableRegistrationDoesNotPretendToObservePower() {
        var attempts = 0
        let watcher = DesktopMacServerPowerWatcher(onChange: { XCTFail("No observation was installed") }, subscribe: { _ in
            attempts += 1
            return nil
        })
        XCTAssertFalse(watcher.start())
        XCTAssertFalse(watcher.start())
        XCTAssertEqual(attempts, 2)
        watcher.stop()
    }

    func testOwnerReleaseCancelsRegistrationWithoutRetainedCallbackCycle() throws {
        let events = Events()
        var watcher: DesktopMacServerPowerWatcher? = DesktopMacServerPowerWatcher(onChange: {}, subscribe: events.subscribe)
        weak var weakWatcher = watcher
        XCTAssertTrue(try XCTUnwrap(watcher?.start()))
        watcher = nil
        XCTAssertNil(weakWatcher)
        XCTAssertEqual(events.cancellations.value, 1)
        events.callbacks[0]()
        XCTAssertEqual(events.cancellations.value, 1)
    }

    func testPowerEventInvalidatesImmediatelyAndOnlyRequestsFreshReadiness() async {
        let events = Events()
        let flow = DesktopMacServerPowerFlow(probe: { .init(status: .ready) })
        await flow.refresh()
        XCTAssertTrue(flow.ready)
        var checksRequested = 0
        let watcher = DesktopMacServerPowerWatcher(onChange: {
            flow.invalidate()
            checksRequested += 1
        }, subscribe: events.subscribe)
        XCTAssertTrue(watcher.start())
        events.callbacks[0]()
        XCTAssertFalse(flow.ready)
        XCTAssertEqual(checksRequested, 1)
        // The notification itself provides no new configuration evidence.
        XCTAssertNotEqual(flow.status, .ready)
        watcher.stop()
    }

    func testChargeOnlyChangesKeepKnownSourceWhileUnplugAndUnknownInvalidate() {
        var transitions = DesktopMacServerPowerTransitions(previous: .ac)
        XCTAssertFalse(transitions.observe(.ac))
        XCTAssertFalse(transitions.observe(.ac))
        XCTAssertTrue(transitions.observe(.battery))
        XCTAssertFalse(transitions.observe(.battery))
        XCTAssertTrue(transitions.observe(.ups))
        XCTAssertFalse(transitions.observe(.ups))
        XCTAssertTrue(transitions.observe(.unknown))
        XCTAssertTrue(transitions.observe(.unknown))
        XCTAssertTrue(transitions.observe(.ac))
        XCTAssertFalse(transitions.observe(.ac))
    }

    private final class Events {
        var callbacks: [DesktopMacServerPowerWatcher.Change] = []
        let cancellations = Counter()
        func subscribe(_ callback: @escaping DesktopMacServerPowerWatcher.Change) -> DesktopMacServerPowerSubscription? {
            callbacks.append(callback)
            let cancellations = cancellations
            return DesktopMacServerPowerSubscription { cancellations.increment() }
        }
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int {
            lock.lock()
            defer { lock.unlock() }
            return count
        }

        func increment() {
            lock.lock()
            count += 1
            lock.unlock()
        }
    }
}
