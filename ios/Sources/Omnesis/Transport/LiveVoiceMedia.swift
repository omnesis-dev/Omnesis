// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// No provider commands are sent by the app's data channel. The gateway's
/// trusted sideband alone changes session context and handles delegations.
@MainActor
protocol LiveVoiceMedia: AnyObject {
    var onEvent: ((Data) -> Void)? { get set }
    var onFailure: ((Error) -> Void)? { get set }
    var onLevels: ((Double, Double) -> Void)? { get set }
    func offer() async throws -> String
    func connect(answer: String) async throws
    func startMicrophone() async throws
    func enableMicrophone(_ enabled: Bool)
    func close()
}

/// Audio level may be zero for genuine captured silence. Readiness requires
/// progress in the SDK's captured-sample duration, not an activation request.
struct LiveMicrophoneProgress {
    private var previous: Double?

    mutating func observe(duration: Double) -> Bool {
        guard duration.isFinite, duration >= 0 else { return false }
        let advanced = previous.map { duration > $0 } ?? false
        previous = duration
        return advanced
    }
}
