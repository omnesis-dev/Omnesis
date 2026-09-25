// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Who is allowed to tell the gateway a conversation is being read.
///
/// Only the surface that renders the transcript may say so. A claim from
/// anywhere else is not a cosmetic slip: the gateway treats content arriving
/// into a conversation it believes is on screen as seen on arrival and opens
/// no unread episode, so a false claim destroys that answer's dot and its
/// notification on every surface rather than delaying them.
///
/// The Swift twin of `AgentCoordinatorSeenTest` on Android.
///
/// All fixture data is invented.
@available(iOS 17.0, *)
@MainActor
final class AgentCoordinatorSeenTests: XCTestCase {
    override func tearDown() {
        RoutingStubProtocol.reset()
        super.tearDown()
    }

    private func makeClient() -> AgentClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RoutingStubProtocol.self]
        return AgentClient(
            baseURL: URL(string: "https://stub.local")!,
            token: "test-token",
            session: URLSession(configuration: config)
        )
    }

    private func waitFor(
        timeout: TimeInterval = 2.0,
        _ predicate: @escaping () -> Bool
    ) async
        -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return predicate()
    }

    func testSceneActiveAloneDoesNotClaimAConversationIsOnScreen() async {
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "conv_a")
        defer { coord.stopForTesting() }

        // Foreground with the user on some other section: the coordinator
        // still points at conv_a, but nothing is rendering it.
        coord.appActiveChanged(true)
        _ = await waitFor(timeout: 0.4) { !RoutingStubProtocol.recordedSeenMarks().isEmpty }
        XCTAssertTrue(
            RoutingStubProtocol.recordedSeenMarks().isEmpty,
            "the scene being active says nothing about which surface is showing"
        )
    }

    func testSurfaceAndSceneTogetherClaimIt() async {
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "conv_a")
        defer { coord.stopForTesting() }

        coord.appActiveChanged(true)
        coord.agentSurfaceVisibilityChanged(true)
        let claimed = await waitFor {
            RoutingStubProtocol.recordedSeenMarks().contains {
                $0.id == "conv_a" && $0.body.contains("true")
            }
        }
        XCTAssertTrue(claimed, "the surface rendering the transcript claims it")
    }

    func testLeavingTheSurfaceWithdrawsTheClaim() async {
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "conv_a")
        defer { coord.stopForTesting() }

        coord.appActiveChanged(true)
        coord.agentSurfaceVisibilityChanged(true)
        _ = await waitFor { !RoutingStubProtocol.recordedSeenMarks().isEmpty }
        coord.agentSurfaceVisibilityChanged(false)

        let withdrawn = await waitFor {
            RoutingStubProtocol.recordedSeenMarks().contains { $0.body.contains("false") }
        }
        XCTAssertTrue(withdrawn, "moving to another section stops the claim")
    }

    func testBackgroundingWithdrawsTheClaimEvenWithTheSurfaceMounted() async {
        let coord = AgentCoordinator()
        coord.attachForTesting(client: makeClient(), sessionId: "conv_a")
        defer { coord.stopForTesting() }

        coord.appActiveChanged(true)
        coord.agentSurfaceVisibilityChanged(true)
        _ = await waitFor { !RoutingStubProtocol.recordedSeenMarks().isEmpty }
        coord.appActiveChanged(false)

        let withdrawn = await waitFor {
            RoutingStubProtocol.recordedSeenMarks().contains { $0.body.contains("false") }
        }
        XCTAssertTrue(withdrawn, "an answer arriving after the phone goes down is unread")
    }
}
