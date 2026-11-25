// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct DesktopUpdatePresentation: Decodable, Equatable, Sendable {
    public enum Phase: String, Decodable, Sendable {
        case idle, available, verified, stopping
        case backedUp = "backed-up"
        case installerOpened = "installer-opened"
        case candidateStarted = "candidate-started"
        case complete, recoveryRequired = "recovery-required", resumed
    }

    public let kind: String
    public let phase: Phase
    public let currentVersion: String
    public let targetVersion: String?
    public let message: String
    public let confirmationId: String?
    public let currentApplicationAvailable: Bool?

    public var verified: Bool {
        kind == "desktopUpdate"
    }

    public var confirmation: String? {
        guard let confirmationId, confirmationId.count == 64,
              confirmationId.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
        return confirmationId
    }
}
