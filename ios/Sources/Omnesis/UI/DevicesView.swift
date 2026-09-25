// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Device-management screen — mirrors the portal's Settings → Devices tab
/// (`packages/gateway/portal/js/views/devices.js`).
///
/// Lists every paired device with its kind, live-connection state, paired / activity
/// times, and — expanded inline — the credentials (tokens) minted for it,
/// each showing its scopes and created / last-used times. Reached from the
/// Settings Gateway card.
///
/// Beyond listing, this surface mutates: revoke a token, revoke a device,
/// forget a revoked device (each destructive action behind a confirm), and
/// pair a new device (one-time code + generated QR). Extra credentials are
/// issued from the CLI, so the card only points there. All transport rides
/// the admin-scoped `/admin/*` surface the portal consumes; each mutation
/// refreshes the list and the latest action owns the notice banner.
///
/// Reached from Settings → Gateway, so it participates in Settings' navigation
/// stack and uses an explicit Settings back control to return there.
@available(iOS 17.0, *)
struct DevicesView: View {
    @Environment(AppStore.self) private var store

    @State private var devices: [DeviceRecord] = []
    /// Tokens fetched lazily per device once its row is first expanded.
    @State private var tokensByDevice: [String: [TokenRecord]] = [:]
    @State private var loading = true
    @State private var loadError: Error?
    @State private var showPairSheet = false
    @State private var repairTarget: DeviceRecord?

    /// Preview-only flag: when true, `.task` never reaches the gateway, so a
    /// seeded snapshot renders deterministically. Always false in production.
    private let isPreview: Bool

    init() {
        self.isPreview = false
    }

    #if DEBUG
    /// Preview/snapshot seam: seed the device list + per-device tokens so
    /// snapshots render without a gateway.
    init(
        previewDevices: [DeviceRecord],
        previewTokens: [String: [TokenRecord]] = [:],
        previewLoading: Bool = false,
        previewError: Error? = nil
    ) {
        self._devices = State(initialValue: previewDevices)
        self._tokensByDevice = State(initialValue: previewTokens)
        self._loading = State(initialValue: previewLoading)
        self._loadError = State(initialValue: previewError)
        self.isPreview = true
    }
    #endif

    var body: some View {
        content
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Devices")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SettingsBackButton()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showPairSheet = true
                    } label: {
                        Label("Pair a device", systemImage: "plus")
                    }
                }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .refreshable { await load() }
            .task { await load() }
            .sheet(isPresented: $showPairSheet) {
                PairDeviceView()
                    .environment(store)
                    .onDisappear { Task { await load() } }
            }
            .sheet(item: $repairTarget) { device in
                PairDeviceView(repairTarget: device)
                    .environment(store)
                    .onDisappear { Task { await load() } }
            }
    }

    @ViewBuilder
    private var content: some View {
        if loading, devices.isEmpty, loadError == nil {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError, devices.isEmpty {
            GatewayErrorView(
                context: "load devices",
                error: loadError,
                onRetry: { Task { await load() } }
            )
        } else {
            DevicesList(
                devices: devices,
                thisDeviceId: store.pairing?.deviceId,
                tokensByDevice: tokensByDevice,
                onExpand: { deviceId in await loadTokens(for: deviceId) },
                onRevokeToken: { tokenId, deviceId in try await revokeToken(tokenId, deviceId: deviceId) },
                onRevokeDevice: { device in try await revokeDevice(device) },
                onForgetDevice: { device in try await forgetDevice(device) },
                onRepairDevice: { device in repairTarget = device }
            )
        }
    }

    /// Revoke one token, then refresh that device's token list. Throws so the
    /// list surfaces a failure banner.
    private func revokeToken(_ tokenId: String, deviceId: String) async throws -> String {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.revokeToken(id: tokenId)
        await reloadTokens(for: deviceId)
        return "Token revoked."
    }

    /// Revoke a device (and all its tokens), then reload the device list.
    /// The cached credentials go with them: the row survives revocation, so a
    /// stale cache would keep listing tokens the gateway has invalidated.
    private func revokeDevice(_ device: DeviceRecord) async throws -> String {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.revokeDevice(id: device.id)
        tokensByDevice[device.id] = nil
        await load()
        return "Revoked \(device.name)."
    }

    /// Delete a revoked device's row for good, then reload the list. The
    /// gateway refuses while the device still hosts sources; that refusal
    /// reaches the banner as the gateway's own message.
    private func forgetDevice(_ device: DeviceRecord) async throws -> String {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.forgetDevice(id: device.id)
        tokensByDevice[device.id] = nil
        await load()
        return "Forgot \(device.name)."
    }

    /// Force-refetch one device's tokens after a mutation (bypasses the
    /// expand-once cache so the change is visible immediately).
    private func reloadTokens(for deviceId: String) async {
        guard let client = store.admin else { return }
        do {
            tokensByDevice[deviceId] = try await client.listTokens(deviceId: deviceId)
        } catch {
            // Keep the last-known token list on a transient refetch failure
            // rather than clobbering it with an empty (looks-like "No tokens")
            // list; a list pull-to-refresh retries.
        }
    }

    private func load() async {
        if isPreview { return }
        guard let client = store.admin else {
            loadError = URLError(.cannotConnectToHost)
            loading = false
            return
        }
        loading = true
        defer { loading = false }
        do {
            // Newest-paired first, matching the portal's createdAt-desc order.
            devices = try await client.listDevices()
                .sorted { $0.pairedAt > $1.pairedAt }
            loadError = nil
        } catch {
            loadError = error
        }
    }

    /// Fetch a device's tokens the first time its row expands. Cached after,
    /// so collapsing + re-expanding doesn't re-hit the gateway; pull-to-refresh
    /// on the list reloads devices and clears the cache.
    private func loadTokens(for deviceId: String) async {
        if isPreview { return }
        if tokensByDevice[deviceId] != nil { return }
        guard let client = store.admin else { return }
        do {
            tokensByDevice[deviceId] = try await client.listTokens(deviceId: deviceId)
        } catch {
            // Leave the entry absent so the row keeps its loading affordance
            // (not a misleading "No tokens" empty state) and re-expanding the
            // row retries. A per-device error banner would be noise for a
            // read-only inline detail.
        }
    }
}

