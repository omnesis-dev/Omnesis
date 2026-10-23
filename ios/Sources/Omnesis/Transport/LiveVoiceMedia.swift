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
    func enableMicrophone(_ enabled: Bool)
    func close()
}
