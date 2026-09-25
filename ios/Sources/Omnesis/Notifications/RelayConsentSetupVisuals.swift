// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

extension RelayConsentSetupStep: PhoneSetupStepVisuals {
    func introductionContent() -> AnyView? {
        AnyView(RelayConsentSetupContent(host: host))
    }

    func introductionActions(coordinator: PhoneSetupCoordinator) -> AnyView? {
        AnyView(RelayConsentSetupActions(host: host, coordinator: coordinator))
    }
}

/// The relay consent page's content: the same explanation and disclosure the
/// standalone consent sheet shows, in setup's style.
struct RelayConsentSetupContent: View {
    let host: any NotificationsSetupHost

    var body: some View {
        if let request = host.relayPushConsentRequest {
            RelayPushConsentContent(
                appId: request.appId,
                style: .setup,
                accent: PhoneSetupTint(hex: RelayConsentSetupStep.copy.tint).ink
            )
            .padding(.top, 20)
        }
    }
}

/// Allow and Not now, which record the answer and move on to Finish.
struct RelayConsentSetupActions: View {
    let host: any NotificationsSetupHost
    let coordinator: PhoneSetupCoordinator

    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 10) {
            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(PhoneSetupPalette.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let request = host.relayPushConsentRequest {
                Button {
                    Task { await allow(request) }
                } label: {
                    if isBusy {
                        PhoneSetupBusyLabel(text: RelayPushConsentCopy.allowing)
                    } else {
                        Text(RelayPushConsentCopy.allow)
                    }
                }
                .buttonStyle(PhoneSetupPrimaryButtonStyle())
                .allowsHitTesting(!isBusy)
                Button(RelayPushConsentCopy.notNow) {
                    Task { await notNow(request) }
                }
                .buttonStyle(PhoneSetupTextButtonStyle())
                .disabled(isBusy)
            } else {
                // The request went away before the user answered it here.
                Button(coordinator.flow.isOnLastStep ? "Finish" : "Next") { coordinator.next() }
                    .buttonStyle(PhoneSetupPrimaryButtonStyle())
            }
        }
    }

    private var isBusy: Bool {
        coordinator.busyStepId == RelayConsentSetupStep.stepId
    }

    private func allow(_ request: RelayPushConsentRequest) async {
        errorMessage = nil
        do {
            try await coordinator.answerCurrentStep(outcome: .on) {
                try await host.allowRelayPush(request)
            }
        } catch {
            errorMessage = RelayConsentSaveMessage.message(for: error)
        }
    }

    private func notNow(_ request: RelayPushConsentRequest) async {
        try? await coordinator.answerCurrentStep(outcome: .notAllowed) {
            host.dismissRelayPushConsent(request)
        }
    }
}

#if DEBUG
#Preview("Relay consent — setup step") {
    let host = PhoneSetupPreviewHost()
    host.notificationPermission = .authorized
    host.relayPushConsentRequest = PhoneSetupPreview.relayConsentRequest
    return PhoneSetupPreview.view(
        host: host,
        screen: .step(index: 1),
        selection: [NotificationsSetupStep.stepId, RelayConsentSetupStep.stepId]
    )
}

#Preview("Relay consent — answered not now") {
    let host = PhoneSetupPreviewHost()
    host.notificationPermission = .authorized
    return PhoneSetupPreview.view(
        host: host,
        screen: .step(index: 1),
        selection: [NotificationsSetupStep.stepId, RelayConsentSetupStep.stepId],
        outcomes: [RelayConsentSetupStep.stepId: .notAllowed]
    )
}
#endif
#endif
