// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
@testable import Omnesis
import XCTest

@available(iOS 17.0, *)
@MainActor
final class AdminCoordinatorSocketSubscriptionTests: XCTestCase {
    func testLiveChannelsPublishAndOldChannelsCannotMutateAReplacementAfterStop() async throws {
        let coordinator = AdminCoordinator()
        let old = Channels()
        let pushes = Pushes()
        coordinator.setOnPushAvailable { pushes.count += 1 }
        coordinator.subscribeSocket(events: old.events.stream, states: old.states.stream, paths: old.paths.stream)
        let connected = DeviceSocket.ConnectionState.connected(deviceId: "test-phone", deviceName: "Test phone", scopes: ["read"])
        old.events.continuation.yield(.init(type: "push.available", payload: .null))
        old.states.continuation.yield(connected)
        old.paths.continuation.yield(.local)
        try await waitUntil { coordinator.wsState == connected && coordinator.connectionPath == .local && pushes.count == 1 }
        XCTAssertTrue(coordinator.wsConnected)
        old.paths.continuation.yield(.relay)
        try await waitUntil { coordinator.connectionPath == .relay }
        old.paths.continuation.yield(.reconnecting)
        old.states.continuation.yield(.failed("Synthetic connection interrupted"))
        try await waitUntil { coordinator.connectionPath == .reconnecting && !coordinator.wsConnected }

        let ended = [
            expectation(description: "event subscription canceled"),
            expectation(description: "state subscription canceled"),
            expectation(description: "path subscription canceled"),
        ]
        old.events.continuation.onTermination = { _ in ended[0].fulfill() }
        old.states.continuation.onTermination = { _ in ended[1].fulfill() }
        old.paths.continuation.onTermination = { _ in ended[2].fulfill() }
        coordinator.stopAdmin()
        XCTAssertNil(coordinator.connectionPath)
        await fulfillment(of: ended, timeout: 5)

        let current = Channels()
        coordinator.subscribeSocket(events: current.events.stream, states: current.states.stream, paths: current.paths.stream)
        current.states.continuation.yield(connected)
        current.paths.continuation.yield(.relay)
        current.events.continuation.yield(.init(type: "push.available", payload: .null))
        try await waitUntil { coordinator.wsState == connected && coordinator.connectionPath == .relay && pushes.count == 2 }
        guard case .terminated = old.events.continuation.yield(.init(type: "push.available", payload: .null)),
              case .terminated = old.states.continuation.yield(.failed("Obsolete socket")),
              case .terminated = old.paths.continuation.yield(.local)
        else { return XCTFail("Stopped subscriptions accepted an obsolete socket delivery") }
        await Task.yield()
        XCTAssertEqual(coordinator.wsState, connected)
        XCTAssertEqual(coordinator.connectionPath, .relay)
        XCTAssertEqual(pushes.count, 2)
        coordinator.stopAdmin()
        current.finish()
    }

    func testSubscriptionsDoNotRetainAReleasedCoordinatorAndLateDeliveriesAreHarmless() async {
        let channels = Channels()
        var coordinator: AdminCoordinator? = AdminCoordinator()
        weak var released = coordinator
        coordinator?.subscribeSocket(events: channels.events.stream, states: channels.states.stream, paths: channels.paths.stream)
        coordinator = nil
        XCTAssertNil(released, "Pending socket subscriptions must not retain the coordinator")
        channels.events.continuation.yield(.init(type: "push.available", payload: .null))
        channels.states.continuation.yield(.connected(deviceId: "obsolete", deviceName: "Obsolete phone", scopes: []))
        channels.paths.continuation.yield(.local)
        await Task.yield()
        channels.finish()
        XCTAssertNil(released)
    }

    private func waitUntil(_ ready: () -> Bool) async throws {
        let deadline = ContinuousClock().now + .seconds(5)
        while !ready(), ContinuousClock().now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(ready(), "Socket subscription did not publish its current state")
    }

    @MainActor
    private final class Pushes { var count = 0 }

    private struct Channels {
        let events = AsyncStream<DeviceSocket.Event>.makeStream()
        let states = AsyncStream<DeviceSocket.ConnectionState>.makeStream()
        let paths = AsyncStream<GatewayConnectionPath>.makeStream()
        func finish() {
            events.continuation.finish()
            states.continuation.finish()
            paths.continuation.finish()
        }
    }
}
#endif
