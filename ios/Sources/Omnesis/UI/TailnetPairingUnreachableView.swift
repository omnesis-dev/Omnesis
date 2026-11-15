// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
#endif

/// The words and links of the pairing state for a gateway address on the
/// owner's Tailscale network that this phone could not reach.
public enum TailnetPairingPresentation {
    public static let title = "Connect to Tailscale"
    public static let openTailscale = "Open Tailscale"
    public static let tryAgain = "Try again"
    /// Tailscale's App Store page, which reads "Open" when the app is
    /// installed. The page works either way, so the app never asks iOS
    /// whether Tailscale is installed (that would need its URL scheme listed
    /// in `LSApplicationQueriesSchemes`).
    public static let appStoreURL = URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!
}

/// The pairing a "Try again" repeats: the scanned payload, as it was confirmed.
struct TailnetPairingRetry: Identifiable {
    let id = UUID()
    let payload: PairingPayload
    /// What a retry failed with when it was not the Tailscale address again.
    var retryError: String?

    var host: String? {
        let address = switch payload {
        case .v4(let v4): v4.gatewayUrl
        case .v3(let v3): v3.gatewayUrl
        case .v2(let v2): v2.gatewayUrl
        case .v1(let v1): v1.url
        }
        return URL(string: address)?.host()
    }
}

#if canImport(SwiftUI) && canImport(UIKit)
/// Shown in place of the generic pairing error when the QR code marks its
/// gateway URL as a Tailscale address and the phone could not reach it.
@available(iOS 17.0, *)
struct TailnetPairingUnreachableView: View {
    /// The gateway host the QR code names.
    let host: String?
    let isPairing: Bool
    /// A different failure from the last retry, shown under the explanation.
    let retryError: String?
    let onOpenTailscale: () -> Void
    let onTryAgain: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    Image(systemName: "network.slash")
                        .font(.system(size: 40, weight: .regular))
                        .foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)

                    Text(TailnetPairingPresentation.title)
                        .font(.title2.bold())
                        .foregroundStyle(Theme.textPrimary)

                    Text(PairingErrorMessage.tailnetUnreachable)
                        .font(.body)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("pairing.tailnet.explanation")

                    if let host {
                        Text(host)
                            .font(Theme.monospace(size: 13))
                            .foregroundStyle(Theme.textMuted)
                            .textSelection(.enabled)
                            .lineLimit(2)
                    }

                    if let retryError {
                        Text(retryError)
                            .font(.callout)
                            .foregroundStyle(Theme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("pairing.tailnet.retryError")
                    }

                    actions
                        .padding(.top, Theme.Spacing.sm)
                }
                .padding(Theme.Spacing.lg)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(isPairing)
                }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        }
        .presentationBackground(Theme.bgPrimary)
        .interactiveDismissDisabled(isPairing)
    }

    private var actions: some View {
        VStack(spacing: Theme.Spacing.md) {
            Button(action: onOpenTailscale) {
                Text(TailnetPairingPresentation.openTailscale)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.md)
                    .background(Theme.accent)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            }
            .accessibilityIdentifier("pairing.tailnet.openTailscale")

            Button(action: onTryAgain) {
                HStack(spacing: Theme.Spacing.sm) {
                    if isPairing { ProgressView().controlSize(.small) }
                    Text(isPairing ? "Pairing…" : TailnetPairingPresentation.tryAgain)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Spacing.md)
                .background(Theme.bgTertiary)
                .foregroundStyle(Theme.textPrimary)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            }
            .disabled(isPairing)
            .accessibilityIdentifier("pairing.tailnet.tryAgain")
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Tailscale address unreachable") {
    TailnetPairingUnreachableView(
        host: PreviewMocks.tailnetGatewayHost,
        isPairing: false,
        retryError: nil,
        onOpenTailscale: {},
        onTryAgain: {},
        onCancel: {}
    )
}

@available(iOS 17.0, *)
#Preview("Tailscale address unreachable — retrying, dark") {
    TailnetPairingUnreachableView(
        host: PreviewMocks.tailnetGatewayHost,
        isPairing: true,
        retryError: nil,
        onOpenTailscale: {},
        onTryAgain: {},
        onCancel: {}
    )
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Tailscale address unreachable — retry failed differently") {
    TailnetPairingUnreachableView(
        host: PreviewMocks.tailnetGatewayHost,
        isPairing: false,
        retryError: PairingErrorMessage.usedOrExpiredCode,
        onOpenTailscale: {},
        onTryAgain: {},
        onCancel: {}
    )
}

@available(iOS 17.0, *)
#Preview("Tailscale address unreachable — large text") {
    TailnetPairingUnreachableView(
        host: PreviewMocks.tailnetGatewayHost,
        isPairing: false,
        retryError: nil,
        onOpenTailscale: {},
        onTryAgain: {},
        onCancel: {}
    )
    .dynamicTypeSize(.accessibility2)
}
#endif
#endif
