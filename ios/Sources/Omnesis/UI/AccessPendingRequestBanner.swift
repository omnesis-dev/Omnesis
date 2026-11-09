// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What the home banner shows for the requests waiting right now: the one
/// it opens, and how many are waiting in all.
struct AccessPendingRequestBannerOffer: Equatable {
    /// The banner's action, which opens the request's approval wizard.
    static let actionTitle = "Configure & Approve"

    let newest: AccessPendingRequest
    let count: Int

    /// The line under the title: who is asking, and how many more are
    /// waiting behind it.
    var detail: String {
        count > 1 ? "\(newest.clientName) and \(count - 1) more" : newest.clientName
    }
}

/// Which waiting requests the banner has been dismissed for.
///
/// Dismissing hides the banner for exactly the set of requests waiting at
/// that moment. A request arriving or leaving changes the set and the banner
/// returns, so a dismissal never hides a request the owner has not seen
/// named. The state is per screen and per session; nothing about it is
/// stored.
struct AccessPendingRequestBannerState: Equatable {
    private var dismissedIds: Set<String>?

    init() {}

    /// The banner to show for `pending` at `nowMillis`, or nil when nothing
    /// is still waiting or the owner dismissed exactly this set.
    func offer(from pending: [AccessPendingRequest], nowMillis: Int64) -> AccessPendingRequestBannerOffer? {
        let waiting = accessLivePendingRequests(pending, nowMillis: nowMillis)
        guard let newest = accessNewestPendingRequest(waiting),
              dismissedIds != Set(waiting.map(\.id)) else { return nil }
        return AccessPendingRequestBannerOffer(newest: newest, count: waiting.count)
    }

    mutating func dismiss(_ pending: [AccessPendingRequest], nowMillis: Int64) {
        dismissedIds = Set(accessLivePendingRequests(pending, nowMillis: nowMillis).map(\.id))
    }
}

/// The requests that can still be decided. The gateway lists only those, but
/// a list read minutes ago can carry one that has since run out.
func accessLivePendingRequests(_ pending: [AccessPendingRequest], nowMillis: Int64) -> [AccessPendingRequest] {
    pending.filter { $0.expiresAt > nowMillis }
}

/// The request to open when several are waiting: the one created last. Two
/// created in the same millisecond keep the gateway's order, newest first.
func accessNewestPendingRequest(_ pending: [AccessPendingRequest]) -> AccessPendingRequest? {
    pending.reduce(nil) { newest, candidate in
        guard let newest, newest.createdAt >= candidate.createdAt else { return candidate }
        return newest
    }
}

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// One row above the home section: a request is waiting, tap to configure
/// and approve it. Several waiting requests share the row; it opens the
/// newest.
@available(iOS 17.0, *)
struct AccessPendingRequestBanner: View {
    let offer: AccessPendingRequestBannerOffer
    let onReview: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        PendingRequestBanner(
            symbol: "person.badge.key.fill",
            title: "Access request waiting",
            detail: offer.detail,
            actionTitle: AccessPendingRequestBannerOffer.actionTitle,
            reviewLabel: "Access request waiting from \(offer.detail)",
            reviewHint: "Opens the request to configure and approve it",
            dismissLabel: "Dismiss access request",
            onReview: onReview,
            onDismiss: onDismiss
        )
    }
}

#if DEBUG
@available(iOS 17.0, *)
private func previewOffer(_ requests: [AccessPendingRequest]) -> AccessPendingRequestBannerOffer {
    AccessPendingRequestBannerOffer(
        newest: accessNewestPendingRequest(requests) ?? PreviewMocks.accessPendingRequests[0],
        count: requests.count
    )
}

#Preview("One request waiting") {
    AccessPendingRequestBanner(
        offer: previewOffer([PreviewMocks.accessPendingRequests[0]]),
        onReview: {},
        onDismiss: {}
    )
}

#Preview("Several waiting · dark") {
    AccessPendingRequestBanner(
        offer: previewOffer(PreviewMocks.accessPendingRequests),
        onReview: {},
        onDismiss: {}
    )
    .preferredColorScheme(.dark)
}

#Preview("Long client name") {
    AccessPendingRequestBanner(
        offer: previewOffer([PreviewMocks.accessPendingRequests[1]]),
        onReview: {},
        onDismiss: {}
    )
}

#Preview("Narrow screen") {
    AccessPendingRequestBanner(
        offer: previewOffer(PreviewMocks.accessPendingRequests),
        onReview: {},
        onDismiss: {}
    )
    .frame(width: 320)
}

#Preview("Large type") {
    AccessPendingRequestBanner(
        offer: previewOffer(PreviewMocks.accessPendingRequests),
        onReview: {},
        onDismiss: {}
    )
    .environment(\.dynamicTypeSize, .accessibility2)
}
#endif

#endif
