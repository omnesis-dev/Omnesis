// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit) && canImport(AVFoundation)
import AVFoundation
import SwiftUI
import UIKit

/// Pairing flow. QR scanner hosted in a `NavigationStack`, with two
/// fall-backs accessed from the toolbar overflow menu:
///   - "Paste JSON" sheet for legacy payloads.
///   - "Manual entry" sheet where the user types gateway URL +
///     pairing code — the V2 exchange flow (POST /devices/pair)
///     runs on submit.
///
/// The QR is expected to encode V2 JSON:
///   `{"v":4,"gatewayUrl":"https://gateway.example.com","pairingCode":"XXXX-YYYY","tls":{"mode":"system"}}`
///
/// Generate one from the desktop:
///   `omnesis devices pair --kind ios` → prints pairingCode
///   On iOS: scan or enter manually.
@available(iOS 17.0, *)
struct PairingView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var scanError: String?
    @State private var showingManualEntry = false
    @State private var manualGatewayUrl = ""
    @State private var manualPairingCode = ""
    @State private var isPairing = false
    @State private var showingPasteJSON = false
    @State private var manualJSON = ""
    @State private var showingGoogleSignIn = false
    @State private var showingScanner = false
    /// Decoded payload waiting for user confirmation. We show a sheet
    /// with host + fingerprint and require an explicit "Pair" tap
    /// before persisting any token — protects against a malicious QR
    /// silently steering the app at a hostile gateway.
    @State private var pendingPayload: PairingPayload?
    private let googleConfiguration: GoogleCloudPairingConfiguration?
    private let accountConfiguration: AccountCloudPairingConfiguration?

    init(
        initialGatewayURL: URL? = nil,
        googleConfiguration: GoogleCloudPairingConfiguration? = .configured(),
        accountConfiguration: AccountCloudPairingConfiguration? = .configured()
    ) {
        _manualGatewayUrl = State(initialValue: initialGatewayURL?.absoluteString ?? "")
        self.googleConfiguration = googleConfiguration
        self.accountConfiguration = accountConfiguration
    }

    var body: some View {
        NavigationStack {
            if let accountConfiguration {
                accountEntry(accountConfiguration)
            } else {
                presentations(scanner(pushed: false))
            }
        }
    }

    /// With an Omnesis account available, pairing opens on the two ways to connect. The camera
    /// starts only once the person picks the QR code.
    private func accountEntry(_ configuration: AccountCloudPairingConfiguration) -> some View {
        presentations(
            AccountCloudPairingView(
                configuration: configuration,
                onScan: { showingScanner = true },
                onManual: { showingManualEntry = true }
            )
            .overlay { pairingProgress }
            .navigationDestination(isPresented: $showingScanner) { scanner(pushed: true) }
        )
    }

    @ViewBuilder
    private var pairingProgress: some View {
        if isPairing {
            Color.black.opacity(0.4).ignoresSafeArea()
            VStack(spacing: 12) {
                ProgressView().controlSize(.large)
                Text("Pairing…").foregroundStyle(.white).font(.headline)
            }
        }
    }

    /// The Google-only sign-in of a build without an Omnesis account configuration.
    private var legacyGoogle: GoogleCloudPairingConfiguration? {
        accountConfiguration == nil ? googleConfiguration : nil
    }

    /// `pushed` is the scanner opened from the account entry. Cancel and the sign-in choices stay on that entry.
    private func scanner(pushed: Bool) -> some View {
        ZStack {
            QRScannerRepresentable(onRead: handleRead, onError: { scanError = $0 })
                .ignoresSafeArea()

            VStack {
                Spacer()
                overlay
                    .padding()
            }

            pairingProgress
        }
        .navigationTitle(pushed ? "Scan the QR code" : "Pair with your gateway")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !pushed {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if legacyGoogle != nil {
                        Button { showingGoogleSignIn = true } label: {
                            Label {
                                Text("Sign in with Google")
                            } icon: {
                                Image("GoogleSignInMark").renderingMode(.original)
                            }
                        }
                        .accessibilityIdentifier("pairing.google.menuSignIn")
                    }
                    Button("Enter code manually") { showingManualEntry = true }
                    Button("Paste JSON") { showingPasteJSON = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityIdentifier("pairing.moreOptions")
            }
        }
    }

    /// The sheets and the alert every pairing step shares, attached once to the root step.
    private func presentations(_ content: some View) -> some View {
        content
            .sheet(isPresented: $showingManualEntry) {
                manualEntrySheet
            }
            .sheet(isPresented: $showingGoogleSignIn) {
                if let configuration = legacyGoogle {
                    GoogleCloudPairingView(configuration: configuration)
                }
            }
            .sheet(isPresented: $showingPasteJSON) {
                pasteJSONSheet
            }
            .sheet(isPresented: Binding(
                get: { pendingPayload != nil },
                set: { if !$0 { pendingPayload = nil } }
            )) {
                if let payload = pendingPayload {
                    PairingConfirmationSheet(
                        payload: payload,
                        isPairing: isPairing,
                        onCancel: { pendingPayload = nil },
                        onConfirm: {
                            let pending = payload
                            pendingPayload = nil
                            Task { await pair(payload: pending) }
                        }
                    )
                }
            }
            .alert("Scan error", isPresented: Binding(
                get: { scanError != nil },
                set: { if !$0 { scanError = nil } }
            )) {
                Button("OK", role: .cancel) { scanError = nil }
            } message: {
                Text(scanError ?? "")
            }
    }

    private var overlay: some View {
        VStack(spacing: 8) {
            Text("On the gateway host, run:")
                .font(.footnote)
            Text("omnesis devices pair --kind ios")
                .font(.footnote.bold().monospaced())
            Text("Then scan the QR code shown in the terminal.")
                .font(.footnote)
            if legacyGoogle != nil {
                GoogleSignInButton { showingGoogleSignIn = true }
                    .accessibilityIdentifier("pairing.google.open")
            }
        }
        .padding()
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    private var manualEntrySheet: some View {
        PairingManualEntryView(
            gatewayURL: $manualGatewayUrl,
            pairingCode: $manualPairingCode,
            isPairing: isPairing,
            onCancel: { showingManualEntry = false },
            onPair: submitManual
        )
    }

    /// Legacy entry point for V1 JSON payloads — kept for users with
    /// pre-rearchitecture QR screenshots.
    private var pasteJSONSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Paste the pairing JSON")
                    .font(.headline)
                TextEditor(text: $manualJSON)
                    .font(.system(.body, design: .monospaced))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.3))
                    )
                    .frame(minHeight: 180)
                    .autocorrectionDisabled(true)
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("pairing.pasteJSON.field")
                Spacer()
            }
            .padding()
            .navigationTitle("Paste JSON")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showingPasteJSON = false }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Pair") {
                        let pasted = manualJSON
                        showingPasteJSON = false
                        handleRead(pasted)
                    }
                    .disabled(manualJSON.isEmpty || isPairing)
                    .accessibilityIdentifier("pairing.pasteJSON.submit")
                }
            }
        }
    }

    /// Handle raw QR payload or pasted JSON. Decodes which version,
    /// then surfaces a confirmation sheet with host + fingerprint
    /// before any network call. The user has to explicitly tap
    /// "Pair" — see `PairingConfirmationSheet`. This is the
    /// pairing counter-measure: even a successfully-decoded JSON
    /// shouldn't auto-pair without the user eyeballing the host.
    private func handleRead(_ raw: String) {
        do {
            let payload = try PairingPayload.decode(from: raw)
            pendingPayload = payload
        } catch {
            scanError = "Invalid pairing payload: \(error)"
        }
    }

    private func submitManual() {
        // Build a V2 payload synthetically from the two text fields.
        // (Manual entry doesn't carry a fingerprint — V3 requires the
        // QR shape so the user can't typo a 64-hex-char digest.)
        let encoded: Data
        do {
            let payload = PairingPayload.V2(
                gatewayUrl: manualGatewayUrl.trimmingCharacters(in: .whitespacesAndNewlines),
                pairingCode: manualPairingCode
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .uppercased()
            )
            encoded = try JSONEncoder().encode(payload)
        } catch {
            scanError = "Invalid input: \(error)"
            return
        }
        guard let json = String(data: encoded, encoding: .utf8) else {
            scanError = "Encoding error"
            return
        }
        showingManualEntry = false
        handleRead(json)
    }

    @MainActor
    private func pair(payload: PairingPayload) async {
        isPairing = true
        defer { isPairing = false }
        // Re-encode the decoded payload back to JSON so we can hand it
        // to the existing AppStore.pairAsync(raw:) seam unchanged. The
        // decode + scheme/fingerprint validation already ran in
        // `handleRead`, so this is just an encode round-trip.
        let raw: String
        do {
            raw = try Self.encodePayload(payload)
        } catch {
            scanError = "Encoding error: \(error)"
            return
        }
        await store.pairAsync(raw: raw)
        if store.pairing != nil {
            dismiss()
        } else if let err = store.lastError {
            scanError = err
        }
    }

    private static func encodePayload(_ payload: PairingPayload) throws -> String {
        let encoder = JSONEncoder()
        let data: Data = switch payload {
        case .v1(let v1): try encoder.encode(v1)
        case .v2(let v2): try encoder.encode(v2)
        case .v3(let v3): try encoder.encode(v3)
        case .v4(let v4): try encoder.encode(v4)
        }
        guard let s = String(data: data, encoding: .utf8) else {
            throw NSError(
                domain: "PairingView", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "non-utf8 payload"]
            )
        }
        return s
    }
}

