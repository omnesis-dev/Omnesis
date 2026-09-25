// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Where a step is listed on Choose.
public enum PhoneSetupStepGroup: Equatable, Sendable {
    /// A data source this phone hosts.
    case source
    /// Listed under "Also": something that sends no data, such as notifications.
    case also
    /// Never listed on Choose: the flow adds the step itself when what the run
    /// chose calls for it.
    case automatic
}

/// What a step's page asks of the user before the step has an outcome.
public enum PhoneSetupIntroduction: Equatable, Sendable {
    /// Continue runs the step.
    case continueStep
    /// The change is made in iOS Settings: Open Settings, or Not now to move on.
    case openSettings
    /// The step's visuals draw the page's content and actions.
    case custom
}

/// How a step's row on Choose behaves.
public enum PhoneSetupRowState: Equatable, Sendable {
    case selectable
    /// Already on for this device: shown with a check, not selectable.
    case alreadyOn
    /// Shown disabled, with `reason` in place of the value line.
    case unavailable(reason: String)
}

extension MobileSourceActivationChoice {
    /// SF Symbol drawn beside the choice.
    public var symbol: String {
        switch self {
        case .keepOther: "iphone"
        case .useBoth: "iphone.gen3.radiowaves.left.and.right"
        case .takeOver: "arrow.right.circle.fill"
        }
    }
}

/// One of the ways to resolve `PhoneSetupOutcome.choiceRequired`.
public struct PhoneSetupChoice: Equatable, Sendable, Identifiable {
    public let choice: MobileSourceActivationChoice
    public let title: String
    public let detail: String

    public var id: String {
        title
    }
}

/// The app state phone setup needs beyond any single step.
@MainActor
public protocol PhoneSetupHost: AnyObject {
    /// Host name of the paired gateway.
    var pairedGatewayHost: String? { get }
    func liveStatus(sourceId: String) -> PhoneSetupLiveStatus?
    /// Why turning this source on last failed or stopped, if it did.
    func enableIssue(sourceId: String) -> String?
}

/// One page of phone setup. Each source contributes its own step from its
/// folder; the flow only ever talks to this contract, so it never branches on
/// which source it is showing.
@MainActor
public protocol PhoneSetupStep {
    var id: String { get }
    var group: PhoneSetupStepGroup { get }
    var copy: PhoneSetupCopy { get }
    var rowState: PhoneSetupRowState { get }
    /// Whether the step's source is on for this device, whatever its row shows.
    var isOn: Bool { get }
    /// What the operating system currently allows the step, when it reports it.
    var authorization: MobileSourceAuthorization? { get }
    /// Source whose live sync status the step's outcome shows, if any.
    var statusSourceId: String? { get }
    /// Why Continue is unavailable right now, shown in place of the fine
    /// print; nil when the step can run.
    var continueBlocker: String? { get }
    /// Whether the step's source keeps syncing while the app is closed only
    /// when Background App Refresh is on.
    var needsBackgroundRefresh: Bool { get }
    var introduction: PhoneSetupIntroduction { get }
    /// Whether an off or limited outcome offers Open Settings.
    var outcomeOffersSettings: Bool { get }
    /// A presentation outside the flow that answering this step makes
    /// unnecessary.
    var answeredPresentation: DeferredPresenter? { get }
    /// For an automatic step: whether the run includes it, given the steps it
    /// chose and the steps already on.
    func isIncluded(alongside chosen: [any PhoneSetupStep]) -> Bool
    /// The page's value line when it depends on those steps.
    func value(alongside chosen: [any PhoneSetupStep]) -> String?
    /// What to change in iOS Settings, on the page (`nil`) or on an outcome.
    func settingsInstruction(for outcome: PhoneSetupOutcome?) -> String?
    /// The outcome to keep for a step that recorded `recorded`, now that its
    /// state implies `live`.
    func reconciled(_ recorded: PhoneSetupOutcome, live: PhoneSetupOutcome?) -> PhoneSetupOutcome?
    /// Re-reads any state the step caches, such as notification settings.
    func refresh() async
    /// Turns the step on through the same path Settings uses, asking the
    /// operating system for access on the way.
    func enable(choice: MobileSourceActivationChoice?) async -> PhoneSetupOutcome
    /// The outcome the device's current state implies; see
    /// `PhoneSetupOutcome.live(enabled:authorization:)`.
    func currentOutcome() -> PhoneSetupOutcome?
    func choices(for mode: SourceMultiDeviceMode) -> [PhoneSetupChoice]
}

extension PhoneSetupStep {
    public var isOn: Bool {
        rowState == .alreadyOn
    }

    public var authorization: MobileSourceAuthorization? {
        nil
    }

    public var statusSourceId: String? {
        group == .source ? id : nil
    }

    public var continueBlocker: String? {
        nil
    }

    public var needsBackgroundRefresh: Bool {
        false
    }

    public var introduction: PhoneSetupIntroduction {
        .continueStep
    }

    public var outcomeOffersSettings: Bool {
        true
    }

    public var answeredPresentation: DeferredPresenter? {
        nil
    }

    public func isIncluded(alongside _: [any PhoneSetupStep]) -> Bool {
        false
    }

    public func value(alongside _: [any PhoneSetupStep]) -> String? {
        nil
    }

    public func settingsInstruction(for outcome: PhoneSetupOutcome?) -> String? {
        outcome.flatMap(copy.settingsInstruction)
    }

    public func reconciled(_ recorded: PhoneSetupOutcome, live: PhoneSetupOutcome?) -> PhoneSetupOutcome? {
        recorded.reconciled(with: live)
    }

    public func refresh() async {}

    public func choices(for _: SourceMultiDeviceMode) -> [PhoneSetupChoice] {
        []
    }
}
