// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// A destination within the Settings sheet. `.root` presents Settings itself;
/// the other cases seed the same navigation stack one level deep for setup
/// shortcuts such as the agent's "Set up agent model" action.
@available(iOS 17.0, *)
enum SettingsDestination: Hashable, Identifiable {
    case root
    case permissions(sourceId: String?)
    case remotePermissions(
        sourceId: String,
        deviceId: String,
        sourceName: String,
        deviceName: String
    )
    case models(initialRole: String?)
    case devices
    case notifications
    /// Every policy a grant can be judged against, listed. Sits beside
    /// Devices because both answer "what has this gateway agreed to".
    case policies
    /// One policy's read-only text, opened from the list. Carries the name so
    /// the screen is titled before the document arrives.
    case policy(familyId: String, name: String?)
    /// Developer mode only: the HealthKit sample-uuid probe.
    case healthSamples

    var id: String {
        switch self {
        case .root: "root"
        case .permissions(let sourceId): "permissions:\(sourceId ?? "all")"
        case .remotePermissions(let sourceId, let deviceId, _, _):
            "remote-permissions:\(sourceId):\(deviceId)"
        case .models(let initialRole): "models:\(initialRole ?? "all")"
        case .devices: "devices"
        case .notifications: "notifications"
        case .policies: "policies"
        case .policy(let familyId, _): "policy:\(familyId)"
        case .healthSamples: "health-samples"
        }
    }
}

