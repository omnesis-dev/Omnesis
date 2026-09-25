// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// When a wait for a location prompt ends. iOS reports a While Using answer
/// through the permission status, but reports nothing for an Always upgrade it
/// skips or that the user declines, and a prompt the user leaves by switching
/// apps leaves the status undecided. So both waits also read the app leaving
/// the active state while iOS shows the prompt, and coming back to it.
public struct LocationPromptWait: Equatable, Sendable {
    public enum Step: Equatable, Sendable {
        case keepWaiting
        /// iOS is showing the prompt: the app has just left the active state.
        case promptShown
        case stop
    }

    /// The longest either wait lasts.
    public static let answerCeiling: Duration = .seconds(60)
    /// How long iOS gets to put the Always upgrade on screen before the wait
    /// takes it as not shown.
    public static let upgradeGrace: Duration = .milliseconds(500)

    private(set) var sawInactive = false

    public init() {}

    /// The While Using prompt ends once iOS reports an answer, once the app is
    /// active again after the prompt, or at `answerCeiling`. A prompt that is
    /// slow to appear keeps the wait going.
    public mutating func whileUsing(isDecided: Bool, isActive: Bool, elapsed: Duration) -> Step {
        if isDecided || elapsed >= Self.answerCeiling { return .stop }
        if !isActive { return markInactive() }
        return sawInactive ? .stop : .keepWaiting
    }

    /// The Always upgrade ends once granted, once the app is active again after
    /// the prompt, when iOS has not put it on screen within `upgradeGrace`, or
    /// at `answerCeiling`.
    public mutating func alwaysUpgrade(isAlways: Bool, isActive: Bool, elapsed: Duration) -> Step {
        if isAlways || elapsed >= Self.answerCeiling { return .stop }
        if !isActive { return markInactive() }
        return sawInactive || elapsed >= Self.upgradeGrace ? .stop : .keepWaiting
    }

    private mutating func markInactive() -> Step {
        guard !sawInactive else { return .keepWaiting }
        sawInactive = true
        return .promptShown
    }
}
