// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What Apple Health's setup step needs from the app.
@MainActor
public protocol AppleHealthSetupHost: AnyObject {
    var appleHealthEnabled: Bool { get }
    var healthDataAvailable: Bool { get }
    var enabledCategories: Set<HealthCategory> { get }
    func setCategory(_ category: HealthCategory, enabled: Bool)
    func enableAppleHealth(activationChoice: MobileSourceActivationChoice?) async -> MobileSourceEnableResult
}

/// Apple Health's page in phone setup.
public struct AppleHealthSetupStep: PhoneSetupStep {
    public static let sourceId = "apple-health:local"

    public static let copy = PhoneSetupCopy(
        title: "Apple Health",
        row: "Sleep, heart, workouts",
        value: "Your sleep, heart and workouts, searchable next to your messages, calendar and notes.",
        ask: "How did I sleep the week before my last race?",
        ledger: PhoneSetupLedger(
            sent: [
                "Health samples: type, value, unit, time",
                "Sleep stages",
                "Workouts and mindful sessions",
                "Source app and device",
                "Details Health attaches to each sample",
            ],
            staysLabel: "Never",
            stays: ["Writing to Apple Health"]
        ),
        fine: "iOS asks next, with a switch for each type.",
        permissionLabel: "Health access",
        // HealthKit never tells an app that reading a type was refused, so
        // the only honest recovery hint is phrased around a type staying empty.
        onBody: "Your history is being read in the background. You don't need to wait here. "
            + "If a type stays empty, Health may have it switched off for Omnesis in the Health app's settings.",
        tint: 0xFF2D55,
        symbol: "heart.fill"
    )

    /// Confirmation before a category that `requiresConsent` is turned on.
    public static let consentTitle = "Enable Mood tracking?"
    public static let consentMessage =
        "Mood data is sensitive health information. Enable indexing your State of Mind logs from Apple Health?"

    unowned let host: any AppleHealthSetupHost

    public var id: String {
        Self.sourceId
    }

    public var group: PhoneSetupStepGroup {
        .source
    }

    public var copy: PhoneSetupCopy {
        Self.copy
    }

    public static let noCategoriesMessage = "Choose at least one category."
    public static let unreadableCategoriesMessage =
        "The categories you chose can't be read on this version of iOS. Turn on another category."

    public var continueBlocker: String? {
        host.enabledCategories.isEmpty ? Self.noCategoriesMessage : nil
    }

    public var rowState: PhoneSetupRowState {
        guard host.healthDataAvailable else { return .unavailable(reason: PhoneSetupCopy.notAvailableReason) }
        return host.appleHealthEnabled ? .alreadyOn : .selectable
    }

    public var isOn: Bool {
        host.appleHealthEnabled
    }

    public var needsBackgroundRefresh: Bool {
        true
    }

    public func enable(choice: MobileSourceActivationChoice?) async -> PhoneSetupOutcome {
        await PhoneSetupOutcome(host.enableAppleHealth(activationChoice: choice))
    }

    /// Granting the Health sheet is the only answer HealthKit reports, so a
    /// source that is on is on.
    public func currentOutcome() -> PhoneSetupOutcome? {
        host.appleHealthEnabled ? .on : nil
    }

    public func choices(for mode: SourceMultiDeviceMode) -> [PhoneSetupChoice] {
        Self.choices(for: mode)
    }

    /// The ways to resolve another iPhone already sending Apple Health. The
    /// setup page and the Settings sheet offer the same choices.
    public static func choices(for mode: SourceMultiDeviceMode) -> [PhoneSetupChoice] {
        var choices = [
            PhoneSetupChoice(
                choice: .keepOther,
                title: "Keep using the other iPhone",
                detail: "Nothing changes, and this iPhone will not ask for Health access."
            ),
        ]
        if mode == .replicated {
            choices.append(PhoneSetupChoice(
                choice: .useBoth,
                title: "Use both iPhones",
                detail: "Both phones contribute for better continuity when one is offline."
            ))
        }
        choices.append(PhoneSetupChoice(
            choice: .takeOver,
            title: "Use only this iPhone",
            detail: "Transfer Apple Health to this phone and stop the other phone from contributing."
        ))
        return choices
    }
}

extension HealthCategory {
    /// The name Omnesis shows for the category.
    public var displayName: String {
        switch self {
        case .body: "Body composition"
        case .activity: "Activity"
        case .vitals: "Vitals"
        case .sleep: "Sleep"
        case .nutrition: "Nutrition"
        case .mindful: "Mindfulness"
        case .environment: "Environmental exposure"
        case .workouts: "Workouts"
        case .mood: "Mood"
        }
    }

    /// Categories holding sensitive self-reports ask for confirmation before
    /// they are turned on.
    public var requiresConsent: Bool {
        self == .mood
    }
}

extension TypeCatalog {
    /// Catalog entries in `categories`, in rotation order.
    public static func entries(in categories: Set<HealthCategory>) -> [TypeEntry] {
        v1.filter { categories.contains($0.category) }
    }
}