/// Manual-code fallback shared by the live sheet and its visual regression
/// preview. A recovery URL is only a prefill; the short-lived pairing code is
/// still required before the app can exchange for a device credential.
@available(iOS 17.0, *)
struct PairingManualEntryView: View {
    @Binding var gatewayURL: String
    @Binding var pairingCode: String
    let isPairing: Bool
    let onCancel: () -> Void
    let onPair: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://gateway.example.com", text: $gatewayURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .font(.system(.body, design: .monospaced))
                } header: {
                    Text("Gateway URL")
                } footer: {
                    Text("The HTTPS address of your Omnesis gateway.")
                }

                Section {
                    TextField("XXXX-YYYY", text: $pairingCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled(true)
                        .font(.system(.body, design: .monospaced))
                } header: {
                    Text("Pairing code")
                } footer: {
                    Text("Displayed after you run `omnesis devices pair --kind ios` on the gateway.")
                }
            }
            .navigationTitle("Manual entry")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Pair", action: onPair)
                        .disabled(gatewayURL.isEmpty || pairingCode.isEmpty || isPairing)
                }
            }
        }
    }
}

/// Confirmation sheet shown between "decoded a payload" and "exchange
/// the code". Displays the host and explicit TLS trust policy before any
/// network call. Legacy V1/V2 payloads get a warning row.
@available(iOS 17.0, *)
struct PairingConfirmationSheet: View {
    let payload: PairingPayload
    let isPairing: Bool
    let onCancel: () -> Void
    let onConfirm: () -> Void
    /// The scrolling layout fits the longer key text a cloud build can show.
    var cloudRelayEnabled = CloudRelayFeature.enabled

