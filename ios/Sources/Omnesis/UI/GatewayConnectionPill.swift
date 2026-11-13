// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

#if canImport(UIKit)
@available(iOS 17.0, *)
struct GatewayConnectionPill: View {
    let path: GatewayConnectionPath
    private var label: String {
        switch path {
        case .local: "Local"
        case .relay: "Remote"
        case .reconnecting: "Reconnecting"
        }
    }

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Theme.bgSecondary, in: Capsule())
            .accessibilityLabel("Gateway connection: \(label)")
            .accessibilityIdentifier("gateway.connectionPath")
    }
}
#endif
