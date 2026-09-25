// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The relay consent explanation and what the relay receives, shared by the
/// standalone consent sheet and phone setup's relay consent step so both say
/// and show exactly the same thing.
@available(iOS 17.0, *)
struct RelayPushConsentContent: View {
    /// Where the content sits: the standalone consent sheet, or a phone setup
    /// page, which uses setup's palette, type and cards.
    enum Style {
        case sheet
        case setup
    }

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let appId: String
    var style = Style.sheet
    var accent: Color = Theme.accent

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            header
            disclosure
        }
    }

    private var textPrimary: Color {
        style == .setup ? PhoneSetupPalette.textPrimary : Theme.textPrimary
    }

    private var textSecondary: Color {
        style == .setup ? PhoneSetupPalette.textSecondary : Theme.textSecondary
    }

    private var divider: Color {
        style == .setup ? PhoneSetupPalette.cardBorder : Theme.border
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "bell.badge.fill")
                .font(.system(size: 52))
                .foregroundStyle(accent)
            switch style {
            case .sheet:
                Text(RelayPushConsentCopy.title)
                    .font(.title2.bold())
                    .foregroundStyle(Theme.textPrimary)
                Text(RelayPushConsentCopy.explanation)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
            case .setup:
                Text(RelayPushConsentCopy.title)
                    .phoneSetupTitle()
                Text(RelayPushConsentCopy.explanation)
                    .phoneSetupBody()
            }
        }
    }

    @ViewBuilder
    private var disclosure: some View {
        switch style {
        case .sheet:
            OmnesisCard { disclosureRows }
        case .setup:
            disclosureRows
                .frame(maxWidth: .infinity, alignment: .leading)
                .phoneSetupCard()
        }
    }

    private var disclosureRows: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            disclosureRow(
                icon: "iphone.gen3",
                title: "During enrollment",
                detail: "The relay receives iOS, the APNs environment, this device’s push token, and this app ID:"
            )
            ScrollView(.horizontal, showsIndicators: false) {
                Text(appId)
                    .font(.footnote.monospaced())
                    .foregroundStyle(textPrimary)
                    .textSelection(.enabled)
                    .fixedSize()
            }
            .padding(.leading, dynamicTypeSize.isAccessibilitySize ? 0 : 40)
            Divider().background(divider)
            disclosureRow(
                icon: "arrow.up.forward.app",
                title: "After enrollment",
                detail: "Your gateway sends an authenticated request with an empty body when it needs to wake this phone."
            )
            Divider().background(divider)
            disclosureRow(
                icon: "hand.raised.fill",
                title: RelayPushConsentCopy.neverReceivesTitle,
                detail: RelayPushConsentCopy.neverReceivesDetail
            )
        }
    }

    @ViewBuilder
    private func disclosureRow(icon: String, title: String, detail: String) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                disclosureIcon(icon)
                disclosureText(title: title, detail: detail)
            }
        } else {
            HStack(alignment: .top, spacing: 12) {
                disclosureIcon(icon)
                disclosureText(title: title, detail: detail)
            }
        }
    }

    private func disclosureIcon(_ icon: String) -> some View {
        Image(systemName: icon)
            .font(.title3)
            .foregroundStyle(accent)
            .frame(width: 28, alignment: .leading)
    }

    private func disclosureText(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.headline)
                .foregroundStyle(textPrimary)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(textSecondary)
        }
    }
}

/// Device-scoped authorization for the content-blind push relay. Enrollment
/// remains separate: the app asks the gateway for a fresh plan after consent,
/// and only a relay plan permits the carrier token to leave the phone.
@available(iOS 17.0, *)
struct RelayPushConsentSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var isWorking: Bool
    @State private var errorMessage: String?

    let appId: String
    let onAllow: @MainActor () async throws -> Void
    let onNotNow: @MainActor () -> Void

    init(
        appId: String,
        initialWorking: Bool = false,
        initialErrorMessage: String? = nil,
        onAllow: @escaping @MainActor () async throws -> Void,
        onNotNow: @escaping @MainActor () -> Void
    ) {
        self.appId = appId
        _isWorking = State(initialValue: initialWorking)
        _errorMessage = State(initialValue: initialErrorMessage)
        self.onAllow = onAllow
        self.onNotNow = onNotNow
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    RelayPushConsentContent(appId: appId)
                    actions
                }
                .padding(Theme.Spacing.lg)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Relay notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(RelayPushConsentCopy.notNow) { decline() }
                        .disabled(isWorking)
                }
            }
        }
        .interactiveDismissDisabled(isWorking)
        .omnesisColorScheme()
    }

    private var actions: some View {
        VStack(spacing: Theme.Spacing.sm) {
            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button {
                Task { await allow() }
            } label: {
                Group {
                    if isWorking {
                        ProgressView()
                            .accessibilityLabel("Saving relay notification permission")
                    } else {
                        Text(RelayPushConsentCopy.allow).font(.headline)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(Theme.accent)
            .disabled(isWorking)
        }
    }

    @MainActor
    private func allow() async {
        isWorking = true
        errorMessage = nil
        do {
            try await onAllow()
            dismiss()
        } catch {
            errorMessage = RelayConsentSaveMessage.message(for: error)
            isWorking = false
        }
    }

    @MainActor
    private func decline() {
        onNotNow()
        dismiss()
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Relay push consent") {
    RelayPushConsentSheet(appId: PreviewMocks.relayPushAppId, onAllow: {}, onNotNow: {})
}

@available(iOS 17.0, *)
#Preview("Relay push consent — saving") {
    RelayPushConsentSheet(
        appId: PreviewMocks.relayPushAppId,
        initialWorking: true,
        onAllow: {},
        onNotNow: {}
    )
}

@available(iOS 17.0, *)
#Preview("Relay push consent — error") {
    RelayPushConsentSheet(
        appId: PreviewMocks.relayPushAppId,
        initialErrorMessage: PreviewMocks.relayPushConsentError,
        onAllow: {},
        onNotNow: {}
    )
}

@available(iOS 17.0, *)
#Preview("Relay push consent — re-pair app") {
    RelayPushConsentSheet(
        appId: PreviewMocks.relayPushAppId,
        initialErrorMessage: RelayConsentSaveMessage.message(
            for: PushRegistrationError.serverError(
                status: 400,
                body: "{\"error\":\"refused\",\"code\":\"BAD_REQUEST\",\"detail\":{\"reason\":\"identity-mismatch\"}}"
            )
        ),
        onAllow: {},
        onNotNow: {}
    )
}

@available(iOS 17.0, *)
#Preview("Relay push consent — re-pair phone") {
    RelayPushConsentSheet(
        appId: PreviewMocks.relayPushAppId,
        initialErrorMessage: RelayConsentSaveMessage.message(
            for: PushRegistrationError.serverError(status: 403, body: "")
        ),
        onAllow: {},
        onNotNow: {}
    )
}

@available(iOS 17.0, *)
#Preview("Relay push consent — Accessibility") {
    RelayPushConsentSheet(appId: PreviewMocks.relayPushAppId, onAllow: {}, onNotNow: {})
        .environment(\.dynamicTypeSize, .accessibility3)
}
#endif
#endif
