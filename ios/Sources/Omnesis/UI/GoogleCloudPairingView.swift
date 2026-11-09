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
                gatewayApproved: model.gatewayApproved,
                onSignIn: { model.start(configuration: configuration) },
                onPair: {
                    model.confirmComparison()
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
    let phase: GoogleCloudPairingCoordinator.Phase
    let verificationCode: String?
    let gatewayHost: String?
    let error: Error?
    var gatewayApproved = false
    let onSignIn: () -> Void
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
                        Text(PairingApprovalPresentation.waitingDevice)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                        PairingCodeText(code: verificationCode)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: 14))
                }
                if phase == .ready || (phase == .comparing && gatewayApproved) {
                    Button("Codes match, pair this device", action: onPair).buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("pairing.google.pair")
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
                    Label("Gateway approved. Confirm the codes match.", systemImage: "checkmark.shield")
                case .pairing:
                    Label("Pairing…", systemImage: "lock")
                case .failed:
                    GatewayErrorView(context: "pair this device", error: GatewayErrorView.signInError(error), onRetry: onSignIn)
                        .frame(minHeight: GatewayErrorView.minScrollHeight)
                }
            }.padding(24).frame(maxWidth: 520, alignment: .leading).frame(maxWidth: .infinity)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
    }
}

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
