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
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var impact: DeviceForgetImpact
    @State private var data = DeviceForgetData.keep
    @State private var busy = false
    @State private var error: String?
    @State private var needsRefresh = false
    @State private var contentHeight: CGFloat = 560

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
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Text("Forget \(device.name)?")
                    .font(.title2.bold())
                    .foregroundStyle(Theme.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text("This device will stop syncing and will no longer report device or source errors.")
                    .foregroundStyle(Theme.textSecondary)
                if impact.hasSources {
                    affectedSources
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Text("What happens to its data?")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.textPrimary)
                        VStack(alignment: .leading, spacing: 0) {
                            choice(.keep)
                            Divider().background(Theme.borderLight)
                            choice(.delete)
                        }
                        Text("Other devices keep syncing. Their data and history already kept from forgotten devices are preserved.")
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let error {
                    Text(error)
                        .foregroundStyle(Theme.danger)
                        .accessibilityIdentifier("devices.forget.error")
                }
                actions
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.lg)
            .background(GeometryReader { proxy in
                Color.clear.preference(key: ForgetDeviceHeightKey.self, value: proxy.size.height)
            })
        }
        .scrollBounceBehavior(.basedOnSize)
        .onPreferenceChange(ForgetDeviceHeightKey.self) { contentHeight = $0 }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .omnesisColorScheme()
        .presentationDetents([.height(contentHeight), .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(busy)
    }

    private var affectedSources: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Affected sources (\(impact.sources.count))")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            ForEach(impact.sources, id: \.id) { source in
                HStack(spacing: Theme.Spacing.sm) {
                    SourceIconView(sourceId: source.id, store: store, size: 22)
                        .accessibilityHidden(true)
                    Text(store.sourceLabel(forSourceId: source.id) ?? humanName(for: source.type))
                        .font(.subheadline)
                        .foregroundStyle(Theme.textPrimary)
                    Spacer(minLength: 0)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func choice(_ option: DeviceForgetData) -> some View {
        let selected = data == option
        return Button { data = option } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(selected ? Theme.accent : Theme.textSecondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(option.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text(option == .keep
                        ? "Keep previously indexed data searchable."
                        : "Remove data held only by this device.")
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .multilineTextAlignment(.leading)
            .frame(minHeight: Theme.tapTarget, alignment: .leading)
            .padding(.vertical, Theme.Spacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private var actions: some View {
        HStack(spacing: Theme.Spacing.lg) {
            Spacer(minLength: 0)
            Button("Cancel") { dismiss() }
                .frame(minHeight: Theme.tapTarget)
                .foregroundStyle(Theme.textSecondary)
            Button {
                Task { await submit() }
            } label: {
                HStack {
                    if busy { ProgressView() }
                    Text(needsRefresh ? "Review sources again" : data == .delete && impact.hasSources
                        ? "Forget and delete data" : "Forget device")
                        .font(.subheadline.weight(.semibold))
                }
                .foregroundStyle(Theme.bgPrimary)
                .padding(.horizontal, Theme.Spacing.md)
                .frame(minHeight: Theme.tapTarget)
                .background(data == .delete ? Theme.danger : Theme.accent, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("devices.forget.confirm")
        }
        .disabled(busy)
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

private struct ForgetDeviceHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 560
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Forget device — keep history") {
    ForgetDeviceConfirmation(
        device: PreviewMocks.deviceRevoked,
        impact: PreviewMocks.deviceForgetCatalogImpact,
        onRefresh: { PreviewMocks.deviceForgetCatalogImpact },
        onForget: { _, _ in }
    )
    .environment(AppStore.preview(sourceIconByType: PreviewMocks.deviceForgetIcons))
}

@available(iOS 17.0, *)
#Preview("Forget device — delete data") {
    ForgetDeviceConfirmation(
        device: PreviewMocks.deviceRevoked,
        impact: PreviewMocks.deviceForgetCatalogImpact,
        initialData: .delete,
        onRefresh: { PreviewMocks.deviceForgetCatalogImpact },
        onForget: { _, _ in }
    )
    .environment(AppStore.preview(sourceIconByType: PreviewMocks.deviceForgetIcons))
}

@available(iOS 17.0, *)
#Preview("Forget device — larger text") {
    ForgetDeviceConfirmation(
        device: PreviewMocks.deviceRevoked,
        impact: PreviewMocks.deviceForgetCatalogImpact,
        onRefresh: { PreviewMocks.deviceForgetCatalogImpact },
        onForget: { _, _ in }
    )
    .environment(AppStore.preview(sourceIconByType: PreviewMocks.deviceForgetIcons))
    .dynamicTypeSize(.accessibility2)
}

#endif
#endif
