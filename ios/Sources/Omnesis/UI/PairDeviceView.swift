// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Pair-a-new-device sheet — mirrors the portal's "Pair a new device" section
/// (`packages/gateway/portal/js/views/devices.js`).
///
/// The gateway mints a one-time pairing code (`POST /admin/devices/pair`,
/// ~10-min TTL). The new device exchanges it for a real token via the public
/// `POST /devices/pair`. We render the code AND a scannable QR. The gateway
/// judges every address it could put in the code (`POST /admin/devices/pair-addresses`)
/// and encodes the chosen one (`POST /admin/devices/pair-qr`), so every client
/// shares the versioned trust policy and the same choice of addresses.
///
/// The form asks for the device kind only: the gateway grants the kind's
/// canonical scopes. A narrower or custom grant is minted from the CLI.
///
/// With the cloud build flag off the sheet is `LegacyPairDeviceView`, unchanged from a
/// build without cloud connectivity (see `PairDeviceSheetStyle`).
@available(iOS 17.0, *)
struct PairDeviceView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var phase: Phase = .form
    let repairTarget: DeviceRecord?
    private let style: PairDeviceSheetStyle

    init(repairTarget: DeviceRecord? = nil, cloudRelayEnabled: Bool = CloudRelayFeature.enabled) {
        self.repairTarget = repairTarget
        style = PairDeviceSheetStyle(cloudRelayEnabled: cloudRelayEnabled)
    }

    enum Phase: Equatable {
        case form
        case paired(PendingPairing, kind: String)
    }

    var body: some View {
        switch style {
        case .networkIdentities:
            LegacyPairDeviceView(repairTarget: repairTarget)
        case .addressPlan:
            addressPlanSheet
        }
    }

    private var addressPlanSheet: some View {
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
            PairingResultView(pending: pending, kind: kind, client: store.admin, repairDeviceName: repairTarget?.name)
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

@available(iOS 17.0, *)
struct RepairDeviceForm: View {
    let device: DeviceRecord
    var onRepair: () async throws -> Void = {}

    @State private var submitting = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Text(
                    "This code is bound to \(device.name). Re-pairing keeps its device identity, "
                        + "sources, memberships, cursors, and existing data."
                )
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

                if let error {
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.danger)
                }

                Button {
                    Task { await submit() }
                } label: {
                    HStack {
                        if submitting { ProgressView().controlSize(.small) }
                        Text(submitting ? "Generating…" : "Generate repair code")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(submitting)
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private func submit() async {
        guard !submitting else { return }
        submitting = true
        error = nil
        defer { submitting = false }
        do {
            try await onRepair()
        } catch {
            self.error = "Repair failed: \(deviceGatewayMessage(error))"
        }
    }
}

// MARK: - Pair form (pure)

/// Pure pairing form: a kind picker and the generate action. The gateway owns
/// the grant for each kind, and the paired device names itself.
@available(iOS 17.0, *)
struct PairDeviceForm: View {
    /// Returns on success; throws to surface the error banner.
    var onPair: (String) async throws -> Void = { _ in }

    @State private var kind = "ios"
    @State private var submitting = false
    @State private var error: String?

    /// Device kinds offered when pairing — generic gateway concept (matches the
    /// portal's `DEVICE_KINDS` / `KIND_LABELS`).
    private var kinds: [String] {
        DeviceKindMeta.pairKinds
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Text(
                    "The gateway returns a one-time pairing code (10-min TTL) and a QR. "
                        + "The new device scans the QR — or exchanges the code via POST /devices/pair — for a real token."
                )
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

                field("Kind") {
                    Picker("Kind", selection: $kind) {
                        ForEach(kinds, id: \.self) { kind in
                            Text(DeviceKindMeta.label(kind)).tag(kind)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(Theme.accent)
                    .disabled(submitting)
                }

                if let error {
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button {
                    Task { await submit() }
                } label: {
                    HStack {
                        if submitting { ProgressView().controlSize(.small) }
                        Text(submitting ? "Generating…" : "Generate pairing code")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(submitting)
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private func field(_ title: String, @ViewBuilder _ control: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            control()
        }
    }

    private func submit() async {
        guard !submitting else { return }
        submitting = true
        error = nil
        defer { submitting = false }
        do {
            try await onPair(kind)
        } catch {
            self.error = "Pairing failed: \(deviceGatewayMessage(error))"
        }
    }
}

// MARK: - Pairing result

/// The result surface: the one-time code, an expiry countdown, and for a phone
/// the QR for the address the gateway recommends, with its other addresses.
@available(iOS 17.0, *)
struct PairingResultView: View {
    let pending: PendingPairing
    /// The kind the code was minted for — gates whether we show a scannable QR
    /// (mobile apps) or code-exchange instructions (CLI/portal/collector).
    let kind: String
    let client: (any PairingAddressProviding)?
    let repairDeviceName: String?

    @State private var model: PairingAddressModel
    @State private var alternativesOpen: Bool
    @State private var manualOpen: Bool
    @State private var copied = false

    /// `plan`, `initialPayload` and `expanded` seed a preview or snapshot: the plan and
    /// the QR render without a gateway, with both disclosures open.
    init(
        pending: PendingPairing,
        kind: String,
        client: (any PairingAddressProviding)? = nil,
        repairDeviceName: String? = nil,
        plan: PairingAddressPlan? = nil,
        initialPayload: String? = nil,
        expanded: Bool = false
    ) {
        self.pending = pending
        self.kind = kind
        self.client = client
        self.repairDeviceName = repairDeviceName
        _model = State(initialValue: PairingAddressModel(
            pairingCode: pending.pairingCode,
            encodesQr: DeviceKindMeta.usesQr(kind),
            plan: plan,
            payload: initialPayload
        ))
        _alternativesOpen = State(initialValue: expanded)
        _manualOpen = State(initialValue: expanded)
    }

    /// Only a phone or an agent is told which address to use.
    private var choosesAddress: Bool {
        DeviceKindMeta.usesQr(kind) || kind == "agent"
    }

    private var noun: String {
        PairingAddressPresentation.noun(kind: kind)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                codeBlock
                if choosesAddress { addressed } else { codeInstructions(gatewayURL: nil) }
            }
            .frame(maxWidth: .infinity)
            .padding(Theme.Spacing.lg)
        }
        .task {
            if choosesAddress, let client { await model.load(client: client) }
        }
    }

    @ViewBuilder
    private var addressed: some View {
        if let error = model.planError {
            problem("Couldn't prepare the \(DeviceKindMeta.usesQr(kind) ? "QR code" : "address"): \(deviceGatewayMessage(error))")
        } else if let plan = model.plan {
            if let selected = model.selected {
                if DeviceKindMeta.usesQr(kind) {
                    qrBlock(selected)
                    reach(selected)
                    awayFromHome(plan)
                    alternatives(plan, selected: selected)
                    cantScan(selected)
                } else {
                    reach(selected)
                    alternatives(plan, selected: selected)
                    codeInstructions(gatewayURL: selected.gatewayUrl)
                }
            } else {
                let who = PairingAddressPresentation.withArticle(noun)
                problem(
                    DeviceKindMeta.usesQr(kind)
                        ? "None of this gateway's addresses can be used by \(who), so there is no QR code to scan."
                        : "None of this gateway's addresses can be used by \(who)."
                )
                PairingRefusedAddresses(plan: plan, noun: noun)
                awayFromHome(plan)
            }
        } else {
            Text("Finding the addresses this \(noun) can use…")
                .font(.footnote)
                .foregroundStyle(Theme.textMuted)
        }
    }

    private func problem(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Theme.danger)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// For non-app kinds there is no QR to scan. Agent integrations have their
    /// own one-shot installer commands; other kinds retain the generic exchange
    /// guidance.
    @ViewBuilder
    private func codeInstructions(gatewayURL: String?) -> some View {
        if kind == "agent" {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Run one command on the agent host. The pairing code is single-use.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                ForEach(agentConnectCommands(gatewayURL: gatewayURL, pairingCode: pending.pairingCode), id: \.self) { command in
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

    private func qrBlock(_ selected: PairingAddressOption) -> some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text("Scan with the Omnesis app on \(repairDeviceName ?? "your \(noun)")")
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
            if let payload = model.payload {
                QRCodeView(payload: payload)
                    .accessibilityLabel("Pairing QR code for \(selected.host)")
            } else if let error = model.qrError {
                Text("Couldn't make the QR code: \(deviceGatewayMessage(error))")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .frame(width: 220, height: 220)
                    .multilineTextAlignment(.center)
            } else {
                ProgressView()
                    .frame(width: 220, height: 220)
                    .accessibilityLabel("Making the QR code…")
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// Where a device paired with the chosen address works, in the gateway's words.
    private func reach(_ selected: PairingAddressOption) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let summary = selected.summary {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("\(selected.label) · \(selected.host)")
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous))
        .accessibilityIdentifier("pair.reach")
    }

    @ViewBuilder
    private func awayFromHome(_ plan: PairingAddressPlan) -> some View {
        if let hint = plan.awayFromHome {
            PairingAwayFromHome(hint: hint, platform: plan.platform, noun: noun)
        }
    }

    @ViewBuilder
    private func alternatives(_ plan: PairingAddressPlan, selected: PairingAddressOption) -> some View {
        if let title = PairingAddressPresentation.alternativesTitle(plan) {
            DisclosureGroup(title, isExpanded: $alternativesOpen) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    if plan.usable.count > 1 {
                        ForEach(plan.usable) { option in
                            PairingAddressChoiceRow(
                                title: plan.title(option),
                                detail: option.summary,
                                selected: option.gatewayUrl == selected.gatewayUrl
                            ) {
                                copied = false
                                Task { await model.select(option, client: client) }
                            }
                        }
                    }
                    PairingRefusedAddresses(plan: plan, noun: noun)
                }
                .padding(.top, Theme.Spacing.sm)
            }
            .font(.subheadline.weight(.semibold))
            .tint(Theme.accent)
            .accessibilityIdentifier("pair.alternatives")
        }
    }

    /// The same pairing by hand. Typing the address and the code is offered only where
    /// the phone's own trust accepts the gateway; anywhere else the JSON carries the pin.
    @ViewBuilder
    private func cantScan(_ selected: PairingAddressOption) -> some View {
        if let payload = model.payload {
            DisclosureGroup("Can't scan the code?", isExpanded: $manualOpen) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    HStack(spacing: Theme.Spacing.sm) {
                        Text("In the Omnesis app, choose **Paste JSON** and paste:")
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
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
                        .accessibilityLabel("Copy pairing JSON")
                    }
                    Text(payload)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.textMuted)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if model.offersManualEntry {
                        let url = Text(selected.gatewayUrl).monospaced()
                        let code = Text(pending.pairingCode).monospaced()
                        Text("Or choose **Manual entry** and type the gateway URL \(url) and the pairing code \(code).")
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("pair.manualEntry")
                    }
                }
                .padding(.top, Theme.Spacing.sm)
            }
            .font(.subheadline.weight(.semibold))
            .tint(Theme.accent)
            .accessibilityIdentifier("pair.cantScan")
        }
    }
}

/// One usable address to choose, named and explained by the gateway.
@available(iOS 17.0, *)
struct PairingAddressChoiceRow: View {
    let title: String
    let detail: String?
    let selected: Bool
    let choose: () -> Void

    var body: some View {
        Button(action: choose) {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.body)
                    .foregroundStyle(selected ? Theme.accent : Theme.textMuted)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.textPrimary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail {
                        Text(detail)
                            .font(.footnote.weight(.regular))
                            .foregroundStyle(Theme.textSecondary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The addresses the gateway will not give this device, each with the gateway's reason.
@available(iOS 17.0, *)
struct PairingRefusedAddresses: View {
    let plan: PairingAddressPlan
    let noun: String

    var body: some View {
        if !plan.refused.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Not offered for \(PairingAddressPresentation.withArticle(noun))")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .accessibilityAddTraits(.isHeader)
                ForEach(plan.refused) { option in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(plan.title(option))
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Theme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let reason = option.reason {
                            Text(reason)
                                .font(.footnote.weight(.regular))
                                .foregroundStyle(Theme.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("pair.refused")
        }
    }
}

/// Shown when no offered address reaches beyond the gateway's own network.
@available(iOS 17.0, *)
struct PairingAwayFromHome: View {
    let hint: PairingAwayFromHomeHint
    let platform: String?
    let noun: String

    var body: some View {
        let steps = PairingAddressPresentation.awayFromHomeSteps(hint, platform: platform, noun: noun)
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("To use this \(noun) away from home")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .accessibilityAddTraits(.isHeader)
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                Text("\(index + 1). \(step)")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let docs = PairingAddressPresentation.awayFromHomeDocs {
                Link("Set up access away from home", destination: docs)
                    .font(.footnote.weight(.semibold))
                    .tint(Theme.accent)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous))
        .accessibilityIdentifier("pair.awayFromHome")
    }
}

/// A live "expires in Ns" countdown for the pairing code's TTL.
@available(iOS 17.0, *)
struct ExpiryCountdown: View {
    let expiresAt: Int64

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let remaining = max(0, (expiresAt - Int64(Date().timeIntervalSince1970 * 1000)) / 1000)
            Text(remaining > 0 ? "expires in \(remaining)s" : "expired — generate a new code")
                .font(.system(size: 12))
                .foregroundStyle(remaining > 0 ? Theme.textMuted : Theme.danger)
        }
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("Pair — form") {
    PairDeviceForm()
        .background(Theme.bgPrimary.ignoresSafeArea())
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Repair — form") {
    RepairDeviceForm(device: PreviewMocks.deviceRevoked)
        .background(Theme.bgPrimary.ignoresSafeArea())
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
private func pairingResultPreview(_ plan: PairingAddressPlan, kind: String = "ios", expanded: Bool = false) -> some View {
    PairingResultView(
        pending: PreviewMocks.pendingPairing,
        kind: kind,
        plan: plan,
        initialPayload: kind == "agent" ? nil : PreviewMocks.pairingQrPayload,
        expanded: expanded
    )
    .background(Theme.bgPrimary.ignoresSafeArea())
}

@available(iOS 17.0, *)
#Preview("Pair — result") {
    pairingResultPreview(PreviewMocks.pairingAddressPlan)
}

@available(iOS 17.0, *)
#Preview("Pair — result, addresses open") {
    pairingResultPreview(PreviewMocks.pairingAddressPlan, expanded: true)
}

@available(iOS 17.0, *)
#Preview("Pair — result, home only") {
    pairingResultPreview(PreviewMocks.pairingAddressPlanHomeOnly, expanded: true)
}

@available(iOS 17.0, *)
#Preview("Pair — result, no usable address") {
    pairingResultPreview(PreviewMocks.pairingAddressPlanNoneUsable)
}

@available(iOS 17.0, *)
#Preview("Pair — finding addresses") {
    PairingResultView(pending: PreviewMocks.pendingPairing, kind: "ios")
        .background(Theme.bgPrimary.ignoresSafeArea())
}

@available(iOS 17.0, *)
#Preview("Pair — agent result") {
    pairingResultPreview(PreviewMocks.pairingAddressPlanAgent, kind: "agent", expanded: true)
}
#endif
#endif
