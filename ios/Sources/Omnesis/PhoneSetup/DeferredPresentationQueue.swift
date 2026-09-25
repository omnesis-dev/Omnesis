// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Something the app presents on its own, rather than because the user just
/// tapped it in the app, and which therefore waits its turn.
public enum DeferredPresenter: Int, CaseIterable, Comparable, Sendable {
    /// A notification the user tapped.
    case pushTarget
    /// An access-authorization code the user scanned.
    case accessAuthorization
    /// Quick capture opened from the Lock Screen or Control Center.
    case capture
    /// The relay-consent decision the gateway is waiting on.
    case relayConsent
    /// A privacy decision that was already waiting when the app came forward.
    case privacyApproval
    /// Focusing the agent composer, which raises the keyboard.
    case composerFocus

    public static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

/// Lets automatic presentations happen one at a time. Each presenter asks for
/// a turn; while phone setup holds the screen, or anything else is on it,
/// nobody gets one. When the screen is free the most important waiting
/// presenter goes, and the next waits until that one has closed, so presenters
/// released together never collide.
public struct DeferredPresentationQueue: Equatable, Sendable {
    public private(set) var waiting: Set<DeferredPresenter> = []
    /// The presenter whose presentation is on screen.
    public private(set) var current: DeferredPresenter?
    /// When the current presenter asked for its sheet, if it did.
    public private(set) var currentSheetRequestedAt: Date?
    /// Whether the current presenter's sheet has appeared.
    public private(set) var hasCurrentAppeared = false
    /// Presenters already asked for again after a sheet that never appeared.
    private var retried: Set<DeferredPresenter> = []

    /// How long a requested sheet may take to appear before its turn is given back.
    public static let appearanceTimeout: TimeInterval = 1

    public init() {}

    public mutating func request(_ presenter: DeferredPresenter) {
        waiting.insert(presenter)
    }

    /// Drops a request whose reason has gone, such as a consent answered
    /// elsewhere.
    public mutating func withdraw(_ presenter: DeferredPresenter) {
        waiting.remove(presenter)
    }

    /// The presenter whose turn it is, which becomes current. Nil while the
    /// gate is shut, the screen is taken, or another presenter is current.
    public mutating func next(gateOpen: Bool, screenIsFree: Bool) -> DeferredPresenter? {
        guard gateOpen, screenIsFree, current == nil, let first = waiting.min() else { return nil }
        waiting.remove(first)
        current = first
        currentSheetRequestedAt = nil
        hasCurrentAppeared = false
        return first
    }

    /// The current presenter has asked for its sheet.
    public mutating func markPresenting(_ presenter: DeferredPresenter, now: Date) {
        guard current == presenter else { return }
        currentSheetRequestedAt = now
    }

    /// The current presenter's presentation is on screen.
    public mutating func didAppear(_ presenter: DeferredPresenter) {
        guard current == presenter else { return }
        hasCurrentAppeared = true
    }

    /// Gives back the turn of a sheet that was asked for but has not appeared
    /// within `appearanceTimeout`, as when SwiftUI drops a presentation made
    /// while another sheet is still leaving. The presenter waits for one more
    /// turn; a second failure is not retried. Returns the presenter whose turn
    /// ended, so home can clear the sheet it asked for.
    public mutating func expireUnappeared(on screen: DeferredPresentationScreen, now: Date) -> DeferredPresenter? {
        guard let current, !hasCurrentAppeared, screen.hasSheet(for: current),
              let requestedAt = currentSheetRequestedAt,
              now.timeIntervalSince(requestedAt) > Self.appearanceTimeout else { return nil }
        endTurn()
        if !retried.contains(current) {
            retried.insert(current)
            waiting.insert(current)
        }
        return current
    }

    /// Whether a change of what home shows should present the next waiting
    /// presenter now. A sheet that just closed is still leaving the screen, so
    /// its dismissal presents the next one instead.
    public static func presentsWhenScreenChanges(
        from old: DeferredPresentationScreen,
        to new: DeferredPresentationScreen
    )
        -> Bool {
        new.isFree && !old.hasSheet
    }

    /// The current presenter has closed, or presented nothing that stays on
    /// screen; the next one may go.
    public mutating func finish(_ presenter: DeferredPresenter) {
        guard current == presenter else { return }
        // A presentation that made it on screen earns a fresh retry next time.
        if hasCurrentAppeared {
            retried.remove(presenter)
        }
        endTurn()
    }

    /// Ends the current turn once what it put on screen has gone, including a
    /// turn whose presentation never happened. The relay consent sheet is
    /// presented from the root rather than home, so home never ends its turn.
    public mutating func settle(on screen: DeferredPresentationScreen) {
        guard let current, current != .relayConsent, !screen.shows(current) else { return }
        if hasCurrentAppeared {
            retried.remove(current)
        }
        endTurn()
    }

    /// First-run setup is taking the screen: a relay consent sheet steps aside
    /// and waits for its turn again.
    public mutating func stepAsideForSetup() {
        guard current == .relayConsent else { return }
        endTurn()
        waiting.insert(.relayConsent)
    }

    /// Whether a request is kept. Outside setup, focusing the composer behind a
    /// sheet would raise the keyboard later out of nowhere, so it is dropped.
    public static func admits(_ presenter: DeferredPresenter, gateOpen: Bool, screenIsFree: Bool) -> Bool {
        !(presenter == .composerFocus && gateOpen && !screenIsFree)
    }

    /// Whether a request the user just made closes home's sheet to present
    /// straight away. While setup holds the screen it waits its turn instead.
    public static func preempts(_ presenter: DeferredPresenter, gateOpen: Bool) -> Bool {
        gateOpen && [.pushTarget, .accessAuthorization, .capture].contains(presenter)
    }

    private mutating func endTurn() {
        current = nil
        currentSheetRequestedAt = nil
        hasCurrentAppeared = false
    }
}

/// What home has on screen, as the queue needs it.
public struct DeferredPresentationScreen: Equatable, Sendable {
    public var settings = false
    public var accessAuthorization = false
    public var privacyApproval = false
    public var privacyLookup = false
    public var capture = false
    public var relayConsent = false

    public init(
        settings: Bool = false,
        accessAuthorization: Bool = false,
        privacyApproval: Bool = false,
        privacyLookup: Bool = false,
        capture: Bool = false,
        relayConsent: Bool = false
    ) {
        self.settings = settings
        self.accessAuthorization = accessAuthorization
        self.privacyApproval = privacyApproval
        self.privacyLookup = privacyLookup
        self.capture = capture
        self.relayConsent = relayConsent
    }

    /// One of home's sheets is up.
    public var hasSheet: Bool {
        settings || accessAuthorization || privacyApproval
    }

    /// Whether `presenter` has a sheet of home's up.
    public func hasSheet(for presenter: DeferredPresenter) -> Bool {
        switch presenter {
        case .pushTarget: settings || accessAuthorization
        case .accessAuthorization: accessAuthorization
        case .privacyApproval: privacyApproval
        case .capture, .relayConsent, .composerFocus: false
        }
    }

    /// Nothing home presents is up.
    public var isFree: Bool {
        !settings && !accessAuthorization && !privacyApproval && !privacyLookup && !capture
    }

    /// Whether `presenter`'s presentation is what is on screen.
    public func shows(_ presenter: DeferredPresenter) -> Bool {
        switch presenter {
        case .pushTarget: settings || accessAuthorization
        case .accessAuthorization: accessAuthorization
        case .capture: capture
        case .relayConsent: relayConsent
        case .privacyApproval: privacyApproval || privacyLookup
        case .composerFocus: false
        }
    }
}
