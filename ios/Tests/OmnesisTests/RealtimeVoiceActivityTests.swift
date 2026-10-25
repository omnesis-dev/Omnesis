// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class RealtimeVoiceActivityTests: XCTestCase {
    func testUserSpeechAndPlaybackHaveDistinctActivity() {
        XCTAssertEqual(activity(user: true), .user)
        XCTAssertEqual(activity(user: true, agent: true), .user)
        XCTAssertEqual(activity(agent: true), .agent)
        XCTAssertEqual(activity(), .quiet)
    }

    func testMutingSuppressesUserSpeechButKeepsPlayingAgentAudio() {
        XCTAssertEqual(activity(muted: true, user: true), .quiet)
        XCTAssertEqual(activity(muted: true, user: true, agent: true), .agent)
        XCTAssertEqual(activity(muted: true, agent: true), .agent)
    }

    func testInactiveCallAlwaysStopsActivity() {
        XCTAssertEqual(activity(active: false, user: true, agent: true), .quiet)
    }

    private func activity(
        active: Bool = true, muted: Bool = false, user: Bool = false, agent: Bool = false
    )
        -> RealtimeVoiceActivity {
        .resolve(active: active, muted: muted, userSpeaking: user, agentSpeaking: agent)
    }
}
