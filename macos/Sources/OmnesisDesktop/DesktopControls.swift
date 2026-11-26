// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

struct DesktopButtonStyle: ButtonStyle {
    var primary = false
    var iconOnly = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.isFocused) private var focused
    @Environment(\.desktopContrast) private var contrast
    @State private var hovered = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13, weight: .medium))
            .padding(.horizontal, iconOnly ? 0 : 12)
            .frame(width: iconOnly ? 36 : nil, height: iconOnly ? 36 : 34)
            .foregroundStyle(foreground(destructive: configuration.role == .destructive))
            .background(
                background(pressed: configuration.isPressed, destructive: configuration.role == .destructive),
                in: RoundedRectangle(cornerRadius: 8)
            )
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(
                contrast == .increased ? DesktopTheme.secondary : iconOnly && !primary ? DesktopTheme.border : Color.clear,
                lineWidth: contrast == .increased ? 2 : 1
            ))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? DesktopTheme.primaryHover : Color.clear, lineWidth: 2)
                .padding(-4))
            .onHover { hovered = $0 }
    }

    private func foreground(destructive: Bool) -> Color {
        if !enabled { return DesktopTheme.muted }
        if primary { return DesktopTheme.primaryInk }
        if destructive { return DesktopTheme.danger }
        return iconOnly ? DesktopTheme.ink : DesktopTheme.accent
    }

    private func background(pressed: Bool, destructive: Bool) -> Color {
        if !enabled { return primary ? DesktopTheme.disabled : .clear }
        if primary {
            if destructive { return pressed ? DesktopTheme.dangerPressed : hovered ? DesktopTheme.dangerHover : DesktopTheme.danger }
            return pressed ? DesktopTheme.primaryPressed : hovered ? DesktopTheme.primaryHover : DesktopTheme.primary
        }
        return iconOnly || pressed || hovered ? (destructive ? DesktopTheme.dangerSurface : DesktopTheme.raised) : .clear
    }
}
