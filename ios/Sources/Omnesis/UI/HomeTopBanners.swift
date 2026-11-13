// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// What sits above the home section: a waiting access request first, then devices
/// waiting to pair, then the permission and notification problems. Each is one row in
/// the section's top inset, so none of them covers the section.
@available(iOS 17.0, *)
struct HomeTopBanners: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    /// Which waiting access requests the banner was dismissed for.
    @State private var accessBannerState = AccessPendingRequestBannerState()
    /// Which waiting pairing requests the banner was dismissed for.
    @State private var pairingBannerState = PairingRequestBannerState()
    private let pairingRequests = PendingPairingRequests.shared
    /// Opens the review sheet on a request the access banner named.
    let onReviewAccess: (AccessPendingRequest) -> Void
    let onOpenSettings: (SettingsDestination) -> Void

    /// What restarts the pairing-request reads: the app coming to the front, a different
    /// pairing or scopes, and a notification or decision asking for a fresh read.
    private struct PairingWatch: Equatable {
        let active: Bool
        let eligible: Bool
        let deviceId: String?
        let nudge: Int
    }

    private var nowMillis: Double {
        Date().timeIntervalSince1970 * 1000
    }

    private var canListPairingRequests: Bool {
        PendingPairingRequests.eligible(cloudRelayEnabled: CloudRelayFeature.enabled, scopes: store.pairing?.scopes)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let offer = accessBannerState.offer(from: store.pendingAccessRequests, nowMillis: Int64(nowMillis)) {
                AccessPendingRequestBanner(
                    offer: offer,
                    onReview: { onReviewAccess(offer.newest) },
                    onDismiss: { accessBannerState.dismiss(store.pendingAccessRequests, nowMillis: Int64(nowMillis)) }
                )
            }
            if let offer = pairingBannerState.offer(from: pairingRequests.requests, nowMillis: nowMillis) {
                PairingRequestBanner(
                    offer: offer,
                    onReview: {
                        pairingRequests.requestOpen()
                        onOpenSettings(.devices)
                    },
                    onDismiss: { pairingBannerState.dismiss(pairingRequests.requests, nowMillis: nowMillis) }
                )
            }
            let showNotificationWarning = NotificationWarningDismissal.shouldShowWarning(
                health: store.pushDeliveryHealth,
                dismissed: store.notificationWarningDismissed
            )
            // Gateway push setup is explained in Settings → Notifications, not here:
            // it asks whoever runs the gateway to act, and a banner over every screen
            // hides the controls beneath it.
            if !store.degradedSourcePermissions.isEmpty || showNotificationWarning {
                AppAttentionBanner(
                    problems: store.degradedSourcePermissions,
                    notificationWarning: showNotificationWarning ? store.pushDeliveryHealth.warning : nil,
                    onOpenPermissions: { onOpenSettings(.permissions(sourceId: nil)) },
                    onOpenNotificationSettings: {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    },
                    onDismissNotification: showNotificationWarning ? { store.dismissNotificationWarning() } : nil
                )
            }
        }
        .task(id: PairingWatch(
            active: scenePhase == .active,
            eligible: canListPairingRequests,
            deviceId: store.pairing?.deviceId,
            nudge: pairingRequests.refreshRequests
        )) { await watchPairingRequests() }
    }

    /// Reads the waiting pairing requests while the app is in front, and again every
    /// `pollInterval`: a request made while this phone was offline for its notification
    /// still reaches the banner. A phone that may not list them asks nothing.
    private func watchPairingRequests() async {
        guard canListPairingRequests else {
            pairingRequests.clear()
            return
        }
        guard scenePhase == .active else { return }
        while !Task.isCancelled {
            await pairingRequests.refresh(client: store.admin)
            do {
                try await Task.sleep(for: PendingPairingRequests.pollInterval)
            } catch {
                return
            }
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
@MainActor
private func homeTopBannersPreview() -> some View {
    PendingPairingRequests.shared.seedForPreview(PreviewMocks.pairingRequestsWithTrust.rows)
    return VStack(spacing: 0) {
        HomeTopBanners(onReviewAccess: { _ in }, onOpenSettings: { _ in })
        Spacer()
    }
    .background(Theme.bgPrimary)
    .environment(AppStore.preview(pendingAccessRequests: [PreviewMocks.accessPendingRequests[0]]))
}

@available(iOS 17.0, *)
#Preview("Home banners — access and pairing requests") {
    homeTopBannersPreview()
}
#endif
#endif
