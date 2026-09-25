// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What leaves the phone for one source, and what never does.
public struct PhoneSetupLedger: Equatable, Sendable {
    public var sent: [String]
    /// Heading for `stays`, such as "Never" or "Stays on this iPhone".
    public var staysLabel: String
    public var stays: [String]
}

/// One line of a step that explains itself with examples instead of a ledger.
public struct PhoneSetupHighlight: Equatable, Sendable, Identifiable {
    /// SF Symbol name.
    public var symbol: String
    public var text: String

    public var id: String {
        text
    }
}

/// Everything one step says during phone setup. The same value feeds the
/// setup page and the source's "What's sent" disclosure in Settings, so the
/// two never disagree about what a source sends.
public struct PhoneSetupCopy: Equatable, Sendable {
    public static let notAvailableReason = "Not available on this iPhone"

    /// The name the source goes by in Settings.
    public var title: String
    /// The one-line value shown on Choose.
    public var row: String
    /// The step page's value line.
    public var value: String
    /// An example question the source makes answerable.
    public var ask: String?
    public var ledger: PhoneSetupLedger?
    /// Shown instead of a ledger by steps that send nothing to the gateway.
    public var highlights: [PhoneSetupHighlight] = []
    /// Fine print under the primary button.
    public var fine: String
    /// The access the outcome copy names when iOS refused it.
    public var permissionLabel: String
    public var onBody: String
    public var limitedBody: String?
    public var partialBody: String?
    public var onTitle: String?
    public var offTitle: String?
    public var offBody: String?
    public var unavailableBody: String?
    /// What to change in iOS Settings when access was refused, naming the
    /// setting's real labels. Shown above the outcome's Open Settings.
    public var notAllowedSettingsSteps: String?
    /// The same when access was granted with limits.
    public var partialSettingsSteps: String?
    /// The busy label while the step turns its source on; `turningOnLabel`
    /// derives one from the title when nil.
    public var busyLabel: String?
    /// Accent colour as 0xRRGGBB.
    public var tint: UInt32
    /// SF Symbol name.
    public var symbol: String

    public var turningOnLabel: String {
        busyLabel ?? "Turning on \(title)…"
    }

    /// The Settings instruction for an outcome whose action is Open Settings.
    public func settingsInstruction(_ outcome: PhoneSetupOutcome) -> String? {
        switch outcome {
        case .notAllowed: notAllowedSettingsSteps
        case .partial: partialSettingsSteps
        case .on, .limited, .unavailable, .choiceRequired, .failed, .skipped: nil
        }
    }

    public func outcomeTitle(_ outcome: PhoneSetupOutcome) -> String {
        switch outcome {
        case .on, .limited, .skipped: onTitle ?? "\(title) is on"
        case .partial: "\(title) is on, with limits"
        case .notAllowed: offTitle ?? "\(title) is off"
        case .unavailable: "\(title) isn't available"
        case .choiceRequired: "Another device already sends \(title)"
        case .failed: "Couldn't turn on \(title)"
        }
    }

    public func outcomeBody(_ outcome: PhoneSetupOutcome) -> String {
        switch outcome {
        case .on, .skipped: onBody
        case .limited: limitedBody ?? onBody
        case .partial: partialBody ?? onBody
        case .notAllowed: offBody ?? "You can allow \(permissionLabel) for Omnesis in Settings any time."
        case .unavailable(let reason): unavailableBody ?? reason
        case .choiceRequired: "Choose how this iPhone should contribute."
        case .failed(let message): message.map(Self.withoutRetryPrompt) ?? "Something went wrong. Nothing was changed."
        }
    }

    /// A failure page has its own Try again button, so a message ending by
    /// asking for one does not ask twice.
    static func withoutRetryPrompt(_ message: String) -> String {
        let prompt = "Try again."
        let trimmed = message.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasSuffix(prompt), trimmed != prompt else { return message }
        return String(trimmed.dropLast(prompt.count)).trimmingCharacters(in: .whitespaces)
    }
}
