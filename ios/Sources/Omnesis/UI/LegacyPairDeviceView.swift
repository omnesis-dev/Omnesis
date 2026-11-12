// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Pair-a-new-device sheet of a build with the cloud build flag off
/// (`CloudRelayFeature.enabled`); `PairDeviceView` presents it. Mirrors the portal's
/// "Pair a new device" section (`packages/gateway/portal/js/views/devices.js`).
///
/// The gateway mints a one-time pairing code (`POST /admin/devices/pair`,
/// ~10-min TTL). The new device exchanges it for a real token via the public
/// `POST /devices/pair`. We render the code AND a scannable QR — the QR payload
/// is encoded server-side (`POST /admin/devices/pair-qr`) so every client
/// shares the versioned trust policy; the user picks which network identity bakes into the
/// QR's `gatewayUrl` from `GET /admin/network-identities`.
///
/// The form asks for the device kind only: the gateway grants the kind's
/// canonical scopes. A narrower or custom grant is minted from the CLI.
@available(iOS 17.0, *)
struct LegacyPairDeviceView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    // See #103 — planned: take the address from /admin/devices/pair-addresses.
    @State private var identities: [NetworkIdentity] = []
    @State private var phase: Phase = .form
    let repairTarget: DeviceRecord?

    init(repairTarget: DeviceRecord? = nil) {
        self.repairTarget = repairTarget
    }

    enum Phase: Equatable {
        case form
        case paired(PendingPairing, kind: String)
    }

    var body: some View {
        NavigationStack {
            content
                .background(Theme.bgPrimary.ignoresSafeArea())
                .navigationTitle(repairTarget.map { "Repair \($0.name)" } ?? "Pair a device")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
                .task { await loadIdentities() }
                .omnesisColorScheme()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .form:
            if let repairTarget {
                RepairDeviceForm(device: repairTarget) {
                    try await pair(kind: repairTarget.kind)
                }
            } else {
                PairDeviceForm { kind in
                    try await pair(kind: kind)
                }
            }
        case .paired(let pending, let kind):
            LegacyPairingResultView(
                pending: pending,
                kind: kind,
                identities: identities,
                gatewayOrigin: store.admin?.baseURL,
                repairDeviceName: repairTarget?.name
            ) { code, gatewayUrl in
                try await store.admin?.buildPairQr(pairingCode: code, gatewayUrl: gatewayUrl) ?? ""
            }
        }
    }

    private func loadIdentities() async {
        guard let client = store.admin else { return }
        do {
            identities = try await client.listNetworkIdentities()
        } catch {
            identities = []
        }
    }

    private func pair(kind: String) async throws {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        let pending = try await client.createPairing(
            kind: kind,
            repairDeviceId: repairTarget?.id
        )
        withAnimation { phase = .paired(pending, kind: kind) }
    }
}

// MARK: - Pairing result (pure)

/// The result surface: the one-time code, an expiry countdown, a host picker,
/// and the generated QR. Re-encodes the QR payload whenever the chosen host
/// changes (the gateway owns the V2/V3 spec).
@available(iOS 17.0, *)
struct LegacyPairingResultView: View {
    let pending: PendingPairing
    /// The kind the code was minted for — gates whether we show a scannable QR
    /// (mobile apps) or code-exchange instructions (CLI/portal/collector).
    let kind: String
    let identities: [NetworkIdentity]
    /// The gateway's own origin (scheme + host + port). The chosen network
    /// identity's address is swapped into this so the QR's `gatewayUrl`
    /// preserves the real scheme and port the gateway is served on — mirrors
    /// the portal's `swapHostForUrl(window.location.origin, …)`.
    let gatewayOrigin: URL?
    /// Encodes the QR payload server-side for (pairingCode, gatewayUrl).
    var encodeQr: (String, String) async throws -> String = { _, _ in "" }
    /// Preview/snapshot seam: a pre-resolved payload so the QR renders without
    /// waiting on the async `.task`. nil in production (the task fills it).
    var initialPayload: String?
    let repairDeviceName: String?

    @State private var selectedIdx = 0
    @State private var payload: String?
    @State private var qrError: String?
    @State private var copied = false

    init(
        pending: PendingPairing,
        kind: String,
        identities: [NetworkIdentity],
        gatewayOrigin: URL? = nil,
        repairDeviceName: String? = nil,
        encodeQr: @escaping (String, String) async throws -> String = { _, _ in "" },
        initialPayload: String? = nil
    ) {
        self.pending = pending
        self.kind = kind
        self.identities = identities
        self.gatewayOrigin = gatewayOrigin
        self.encodeQr = encodeQr
        self.initialPayload = initialPayload
        self.repairDeviceName = repairDeviceName
        self._payload = State(initialValue: initialPayload)
    }

