// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What the background refresh step needs from the app.
@MainActor
public protocol BackgroundRefreshSetupHost: AnyObject {
    var backgroundRefreshStatus: BackgroundRefreshPermissionState { get }
    var isLowPowerModeEnabled: Bool { get }
}

/// Background App Refresh, which the flow adds when it is off and a step the
/// run chose, or a source already on, only keeps syncing while it is on. The
/// app contributes the step; the steps that rely on the setting say so.
public struct BackgroundRefreshSetupStep: PhoneSetupStep {
    public static let stepId = "background-refresh"

    public static let copy = PhoneSetupCopy(
        title: "Background refresh",
        row: "Keeps sources syncing while Omnesis is closed",
        value: "Your sources keep syncing while Omnesis is closed only when Background App Refresh is on.",
        fine: "",
        permissionLabel: "Background App Refresh",
        onBody: "Your sources keep syncing while Omnesis is closed.",
        onTitle: "Background refresh is on",
        offTitle: "Background refresh is still off",
        offBody: "You can turn it on in Settings any time.",
        tint: 0x5E5CE6,
        symbol: "arrow.clockwise"
    )

    static let turnOnInstruction = "In Settings, turn on Background App Refresh for Omnesis. "
        + "If it's off for the whole iPhone, tap General, then Background App Refresh."
    static let lowPowerModeLine = "Low Power Mode also pauses background refresh."

    unowned let host: any BackgroundRefreshSetupHost

    public var id: String {
        Self.stepId
    }

    public var group: PhoneSetupStepGroup {
        .automatic
    }

    public var copy: PhoneSetupCopy {
        Self.copy
    }

    public var introduction: PhoneSetupIntroduction {
        .openSettings
    }

    public var rowState: PhoneSetupRowState {
        host.backgroundRefreshStatus == .available ? .alreadyOn : .selectable
    }

    public var authorization: MobileSourceAuthorization? {
        host.backgroundRefreshStatus == .available ? .granted(.full) : .notAllowed
    }

    /// Only a setting the user can change earns a page: a restricted one is
    /// left to the permission warning in Settings.
    public func isIncluded(alongside chosen: [any PhoneSetupStep]) -> Bool {
        host.backgroundRefreshStatus == .denied && chosen.contains { $0.needsBackgroundRefresh }
    }

    /// Names the steps that rely on the setting, such as "Apple Health and
    /// Photos keep syncing…".
    public func value(alongside chosen: [any PhoneSetupStep]) -> String? {
        let titles = chosen.filter(\.needsBackgroundRefresh).map(\.copy.title)
        guard !titles.isEmpty else { return nil }
        let verb = titles.count == 1 ? "keeps" : "keep"
        return "\(Self.naturalList(titles)) \(verb) syncing while Omnesis is closed only when Background App Refresh is on."
    }

    /// Low Power Mode switches the setting off behind the user's back, so it
    /// is named too.
    public func settingsInstruction(for outcome: PhoneSetupOutcome?) -> String? {
        guard outcome == nil || outcome == .notAllowed, host.backgroundRefreshStatus == .denied else { return nil }
        return host.isLowPowerModeEnabled ? Self.turnOnInstruction + "\n" + Self.lowPowerModeLine : Self.turnOnInstruction
    }

    public func enable(choice _: MobileSourceActivationChoice?) async -> PhoneSetupOutcome {
        host.backgroundRefreshStatus == .available ? .on : .notAllowed
    }

    public func currentOutcome() -> PhoneSetupOutcome? {
        host.backgroundRefreshStatus == .available ? .on : nil
    }

    /// A setting that is still off stays still off until iOS reports it on.
    public func reconciled(_ recorded: PhoneSetupOutcome, live: PhoneSetupOutcome?) -> PhoneSetupOutcome? {
        recorded == .notAllowed ? (live ?? recorded) : recorded.reconciled(with: live)
    }

    static func naturalList(_ items: [String]) -> String {
        guard items.count > 1, let last = items.last else { return items.first ?? "" }
        return items.dropLast().joined(separator: ", ") + " and " + last
    }
}
