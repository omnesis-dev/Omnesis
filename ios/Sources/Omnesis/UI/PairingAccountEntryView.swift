// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

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

/// The first pairing step of a build with an Omnesis account: sign in, or pair directly.
@available(iOS 17.0, *)
struct PairingAccountEntryView: View {
    let googleAvailable: Bool
    let passkeysAvailable: Bool
    /// An explanation that is not a failure, such as a passkey prompt that found no passkey.
    var notice: String?
    /// Why the last sign-in failed. Shown under the buttons it belongs to.
    var failure: String?
    let onGoogle: () -> Void
    let onPasskey: () -> Void
    let onScan: () -> Void
    let onManual: () -> Void

    static let accountDetail = "Sign in to your Omnesis account to enroll this device to your gateway. "
        + "Access your gateway from anywhere outside your home network via Omnesis Relay. "
        + "Traffic is encrypted end-to-end and Omnesis Relay cannot see your data."

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                section("Pair using your Omnesis Account", detail: Self.accountDetail) {
                    if googleAvailable {
                        GoogleSignInButton(fillsWidth: true, action: onGoogle)
                            .accessibilityIdentifier("pairing.entry.google")
                    }
                    if passkeysAvailable {
                        PasskeySignInButton(fillsWidth: true, action: onPasskey)
                            .accessibilityIdentifier("pairing.entry.passkey")
                    }
                    if let notice {
                        message(notice, symbol: "info.circle", tint: Theme.textSecondary)
                            .accessibilityIdentifier("pairing.account.notice")
                    } else if let failure {
                        message(failure, symbol: "exclamationmark.triangle.fill", tint: .red)
                            .accessibilityIdentifier("pairing.account.error")
                    }
                }
                section("Pair directly", detail: "Use a pairing code from your gateway. No account needed.") {
                    VStack(spacing: 0) {
                        row("Scan the gateway's QR code", symbol: "qrcode.viewfinder", action: onScan)
                            .accessibilityIdentifier("pairing.entry.scan")
                        Divider().padding(.leading, 58)
                        row("Enter code manually", symbol: "keyboard", action: onManual)
                            .accessibilityIdentifier("pairing.entry.manual")
                    }
                    .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
    }

    private func message(_ text: String, symbol: String, tint: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func section(_ title: String, detail: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text(title)
                    .font(.title3.bold())
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(detail).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            content()
        }
    }

    private func row(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(Theme.accent)
                    .frame(width: 32)
                    .accessibilityHidden(true)
                Text(title)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

#if DEBUG
@available(iOS 17.0, *)
private func pairingAccountEntryPreview(
    google: Bool = true,
    passkeys: Bool = true,
    notice: String? = nil,
    failure: String? = nil
)
    -> some View {
    NavigationStack {
        PairingAccountEntryView(
            googleAvailable: google,
            passkeysAvailable: passkeys,
            notice: notice,
            failure: failure,
            onGoogle: {},
            onPasskey: {},
            onScan: {},
            onManual: {}
        )
        .navigationTitle("Pair with your gateway")
        .navigationBarTitleDisplayMode(.inline)
    }
}

@available(iOS 17.0, *)
#Preview("Pairing entry — Omnesis account") { pairingAccountEntryPreview() }
@available(iOS 17.0, *)
#Preview("Pairing entry — passkey only, dark") { pairingAccountEntryPreview(google: false).preferredColorScheme(.dark) }
@available(iOS 17.0, *)
#Preview("Pairing entry — no passkey on this iPhone") {
    pairingAccountEntryPreview(notice: AccountPairingError.noPasskey.signInNotice).preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Pairing entry — sign-in failed") {
    pairingAccountEntryPreview(failure: accountPairingErrorMessage(AccountPairingError.expired))
}

@available(iOS 17.0, *)
#Preview("Pairing entry — large text") { pairingAccountEntryPreview().dynamicTypeSize(.accessibility2) }

@available(iOS 17.0, *)
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
