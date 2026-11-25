// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct DesktopUpdatePresentation: Decodable, Equatable, Sendable {
    public struct CodeCleanup: Decodable, Equatable, Sendable {
        public enum Phase: String, Decodable, Sendable { case preview, complete }
        public let phase: Phase
        public let confirmationId: String?
        public let reclaimableBytes: Int64
        public let removedBytes: Int64
        public let removedEpochs: Int64
        public let retainedEpochs: Int64
        public var valid: Bool {
            [reclaimableBytes, removedBytes, removedEpochs, retainedEpochs].allSatisfy { $0 >= 0 && $0 <= 9_007_199_254_740_991 }
        }

        public var confirmation: String? {
            guard valid, phase == .preview, let confirmationId, confirmationId.count == 64,
                  confirmationId.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
            return confirmationId
        }
    }

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
    public let codeCleanup: CodeCleanup?

    public var verified: Bool {
        kind == "desktopUpdate"
    }

    public var confirmation: String? {
        guard codeCleanup == nil, let confirmationId, confirmationId.count == 64,
              confirmationId.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
        return confirmationId
    }
}
