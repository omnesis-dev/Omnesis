// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The first pairing step: the three ways to pair, in one list. Signing in opens
/// `AccountSignInChoiceView`, where the person picks Google or a passkey.
@available(iOS 17.0, *)
struct PairingAccountEntryView: View {
    static let signInTitle = "Sign in with cloud account"
    /// One line for all three ways, so none of them reads as the exception.
    static let detail = "Choose how to connect this phone to your gateway."

    let onSignIn: () -> Void
    let onScan: () -> Void
    let onManual: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text(Self.detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 0) {
                    row("Scan the gateway's QR code", symbol: "qrcode.viewfinder", action: onScan)
                        .accessibilityIdentifier("pairing.entry.scan")
                    Divider().padding(.leading, 58)
                    row("Enter code manually", symbol: "keyboard", action: onManual)
                        .accessibilityIdentifier("pairing.entry.manual")
                    Divider().padding(.leading, 58)
                    row(Self.signInTitle, symbol: "person.crop.circle", action: onSignIn)
                        .accessibilityIdentifier("pairing.entry.cloudAccount")
                }
                .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
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

/// The second step of signing in: Google or a passkey. A sign-in that ended without pairing
/// comes back here with what happened under the buttons.
@available(iOS 17.0, *)
struct AccountSignInChoiceView: View {
    static let title = "Cloud account"

    let googleAvailable: Bool
    /// An explanation that is not a failure, such as a passkey prompt that found no passkey.
    var notice: String?
    /// Why the last sign-in failed.
    var failure: String?
    let onGoogle: () -> Void
    let onPasskey: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text("Choose how to sign in.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if googleAvailable {
                    GoogleSignInButton(fillsWidth: true, action: onGoogle)
                        .accessibilityIdentifier("pairing.account.google")
                }
                PasskeySignInButton(fillsWidth: true, action: onPasskey)
                    .accessibilityIdentifier("pairing.account.passkey")
                if let notice {
                    message(notice, symbol: "info.circle", tint: Theme.textSecondary)
                        .accessibilityIdentifier("pairing.account.notice")
                } else if let failure {
                    message(failure, symbol: "exclamationmark.triangle.fill", tint: .red)
                        .accessibilityIdentifier("pairing.account.error")
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
}

#if DEBUG
@available(iOS 17.0, *)
private func pairingEntryPreview() -> some View {
    NavigationStack {
        PairingAccountEntryView(onSignIn: {}, onScan: {}, onManual: {})
            .navigationTitle("Pair with your gateway")
            .navigationBarTitleDisplayMode(.inline)
    }
}

@available(iOS 17.0, *)
private func signInChoicePreview(google: Bool = true, notice: String? = nil, failure: String? = nil) -> some View {
    NavigationStack {
        AccountSignInChoiceView(googleAvailable: google, notice: notice, failure: failure, onGoogle: {}, onPasskey: {})
            .navigationTitle(AccountSignInChoiceView.title)
            .navigationBarTitleDisplayMode(.inline)
    }
}

@available(iOS 17.0, *)
#Preview("Pairing entry") { pairingEntryPreview() }
@available(iOS 17.0, *)
#Preview("Pairing entry — dark") { pairingEntryPreview().preferredColorScheme(.dark) }
@available(iOS 17.0, *)
#Preview("Pairing entry — large text") { pairingEntryPreview().dynamicTypeSize(.accessibility2) }
@available(iOS 17.0, *)
#Preview("Sign-in choice") { signInChoicePreview() }
@available(iOS 17.0, *)
#Preview("Sign-in choice — passkey only, dark") { signInChoicePreview(google: false).preferredColorScheme(.dark) }
@available(iOS 17.0, *)
#Preview("Sign-in choice — no passkey on this iPhone") {
    signInChoicePreview(notice: AccountPairingError.noPasskey.signInNotice).preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Sign-in choice — sign-in failed") {
    signInChoicePreview(failure: accountPairingErrorMessage(AccountPairingError.expired))
}
#endif
#endif
