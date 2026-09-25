// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The sections of the app home, post-onboarding. The Agent surface is
/// the landing view; every other section is reached through the
/// left-side `MainMenuDrawer` (there is no bottom tab bar). Settings is
/// not a case — it lives as a sheet presented from the drawer header.
///
/// Declared outside any UIKit guard so the push-routing decision below
/// is testable in the sim-less SwiftPM logic lane.
@available(iOS 17.0, *)
enum HomeTab: Hashable {
    case agent, search, people, sources, privacy, briefs, watches
}

/// What the app was presenting when it last left the foreground. Persisting
/// the exact conversation (including a deliberately fresh, not-yet-minted
/// one) prevents a Watch-created conversation with a newer `updatedAt` from
/// stealing the next app launch.
enum ForegroundConversationState: Equatable, Codable, Sendable {
    case conversation(String)
    case fresh
    case outsideAgent

    private enum CodingKeys: String, CodingKey { case kind, conversationId }
    private enum Kind: String, Codable { case conversation, fresh, outsideAgent }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .kind) {
        case .conversation:
            self = try .conversation(values.decode(String.self, forKey: .conversationId))
        case .fresh: self = .fresh
        case .outsideAgent: self = .outsideAgent
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .conversation(let id):
            try values.encode(Kind.conversation, forKey: .kind)
            try values.encode(id, forKey: .conversationId)
        case .fresh:
            try values.encode(Kind.fresh, forKey: .kind)
        case .outsideAgent:
            try values.encode(Kind.outsideAgent, forKey: .kind)
        }
    }
}

struct ForegroundConversationRecord: Equatable, Codable, Sendable {
    let state: ForegroundConversationState
    let leftAt: Date
}

enum ForegroundConversationAction: Equatable, Sendable {
    /// The user left the app on another section recently; keep that in-memory
    /// navigation untouched rather than dragging them into Ask.
    case preserve
    case resume(String)
    /// Open Ask on a locally empty conversation and focus its composer.
    case fresh
}

/// Pure one-hour decision. The boundary is intentionally inclusive: exactly
/// one hour is stale. Missing or future records are untrusted and start fresh.
enum ForegroundConversationPolicy {
    static let recentWindow: TimeInterval = 3600 // PARITY:agent-return-window-ms

    static func action(
        record: ForegroundConversationRecord?,
        now: Date,
        recentWindow: TimeInterval = recentWindow
    )
        -> ForegroundConversationAction {
        guard let record else { return .fresh }
        let age = now.timeIntervalSince(record.leftAt)
        guard age >= 0, age < recentWindow else { return .fresh }
        switch record.state {
        case .conversation(let id) where !id.isEmpty: return .resume(id)
        case .conversation, .fresh: return .fresh
        case .outsideAgent: return .preserve
        }
    }
}

/// UserDefaults persistence is isolated behind this tiny seam so policy tests
/// use invented records and a throwaway suite rather than global app state.
final class ForegroundConversationStore {
    static let recordKey = "agent.foregroundConversation"

    private let defaults: UserDefaults
    private let now: () -> Date

    init(defaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.now = now
    }

    func load() -> ForegroundConversationRecord? {
        guard let data = defaults.data(forKey: Self.recordKey) else { return nil }
        return try? JSONDecoder().decode(ForegroundConversationRecord.self, from: data)
    }

    func save(state: ForegroundConversationState) {
        guard let data = try? JSONEncoder().encode(
            ForegroundConversationRecord(state: state, leftAt: now())
        ) else { return }
        defaults.set(data, forKey: Self.recordKey)
    }

    func action() -> ForegroundConversationAction {
        ForegroundConversationPolicy.action(record: load(), now: now())
    }
}

/// Observable request passed from scene lifecycle into `HomeView`. A monotonic
/// id lets the view consume a request once even when SwiftUI remounts it.
struct ForegroundConversationRequest: Equatable {
    let id: Int
    let action: ForegroundConversationAction
}

/// Automatic foreground navigation yields to any explicit destination that is
/// already pending. Later push/deep-link changes still win through their own
/// existing `onChange` handlers and AgentCoordinator session generations.
enum ForegroundNavigationArbiter {
    static func automaticAction(
        _ action: ForegroundConversationAction,
        pushPending: Bool,
        capturePending: Bool
    )
        -> ForegroundConversationAction? {
        guard !pushPending, !capturePending else { return nil }
        return action
    }
}

