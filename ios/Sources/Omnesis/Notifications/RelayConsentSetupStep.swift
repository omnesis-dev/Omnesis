// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The relay consent decision, which the flow adds before Finish whenever the
/// gateway asks for it while setup is open and notifications are allowed.
/// Answering it here means the standalone consent sheet doesn't appear during
/// the same visit to the app.
public struct RelayConsentSetupStep: PhoneSetupStep {
    public static let stepId = "relay-consent"

    /// The page's own content is the shared consent view; the copy here names
    /// the step and describes the two answers.
    public static let copy = PhoneSetupCopy(
        title: "Private notification wakes",
        row: RelayPushConsentCopy.title,
        value: RelayPushConsentCopy.explanation,
        fine: "",
        permissionLabel: "relay notifications",
        onBody: "Your gateway can now wake this iPhone privately.",
        onTitle: "Relay notifications are on",
        offTitle: "Relay notifications are off",
        offBody: "Omnesis will ask again later. You can also allow them from Settings.",
        tint: NotificationsSetupStep.copy.tint,
        symbol: "bell.fill"
    )

    unowned let host: any NotificationsSetupHost

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
        .custom
    }

    /// Declining isn't something to fix in iOS Settings.
    public var outcomeOffersSettings: Bool {
        false
    }

    public var rowState: PhoneSetupRowState {
        .selectable
    }

    public var answeredPresentation: DeferredPresenter? {
        .relayConsent
    }

    /// Wakes only matter once notifications are allowed, so a request waits
    /// for that.
    public func isIncluded(alongside _: [any PhoneSetupStep]) -> Bool {
        host.relayPushConsentRequest != nil && host.notificationPermission == .authorized
    }

    /// The page's own Allow and Not now answer the step; it has nothing to
    /// turn on.
    public func enable(choice _: MobileSourceActivationChoice?) async -> PhoneSetupOutcome {
        .skipped
    }

    public func currentOutcome() -> PhoneSetupOutcome? {
        nil
    }

    /// The answer is the user's decision, not device state, so it stands.
    public func reconciled(_ recorded: PhoneSetupOutcome, live _: PhoneSetupOutcome?) -> PhoneSetupOutcome? {
        recorded
    }
}
