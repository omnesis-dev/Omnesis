// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The last section of Settings: every version this build can state about
/// itself, alongside the policy the app ships under.
///
/// The product version says how old the build is relative to its gateway, the
/// build number is all that separates two builds of one version, and the wire
/// protocol is the number a gateway either speaks or refuses — the reason a
/// paired phone can stop connecting entirely. The three values are selectable,
/// because the usual reason to read them is to quote them somewhere else; the
/// policy row below them is not, so the selection gesture never competes with
/// the tap that opens it.
///
/// Its own view so a snapshot can render it: at the foot of a screen this long
/// it never reaches the captured canvas.
@available(iOS 17.0, *)
struct AboutSection: View {
    /// The one policy URL the app links to.
    static var privacyPolicyURL: URL {
        guard let url = URL(string: "https://omnesis.dev/mobile-privacy-policy") else {
            preconditionFailure("Invalid privacy policy URL")
        }
        return url
    }

    let versions: AppVersionInfo

    var body: some View {
        Section("About") {
            Group {
                LabeledContent("Version", value: versions.version)
                LabeledContent("Build", value: versions.build)
                LabeledContent("Wire protocol", value: String(versions.wireProtocol))
            }
            .textSelection(.enabled)
            Link(destination: Self.privacyPolicyURL) {
                Label("Privacy Policy", systemImage: "hand.raised")
            }
            .accessibilityHint("Opens the Omnesis mobile privacy policy in your browser")
        }
        .listRowBackground(Theme.bgSecondary)
    }
}

#if DEBUG
@available(iOS 17.0, *)
private func aboutSectionPreview(_ versions: AppVersionInfo) -> some View {
    Form { AboutSection(versions: versions) }
        .scrollContentBackground(.hidden)
        .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("Settings — About") {
    aboutSectionPreview(PreviewMocks.appVersionInfo)
}

// What a build whose bundle declares no version renders as — the state an
// operator sees if a build is assembled without its version fields.
@available(iOS 17.0, *)
#Preview("Settings — About, version unknown") {
    aboutSectionPreview(PreviewMocks.appVersionInfoUnknown)
}
#endif
#endif