// MARK: - List (shared with the preview wrapper)

/// Pure layout over a fixed `devices` array (+ a per-device token map) so
/// the snapshot test exercises the same view tree the live screen renders.
/// `onExpand` is called the first time a device row opens, so the wiring
/// view can lazily fetch that device's tokens. The mutation closures
/// (`onRevokeToken` / `onRevokeDevice` / `onForgetDevice`) are
/// supplied by the wiring view; this view owns the last-action-wins notice
/// banner + confirm state.
@available(iOS 17.0, *)
struct DevicesList: View {
    let devices: [DeviceRecord]
    /// Device backing the current app session — pinned as "This device".
    var thisDeviceId: String?
    let tokensByDevice: [String: [TokenRecord]]
    var onExpand: (String) async -> Void = { _ in }
    /// Revoke a token; returns the banner text or throws.
    var onRevokeToken: (String, String) async throws -> String = { _, _ in "" }
    /// Revoke a device; returns the banner text or throws.
    var onRevokeDevice: (DeviceRecord) async throws -> String = { _ in "" }
    /// Forget a revoked device for good; returns the banner text or throws.
    var onForgetDevice: (DeviceRecord) async throws -> String = { _ in "" }
    var onRepairDevice: (DeviceRecord) -> Void = { _ in }

    @State private var notice: Notice?
    /// Other paired devices are collapsed by default to keep the list compact.
    @State private var showOther: Bool
    /// Device queued for a revoke confirm.
    @State private var revokeDeviceConfirm: DeviceRecord?
    /// Revoked device queued for a forget confirm.
    @State private var forgetDeviceConfirm: DeviceRecord?
    /// (tokenId, deviceId) queued for a revoke confirm.
    @State private var revokeTokenConfirm: TokenRef?
    @State private var busy = false

    /// A mutation's result. `deviceId` is the card the message belongs to:
    /// a refusal is rendered inside that device's card, because the only
    /// affordance that can produce one sits in a group the user had to scroll
    /// to and expand, and a banner pinned to the top of the scroll content
    /// would paint off-screen. A message about no single card — a success,
    /// which removes or rewrites the row it concerned — has none and rides
    /// the banner.
    private struct Notice: Equatable {
        let ok: Bool
        let text: String
        var deviceId: String?
    }

    private struct TokenRef: Identifiable, Equatable {
        let tokenId: String
        let deviceId: String
        var id: String {
            tokenId
        }
    }

    /// Preview/snapshot seam: a card-scoped refusal the list starts with, so
    /// the surface a failed mutation produces renders without a gateway.
    struct SeededFailure {
        let deviceId: String
        let text: String
    }