    var body: some View {
        NavigationStack {
            Group {
                if cloudRelayEnabled {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                            summary
                            actions
                        }
                        .padding(Theme.Spacing.lg)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                } else {
                    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                        summary

                        Spacer()

                        actions
                    }
                    .padding(Theme.Spacing.lg)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
        }
        .omnesisColorScheme()
    }

    @ViewBuilder
    private var summary: some View {
        Text("Confirm pairing")
            .font(.title2.bold())
            .foregroundStyle(Theme.textPrimary)

        Text("About to pair with:")
            .font(.subheadline)
            .foregroundStyle(Theme.textSecondary)

        hostCard
        fingerprintCard
    }

    private var actions: some View {
        HStack(spacing: Theme.Spacing.md) {
            Button(action: onCancel) {
                Text("Cancel")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.md)
                    .background(Theme.bgTertiary)
                    .foregroundStyle(Theme.textPrimary)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            }
            .disabled(isPairing)

            Button(action: onConfirm) {
                Text(isPairing ? "Pairing…" : "Pair")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.md)
                    .background(Theme.accent)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            }
            .disabled(isPairing)
            .accessibilityIdentifier("pairing.confirm")
        }
    }

    private var hostCard: some View {
        OmnesisCard {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text("HOST")
                    .font(.caption2.bold())
                    .tracking(0.6)
                    .foregroundStyle(Theme.textMuted)
                Text(hostAndPort)
                    .font(Theme.monospace(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .textSelection(.enabled)
                Text(versionLabel)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private var fingerprintCard: some View {
        OmnesisCard {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                HStack {
                    Text("TLS TRUST")
                        .font(.caption2.bold())
                        .tracking(0.6)
                        .foregroundStyle(Theme.textMuted)
                    Spacer()
                    if trustPresentation == .legacy {
                        OmnesisPill(
                            text: "legacy",
                            colors: Theme.pillColor(forState: "needs-auth", paused: false)
                        )
                    } else if trustPresentation == .system {
                        OmnesisPill(
                            text: "WebPKI",
                            colors: Theme.pillColor(forState: "ok", paused: false)
                        )
                    }
                }
                if trustPresentation == .system {
                    Text("System WebPKI")
                        .font(.subheadline.bold())
                        .foregroundStyle(Theme.textPrimary)
                    Text(
                        "iOS will verify the certificate chain and gateway hostname " +
                            "using the system trust store."
                    )
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                } else if let formatted = fingerprintFormatted {
                    if trustPresentation == .pinnedKey {
                        Text("Gateway public key fingerprint").font(.subheadline.bold()).foregroundStyle(Theme.textPrimary)
                        Text("The gateway keeps this key when its HTTPS certificate renews.").font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    if cloudRelayEnabled {
                        Text(formatted)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(Theme.textPrimary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(formatted)
                            .font(Theme.monospace(size: 12))
                            .foregroundStyle(Theme.textPrimary)
                            .textSelection(.enabled)
                            .lineLimit(4)
                    }
                } else {
                    Text(legacyUsesHTTPS ? "System-trusted HTTPS (legacy)" : "Unencrypted (legacy payload)")
                        .font(.subheadline.bold())
                        .foregroundStyle(Theme.warning)
                    Text(legacyTrustExplanation)
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
    }

    /// Formatted as `aa:bb:cc:dd:…` every 2 hex chars for legibility.
    /// Returns nil for V1/V2 (no fingerprint negotiated).
    private var fingerprintFormatted: String? {
        guard let hex = fingerprintHex else { return nil }
        var out = ""
        out.reserveCapacity(hex.count + hex.count / 2)
        var i = hex.startIndex
        while i < hex.endIndex {
            let next = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            if !out.isEmpty { out.append(":") }
            out.append(contentsOf: hex[i ..< next])
            i = next
        }
        return out
    }

    private var fingerprintHex: String? {
        switch payload {
        case .v4(let v4):
            switch v4.tls {
            case .pinnedLeaf(let fingerprint), .pinnedLeafStrict(let fingerprint): fingerprint.lowercased()
            case .pinnedKeyStrict(let spki): spki.lowercased()
            case .system: nil
            }
        case .v3(let v3): v3.fingerprint.lowercased()
        case .v2, .v1: nil
        }
    }

    private enum TrustPresentation { case system, pinnedLeaf, pinnedKey, legacy }

    private var legacyUsesHTTPS: Bool {
        guard case .legacy = trustPresentation else { return false }
        return URL(string: gatewayURLString)?.scheme?.lowercased() == "https"
    }

    private var legacyTrustExplanation: String {
        if legacyUsesHTTPS {
            return "This older QR does not state an explicit TLS policy. iOS will verify the certificate chain and gateway hostname using the system trust store."
        }
        return "This older QR uses plaintext HTTP. Traffic and credentials are not protected from interception on the network."
    }

    private var trustPresentation: TrustPresentation {
        switch payload {
        case .v4(let v4):
            switch v4.tls {
            case .system: .system
            case .pinnedLeaf, .pinnedLeafStrict: .pinnedLeaf
            case .pinnedKeyStrict: .pinnedKey
            }
        case .v3: .pinnedLeaf
        case .v2, .v1: .legacy
        }
    }

    private var hostAndPort: String {
        let urlString = gatewayURLString
        guard let url = URL(string: urlString) else { return urlString }
        let host = url.host ?? urlString
        if let port = url.port {
            return "\(host):\(port)"
        }
        return host
    }

    private var gatewayURLString: String {
        switch payload {
        case .v4(let v4): v4.gatewayUrl
        case .v3(let v3): v3.gatewayUrl
        case .v2(let v2): v2.gatewayUrl
        case .v1(let v1): v1.url
        }
    }

    private var versionLabel: String {
        switch payload {
        case .v4(let v4):
            switch v4.tls {
            case .system: "System-trusted HTTPS (V4)"
            case .pinnedLeaf: "TLS-pinned (V4)"
            case .pinnedLeafStrict: "Verified gateway (V4)"
            case .pinnedKeyStrict: "Verified gateway key (V4)"
            }
        case .v3: "TLS-pinned (V3)"
        case .v2: "Unpinned exchange (V2)"
        case .v1: "Legacy token (V1)"
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Pairing") {
    PairingView(googleConfiguration: PreviewMocks.googleCloudPairingConfiguration)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Pairing — Omnesis account") {
    PairingView(accountConfiguration: PreviewMocks.accountCloudPairingConfiguration)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Manual entry — recovery URL") {
    @Previewable @State var gatewayURL = "https://gateway.example:7600"
    @Previewable @State var pairingCode = ""
    PairingManualEntryView(
        gatewayURL: $gatewayURL,
        pairingCode: $pairingCode,
        isPairing: false,
        onCancel: {},
        onPair: {}
    )
}

@available(iOS 17.0, *)
#Preview("Confirmation — V3 (pinned)") {
    PairingConfirmationSheet(
        payload: .v3(PreviewMocks.pairingPayloadV3),
        isPairing: false,
        onCancel: {},
        onConfirm: {}
    )
}

@available(iOS 17.0, *)
#Preview("Confirmation — V4 (system trust)") {
    PairingConfirmationSheet(
        payload: .v4(PreviewMocks.pairingPayloadV4System),
        isPairing: false,
        onCancel: {},
        onConfirm: {}
    )
}

@available(iOS 17.0, *)
#Preview("Confirmation — V3 (pinned), cloud build") {
    PairingConfirmationSheet(
        payload: .v3(PreviewMocks.pairingPayloadV3),
        isPairing: false,
        onCancel: {},
        onConfirm: {},
        cloudRelayEnabled: true
    )
}

@available(iOS 17.0, *)
#Preview("Confirmation — V3 (pinned), default build") {
    PairingConfirmationSheet(
        payload: .v3(PreviewMocks.pairingPayloadV3),
        isPairing: false,
        onCancel: {},
        onConfirm: {},
        cloudRelayEnabled: false
    )
}

@available(iOS 17.0, *)
#Preview("Confirmation — V2 (legacy)") {
    PairingConfirmationSheet(
        payload: .v2(PreviewMocks.pairingPayloadV2),
        isPairing: false,
        onCancel: {},
        onConfirm: {}
    )
}
#endif
#endif
