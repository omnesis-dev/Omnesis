// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

/// What the home banner shows while new devices wait for approval: one row however many
/// wait, whichever way they asked, with the count in its words.
public struct PairingRequestBannerOffer: Equatable, Sendable {
    public static let one = "A new device is waiting for your OK."
    /// The banner's action, which opens Waiting for your OK.
    public static let actionTitle = "Review"

    public let count: Int

    public var text: String {
        count > 1 ? "\(count) new devices are waiting for your OK." : Self.one
    }
}

/// Which waiting requests the banner has been dismissed for. Dismissing hides it for exactly
/// the set waiting at that moment; a request arriving or leaving brings it back. Nothing is stored.
public struct PairingRequestBannerState: Equatable, Sendable {
    private var dismissedIds: Set<String>?

    public init() {}

    public func offer(
        from requests: [GatewayPairingApprovalRequest],
        tailscale: [TailscaleJoinRequest] = [],
        nowMillis: Double
    )
        -> PairingRequestBannerOffer? {
        let waiting = Self.waitingIds(requests, tailscale, nowMillis: nowMillis)
        guard !waiting.isEmpty, dismissedIds != waiting else { return nil }
        return PairingRequestBannerOffer(count: waiting.count)
    }

    public mutating func dismiss(
        _ requests: [GatewayPairingApprovalRequest],
        tailscale: [TailscaleJoinRequest] = [],
        nowMillis: Double
    ) {
        dismissedIds = Self.waitingIds(requests, tailscale, nowMillis: nowMillis)
    }

    /// The two kinds keep their ids apart, so one of each with the same id counts twice.
    private static func waitingIds(
        _ requests: [GatewayPairingApprovalRequest],
        _ tailscale: [TailscaleJoinRequest],
        nowMillis: Double
    )
        -> Set<String> {
        let now = Date(timeIntervalSince1970: nowMillis / 1000)
        return Set(pairingRequestsStillWaiting(requests, nowMillis: nowMillis).map { "cloud:\($0.id)" })
            .union(tailscale.filter { $0.expiresAt > now }.map { "tailscale:\($0.id)" })
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

/// A request to open Waiting for your OK, as Devices takes it.
public struct PairingRequestsOpen: Equatable, Sendable {
    /// It came from a `tailscale-join` notification: the gateway serves Tailscale join
    /// requests, whether or not this phone has read its status yet.
    public let tailscale: Bool
}

/// The devices waiting for the owner's OK on this gateway, as the home banner reads them,
/// and the request to open Waiting for your OK that a notification tap or the banner makes.
///
/// Only an administrator's phone asks the gateway, and only for the kinds this build and
/// gateway offer (`DeviceApprovalKinds`); any other phone holds empty lists and never sends
/// a request.
@MainActor
@Observable
public final class PendingPairingRequests {
    public static let shared = PendingPairingRequests()

    /// How often the banner asks again while the app is in front.
    public static let pollInterval: Duration = .seconds(30)

    /// Devices that signed in with the owner's Omnesis account.
    public private(set) var requests: [GatewayPairingApprovalRequest] = []
    /// Devices that reached the gateway through the owner's Tailscale network.
    public private(set) var tailscaleRequests: [TailscaleJoinRequest] = []
    /// Bumped to ask for a fresh read now: a notification arrived, or a decision was made.
    public private(set) var refreshRequests = 0
    /// Bumped to ask Devices to open Waiting for your OK.
    public private(set) var openRequests = 0
    /// The request a notification named, listed first when the list opens.
    public private(set) var focusedRequestId: String?
    private var openIsForTailscale = false
    private var consumedOpenRequests = 0
    private var generation = 0
    private var frozen = false

    public init() {}

    /// Reads can overlap, and only the latest one started lands. A failure empties that kind's
    /// list: a banner is the wrong place for a network error, and the next read asks again.
    /// A kind without a client is not asked and reads as empty.
    public func refresh(cloud: (any GatewayPairingApproving)?, tailscale: (any TailscaleJoinDeciding)?) async {
        guard !frozen else { return }
        generation += 1
        let current = generation
        async let cloudRows = Self.read(cloud)
        async let joinRows = Self.read(tailscale)
        let (incoming, joins) = await (cloudRows, joinRows)
        guard current == generation, !frozen else { return }
        requests = incoming
        tailscaleRequests = joins
    }

    /// Asks the one gateway for the kinds this phone reviews, and nothing for the others.
    public func refresh(kinds: DeviceApprovalKinds, client: (any GatewayPairingApproving & TailscaleJoinDeciding)?) async {
        await refresh(cloud: kinds.cloud ? client : nil, tailscale: kinds.tailscale ? client : nil)
    }

    public func requestRefresh() {
        refreshRequests &+= 1
    }

    /// `tailscale` marks a request from a `tailscale-join` notification.
    public func requestOpen(focus requestId: String? = nil, tailscale: Bool = false) {
        focusedRequestId = requestId
        openIsForTailscale = tailscale
        openRequests &+= 1
    }

    /// Non-nil once per request to open, so a screen that appears again later does not reopen it.
    public func consumeOpen() -> PairingRequestsOpen? {
        guard openRequests != consumedOpenRequests else { return nil }
        consumedOpenRequests = openRequests
        return PairingRequestsOpen(tailscale: openIsForTailscale)
    }

    /// Forget everything, for a phone that is no longer paired or no longer an administrator.
    public func clear() {
        guard !frozen else { return }
        generation += 1
        requests = []
        tailscaleRequests = []
        focusedRequestId = nil
        consumedOpenRequests = openRequests
    }

    private nonisolated static func read(_ client: (any GatewayPairingApproving)?) async -> [GatewayPairingApprovalRequest] {
        guard let client else { return [] }
        return await (try? client.pairingApprovalRequests()) ?? []
    }

    private nonisolated static func read(_ client: (any TailscaleJoinDeciding)?) async -> [TailscaleJoinRequest] {
        guard let client else { return [] }
        return await (try? client.tailscaleJoinRequests()) ?? []
    }

    #if DEBUG
    /// Preview and snapshot seam: fixed lists no read replaces. `nil` returns to live reads.
    public func seedForPreview(_ seeded: [GatewayPairingApprovalRequest]?, tailscale: [TailscaleJoinRequest] = []) {
        generation += 1
        frozen = seeded != nil
        requests = seeded ?? []
        tailscaleRequests = seeded == nil ? [] : tailscale
    }
    #endif
}