/// Whether a privacy decision that is already waiting should open itself when
/// the app comes to the foreground — on a cold launch and on every return from
/// the background, never on the inactive-to-active flicker of a system alert
/// or Control Center.
///
/// A held answer expires. Leaving it to be found means it is silently dropped
/// instead, so the decision is put in front of the owner rather than waiting
/// for them to go looking. That licence is narrow:
///
///   - An explicit destination wins. A notification tap or a queued capture
///     already named where the app should be, and this must never displace it
///     — including a tap that was routed while the ledger was being read.
///   - Nothing already on screen is displaced.
///   - One offer per session. Dismissing without deciding is an answer of a
///     kind — "not now" — and re-presenting on every return from the
///     background would make the app unusable. The next cold launch asks
///     again, because the decision is still waiting and still expiring.
///   - An unpaired app has no gateway to have a decision on.
enum PrivacyApprovalAutoOpenPolicy {
    /// What the app has already claimed. Any one of these means the screen is
    /// spoken for by something the owner asked for, and a decision that opens
    /// itself must wait.
    struct Occupancy {
        var alreadyPresenting = false
        var pushPending = false
        /// A push target that was consumed by its destination while the
        /// decision's own ledger lookup was in flight. Nothing is pending any
        /// more, but the owner was routed somewhere they asked for, and that
        /// still outranks a decision that opens itself.
        var pushRoutedMeanwhile = false
        var capturePending = false

        var isOccupied: Bool {
            alreadyPresenting || pushPending || pushRoutedMeanwhile || capturePending
        }
    }

    static func shouldPresent(
        pendingCount: Int,
        paired: Bool,
        presentedThisSession: Bool,
        occupancy: Occupancy
    )
        -> Bool {
        guard pendingCount > 0, paired, !presentedThisSession else { return false }
        return !occupancy.isOccupied
    }
}

enum AgentComposerForegroundFocusPolicy {
    static func shouldFocus(
        request: Int,
        sessionId: String?,
        canCompose: Bool
    )
        -> Bool {
        request > 0 && sessionId == nil && canCompose
    }
}

/// The home section a push-tap target deep-links into.
///
/// Total on purpose: a target the gateway addressed to this app always
/// has a destination. The sending gateway is the authority that the
/// destination feature exists, so the decision never consults the app's
/// mirror of `/status` — that mirror reads `false` until the fetch
/// resolves (cold start) and stays `false` for the whole session when
/// the gateway is slow or unreachable at launch, which would silently
/// drop a valid tap.
///
/// Every section this maps to renders unconditionally in HomeView's
/// `sectionContent` and consumes the queued target when it appears (the
/// router is a queue-of-one). The experimental gate governs *browsing*
/// only: the drawer hides experimental entries, but it never blocks a
/// deep-link destination from mounting.
@available(iOS 17.0, *)
func homeTab(for target: PushTarget) -> HomeTab {
    switch target {
    case .brief: .briefs
    case .privacyApproval: .privacy
    // HomeView intercepts this target and presents the authorization sheet.
    // The fallback keeps this function total for callers predating that sheet.
    case .accessAuthorization: .agent
    case .agentAnswer: .agent
    case .watchFiring, .watch: .watches
    case .sourcePermission: .sources
    }
}

@available(iOS 17.0, *)
extension HomeTab {
    /// The tab the home view opens on. Normally `.agent`; in DEBUG builds a
    /// demo capture can request a different starting tab via the
    /// `DEMO_INITIAL_TAB` launch-environment variable (the landing-page
    /// screenshot pipeline launches straight onto Sources). DEBUG-only, like
    /// the other DEMO_* hooks, so the shipping app always opens on the agent.
    static var demoInitialOrAgent: HomeTab {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["DEMO_INITIAL_TAB"] ?? "" {
        case "agent": return .agent
        case "search": return .search
        case "people": return .people
        case "briefs": return .briefs
        case "sources": return .sources
        default: return .agent
        }
        #else
        return .agent
        #endif
    }
}
