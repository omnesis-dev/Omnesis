// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct DesktopRemovalPlan: Decodable, Equatable, Sendable {
    public enum Mode: String, Decodable, Sendable { case keepData = "keep-data", eraseData = "erase-data" }
    public let available: Bool
    public let mode: Mode
    public let confirmationId: String?
    public let summary: String
    public let dataKept: Bool
    public let keyKept: Bool

    public var canConfirm: Bool {
        available && confirmationId?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
            && ((mode == .keepData && dataKept && keyKept) || (mode == .eraseData && !dataKept && !keyKept))
    }
}

public struct DesktopRemovalOutcome: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Sendable {
        case notInstalled = "not-installed", retired, keyCleanupPending = "key-cleanup-pending"
    }

    public enum DataDisposition: String, Decodable, Sendable { case absent, retained, erased }
    public enum KeyDisposition: String, Decodable, Sendable { case unchanged, retained, cleared, pending }
    public let status: Status
    public let data: DataDisposition
    public let keyring: KeyDisposition

    public var finished: Bool {
        switch (status, data, keyring) {
        case (.notInstalled, .absent, .unchanged), (.retired, .retained, .retained), (.retired, .erased, .cleared): true
        default: false
        }
    }

    public var title: String {
        finished ? "Ready to remove the app" : "One removal step needs attention"
    }

    public var message: String {
        if status == .keyCleanupPending || keyring == .pending {
            return "Omnesis is stopped, but removing its saved encryption key has not finished. Retry this step before moving the app to Trash."
        }
        if !finished { return "Omnesis has not confirmed every removal step finished. Keep the app and try again." }
        switch data {
        case .retained: return "Omnesis is stopped. Your Omnesis data and its encryption key are kept on this Mac, ready if you reinstall."
        case .erased: return "The Omnesis data on this Mac was erased. Your original information in connected apps and accounts is unchanged."
        case .absent: return "No Omnesis library data was found on this Mac."
        }
    }
}