    init(
        devices: [DeviceRecord],
        thisDeviceId: String? = nil,
        tokensByDevice: [String: [TokenRecord]],
        onExpand: @escaping (String) async -> Void = { _ in },
        onRevokeToken: @escaping (String, String) async throws -> String = { _, _ in "" },
        onRevokeDevice: @escaping (DeviceRecord) async throws -> String = { _ in "" },
        onForgetDevice: @escaping (DeviceRecord) async throws -> String = { _ in "" },
        onRepairDevice: @escaping (DeviceRecord) -> Void = { _ in },
        startOtherExpanded: Bool = false,
        seededFailure: SeededFailure? = nil
    ) {
        self.devices = devices
        self.thisDeviceId = thisDeviceId
        self.tokensByDevice = tokensByDevice
        self.onExpand = onExpand
        self.onRevokeToken = onRevokeToken
        self.onRevokeDevice = onRevokeDevice
        self.onForgetDevice = onForgetDevice
        self.onRepairDevice = onRepairDevice
        self._showOther = State(initialValue: startOtherExpanded)
        self._notice = State(
            initialValue: seededFailure.map { Notice(ok: false, text: $0.text, deviceId: $0.deviceId) }
        )
    }

    var body: some View {
        if devices.isEmpty {
            emptyState
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    statsBar
                    if let notice, notice.deviceId == nil {
                        noticeBanner(notice)
                    }
                    let grouped = DeviceGrouping.group(devices, thisDeviceId: thisDeviceId)
                    if let thisDevice = grouped.thisDevice {
                        groupHeader("This device", count: nil)
                        deviceCard(thisDevice, isThis: true)
                    }
                    groupHeader("Live connections", count: grouped.live.count)
                    if grouped.live.isEmpty {
                        Text("No other live connections right now.")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textMuted)
                    } else {
                        ForEach(grouped.live) { device in
                            deviceCard(device, isThis: false)
                        }
                    }
                    if !grouped.other.isEmpty {
                        otherToggle(count: grouped.other.count)
                        if showOther {
                            ForEach(grouped.other) { device in
                                deviceCard(device, isThis: false)
                            }
                        }
                    }
                    footerNote
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.lg)
            }
            .alert(
                "Revoke device?",
                isPresented: Binding(
                    get: { revokeDeviceConfirm != nil },
                    set: { if !$0 { revokeDeviceConfirm = nil } }
                ),
                presenting: revokeDeviceConfirm
            ) { device in
                Button("Revoke", role: .destructive) { runRevokeDevice(device) }
                Button("Cancel", role: .cancel) {}
            } message: { device in
                Text("This revokes \(device.name) and all of its tokens. It must be re-paired to talk to the gateway again.")
            }
            .alert(
                "Forget device?",
                isPresented: Binding(
                    get: { forgetDeviceConfirm != nil },
                    set: { if !$0 { forgetDeviceConfirm = nil } }
                ),
                presenting: forgetDeviceConfirm
            ) { device in
                Button("Forget", role: .destructive) { runForgetDevice(device) }
                Button("Cancel", role: .cancel) {}
            } message: { device in
                Text(
                    "This forgets \(device.name) for good. A device that still hosts sources is refused — remove those sources first."
                )
            }
            .alert(
                "Revoke token?",
                isPresented: Binding(
                    get: { revokeTokenConfirm != nil },
                    set: { if !$0 { revokeTokenConfirm = nil } }
                ),
                presenting: revokeTokenConfirm
            ) { ref in
                Button("Revoke", role: .destructive) { runRevokeToken(ref) }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Any process still using this token will start getting 401s on its next request.")
            }
        }
    }

    private func deviceCard(_ device: DeviceRecord, isThis: Bool) -> some View {
        DeviceCard(
            device: device,
            isThis: isThis,
            tokens: tokensByDevice[device.id],
            failure: failure(for: device),
            onExpand: { await onExpand(device.id) },
            onRevokeDevice: { revokeDeviceConfirm = device },
            onForgetDevice: { forgetDeviceConfirm = device },
            onRepairDevice: { onRepairDevice(device) },
            onRevokeToken: { tokenId in
                revokeTokenConfirm = TokenRef(tokenId: tokenId, deviceId: device.id)
            },
            mutationsDisabled: busy
        )
    }

    /// The last action's message when it failed on this device — the card is
    /// where it belongs, so it lands where the action was taken.
    private func failure(for device: DeviceRecord) -> String? {
        guard let notice, !notice.ok, notice.deviceId == device.id else { return nil }
        return notice.text
    }

    private func groupHeader(_ title: String, count: Int?) -> some View {
        HStack(spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.textMuted)
            if let count {
                countPill(count)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, Theme.Spacing.sm)
    }

    private func countPill(_ n: Int) -> some View {
        Text("\(n)")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.textSecondary)
            .monospacedDigit()
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(Theme.bgTertiary)
            .clipShape(Capsule())
    }

    private func otherToggle(count: Int) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) { showOther.toggle() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: showOther ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
                Text("OTHER DEVICES")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.textMuted)
                countPill(count)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, Theme.Spacing.sm)
    }

    private func runRevokeDevice(_ device: DeviceRecord) {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                notice = try await Notice(ok: true, text: onRevokeDevice(device))
            } catch {
                notice = Notice(
                    ok: false,
                    text: "Revoke failed: \(deviceGatewayMessage(error))",
                    deviceId: device.id
                )
            }
        }
    }

    private func runForgetDevice(_ device: DeviceRecord) {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                notice = try await Notice(ok: true, text: onForgetDevice(device))
            } catch {
                notice = Notice(ok: false, text: forgetFailureText(error), deviceId: device.id)
            }
        }
    }

    private func runRevokeToken(_ ref: TokenRef) {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                notice = try await Notice(ok: true, text: onRevokeToken(ref.tokenId, ref.deviceId))
            } catch {
                notice = Notice(
                    ok: false,
                    text: "Revoke failed: \(deviceGatewayMessage(error))",
                    deviceId: ref.deviceId
                )
            }
        }
    }

    /// The gateway refuses to delete a device that still hosts sources. Its
    /// own message names the sources by id and points at a CLI command, which
    /// is neither readable nor actionable on a phone: the remedy here is the
    /// Sources screen. Every other refusal keeps the gateway's wording.
    private func forgetFailureText(_ error: Error) -> String {
        if let gatewayError = error as? GatewayClient.Error,
           gatewayError.gatewayCode == Self.deviceStillHostsSourcesCode {
            return "This device still hosts sources. Remove them from the Sources screen first, then forget it."
        }
        return "Forget failed: \(deviceGatewayMessage(error))"
    }

    /// The gateway's refusal code for forgetting a device that sources still
    /// point at (`DELETE /admin/devices/:id?forget=true`).
    private static let deviceStillHostsSourcesCode = "DEVICE_STILL_HOSTS_SOURCES"

    private func noticeBanner(_ notice: Notice) -> some View {
        Text(notice.text)
            .font(.system(size: 12))
            .foregroundStyle(notice.ok ? Theme.success : Theme.danger)
            .padding(Theme.Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((notice.ok ? Theme.success : Theme.danger).opacity(0.10))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.medium)
                    .stroke((notice.ok ? Theme.success : Theme.danger).opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "laptopcomputer.and.iphone")
                .font(.system(size: 36))
                .foregroundStyle(Theme.textMuted)
            Text("No devices")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text("Paired phones, collectors, and CLI sessions show up here once they connect to the gateway.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var statsBar: some View {
        let live = DeviceGrouping.liveConnectionCount(devices)
        let revoked = DeviceGrouping.revokedCount(devices)
        return HStack(spacing: Theme.Spacing.md) {
            statChip(value: devices.count, label: devices.count == 1 ? "device" : "devices")
            statChip(value: live, label: live == 1 ? "live connection" : "live connections")
            if revoked > 0 {
                statChip(value: revoked, label: "revoked")
            }
            Spacer(minLength: 0)
        }
    }

    private func statChip(value: Int, label: String) -> some View {
        HStack(spacing: 4) {
            Text("\(value)")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .monospacedDigit()
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)
        }
    }

    private var footerNote: some View {
        Text("Tap a device to see its credentials.")
            .font(.system(size: 11))
            .foregroundStyle(Theme.textMuted)
            .padding(.top, Theme.Spacing.sm)
    }
}

/// Map a transport error to a short human message for the inline banners.
/// Shared by the device-management mutation surfaces.
@available(iOS 17.0, *)
func deviceGatewayMessage(_ error: Error) -> String {
    guard let gatewayError = error as? GatewayClient.Error else { return error.localizedDescription }
    return switch gatewayError {
    case .unauthorized: "not authorized"
    case .forbidden: "this device lacks admin scope"
    case .internalSource: "not available for gateway-hosted sources"
    case .notFound: "no longer exists"
    case .serverError(_, let body): gatewayError.gatewayMessage ?? (body.isEmpty ? "server error" : body)
    case .invalidResponse, .invalidURL: "bad gateway response"
    case .decoding: "could not read the response"
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("Devices — list") {
    NavigationStack {
        DevicesView(
            previewDevices: PreviewMocks.devices,
            previewTokens: PreviewMocks.deviceTokens
        )
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Devices — with a revoked device") {
    NavigationStack {
        DevicesView(
            previewDevices: PreviewMocks.devicesWithRevoked,
            previewTokens: PreviewMocks.deviceTokens
        )
    }
    .environment(AppStore.preview())
}
#endif
#endif
