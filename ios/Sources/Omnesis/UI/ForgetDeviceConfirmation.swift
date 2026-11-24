// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Confirmation keeps the reviewed source impact visible until forgetting succeeds.
@available(iOS 17.0, *)
struct ForgetDeviceConfirmation: View {
    let device: DeviceRecord
    let onRefresh: () async throws -> DeviceForgetImpact
    let onForget: (DeviceForgetData, String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var impact: DeviceForgetImpact
    @State private var data = DeviceForgetData.keep
    @State private var busy = false
    @State private var error: String?
    @State private var needsRefresh = false

    init(
        device: DeviceRecord,
        impact: DeviceForgetImpact,
        initialData: DeviceForgetData = .keep,
        onRefresh: @escaping () async throws -> DeviceForgetImpact,
        onForget: @escaping (DeviceForgetData, String) async throws -> Void
    ) {
        self.device = device
        self._impact = State(initialValue: impact)
        self._data = State(initialValue: initialData)
        self.onRefresh = onRefresh
        self.onForget = onForget
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Forget \(device.name) permanently. It will stop syncing and will no longer report device or source errors.")
                    if impact.hasSources {
                        Text("\(impact.sources.count) source\(impact.sources.count == 1 ? "" : "s") hosted by this device.")
                        Picker("Historical data", selection: $data) {
                            ForEach(DeviceForgetData.allCases, id: \.self) { option in
                                Text(option.title).tag(option)
                            }
                        }
                        .pickerStyle(.inline)
                        Text(data == .keep
                            ? "Previously indexed data stays searchable. Sources still used by other devices keep syncing."
                            :
                            "Deletes this device’s data where it can be attributed to it. " +
                            "Other devices’ data, shared data still in use and history kept " +
                            "from earlier forgotten devices will stay.")
                            .font(.footnote)
                            .foregroundStyle(Theme.textMuted)
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(Theme.danger).accessibilityIdentifier("devices.forget.error") }
                }
                Section {
                    Button(role: data == .delete ? .destructive : nil) {
                        Task { await submit() }
                    } label: {
                        HStack {
                            if busy { ProgressView() }
                            Text(needsRefresh ? "Review sources again" : data == .delete && impact
                                .hasSources ? "Forget and delete data" : "Forget device")
                        }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("devices.forget.confirm")
                }
            }
            .navigationTitle("Forget device?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
            }
            .disabled(busy)
            .interactiveDismissDisabled(busy)
        }
    }

    private func submit() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        if needsRefresh {
            await refreshImpact()
            return
        }
        do {
            try await onForget(data, impact.fingerprint)
            dismiss()
        } catch let failure as GatewayClient.Error where failure.gatewayCode == "DEVICE_FORGET_IMPACT_CHANGED" {
            needsRefresh = true
            data = .keep
            await refreshImpact()
        } catch {
            self.error = "Forget failed: \(deviceGatewayMessage(error))"
        }
    }

    private func refreshImpact() async {
        do {
            impact = try await onRefresh()
            needsRefresh = false
            data = .keep
            error = "This device’s sources changed. Review the data choice and confirm again."
        } catch {
            self.error = "Cannot refresh the device’s sources: \(deviceGatewayMessage(error))"
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Forget device — keep history") {
    ForgetDeviceConfirmation(
        device: PreviewMocks.deviceRevoked,
        impact: PreviewMocks.deviceForgetImpact,
        onRefresh: { PreviewMocks.deviceForgetImpact },
        onForget: { _, _ in }
    )
}

@available(iOS 17.0, *)
#Preview("Forget device — delete data") {
    ForgetDeviceConfirmation(
        device: PreviewMocks.deviceRevoked,
        impact: PreviewMocks.deviceForgetImpact,
        initialData: .delete,
        onRefresh: { PreviewMocks.deviceForgetImpact },
        onForget: { _, _ in }
    )
}

#endif
#endif
