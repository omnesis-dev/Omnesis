// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The code two devices compare during pairing, such as `465 774`: large and monospaced, on
/// one line. It shows the string it is given and assumes nothing about its length or grouping;
/// one that cannot fit a line shrinks, then wraps.
@available(iOS 17.0, *)
struct PairingCodeText: View {
    let code: String

    var body: some View {
        ViewThatFits(in: .horizontal) {
            text.lineLimit(1).fixedSize()
            // A code too long for one line takes two, shrinking before it would break mid-group.
            text.lineLimit(2).minimumScaleFactor(0.5).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Verification code \(Self.spoken(code))")
        .accessibilityIdentifier("pairing.code")
    }

    private var text: some View {
        Text(code)
            .font(.system(.title, design: .monospaced).weight(.semibold))
            .foregroundStyle(Theme.textPrimary)
            .textSelection(.enabled)
    }

    /// Read character by character, so VoiceOver never turns a group into a word or a number.
    static func spoken(_ code: String) -> String {
        code.filter { $0.isLetter || $0.isNumber }.map(String.init).joined(separator: " ")
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Pairing code — lengths") {
    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
        PairingCodeText(code: "465 774")
        PairingCodeText(code: "003 579")
    }
    .padding()
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("Pairing code — large text") {
    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
        PairingCodeText(code: "465 774")
        PairingCodeText(code: "003 579")
    }
    .padding()
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.bgPrimary)
    .dynamicTypeSize(.accessibility2)
}
#endif
#endif