    private var hosts: [NetworkIdentity] {
        identities.isEmpty
            ? [NetworkIdentity(address: "", label: "No network identity discovered", kind: "none", offLan: false)]
            : identities
    }

    private var chosen: NetworkIdentity {
        hosts[min(selectedIdx, hosts.count - 1)]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                codeBlock
                if DeviceKindMeta.usesQr(kind) {
                    hostPicker
                    qrBlock
                } else {
                    if kind == "agent" {
                        hostPicker
                    }
                    codeInstructions
                }
            }
            .frame(maxWidth: .infinity)
            .padding(Theme.Spacing.lg)
        }
        .task(id: chosen.address) {
            if DeviceKindMeta.usesQr(kind), initialPayload == nil { await refreshPayload() }
        }
    }

    /// For non-app kinds there is no QR to scan. Agent integrations have their
    /// own one-shot installer commands; other kinds retain the generic exchange
    /// guidance.
    @ViewBuilder
    private var codeInstructions: some View {
        if kind == "agent" {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Run one command on the agent host. The pairing code is single-use.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                ForEach(
                    agentConnectCommands(
                        gatewayURL: agentGatewayURL(
                            gatewayOrigin: gatewayOrigin,
                            identityAddresses: identities.map(\.address),
                            selectedIndex: selectedIdx
                        ),
                        pairingCode: pending.pairingCode
                    ),
                    id: \.self
                ) { command in
                    Text(command)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Theme.textPrimary)
                        .textSelection(.enabled)
                        .padding(Theme.Spacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.small))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(
                "On the new device, exchange this code for a token — e.g. run "
                    + "`omnesis devices pair` and enter the code, or POST it to /devices/pair."
            )
            .font(.footnote)
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var codeBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("PAIRING CODE")
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(Theme.textMuted)
            Text(pending.pairingCode)
                .font(.system(size: 22, weight: .bold, design: .monospaced))
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
            ExpiryCountdown(expiresAt: pending.expiresAt)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var hostPicker: some View {
        if identities.count > 1 {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text(repairDeviceName.map { "Address \($0) will connect to" } ?? "Address the new device will connect to")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                Picker("Host", selection: $selectedIdx) {
                    ForEach(Array(hosts.enumerated()), id: \.offset) { idx, host in
                        Text("\(host.address) — \(host.label)\(host.offLan ? " (off-LAN)" : "")").tag(idx)
                    }
                }
                .pickerStyle(.menu)
                .tint(Theme.accent)
            }
        }
    }

    private var qrBlock: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text(repairDeviceName.map { "Scan with the Omnesis app on \($0)" } ?? "Scan with the Omnesis app on the new device")
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
            if let payload {
                QRCodeView(payload: payload)
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    HStack(spacing: Theme.Spacing.sm) {
                        Text("Or paste this payload manually")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                        Spacer(minLength: 0)
                        Button {
                            UIPasteboard.general.string = payload
                            copied = true
                        } label: {
                            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Theme.accent)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Copy pairing payload")
                    }
                    Text(payload)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.textMuted)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if let qrError {
                Text("Couldn't build QR: \(qrError)")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .frame(width: 220, height: 220)
                    .multilineTextAlignment(.center)
            } else {
                ProgressView().frame(width: 220, height: 220)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func refreshPayload() async {
        guard !chosen.address.isEmpty else {
            qrError = "no reachable address"
            return
        }
        payload = nil
        qrError = nil
        copied = false
        let gatewayUrl = swapHost(into: gatewayOrigin, host: chosen.address)
        do {
            payload = try await encodeQr(pending.pairingCode, gatewayUrl)
        } catch {
            qrError = deviceGatewayMessage(error)
        }
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("Pair — result, flag off") {
    LegacyPairingResultView(
        pending: PreviewMocks.pendingPairing,
        kind: "ios",
        identities: PreviewMocks.networkIdentities,
        encodeQr: { code, url in "{\"v\":4,\"gatewayUrl\":\"\(url)\",\"pairingCode\":\"\(code)\",\"tls\":{\"mode\":\"system\"}}" },
        initialPayload: #"{"v":4,"gatewayUrl":"https://gateway.example:7600","pairingCode":"7K3M-9QX2","tls":{"mode":"system"}}"#
    )
    .background(Theme.bgPrimary.ignoresSafeArea())
}

@available(iOS 17.0, *)
#Preview("Pair — agent result, flag off") {
    LegacyPairingResultView(
        pending: PreviewMocks.pendingPairing,
        kind: "agent",
        identities: PreviewMocks.networkIdentities,
        gatewayOrigin: URL(string: "https://gateway.example:7600")
    )
    .background(Theme.bgPrimary.ignoresSafeArea())
}
#endif
#endif
