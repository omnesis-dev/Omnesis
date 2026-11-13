// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit) && canImport(AuthenticationServices)
import AuthenticationServices
import SwiftUI

/// Shows a relay page in the system's sign-in browser, which keeps the person's
/// Omnesis account session and passkeys between visits.
///
/// These pages never call back into the app: a sign-in ends on the relay's own
/// page and the gateway's status moves on by itself, so the page stays up until
/// the person closes it or `close()` is called.
@MainActor
final class OmnesisAccountSystemBrowser: NSObject, OmnesisAccountBrowsing, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var window: ASPresentationAnchor?
    private var visit: UUID?

    func open(_ url: URL) {
        close()
        guard let anchor = GoogleSystemBrowser.defaultAnchor() else { return }
        let opening = UUID()
        let opened = ASWebAuthenticationSession(url: url, callbackURLScheme: nil) { [weak self] _, _ in
            Task { @MainActor in self?.ended(opening) }
        }
        opened.presentationContextProvider = self
        window = anchor
        visit = opening
        session = opened
        if !opened.start() { ended(opening) }
    }

    func close() {
        session?.cancel()
        session = nil
        window = nil
        visit = nil
    }

    func presentationAnchor(for _: ASWebAuthenticationSession) -> ASPresentationAnchor {
        window ?? ASPresentationAnchor()
    }

    /// The person closed the page. A newer page opened since then is left alone.
    private func ended(_ opening: UUID) {
        guard visit == opening else { return }
        session = nil
        window = nil
        visit = nil
    }
}

extension OmnesisAccountModel {
    /// The model behind Settings, opening relay pages in the system browser.
    static func live() -> OmnesisAccountModel {
        OmnesisAccountModel(browser: OmnesisAccountSystemBrowser())
    }
}

/// The Settings row that opens the Omnesis account screen. It is absent in a build
/// without cloud connectivity and on a gateway that offers no Omnesis account.
@available(iOS 17.0, *)
struct OmnesisAccountSettingsLink: View {
    let model: OmnesisAccountModel

    var body: some View {
        if model.offered {
            NavigationLink(value: SettingsDestination.omnesisAccount) {
                Label("Omnesis account", systemImage: "person.crop.circle")
            }
            .accessibilityIdentifier("settings.omnesisAccount")
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Omnesis account — Settings row") {
    NavigationStack {
        Form {
            Section("Gateway") {
                Label("Configure Devices", systemImage: "laptopcomputer.and.iphone")
                OmnesisAccountSettingsLink(model: OmnesisAccountModel(enabled: true, status: PreviewMocks.cloudRelayConnected))
            }
            .listRowBackground(Theme.bgSecondary)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bgPrimary)
    }
}
#endif
#endif
