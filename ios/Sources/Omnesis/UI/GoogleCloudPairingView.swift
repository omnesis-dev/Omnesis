// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct GoogleCloudPairingView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var model: GoogleCloudPairingCoordinator
    let configuration: GoogleCloudPairingConfiguration

    init(configuration: GoogleCloudPairingConfiguration, model: GoogleCloudPairingCoordinator? = nil) {
        self.configuration = configuration
        _model = State(initialValue: model ?? GoogleCloudPairingCoordinator())
    }

    var body: some View {
        NavigationStack {
            GoogleCloudPairingPanel(
                phase: model.phase,
                verificationCode: model.verificationCode,
                gatewayHost: model.gatewayHost,
                error: model.error,
                compared: model.compared,
                onSignIn: { model.start(configuration: configuration) },
                onCompare: { model.confirmComparison() },
                onPair: {
                    Task {
                        await model.complete { raw in
                            let previous = store.pairing?.pairingGeneration
                            await store.pairAsync(raw: raw)
                            return model.acceptsCompletedPairing(store.pairing, previousGeneration: previous)
                        }
                        if model.phase == .idle { dismiss() }
                    }
                }
            )
            .navigationTitle("Find your gateway")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        model.cancel()
                        dismiss()
                    }
                    .disabled(model.phase == .pairing)
                }
            }
        }
        .onDisappear { model.cancel() }
        .interactiveDismissDisabled(model.phase == .pairing)
    }
}

@available(iOS 17.0, *)
struct GoogleCloudPairingPanel: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let phase: GoogleCloudPairingCoordinator.Phase
    let verificationCode: String?
    let gatewayHost: String?
    let error: Error?
    let compared: Bool
    let onSignIn: () -> Void
    let onCompare: () -> Void
    let onPair: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: "lock.shield").font(.system(size: 40)).foregroundStyle(.tint)
                Text("Pair securely with Google").font(.title2.bold())
                Text("Google finds your gateway. Your gateway approves access, "
                    + "and comparing a code makes sure you are connecting to it.")
                    .foregroundStyle(.secondary)
                if let gatewayHost { Text(gatewayHost).font(.footnote.monospaced()).textSelection(.enabled) }
                if let verificationCode {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("COMPARE THIS CODE").font(.caption.bold()).foregroundStyle(.secondary)
                        if dynamicTypeSize.isAccessibilitySize {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(Array(verificationCode.split(separator: "-").enumerated()), id: \.offset) { _, group in
                                    Text(group).font(.title3.monospaced().bold()).fixedSize()
                                }
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(verificationCode)
                        } else {
                            Text(verificationCode)
                                .font(.title3.monospaced().bold())
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text(
                            "On the gateway itself, open its local portal or run omnesis cloud requests. "
                                + "Compare every group. If any differ, cancel."
                        )
                        .font(.callout)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                    if !compared {
                        Button("The codes match on my trusted device", action: onCompare)
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("pairing.google.confirmCode")
                    }
                }
                switch phase {
                case .idle:
                    GoogleSignInButton(action: onSignIn)
                    Text("You can also cancel and pair by QR code. Google sign-in is optional.").font(.footnote).foregroundStyle(.secondary)
                case .signingIn:
                    Label("Complete sign-in in the system browser.", systemImage: "globe")
                case .findingGateway:
                    Label("Finding your gateway…", systemImage: "network")
                case .comparing:
                    Text("Compare the code before continuing.").font(.callout).foregroundStyle(.secondary)
                case .waiting:
                    Label("Waiting for approval on your gateway…", systemImage: "clock")
                case .ready:
                    Label("Code compared and gateway approved.", systemImage: "checkmark.shield")
                    Button("Pair with this gateway", action: onPair).buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("pairing.google.pair")
                case .pairing:
                    Label("Pairing…", systemImage: "lock")
                case .failed:
                    GatewayErrorView(context: "pair this device", error: error, onRetry: onSignIn)
                        .frame(minHeight: GatewayErrorView.minScrollHeight)
                }
            }.padding(24).frame(maxWidth: 520, alignment: .leading).frame(maxWidth: .infinity)
        }
    }
}

/// Uses Google's original color artwork without inheriting the surrounding tint.
@available(iOS 17.0, *)
struct GoogleSignInButton: View {
    var title = "Sign in with Google"
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image("GoogleSignInMark")
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .foregroundStyle(Color(red: 31 / 255, green: 31 / 255, blue: 31 / 255))
            .background(.white, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(red: 116 / 255, green: 119 / 255, blue: 117 / 255)))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }
}

#if DEBUG
#Preview("Google button — light") { GoogleSignInButton {}.padding() }
#Preview("Google button — dark") { GoogleSignInButton {}.padding().preferredColorScheme(.dark) }
#Preview("Google button — large text") { GoogleSignInButton {}.padding().dynamicTypeSize(.accessibility2) }
#Preview("Google pairing — sign-in sheet") {
    GoogleCloudPairingView(configuration: PreviewMocks.googleCloudPairingConfiguration)
        .environment(AppStore.preview())
}

#Preview("Google pairing — optional") {
    NavigationStack { PreviewMocks.googlePairingPanel(.idle) }.navigationTitle("Find your gateway")
}

#Preview("Google pairing — compare") {
    NavigationStack { PreviewMocks.googlePairingPanel(.comparing) }.preferredColorScheme(.dark)
}

#Preview("Google pairing — approved") {
    NavigationStack { PreviewMocks.googlePairingPanel(.ready) }.dynamicTypeSize(.accessibility2)
}

#Preview("Google pairing — failed") {
    NavigationStack { PreviewMocks.googlePairingPanel(.failed) }
}
#endif
#endif
