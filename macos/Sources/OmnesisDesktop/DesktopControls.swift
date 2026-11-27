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
        let destructive = configuration.role == .destructive
        configuration.label.font(DesktopDesignTokens.Typography.button)
            .padding(.horizontal, iconOnly ? 0 : DesktopDesignTokens.Control.horizontalPadding)
            .padding(.vertical, iconOnly ? 0 : 6)
            .frame(
                width: iconOnly ? DesktopDesignTokens.Control.iconTarget : nil,
                height: iconOnly ? DesktopDesignTokens.Control.iconTarget : nil
            )
            .frame(minHeight: iconOnly ? nil : DesktopDesignTokens.Control.height)
            .foregroundStyle(foreground(destructive: destructive))
            .background(
                background(pressed: configuration.isPressed, destructive: destructive),
                in: RoundedRectangle(cornerRadius: DesktopDesignTokens.Radius.control)
            )
            .overlay(RoundedRectangle(cornerRadius: DesktopDesignTokens.Radius.control).strokeBorder(
                boundary,
                lineWidth: contrast == .increased ? 2 : 1
            ))
            .overlay(RoundedRectangle(cornerRadius: DesktopDesignTokens.Radius.medium).strokeBorder(
                enabled && focused ? DesktopTheme.focusRing : Color.clear,
                lineWidth: 2
            ).padding(-3))
            .onHover { hovered = $0 }
    }

    private var boundary: Color {
        if contrast == .increased { return DesktopTheme.strongBorder }
        return !primary && !iconOnly ? DesktopTheme.border : .clear
    }

    private func foreground(destructive: Bool) -> Color {
        if !enabled { return DesktopTheme.muted }
        if primary { return destructive ? DesktopTheme.dangerInk : DesktopTheme.primaryInk }
        if destructive { return DesktopTheme.danger }
        return DesktopTheme.ink
    }

    private func background(pressed: Bool, destructive: Bool) -> Color {
        if !enabled { return primary ? DesktopTheme.disabled : .clear }
        if primary {
            if destructive { return pressed ? DesktopTheme.dangerPressed : hovered ? DesktopTheme.dangerHover : DesktopTheme.danger }
            return pressed ? DesktopTheme.primaryPressed : hovered ? DesktopTheme.primaryHover : DesktopTheme.primary
        }
        if destructive, pressed || hovered { return DesktopTheme.dangerSurface }
        if pressed { return DesktopTheme.pressed }
        if hovered { return DesktopTheme.hover }
        return iconOnly ? .clear : DesktopTheme.surface
    }
}