/// Unified Settings sheet. Its Gateway section owns model and device
/// management alongside connection identity / URL / re-pair / unpair, then
/// the phone-source sections own their respective on-device settings. Every
/// enabled phone source includes its own authoritative status and Sync-now;
/// source-specific permission and configuration controls remain beside it.
@available(iOS 17.0, *)
struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.appearanceStore) private var appearance
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var urlString: String = ""
    @State private var saveError: String?
    @State private var showUnpairConfirm = false
    @State private var showRepairConfirm = false
    @State private var editingURL = false
    @State private var observedClaimReason: NotificationClaimDiagnostic.Reason?
    /// Why a switch just snapped back: its source can't be turned on here.
    @State private var turnOnNotices: [String: String] = [:]
    @State private var departure = LocalSourceDepartureRequest()
    @State private var pendingDepartureAction: (() async -> Void)?
    @State private var showMoodConsentAlert: Bool
    @State private var showAccessAuthorization = false
    @State private var path: [SettingsDestination]
    private let destinationMode: DestinationMode
    #if DEBUG
    private let previewClaimReason: NotificationClaimDiagnostic.Reason?
    #endif

    private enum DestinationMode: Equatable {
        case live
        #if DEBUG
        case preview
        #endif
    }

    /// `previewMoodConsentAlertPresented` exists only so a `#Preview`
    /// can render the consent alert without a user tap — production
    /// call sites all use the default.
    init(
        initialDestination: SettingsDestination = .root,
        previewMoodConsentAlertPresented: Bool = false
    ) {
        _showMoodConsentAlert = State(initialValue: previewMoodConsentAlertPresented)
        _path = State(initialValue: initialDestination == .root ? [] : [initialDestination])
        destinationMode = .live
        #if DEBUG
        previewClaimReason = nil
        #endif
    }

    #if DEBUG
    /// Runs the production Settings navigation stack with deterministic child
    /// data, allowing pushed Models / Devices chrome to be snapshotted without
    /// making gateway requests.
    init(
        initialDestination: SettingsDestination,
        previewData: Bool,
        previewMoodConsentAlertPresented: Bool = false,
        previewClaimReason: NotificationClaimDiagnostic.Reason? = nil
    ) {
        _showMoodConsentAlert = State(initialValue: previewMoodConsentAlertPresented)
        _path = State(initialValue: initialDestination == .root ? [] : [initialDestination])
        destinationMode = previewData ? .preview : .live
        self.previewClaimReason = previewClaimReason
    }
    #endif

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                permissionHealthSection
                pushHealthSection

                appearanceSection

                gatewaySection

                if !store.pendingLocalSourceDepartures.isEmpty {
                    Section("Departure pending") {
                        ForEach(store.pendingLocalSourceDepartures.sorted(), id: \.self) { sourceId in
                            Text(pushHealthLabel(for: sourceId)).font(.headline)
                        }
                        Text("Uploads are stopped on this iPhone. The gateway has not confirmed the departure. "
                            + "The queued request retries on reconnect and may delete this device's partition. "
                            +
                            "Turning the source back on replaces a request that has not started; it cannot undo deletion already underway.")
                    }
                }

                if !store.pendingLocalSourceResumes.isEmpty {
                    Section("Activation pending") {
                        ForEach(store.pendingLocalSourceResumes.sorted(), id: \.self) { sourceId in
                            Text(pushHealthLabel(for: sourceId)).font(.headline)
                        }
                        Text("This iPhone is waiting for the gateway to enable its contribution. "
                            + "The stored request retries on reconnect, including after source removal cleanup finishes.")
                    }
                }

                notificationsSection

                phoneSetupSection

                if store.appleHealthEnabled {
                    appleHealthSection
                } else {
                    Section {
                        appleHealthEnableCard
                            .disabled(!canTurnOn(AppleHealthSetupStep.sourceId))
                        localSourceIssue(AppleHealthSetupStep.sourceId)
                        PhoneSetupWhatsSent(copy: AppleHealthSetupStep.copy)
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
                }

                activitySegmentsSection

                coreLocationVisitsSection

                if store.photosEnabled {
                    photosSection
                } else {
                    Section {
                        photosEnableCard
                            .disabled(!canTurnOn(PhotosSetupStep.sourceId))
                        localSourceIssue(PhotosSetupStep.sourceId)
                        PhoneSetupWhatsSent(copy: PhotosSetupStep.copy)
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
                }

                aboutSection

                if let err = store.lastError {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.danger)
                    }
                    .listRowBackground(Theme.bgSecondary)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bgPrimary)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            #if DEBUG
                // Scrolled store artwork needs opaque chrome: otherwise Form
                // text beneath the translucent status bar can visually erase
                // parts of the iPad clock in the captured bitmap.
                .toolbarBackground(
                    Self.storeArtworkMode ? Theme.bgPrimary : Color.clear,
                    for: .navigationBar
                )
                .toolbarBackground(Self.storeArtworkMode ? .visible : .automatic, for: .navigationBar)
            #endif
                .toolbar {
                    if path.isEmpty {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { dismiss() }
                                .tint(Theme.accent)
                        }
                    }
                }
                .navigationDestination(for: SettingsDestination.self) { destination in
                    destinationView(destination)
                }
                .alert("Unpair this device?", isPresented: $showUnpairConfirm) {
                    Button("Unpair", role: .destructive) {
                        Task {
                            await store.unpair()
                            dismiss()
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text(
                        "Existing health samples on your gateway stay where they are. "
                            + "You'll need to scan a fresh pairing QR from the gateway CLI to resume syncing."
                    )
                }
                .alert("Re-pair with gateway?", isPresented: $showRepairConfirm) {
                    Button("Re-pair", role: .destructive) {
                        Task {
                            await store.beginRepair()
                            dismiss()
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text(
                        "Buffered batches will be discarded and the app will reopen the pairing QR scanner. "
                            + "HealthKit permissions stay granted."
                    )
                }
                .alert("Save failed", isPresented: Binding(
                    get: { saveError != nil },
                    set: { if !$0 { saveError = nil } }
                )) {
                    Button("OK", role: .cancel) { saveError = nil }
                } message: {
                    Text(saveError ?? "")
                }
                .onAppear {
                    urlString = store.pairing?.url.absoluteString ?? ""
                }
                .task {
                    guard destinationMode == .live else { return }
                    // Re-read notification settings on open — the user may have
                    // changed permission / Scheduled Summary in iOS Settings.
                    await store.refreshPushDeliveryHealth()
                    await store.refreshPushGatewayConfiguration()
                    await store.refreshSourcePermissionHealth()
                    await store.refreshSources()
                }
                .task(id: scenePhase) {
                    guard destinationMode == .live, scenePhase == .active else { return }
                    while !Task.isCancelled {
                        observedClaimReason = NotificationClaimDiagnostic.current()
                        do {
                            try await Task.sleep(for: .seconds(5))
                        } catch {
                            break
                        }
                    }
                }
                .refreshable {
                    await store.syncAll()
                    await store.refreshSourcePermissionHealth()
                    await store.refreshSources()
                }
                .sheet(isPresented: departurePresented) {
                    SourceDepartureConfirmation(sourceName: departure.sourceId.map(pushHealthLabel(for:)) ?? "Source") {
                        guard departure.confirm() != nil, let action = pendingDepartureAction else { return }
                        pendingDepartureAction = nil
                        Task { await action() }
                    }
                }
                .sheet(isPresented: $showAccessAuthorization) {
                    AccessAuthorizationSheet()
                        .environment(store)
                        .omnesisColorScheme()
                }
        }
        .environment(\.returnToSettingsRoot) {
            path.removeAll()
        }
        // A source whose row can be turned on again, as after changing access
        // in iOS Settings, no longer says why it couldn't.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            turnOnNotices = turnOnNotices.filter { store.phoneSetup.unavailableReason(for: $0.key) != nil }
        }
        .phoneSetupCover(store.phoneSetup, presentations: [.settings, .settingsStep])
        .omnesisColorScheme()
    }

    #if DEBUG
    private static var storeArtworkMode: Bool {
        ProcessInfo.processInfo.environment["DEMO_SETTINGS_PREVIEW"] == "1"
    }
    #endif

    @ViewBuilder
    private func destinationView(_ destination: SettingsDestination) -> some View {
        switch destination {
        case .root:
            EmptyView()
        case .permissions(let sourceId):
            SourcePermissionHealthView(focusedSourceId: sourceId)
        case .remotePermissions(let sourceId, let deviceId, let sourceName, let deviceName):
            RemoteSourcePermissionView(
                sourceId: sourceId,
                deviceId: deviceId,
                sourceName: sourceName,
                deviceName: deviceName
            )
        case .models(let initialRole):
            #if DEBUG
            if destinationMode == .preview {
                ModelsView(
                    previewOverview: ModelsPreviewData.overview(),
                    previewSystem: ModelsPreviewData.systemInfo(),
                    initialPickerRole: initialRole
                )
            } else {
                ModelsView(initialPickerRole: initialRole)
            }
            #else
            ModelsView(initialPickerRole: initialRole)
            #endif
        case .devices:
            #if DEBUG
            if destinationMode == .preview {
                DevicesView(
                    previewDevices: PreviewMocks.devices,
                    previewTokens: PreviewMocks.deviceTokens
                )
            } else {
                DevicesView()
            }
            #else
            DevicesView()
            #endif
        case .notifications:
            Form { notificationsSection }
                .scrollContentBackground(.hidden)
                .background(Theme.bgPrimary)
                .navigationTitle("Notifications")
                .navigationBarTitleDisplayMode(.inline)
        case .policies:
            #if DEBUG
            if destinationMode == .preview {
                PoliciesListView(previewFamilies: PreviewMocks.privacyPolicyFamilies)
            } else {
                PoliciesListView()
            }
            #else
            PoliciesListView()
            #endif
        case .policy(let familyId, let name):
            #if DEBUG
            if destinationMode == .preview {
                PrivacyPolicyScreen(previewPolicy: PreviewMocks.privacyPolicyFamily, name: name)
            } else {
                PrivacyPolicyScreen(familyId: familyId, name: name)
            }
            #else
            PrivacyPolicyScreen(familyId: familyId, name: name)
            #endif
        case .healthSamples:
            #if canImport(HealthKit)
            #if DEBUG
            if destinationMode == .preview {
                HealthSampleProbeView(previewRows: PreviewMocks.healthSampleProbeRows)
            } else {
                HealthSampleProbeView()
            }
            #else
            HealthSampleProbeView()
            #endif
            #else
            EmptyView()
            #endif
        }
    }

    // MARK: - Push health

    @ViewBuilder
    private var permissionHealthSection: some View {
        if !store.degradedSourcePermissions.isEmpty {
            Section {
                NavigationLink(value: SettingsDestination.permissions(sourceId: nil)) {
                    Label(
                        "Fix source permissions (\(store.degradedSourcePermissions.count))",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(Theme.warning)
                }
            } header: {
                Text("Data sources")
            }
            .listRowBackground(Theme.bgSecondary)
        }
    }

    /// Resolve a source id to a display name for the push-health banner:
    /// the gateway's descriptor label when known, else the shared type→name
    /// map. A source blocked from its very first push has no sync-state row
    /// yet, so the descriptor label is usually absent exactly here — without
    /// the fallback the banner would show a raw `<type>:<account>` id.
    private func pushHealthLabel(for sourceId: String) -> String {
        if let label = store.sourceLabel(forSourceId: sourceId) { return label }
        return humanName(for: sourceTypeOf(sourceId))
    }

    /// Sits above everything else because it reports data that is *not*
    /// reaching Omnesis — a state every other row on this screen would
    /// otherwise render as healthy.
    @ViewBuilder
    private var pushHealthSection: some View {
        if !PushHealth.isHealthy(
            blockedSourceIds: store.blockedSourceIds,
            oldestBufferedAge: store.oldestBufferedAge,
            quarantinedBatches: store.quarantinedBatches
        ) {
            Section {
                PushHealthBanner(
                    blockedSourceIds: store.blockedSourceIds,
                    bufferedBatches: store.bufferedBatches,
                    oldestBufferedAge: store.oldestBufferedAge,
                    quarantinedBatches: store.quarantinedBatches,
                    labelForSourceId: pushHealthLabel(for:),
                    retryPhase: store.pushRetryPhase,
                    onRetry: { Task { await store.retryPushDelivery() } },
                    onDiscardUndelivered: { Task { await store.discardQuarantined() } }
                )
            }
            .listRowBackground(Theme.bgSecondary)
        }
    }

    // MARK: - Appearance

    /// Light / Dark / System picker. Writes straight to the shared
    /// `AppearanceStore`, which persists the choice and re-themes every
    /// surface (including this sheet) live.
    private var appearanceSection: some View {
        Section {
            Picker(
                "Theme",
                selection: Binding(
                    get: { appearance.mode },
                    set: { appearance.mode = $0 }
                )
            ) {
                ForEach(AppearanceMode.allCases, id: \.self) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)
        } header: {
            Text("Appearance")
        } footer: {
            Text("Light, Dark, or follow the system setting. Dark is the default.")
        }
        .listRowBackground(Theme.bgSecondary)
    }

    // MARK: - Apple Health hero (when disabled)

    private var appleHealthEnableCard: some View {
        Button {
            turnOn(AppleHealthSetupStep.sourceId)
        } label: {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(spacing: 12) {
                    Image(systemName: "heart.text.square.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(Theme.success)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Enable Apple Health")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                        Text("Sync your iPhone's Health data to Omnesis.")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                }
                HStack(spacing: 6) {
                    healthChip("figure.run", "Activity")
                    healthChip("heart.fill", "Vitals")
                    healthChip("bed.double.fill", "Sleep")
                    healthChip("ellipsis", "+5")
                }
            }
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(
                    colors: [Theme.success.opacity(0.10), Theme.bgSecondary],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.large)
                    .stroke(Theme.success.opacity(0.35), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
        }
        .buttonStyle(.plain)
    }

    private func healthChip(_ icon: String, _ label: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 9))
                .foregroundStyle(Theme.success)
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Theme.bgTertiary)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    // MARK: - Apple Health card (enabled)

    /// Apple Health's source status, master toggle, permission re-prompt, the
    /// per-category toggles, and the background-sync hint.
    private var appleHealthSection: some View {
        Section {
            localSourceSyncRow(sourceId: "apple-health:local")

            Toggle("Apple Health", isOn: Binding(
                get: { store.appleHealthEnabled },
                set: { newValue in
                    if newValue {
                        turnOn(AppleHealthSetupStep.sourceId)
                    } else {
                        proposeDeparture("apple-health:local") { await store.disableAppleHealth() }
                    }
                }
            ))
            .disabled(!canTurnOn(AppleHealthSetupStep.sourceId))
            localSourceIssue(AppleHealthSetupStep.sourceId)
            Button("Re-run HealthKit permission prompt") {
                Task { await store.requestHealthKitAuthorization() }
            }

            ForEach(HealthCategory.allCases, id: \.self) { category in
                Toggle(category.displayName, isOn: categoryBinding(for: category))
            }
            PhoneSetupWhatsSent(copy: AppleHealthSetupStep.copy)

            VStack(alignment: .leading, spacing: 8) {
                Label("Keep Omnesis in your app switcher", systemImage: "square.stack.3d.up.fill")
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
                Text(
                    "iOS pauses background health sync for force-quit apps. Swiping Omnesis out of the "
                        + "app switcher stops new data from flowing until you open it again."
                )
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
            }
        } header: {
            Text("Apple Health")
        } footer: {
            Text(Self.appleHealthFooterText)
        }
        .listRowBackground(Theme.bgSecondary)
        .alert(AppleHealthSetupStep.consentTitle, isPresented: $showMoodConsentAlert) {
            Button("Enable", role: .destructive) { store.setCategory(.mood, enabled: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(AppleHealthSetupStep.consentMessage)
        }
    }

    // MARK: - Photos hero (when disabled)

    private var photosEnableCard: some View {
        Button {
            turnOn(PhotosSetupStep.sourceId)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "photo.stack.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Enable Photos")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text("OCR your photo library on-device for private search. No image ever leaves your phone.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(
                    colors: [Theme.accent.opacity(0.10), Theme.bgSecondary],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.large)
                    .stroke(Theme.accent.opacity(0.35), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Photos card (enabled)

    private var photosSection: some View {
        Section {
            localSourceSyncRow(sourceId: "photos:local")
            Toggle("Photos", isOn: Binding(
                get: { store.photosEnabled },
                set: { newValue in
                    if newValue {
                        turnOn(PhotosSetupStep.sourceId)
                    } else {
                        proposeDeparture("photos:local") { await store.disablePhotos() }
                    }
                }
            ))
            .disabled(!canTurnOn(PhotosSetupStep.sourceId))
            localSourceIssue(PhotosSetupStep.sourceId)
            if store.photosAccess == .limited {
                PhotosLimitedAccessRow()
            }
            PhoneSetupWhatsSent(copy: PhotosSetupStep.copy)
        } header: {
            Text("Photos")
        } footer: {
            Text(Self.photosFooterText)
        }
        .listRowBackground(Theme.bgSecondary)
    }

    private var departurePresented: Binding<Bool> {
        Binding(
            get: { departure.sourceId != nil },
            set: { isPresented in
                guard !isPresented else { return }
                departure.cancel()
                pendingDepartureAction = nil
            }
        )
    }

    private func proposeDeparture(_ sourceId: String, action: @escaping () async -> Void) {
        pendingDepartureAction = action
        departure.propose(sourceId)
    }

    private static let photosFooterText =
        "Screenshots and photos are OCR'd and analyzed entirely on-device — only extracted text "
            + "and metadata are sent to your gateway, never images. Geotagged photos are "
            + "reverse-geocoded to a place name, which may use your phone's location service. "
            + "New photos process quickly; the full library backfill happens gradually in "
            + "priority order (screenshots, then recent, then the rest). " + localDepartureFooter

    private static let localDepartureFooter =
        "Turning this off requests a device detach, not a pause. You will review its data consequences before confirming. "
            + "Use Pause sync in the source details to keep data and cursors while stopping ingestion for the whole source."

    private static let appleHealthFooterText =
        "Disabled categories are skipped even if iOS still has access to them. " + localDepartureFooter

    private static let activitySegmentsFooterText =
        "Uses your iPhone's motion coprocessor to log contiguous stretches of stationary, "
            + "walking, running, driving, and cycling time. iOS asks for Motion & Fitness access when you turn this on. "
            + localDepartureFooter

    private static let coreLocationVisitsFooterText =
        "Records the places you spend time — arrivals and departures — and turns each into a named "
            + "place on your device. The name, arrival and departure times, coordinates, accuracy, and "
            + "place details are sent to your paired gateway; searchable summaries omit raw coordinates. "
            + "iOS will ask to always allow location so visits can be recorded in the background. " + localDepartureFooter

    @ViewBuilder
    private func localSourceSyncRow(sourceId: String) -> some View {
        let status = store.localSyncStatus(sourceId: sourceId)
        let syncing = status?.state == "syncing"
        HStack(spacing: 10) {
            if syncing {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: syncStatusIcon(status))
                    .foregroundStyle(syncStatusColor(status))
                    .imageScale(.large)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 2) {
                    Text(LocalSyncStatusText.headline(status))
                        .font(.headline)
                        .foregroundStyle(.primary)
                    SourceNoticeIcons(notices: status?.displayNotices ?? [], deviceName: "This iPhone")
                }
                TimelineView(.periodic(from: .now, by: 30)) { _ in
                    if let detail = syncStatusDetail(status) {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
            Spacer()
            if !syncing {
                Button {
                    Task { await store.syncSource(sourceId: sourceId) }
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 18, weight: .semibold))
                }
                .buttonStyle(.borderless)
                .disabled(store.pairing == nil)
                .accessibilityLabel("Sync now")
            }
        }
    }

    /// Progress or the last-sync time. What is wrong is behind the notice
    /// icon beside the headline, never in this line.
    private func syncStatusDetail(_ status: SourceSyncStatus?) -> String? {
        if status?.state == "syncing", let processed = status?.progress?.processed {
            return "\(processed.formatted()) processed"
        }
        if let last = formatTimeAgo(status?.lastSyncAt) { return "Last synced \(last)" }
        return nil
    }

    private func syncStatusIcon(_ status: SourceSyncStatus?) -> String {
        switch status?.state {
        case nil, "idle": "clock"
        case "error": "xmark.circle.fill"
        case "needs-auth", "auth-expiring", "rate-limited", "stale", "paused", "disabled", "unavailable", "permission-degraded",
             "background-access-missing":
            "exclamationmark.triangle.fill"
        default: "checkmark.circle.fill"
        }
    }

    private func syncStatusColor(_ status: SourceSyncStatus?) -> Color {
        switch status?.state {
        case nil, "idle": .secondary
        case "error": Theme.danger
        case "needs-auth", "auth-expiring", "rate-limited", "stale", "paused", "disabled", "unavailable", "permission-degraded",
             "background-access-missing":
            Theme.warning
        default: Theme.success
        }
    }

    /// Live WS connection state — flips immediately when the socket
    /// drops, beats an on-appear HTTP probe.
    @ViewBuilder
    private var connectionRow: some View {
        switch store.wsState {
        case .disconnected, .connecting, .authenticating:
            HStack {
                ProgressView().controlSize(.small)
                Text("Connecting…").foregroundStyle(.secondary)
            }
        case .connected:
            Label("Connected", systemImage: "checkmark.circle.fill")
                .foregroundStyle(Theme.success)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 6) {
                Label("Gateway connection failed", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                Text(
                    "Away from home? Connect Tailscale on this phone and the gateway. If this pairing uses a home-network address, re-pair using the gateway's Tailscale hostname."
                )
                .font(.footnote)
                .foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Gateway

    /// Gateway-owned configuration, connection identity, edit-URL escape
    /// hatch, and destructive re-pair / unpair actions in one place.
    private var gatewaySection: some View {
        Section {
            if let pairing = store.pairing {
                LabeledContent("Name", value: pairing.gatewayName)

                if editingURL {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField(
                            "https://gateway.example.com",
                            text: $urlString,
                            axis: .vertical
                        )
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .keyboardType(.URL)

                        HStack {
                            Button("Save") { saveURL() }
                                .disabled(urlString.isEmpty)
                            Spacer()
                            Button("Cancel") {
                                urlString = pairing.url.absoluteString
                                editingURL = false
                            }
                            .foregroundStyle(.secondary)
                        }
                    }
                } else {
                    HStack {
                        LabeledContent("URL", value: pairing.url.absoluteString)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if pairing.tlsMode != .system {
                            Button("Edit") {
                                urlString = pairing.url.absoluteString
                                editingURL = true
                            }
                            .font(.callout)
                            .buttonStyle(.borderless)
                        }
                    }
                }

                connectionRow
            }

            NavigationLink(value: SettingsDestination.models(initialRole: nil)) {
                Label("Configure Models", systemImage: "cube")
            }
            NavigationLink(value: SettingsDestination.devices) {
                Label("Configure Devices", systemImage: "laptopcomputer.and.iphone")
            }
            // "Policies", not "Privacy Policy": the App Store privacy policy
            // linked further down this screen is a different document, and two
            // rows with near-identical names would be read as the same thing.
            NavigationLink(value: SettingsDestination.policies) {
                Label("Policies", systemImage: "doc.text")
            }
            Button {
                showAccessAuthorization = true
            } label: {
                Label("Authorize an MCP connection", systemImage: "person.badge.key")
            }
            if store.developerEnabled {
                NavigationLink(value: SettingsDestination.healthSamples) {
                    Label("Health sample probe", systemImage: "waveform.path.ecg")
                }
            }

            Button("Re-pair with gateway") {
                showRepairConfirm = true
            }
            Button("Unpair", role: .destructive) {
                showUnpairConfirm = true
            }
        } header: {
            Text("Gateway")
        } footer: {
            switch store.pairing?.tlsMode {
            case .system:
                Text(
                    "This pairing uses system HTTPS verification. Re-pair to change its URL. "
                        + "Re-pair wipes the token + buffered batches and scans a new QR."
                )
            case .pinnedLeaf:
                Text(
                    "Omnesis requires HTTPS. Edit the URL only when the same certificate-pinned "
                        + "gateway moves; re-pair if the gateway or certificate was replaced."
                )
            case .legacy:
                Text(
                    "This legacy pairing uses HTTPS with system verification. Re-pair to upgrade "
                        + "its trust settings before changing the gateway URL."
                )
            case nil:
                EmptyView()
            }
        }
        .listRowBackground(Theme.bgSecondary)
    }

    private func saveURL() {
        guard let url = URL(string: urlString), url.scheme != nil else {
            saveError = "Not a valid URL"
            return
        }
        do {
            try PairingService().updateGatewayURL(url)
            store.reload()
            editingURL = false
        } catch {
            if case PairingPayloadError.invalidShape(let message) = error {
                saveError = message
            } else {
                saveError = error.localizedDescription
            }
        }
    }
}

/// Explicit first-level back control for gateway configuration pages. Keeping
/// "Settings" visible makes the hierarchy unambiguous while `dismiss()` still
/// performs a normal one-level stack pop.
@available(iOS 17.0, *)
struct SettingsBackButton: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Button { dismiss() } label: {
            HStack(spacing: 4) {
                Image(systemName: "chevron.left")
                Text("Settings")
            }
        }
        .accessibilityLabel("Back to Settings")
    }
}

/// Split into its own extension to keep `SettingsView`'s primary body
/// under SwiftLint's `type_body_length` threshold.
@available(iOS 17.0, *)
extension SettingsView {
    /// Binding for one Apple Health category toggle. Every category
    /// flips straight through except Mood, which carries mental-health
    /// self-reports: turning it ON routes through a confirmation alert
    /// first — the getter keeps reflecting the store's actual (still
    /// off) state until the user confirms, so the switch settles back
    /// to off if they cancel. Turning a category off never needs
    /// confirmation.
    private func categoryBinding(for category: HealthCategory) -> Binding<Bool> {
        Binding(
            get: { store.enabledCategories.contains(category) },
            set: { newValue in
                if category == .mood, newValue {
                    showMoodConsentAlert = true
                } else {
                    store.setCategory(category, enabled: newValue)
                }
            }
        )
    }

    // MARK: - Activity Segments

    /// Single master toggle — unlike Apple Health there are no
    /// per-category sub-toggles, so this is one row plus an explainer,
    /// not a whole opt-in hero card.
    // MARK: - Notifications

    private var notificationsSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Label(gatewayPushStatus.title, systemImage: gatewayPushStatus.symbol)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(gatewayPushStatus.isWarning ? Theme.warning : Theme.textPrimary)
                Text(gatewayPushStatus.detail)
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                if case .noDirectCredential = store.pushGatewayConfiguration,
                   let appId = store.pushConfigurationAppId {
                    Text(appId)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let warning = store.pushDeliveryHealth.warning {
                Label(warning.title, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                Text(warning.detail)
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                if store.pushDeliveryHealth == .notDetermined {
                    Button {
                        Task { await store.requestNotificationPermission() }
                    } label: {
                        Label("Turn on notifications", systemImage: "bell.badge")
                    }
                    .tint(Theme.accent)
                    .disabled(store.pairing == nil)
                } else {
                    Button {
                        openIOSSettings()
                    } label: {
                        Label("Open iOS Settings", systemImage: "arrow.up.forward.app")
                    }
                    .tint(Theme.accent)
                }
            }
            if let failure = store.pushRegistrationFailure {
                Label("Apple push registration failed", systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                Text("iOS could not register this app with Apple: \(failure). "
                    + "Check the Push Notifications capability and provisioning profile, then try again.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let failure = store.pushGatewayRegistrationFailure {
                Label("Gateway push registration failed", systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if store.pairing != nil, let reason = claimDiagnostic {
                Label("Recent notification text issue", systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                Text(reason.detail)
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Retry push registration") {
                Task { await store.requestPushAndRegister() }
            }
            .disabled(store.pairing == nil)
            Link("Notification setup guide", destination: URL(string: "https://omnesis.dev/docs/notifications")!)
        } header: {
            Text("Push delivery")
        }
        .listRowBackground(Theme.bgSecondary)
    }

    private var claimDiagnostic: NotificationClaimDiagnostic.Reason? {
        #if DEBUG
        if let previewClaimReason { return previewClaimReason }
        #endif
        return observedClaimReason
    }

    private struct GatewayPushStatus {
        let title: String
        let detail: String
        let symbol: String
        let isWarning: Bool

        init(_ title: String, _ detail: String, _ symbol: String, _ isWarning: Bool) {
            self.title = title
            self.detail = detail
            self.symbol = symbol
            self.isWarning = isWarning
        }
    }

    private var gatewayPushStatus: GatewayPushStatus {
        switch store.pushGatewayConfiguration {
        case .notChecked:
            GatewayPushStatus(
                "Push setup not checked",
                store.pairing == nil
                    ? "Pair with a gateway to check background notification setup."
                    : "The gateway push plan has not been checked for this app. Check again below.",
                "bell",
                false
            )
        case .checking:
            GatewayPushStatus(
                "Checking push setup",
                "Asking the gateway which Apple push path it would use for this app.",
                "arrow.triangle.2.circlepath",
                false
            )
        case .direct:
            GatewayPushStatus(
                "Direct Apple push configured",
                "Your gateway selected direct Apple push. Background delivery has not been verified.",
                "checkmark.circle",
                false
            )
        case .relay:
            GatewayPushStatus(
                "Relay push selected",
                "Your gateway selected the official relay. Background delivery has not been verified.",
                "checkmark.circle",
                false
            )
        case .relayConsentRequired:
            GatewayPushStatus(
                "Relay consent needed",
                "Allow the official relay to send private notification wakes for this app. "
                    + "You can continue using Omnesis without it.",
                "hand.raised",
                true
            )
        case .noDirectCredential:
            GatewayPushStatus(
                "Background notifications aren't configured",
                "Your gateway has no Apple push credentials for this app. Run `omnesis push setup` "
                    + "on your gateway host, selecting iOS and the app identifier below.",
                "exclamationmark.triangle.fill",
                true
            )
        case .unavailable(let reason):
            GatewayPushStatus("Background notifications unavailable", reason, "exclamationmark.triangle.fill", true)
        case .gatewayUnavailable:
            GatewayPushStatus(
                "Couldn't check push setup",
                "The app could not get a valid push plan from the gateway. "
                    + "Reconnect and check again; its Apple push configuration is unknown.",
                "wifi.exclamationmark",
                true
            )
        case .planUnavailable:
            GatewayPushStatus(
                "Push plan unavailable",
                "This gateway cannot provide a push plan for this device. "
                    + "Update the gateway or repair pairing, then check again.",
                "questionmark.circle",
                true
            )
        case .legacyGateway:
            GatewayPushStatus(
                "Push setup not reported",
                "This gateway does not report push selection. Background delivery has not been verified.",
                "questionmark.circle",
                false
            )
        }
    }

    private func openIOSSettings() {
        #if canImport(UIKit)
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
        #endif
    }

    private var activitySegmentsSection: some View {
        Section {
            if store.activitySegmentsEnabled {
                localSourceSyncRow(sourceId: "activity-segments:local")
            }
            Toggle("Movement", isOn: Binding(
                get: { store.activitySegmentsEnabled },
                set: { newValue in
                    if newValue {
                        turnOn(MovementSetupStep.sourceId)
                    } else {
                        proposeDeparture("activity-segments:local") { await store.disableActivitySegments() }
                    }
                }
            ))
            .disabled(!canTurnOn(MovementSetupStep.sourceId))
            localSourceIssue(MovementSetupStep.sourceId)
            PhoneSetupWhatsSent(copy: MovementSetupStep.copy)
        } header: {
            Text("Movement")
        } footer: {
            Text(Self.activitySegmentsFooterText)
        }
        .listRowBackground(Theme.bgSecondary)
    }

    // MARK: - Places

    private var coreLocationVisitsSection: some View {
        Section {
            if store.coreLocationVisitsEnabled {
                localSourceSyncRow(sourceId: "core-location-visits:local")
            }
            Toggle("Places", isOn: Binding(
                get: { store.coreLocationVisitsEnabled },
                set: { newValue in
                    if newValue {
                        turnOn(PlacesSetupStep.sourceId)
                    } else {
                        proposeDeparture("core-location-visits:local") { await store.disableCoreLocationVisits() }
                    }
                }
            ))
            .disabled(!canTurnOn(PlacesSetupStep.sourceId))
            if store.coreLocationVisitsEnabled, store.locationVisitsPermission == .notDetermined {
                Button("Allow location") {
                    Task { _ = await store.requestLocationVisitsPermission() }
                }
            }
            localSourceIssue(PlacesSetupStep.sourceId)
            PhoneSetupWhatsSent(copy: PlacesSetupStep.copy)
        } header: {
            Text("Places")
        } footer: {
            Text(Self.coreLocationVisitsFooterText)
        }
        .listRowBackground(Theme.bgSecondary)
    }

    private var aboutSection: some View {
        AboutSection(versions: AppBuild.versionInfo)
    }

    private var phoneSetupSection: some View {
        Section {
            PhoneSetupSettingsRow(summary: store.phoneSetup.sourceSummary) {
                guard let deviceId = store.pairing?.deviceId else { return }
                store.phoneSetup.presentFromSettings(deviceId: deviceId)
            }
            .disabled(store.admin == nil)
        } header: {
            Text("This iPhone")
        }
        .listRowBackground(Theme.bgSecondary)
    }

    /// Turning a source on opens its phone setup page, which returns here once
    /// the step is answered. A source that can't be turned on here says why.
    private func turnOn(_ stepId: String) {
        if let reason = store.phoneSetup.unavailableReason(for: stepId) {
            turnOnNotices[stepId] = reason
            return
        }
        turnOnNotices[stepId] = nil
        guard let deviceId = store.pairing?.deviceId else { return }
        store.phoneSetup.presentStep(stepId, deviceId: deviceId)
    }

    /// A source can be switched while the gateway client exists and no
    /// activation for it is already running.
    private func canTurnOn(_ sourceId: String) -> Bool {
        store.admin != nil && !store.localSourceActivationsInFlight.contains(sourceId)
    }

    /// Why this source is off, shown beside its switch: it can't be turned on
    /// here, or its last attempt failed.
    @ViewBuilder
    private func localSourceIssue(_ sourceId: String) -> some View {
        let notice = turnOnNotices[sourceId] == nil ? nil : store.phoneSetup.unavailableReason(for: sourceId)
        if let issue = notice ?? store.localSourceEnableIssues[sourceId] {
            Label(issue, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(Theme.warning)
        }
    }
}

/// The same lifecycle explanation is used for Settings and source removal.
@available(iOS 17.0, *)
struct SourceDepartureConfirmation: View {
    @Environment(\.dismiss) private var dismiss
    var sourceName: String
    var wholeSource = false
    var onConfirm: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(sourceName).font(.title2.bold())
                    Text(wholeSource
                        ? LocalSourceDepartureRequest.wholeSourceExplanation
                        : LocalSourceDepartureRequest.explanation)
                    Text(LocalSourceDepartureRequest.deletionLimits)
                        .font(.footnote).foregroundStyle(.secondary)
                    Button(wholeSource ? "Remove entire source" : "Stop contributing", role: .destructive) {
                        onConfirm()
                        dismiss()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.danger)
                    Button("Cancel", role: .cancel) { dismiss() }
                        .buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle(wholeSource ? "Remove source?" : "Leave source?")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Device departure — membership may change or be offline") {
    SourceDepartureConfirmation(sourceName: humanName(for: PreviewMocks.sourceAppleHealth.type), onConfirm: {})
}

@available(iOS 17.0, *)
#Preview("Whole source deletion") {
    SourceDepartureConfirmation(sourceName: humanName(for: PreviewMocks.sourceAppleHealth.type), wholeSource: true, onConfirm: {})
}

@available(iOS 17.0, *)
#Preview("Settings — offline activation pending") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(pendingLocalSourceResumes: [PreviewMocks.sourceAppleHealth.id]))
}

@available(iOS 17.0, *)
#Preview("Settings — offline departure pending") {
    SettingsView(initialDestination: .root, previewData: true).environment(AppStore.preview(
        appleHealthEnabled: false,
        pendingLocalSourceDepartures: [PreviewMocks.sourceAppleHealth.id]
    ))
}

@available(iOS 17.0, *)
#Preview("Settings — paired, Apple Health on") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — gateway unreachable") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            pairedDeviceId: "dev_iphone",
            wsState: .failed("Connection timed out")
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — notification text unavailable") {
    SettingsView(
        initialDestination: .notifications,
        previewData: true,
        previewClaimReason: .unreachable
    )
    .environment(AppStore.preview(pairedDeviceId: "dev_iphone"))
}

@available(iOS 17.0, *)
#Preview("Settings — source status loading") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — source syncing") {
    let status = PreviewMocks.localSourceStatus(sourceId: "apple-health:local", state: "syncing")
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            statusesBySource: [status.sourceId: status],
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — Photos status") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false,
            photosEnabled: true
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — Configure Models") {
    SettingsView(initialDestination: .models(initialRole: nil), previewData: true)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Settings — Configure Background Agent") {
    SettingsView(
        initialDestination: .models(initialRole: "background-agent"),
        previewData: true
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Settings — Configure Devices") {
    SettingsView(initialDestination: .devices, previewData: true)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Settings — Policies") {
    SettingsView(initialDestination: .policies, previewData: true)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Settings — developer mode (Health sample probe entry)") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshotDeveloper,
            indexStats: PreviewMocks.indexStats
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — Health sample probe") {
    SettingsView(initialDestination: .healthSamples, previewData: true)
        .environment(AppStore.preview(statusSnapshot: PreviewMocks.statusSnapshotDeveloper))
}

@available(iOS 17.0, *)
#Preview("Settings — Apple Health disabled (opt-in card)") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — Mood consent alert") {
    SettingsView(
        initialDestination: .root,
        previewData: true,
        previewMoodConsentAlertPresented: true
    )
    .environment(AppStore.preview(
        statusesBySource: PreviewMocks.syncStatuses,
        pairedDeviceId: "dev_iphone",
        statusSnapshot: PreviewMocks.statusSnapshot,
        indexStats: PreviewMocks.indexStats
    ))
}

@available(iOS 17.0, *)
#Preview("Settings — Activity Segments enabled") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false,
            activitySegmentsEnabled: true
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — Places enabled") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false,
            coreLocationVisitsEnabled: true
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — push denied") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushDeliveryHealth: .permissionDenied
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — push Scheduled Summary") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushDeliveryHealth: .scheduledSummary
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — push alerts off") {
    SettingsView(initialDestination: .root, previewData: true)
        .environment(AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushDeliveryHealth: .alertsOff
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — direct push setup missing") {
    SettingsView(initialDestination: .notifications, previewData: true)
        .environment(AppStore.preview(
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushGatewayConfiguration: .noDirectCredential,
            pushConfigurationAppId: PreviewMocks.independentlySignedAppId
        ))
}

@available(iOS 17.0, *)
#Preview("Settings — push gateway unavailable, large text") {
    SettingsView(initialDestination: .notifications, previewData: true)
        .environment(AppStore.preview(
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushGatewayConfiguration: .gatewayUnavailable,
            pushRegistrationFailure: "No valid aps-environment entitlement"
        ))
        .dynamicTypeSize(.accessibility2)
}

@available(iOS 17.0, *)
#Preview("Settings — direct push selected, narrow") {
    SettingsView(initialDestination: .notifications, previewData: true)
        .environment(AppStore.preview(
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushGatewayConfiguration: .direct,
            pushConfigurationAppId: PreviewMocks.independentlySignedAppId
        ))
        .frame(width: 320)
}
#endif
#endif
