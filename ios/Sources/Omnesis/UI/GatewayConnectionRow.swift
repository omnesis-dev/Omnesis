// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Live device-socket state for Settings. It flips as soon as the socket does,
/// so it says more than an HTTP probe on appear would.
@available(iOS 17.0, *)
struct GatewayConnectionRow: View {
    let state: DeviceSocket.ConnectionState
    var path: GatewayConnectionPath?
    var cloudRelayEnabled = CloudRelayFeature.enabled

    var body: some View {
        let status = GatewayConnectionStatus(state)
        VStack(alignment: .leading, spacing: 6) {
            if cloudRelayEnabled {
                HStack(alignment: .top) {
                    heading(status)
                    Spacer()
                    if let indicator = GatewayConnectionStatus.pathIndicator(state: state, selected: path) {
                        GatewayConnectionPill(path: indicator)
                    }
                }
            } else {
                heading(status)
            }
            if let explanation = status.explanation {
                Text(explanation)
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let diagnostic = status.diagnostic {
                Text(diagnostic)
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func heading(_ status: GatewayConnectionStatus) -> some View {
        switch status.tone {
        case .progress:
            HStack {
                ProgressView().controlSize(.small)
                Text(status.title).foregroundStyle(.secondary)
            }
        case .success:
            Label(status.title, systemImage: "checkmark.circle.fill")
                .foregroundStyle(Theme.success)
        case .waiting:
            Label(status.title, systemImage: "wifi.slash")
                .foregroundStyle(.secondary)
        case .warning:
            Label(status.title, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.warning)
        }
    }
}

#if DEBUG
/// Every state the row can show, for previews and snapshots.
@available(iOS 17.0, *)
enum GatewayConnectionRowPreviewStates {
    static let all: [(name: String, state: DeviceSocket.ConnectionState)] = [
        ("Connecting", .connecting),
        ("Connected", .connected(deviceId: "d", deviceName: "iPhone", scopes: [])),
        ("Offline", .reconnecting(.init(
            network: .unavailable,
            lastError: "The Internet connection appears to be offline.",
            failedAttemptsOnNetwork: 0
        ))),
        ("Retrying", .reconnecting(.init(
            network: .available,
            lastError: "Could not connect to the server.",
            failedAttemptsOnNetwork: 1
        ))),
        ("Retrying for a while", .reconnecting(.init(
            network: .available,
            lastError: "The request timed out.",
            failedAttemptsOnNetwork: GatewayConnectionStatus.sustainedFailureAttempts
        ))),
        ("Authentication", .failed(.init(
            kind: .authentication,
            detail: "The gateway answered with status 401."
        ))),
        ("Certificate", .failed(.init(
            kind: .certificate,
            detail: "An SSL error has occurred and a secure connection to the server cannot be made."
        ))),
        ("Incompatible", .failed(.init(
            kind: .incompatible,
            detail: "client protocol 1 != gateway 2"
        ))),
    ]
}

@available(iOS 17.0, *)
struct GatewayConnectionRowGallery: View {
    var body: some View {
        List(GatewayConnectionRowPreviewStates.all, id: \.name) { entry in
            GatewayConnectionRow(state: entry.state)
        }
    }
}

@available(iOS 17.0, *)
#Preview("Connection row — all states") {
    GatewayConnectionRowGallery()
}

@available(iOS 17.0, *)
#Preview("Connection row — all states, light") {
    GatewayConnectionRowGallery()
        .preferredColorScheme(.light)
}
#endif

#endif
