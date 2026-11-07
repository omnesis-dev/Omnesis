// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

struct AccessPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(enabled ? Color.white : Theme.textSecondary)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(enabled ? Theme.accessPrimary : Color(uiColor: .tertiarySystemFill), in: Capsule())
            .opacity(enabled && configuration.isPressed ? 0.8 : 1)
    }
}

struct AccessInputGroupStyle: GroupBoxStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            configuration.label.font(.headline)
            configuration.content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
    }
}

#if DEBUG
#Preview("Available and unavailable actions") {
    VStack(spacing: 16) {
        Button("Continue") {}.buttonStyle(AccessPrimaryButtonStyle())
        Button("Continue") {}.buttonStyle(AccessPrimaryButtonStyle()).disabled(true)
    }.padding()
}
#endif
#endif
