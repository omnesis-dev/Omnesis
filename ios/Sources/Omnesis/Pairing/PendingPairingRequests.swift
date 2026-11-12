// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

/// What the home banner shows while devices that signed in wait for approval: one row
/// however many wait, with the count in its words.
public struct PairingRequestBannerOffer: Equatable, Sendable {
    public static let one = "A device is waiting for your approval to pair to this gateway."
    /// The banner's action, which opens Pairing requests.
    public static let actionTitle = "Review"

    public let count: Int

    public var text: String {
        count > 1 ? "\(count) devices are waiting for your approval to pair to this gateway." : Self.one
    }
}

/// Which waiting requests the banner has been dismissed for. Dismissing hides it for exactly
/// the set waiting at that moment; a request arriving or leaving brings it back. Nothing is stored.
public struct PairingRequestBannerState: Equatable, Sendable {
    private var dismissedIds: Set<String>?

    public init() {}

    public func offer(from requests: [GatewayPairingApprovalRequest], nowMillis: Double) -> PairingRequestBannerOffer? {
        let waiting = pairingRequestsStillWaiting(requests, nowMillis: nowMillis)
        guard !waiting.isEmpty, dismissedIds != Set(waiting.map(\.id)) else { return nil }
        return PairingRequestBannerOffer(count: waiting.count)
    }

    public mutating func dismiss(_ requests: [GatewayPairingApprovalRequest], nowMillis: Double) {
        dismissedIds = Set(pairingRequestsStillWaiting(requests, nowMillis: nowMillis).map(\.id))
    }
}

/// The requests the owner can still decide. A list read a while ago can carry one that has
/// since run out or been decided on another device.
public func pairingRequestsStillWaiting(
    _ requests: [GatewayPairingApprovalRequest],
    nowMillis: Double
)
    -> [GatewayPairingApprovalRequest] {
    requests.filter { $0.status == "pending" && $0.expiresAt > nowMillis }
}

/// The sign-in pairing requests waiting on this gateway, as the home banner reads them, and
/// the request to open Pairing requests that a notification tap or the banner makes.
///
/// Only an administrator's phone in a build with the Omnesis account asks the gateway; any
/// other phone holds an empty list and never sends a request.
@MainActor
@Observable
public final class PendingPairingRequests {
    public static let shared = PendingPairingRequests()

    /// How often the banner asks again while the app is in front.
    public static let pollInterval: Duration = .seconds(30)

    public private(set) var requests: [GatewayPairingApprovalRequest] = []
    /// Bumped to ask for a fresh read now: a notification arrived, or a decision was made.
    public private(set) var refreshRequests = 0
    /// Bumped to ask Devices to open Pairing requests.
    public private(set) var openRequests = 0
    private var consumedOpenRequests = 0
    private var generation = 0
    private var frozen = false

    public init() {}

    /// Whether this phone may list pairing requests at all.
    public nonisolated static func eligible(cloudRelayEnabled: Bool, scopes: [String]?) -> Bool {
        cloudRelayEnabled && scopes?.contains("admin") == true
    }

    /// Reads can overlap, and only the latest one started lands. A failure empties the list:
    /// a banner is the wrong place for a network error, and the next read asks again.
    public func refresh(client: (any GatewayPairingApproving)?) async {
        guard !frozen else { return }
        generation += 1
        let current = generation
        guard let client else {
            requests = []
            return
        }
        let incoming = await (try? client.pairingApprovalRequests()) ?? []
        guard current == generation, !frozen else { return }
        requests = incoming
    }

    public func requestRefresh() {
        refreshRequests &+= 1
    }

    public func requestOpen() {
        openRequests &+= 1
    }

    /// True once per request to open, so a screen that appears again later does not reopen it.
    public func consumeOpen() -> Bool {
        guard openRequests != consumedOpenRequests else { return false }
        consumedOpenRequests = openRequests
        return true
    }

    /// Forget everything, for a phone that is no longer paired or no longer an administrator.
    public func clear() {
        guard !frozen else { return }
        generation += 1
        requests = []
        consumedOpenRequests = openRequests
    }

    #if DEBUG
    /// Preview and snapshot seam: a fixed list no read replaces. `nil` returns to live reads.
    public func seedForPreview(_ seeded: [GatewayPairingApprovalRequest]?) {
        generation += 1
        frozen = seeded != nil
        requests = seeded ?? []
    }
    #endif
}
