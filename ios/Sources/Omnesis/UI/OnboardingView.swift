// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// First-launch explainer. Leads directly into the QR pairing screen.
/// During a Re-pair (`store.isRepairing`) we skip the explainer and open
/// the QR scanner immediately — the user has already seen this copy.
@available(iOS 17.0, *)
struct OnboardingView: View {
    @Environment(AppStore.self) private var store
    @State private var showingPairing = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    if store.pairingRecovery != nil {
                        recoveryNotice
                        Spacer(minLength: 24)
                        pairButton
                    } else {
                        bulletList
                        Spacer(minLength: 24)
                        pairButton
                    }
                }
                .padding()
            }
            .navigationTitle("Omnesis")
            .sheet(isPresented: $showingPairing) {
                PairingView(initialGatewayURL: store.pairingRecovery?.gatewayURL)
            }
            .onAppear {
                if store.isRepairing { showingPairing = true }
            }
        }
    }

    private var recoveryNotice: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Pair this device again", systemImage: "iphone.and.arrow.forward")
                .font(.headline)
            Text(
                "An older Omnesis version allowed one pairing to sync through iCloud. "
                    + "That shared credential was removed so each iPhone or iPad gets "
                    + "its own identity. Data on your gateway is unchanged."
            )
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image("OmnesisLogo")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(height: 64)
                .foregroundStyle(AppBuild.isDemo ? Theme.brandLogoDemo : Theme.brandLogo)
                .frame(maxWidth: .infinity, alignment: .center)
            Text("Search your entire digital life.")
                .font(.largeTitle).bold()
            Text(
                "Omnesis indexes your messages, mail, files, and more on your gateway. "
                    + "This app is your window into all of it, "
                    + "and adds data only your phone has, like Apple Health, to the mix."
            )
            .font(.body)
            .foregroundStyle(.secondary)
        }
    }

    private var bulletList: some View {
        VStack(alignment: .leading, spacing: 14) {
            bullet("magnifyingglass", "Search your whole index, right from your phone.")
            bullet("lock.shield.fill", "Your index stays on your gateway. You choose local or cloud inference.")
            bullet("heart.text.square.fill", "Adds data only your phone has, like Apple Health, when you choose to.")
        }
    }

    private func bullet(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(Color.accentColor)
                .frame(width: 28)
            Text(text).font(.body)
            Spacer()
        }
    }

    private var pairButton: some View {
        Button {
            showingPairing = true
        } label: {
            Text(store.pairingRecovery == nil ? "Pair with your gateway" : "Pair this device")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding()
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Onboarding") {
    OnboardingView()
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Onboarding — pairing recovery") {
    OnboardingView()
        .environment(AppStore.preview(
            pairingRecovery: PairingRecovery(
                gatewayURL: URL(string: "https://gateway.example:7600")
            )
        ))
}
#endif
#endif
