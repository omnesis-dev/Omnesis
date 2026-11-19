// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The one shape every sign-in button has: the same rounded rectangle, icon box, type and
/// padding, so two of them stacked are the same height and width. Each keeps its own colours.
@available(iOS 17.0, *)
struct SignInButton<Icon: View>: View {
    static var cornerRadius: CGFloat {
        8
    }

    let title: String
    var fillsWidth = false
    let foreground: Color
    let background: Color
    let border: Color
    let action: () -> Void
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius)
        Button(action: action) {
            HStack(spacing: 12) {
                icon()
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)
                Text(title)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.subheadline.weight(.medium))
            .frame(maxWidth: fillsWidth ? .infinity : nil)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .foregroundStyle(foreground)
            .background(background, in: shape)
            .overlay(shape.strokeBorder(border))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
    }
}

/// Uses Google's original color artwork without inheriting the surrounding tint.
@available(iOS 17.0, *)
struct GoogleSignInButton: View {
    var title = "Sign in with Google"
    var fillsWidth = false
    let action: () -> Void

    var body: some View {
        SignInButton(
            title: title,
            fillsWidth: fillsWidth,
            foreground: Color(red: 31 / 255, green: 31 / 255, blue: 31 / 255),
            background: .white,
            border: Color(red: 116 / 255, green: 119 / 255, blue: 117 / 255),
            action: action
        ) {
            Image("GoogleSignInMark")
                .renderingMode(.original)
                .resizable()
                .scaledToFit()
        }
    }
}

/// The passkey button, in the shape of the Google one beside it and in the app's own colours.
@available(iOS 17.0, *)
struct PasskeySignInButton: View {
    var fillsWidth = false
    let action: () -> Void

    var body: some View {
        SignInButton(
            title: "Sign in with Passkey",
            fillsWidth: fillsWidth,
            foreground: Theme.accent,
            background: Theme.bgSecondary,
            border: Theme.border,
            action: action
        ) {
            Image(systemName: "key.fill")
        }
    }
}

#if DEBUG
#Preview("Google button — light") { GoogleSignInButton {}.padding() }
#Preview("Google button — dark") { GoogleSignInButton {}.padding().preferredColorScheme(.dark) }
#Preview("Google button — large text") { GoogleSignInButton {}.padding().dynamicTypeSize(.accessibility2) }
#Preview("Sign-in buttons — same shape") {
    VStack(spacing: Theme.Spacing.md) {
        GoogleSignInButton(fillsWidth: true) {}
        PasskeySignInButton(fillsWidth: true) {}
        GoogleSignInButton {}
        PasskeySignInButton {}
    }
    .padding()
    .background(Theme.bgPrimary)
}
#endif
#endif
