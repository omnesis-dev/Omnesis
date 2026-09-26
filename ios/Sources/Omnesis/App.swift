// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit
#if canImport(CoreMotion)
import CoreMotion
#endif

/// Application entry point. The Xcode iOS app target's `@main` references
/// this struct — or for Package.swift-only workflows, Xcode auto-wraps
/// it when the package is opened as an iOS application.
///
/// Root flow:
///   1. On launch, check Keychain for an existing pairing (via
///      `AppStore` state).
///   2. If unpaired → show onboarding / QR-scanner screens.
///   3. Once paired → `HomeView`, with phone setup offered over it until
///      this device has been through it once.
@main
@available(iOS 17.0, *)
public struct OmnesisApp: App {
    @State private var store: AppStore
    @UIApplicationDelegateAdaptor(OmnesisAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    public init() {
        // Before anything else: a watch relay can be what launched this
        // process, and the watch is retrying against a deadline until the
        // phone's WatchConnectivity session is up. Building the app state
        // below takes long enough to matter to it.
        #if os(iOS)
        WatchRelayReceiver.shared.activate()
        #endif
        // DEBUG: seed a pairing from JSON supplied by XCUITest, directly or
        // from a file, so automation can pair without scanning a QR code. It
        // carries url, token, and optionally a TLS fingerprint
        // (for HTTPS gateways with self-signed certs). Writing directly
        // to Keychain before AppStore.init() means the normal
        // `reload()` path picks it up, and setting the fingerprint
        // makes OmnesisURLSession build a PinnedSession that trusts
        // the gateway's cert.
        #if DEBUG
        AutomationPairingReset.applyIfRequested()
        let automationPairingData: Data? = {
            if let json = ProcessInfo.processInfo.environment["DEMO_PAIRING_JSON"] {
                return json.data(using: .utf8)
            }
            if let idx = CommandLine.arguments.firstIndex(of: "-pairingFile"),
               idx + 1 < CommandLine.arguments.count {
                return FileManager.default.contents(
                    atPath: CommandLine.arguments[idx + 1]
                )
            }
            if let idx = CommandLine.arguments.firstIndex(of: "-pairingFileName"),
               idx + 1 < CommandLine.arguments.count,
               let documents = FileManager.default.urls(
                   for: .documentDirectory,
                   in: .userDomainMask
               ).first {
                return FileManager.default.contents(
                    atPath: documents.appendingPathComponent(
                        CommandLine.arguments[idx + 1],
                        isDirectory: false
                    ).path
                )
            }
            return nil
        }()
        if let data = automationPairingData {
            if let config = try? JSONDecoder().decode(AutomationPairingConfig.self, from: data) {
                let store = Keychain()
                let tlsMode = PairingTlsMode(rawValue: config.tlsMode ?? "") ??
                    (config.fingerprint == nil ? .legacy : .pinnedLeaf)
                let credential = PairingCredentialBundle(
                    url: config.url,
                    token: config.token,
                    accountId: "local",
                    deviceId: config.deviceId ?? "demo",
                    name: config.name ?? "Demo Gateway",
                    scopes: [],
                    tlsMode: tlsMode.rawValue,
                    fingerprint: tlsMode == .system ? nil : config.fingerprint
                )
                if let encoded = try? credential.encoded() {
                    try? store.set(encoded, forKey: PairingCredentialBundle.key)
                }
                if let claimToken = config.claimToken,
                   tlsMode != .legacy {
                    let notificationStore = NotificationClaimCredentials.sharedKeychain()
                    try? NotificationClaimCredentials.commit(
                        .init(
                            url: config.url,
                            token: claimToken,
                            deviceId: config.deviceId ?? "demo",
                            tlsMode: tlsMode.rawValue,
                            fingerprint: tlsMode == .system ? nil : config.fingerprint
                        ),
                        keychain: notificationStore
                    )
                }
                OmnesisURLSession.reset()
            }
        }
        #endif

        // iOS only accepts BGTaskScheduler.register calls that happen
        // BEFORE applicationDidFinishLaunching returns — i.e. before
        // the first SwiftUI lifecycle tick. Construct the AppStore
        // here, register right away, then stash it in @State.
        let store = AppStore()
        store.registerBackgroundTasks()
        _store = State(wrappedValue: store)
    }

    public var body: some Scene {
        WindowGroup {
            #if DEBUG
            // Visual-debug route: `DEMO_AGENT_PREVIEW=<seed>` boots straight
            // into the agent transcript seeded with a preview store, so a
            // real app process (with genuine device safe-area insets)
            // renders the conversation surface without a paired gateway.
            // `tall` verifies the transcript's bottom fade on hardware /
            // simulator (which the offscreen snapshot harness can't — it
            // reports zero safe area); `scroll-stress` drives the
            // scroll-to-bottom UI test. No-op unless the env var is set.
            if Self.settingsPreview {
                settingsPreviewRoot
            } else if Self.accessAuthorizationPreview {
                accessAuthorizationPreviewRoot
            } else if let seed = Self.agentPreviewSeed {
                if Self.agentPreviewDelayed {
                    DelayedAgentPreview(seed: seed)
                } else {
                    agentPreviewRoot(seed)
                }
            } else if let mode = Self.pushTapDemoMode {
                // Push-tap UI-test harness — see PushTapDemoRoot.
                PushTapDemoRoot(mode: mode, delegate: appDelegate)
            } else if Self.menuRevealDemo {
                // Menu-reveal UI-test harness — see MenuRevealDemoRoot.
                MenuRevealDemoRoot(surface: Self.menuRevealDemoSurface ?? .briefs)
            } else {
                appRoot
            }
            #else
            appRoot
            #endif
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                Task { await store.onActive() }
            case .background:
                Task { await store.onBackground() }
            default:
                break
            }
        }
    }

    @ViewBuilder
    private var appRoot: some View {
        RootView()
            .environment(store)
            .environment(store.notificationRouter)
            .environment(\.appearanceStore, store.appearance)
            .onOpenURL { url in
                // A QR carries only a temporary code. Record it only while
                // this phone is already paired, so it can never initiate or
                // silently change a Gateway pairing.
                guard let pairing = store.pairing,
                      let link = AccessAuthorizationDeepLink(url: url)
                else { return }
                AccessAuthorizationDeepLinkRouter.shared.request(
                    code: link.code,
                    pairingKey: Self.accessAuthorizationPairingKey(pairing)
                )
            }
            .task {
                // Late-bind the AppDelegate's callbacks to the
                // AppStore. Done here (rather than in init) so the
                // delegate has been instantiated by SwiftUI before
                // we attach.
                store.bindAppDelegate(appDelegate)
                await store.retryPendingDeviceRevocation()
            }
        #if DEBUG
            .demoUIScale()
        #endif
    }

    static func accessAuthorizationPairingKey(
        _ pairing: Pairing
    )
        -> AccessAuthorizationPairingKey {
        AccessAuthorizationPairingKey(
            gatewayURL: pairing.url.absoluteString,
            deviceId: pairing.deviceId,
            generation: pairing.pairingGeneration
        )
    }

    #if DEBUG
    /// `DEMO_PUSH_TAP` boots the push-tap UI-test harness instead of the
    /// normal app root (see `PushTapDemoRoot` for the mode vocabulary).
    static var pushTapDemoMode: String? {
        ProcessInfo.processInfo.environment["DEMO_PUSH_TAP"]
    }

    /// Resolves the `DEMO_AGENT_PREVIEW` launch environment to a seeded
    /// transcript, or `nil` for the normal app root. `tall` is a uniform
    /// long conversation (bottom-fade visual check); `scroll-stress` mixes
    /// short and very tall turns to drive the scroll-to-bottom UI test.
    static var agentPreviewSeed: AppStore.AgentPreviewSeed? {
        switch ProcessInfo.processInfo.environment["DEMO_AGENT_PREVIEW"] {
        case "store": PreviewMocks.agentStoreTranscript
        case "tall": PreviewMocks.agentTallTranscript
        case "scroll-stress", "scroll-stress-delayed": PreviewMocks.agentScrollStressTranscript
        default: nil
        }
    }

    static var settingsPreview: Bool {
        ProcessInfo.processInfo.environment["DEMO_SETTINGS_PREVIEW"] == "1"
    }

    static var accessAuthorizationPreview: Bool {
        ProcessInfo.processInfo.environment["DEMO_ACCESS_AUTHORIZATION"] == "1"
    }

    private var settingsPreviewRoot: some View {
        SettingsView(initialDestination: .root, previewData: true)
            .environment(AppStore.preview())
            .environment(\.appearanceStore, AppearanceStore(mode: .dark))
    }

    private var accessAuthorizationPreviewRoot: some View {
        AccessAuthorizationSheet(
            previewRequest: PreviewMocks.accessAuthorizationRequest,
            overview: PreviewMocks.accessOverview,
            mode: .data
        )
        .environment(AppStore.preview())
        .environment(\.appearanceStore, AppearanceStore(mode: .dark))
    }

    /// `scroll-stress-delayed` reproduces the cold-launch resume timing: the
    /// transcript is installed asynchronously AFTER the view has appeared
    /// (so the transcript ScrollView is created fresh with a full
    /// conversation already in it), rather than seeded synchronously before
    /// the first render. See `DelayedAgentPreview`.
    static var agentPreviewDelayed: Bool {
        ProcessInfo.processInfo.environment["DEMO_AGENT_PREVIEW"] == "scroll-stress-delayed"
    }

    /// `DEMO_MENU_REVEAL=briefs|capture` boots the menu-reveal UI-test
    /// harness over that surface. See `MenuRevealDemoRoot`.
    static var menuRevealDemoSurface: MenuRevealDemoSurface? {
        MenuRevealDemoSurface(
            rawValue: ProcessInfo.processInfo.environment["DEMO_MENU_REVEAL"] ?? ""
        )
    }

    static var menuRevealDemo: Bool {
        menuRevealDemoSurface != nil
    }

    /// The seeded agent transcript shown when `DEMO_AGENT_PREVIEW` is set.
    private func agentPreviewRoot(_ seed: AppStore.AgentPreviewSeed) -> some View {
        AgentView(menuOpen: .constant(false))
            .environment(AppStore.preview(agentPreview: seed))
            .environment(\.appearanceStore, AppearanceStore(mode: .dark))
    }
    #endif
}

#if DEBUG
/// Which surface the menu-reveal harness puts under the container.
///
/// `briefs` is the list whose swipe actions have to keep working alongside the
/// reveal; `capture` is quick capture, which carries a swipe-down-to-discard
/// drag of its own and so is the other place the two can fight over a touch.
@available(iOS 17.0, *)
enum MenuRevealDemoSurface: String {
    case briefs
    case capture
}

/// Harness for the menu-reveal gesture tests: a `MenuRevealContainer` over a
/// real `BriefsListContent`, seeded from fixtures so it needs no gateway.
///
/// This is the exact composition that goes wrong in ways a still render can
/// never show. The container's drag spans the whole app, so it sits directly
/// over a `List` whose rows carry their own swipe actions — and a drag gesture
/// that recognises too eagerly cancels the touch for those UIKit-driven
/// buttons, leaving them dead. Only driving real gestures catches that.
///
/// Everything the test asserts on is visible on screen: rows disappear,
/// "More…" writes a marker, and opening a row presents a marker sheet whose
/// content reflects whether the menu changed underneath it.
private struct MenuRevealDemoRoot: View {
    static let moreMarker = "MENU-REVEAL-MORE-TAPPED"
    static let menuMarker = "MENU-REVEAL-MENU-VISIBLE"
    static let detailMarker = "MENU-REVEAL-DETAIL-VISIBLE"
    static let menuBehindSheetMarker = "MENU-REVEAL-OPENED-UNDER-SHEET"

    let surface: MenuRevealDemoSurface

    @State private var menuOpen = false
    @State private var feed = BriefsFeedState(briefs: PreviewMocks.briefs)
    @State private var moreTapped = false
    @State private var openBrief: BriefRecord?

    var body: some View {
        MenuRevealContainer(isOpen: $menuOpen) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Text(Self.menuMarker)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
            }
            .padding(.top, 80)
            .padding(.horizontal, Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgDrawer.ignoresSafeArea())
        } content: {
            switch surface {
            case .capture:
                // Listening rather than idle: the surface starts the recogniser
                // on appear when it is idle, and a permission prompt would sit
                // over the gesture under test.
                CaptureView(surface: .app, speech: .preview(state: .listening))
            case .briefs:
                briefsSurface
            }
        }
        .environment(AppStore.preview())
        .environment(\.appearanceStore, AppearanceStore(mode: .dark))
    }

    private var briefsSurface: some View {
        NavigationStack {
            BriefsListContent(
                feed: feed,
                loading: false,
                loadError: nil,
                onOpen: { openBrief = $0 },
                onQuickClear: { brief in _ = feed.remove(id: brief.id) },
                onAsk: { _ in },
                onMoreOptions: { _ in moreTapped = true },
                onRetry: {},
                onRefresh: {}
            )
            .navigationTitle("Briefs")
            .navigationBarTitleDisplayMode(.inline)
            .background(Theme.bgPrimary.ignoresSafeArea())
            // A real push, so the edge can be tested where the interactive
            // back-swipe is live — the one place the reveal has to yield.
            .safeAreaInset(edge: .top, spacing: 0) {
                NavigationLink("Open detail") {
                    Text(Self.detailMarker)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.bgPrimary.ignoresSafeArea())
                }
                .accessibilityIdentifier("openDetail")
                .padding(.vertical, Theme.Spacing.sm)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 2) {
                    Text(moreTapped ? Self.moreMarker : "")
                }
                .font(.footnote)
                .foregroundStyle(Theme.textMuted)
            }
        }
        .sheet(item: $openBrief) { _ in
            VStack(spacing: Theme.Spacing.lg) {
                Text(menuOpen ? Self.menuBehindSheetMarker : Self.detailMarker)
                Button("Stage open menu") { menuOpen = true }
                    .accessibilityIdentifier("stageOpenMenu")
                Button("Close brief") { openBrief = nil }
                    .accessibilityIdentifier("closeBriefSheet")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgPrimary.ignoresSafeArea())
            // The closing-direction test deliberately stages a state the real
            // gate prevents: an open menu underneath this sheet. Keep the
            // harness controls usable after the presenter's content disables.
            .environment(\.isEnabled, true)
        }
    }
}

/// Reproduces the cold-launch resume timing for the scroll-to-bottom UI
/// test. The store starts empty (so the view first shows the empty state,
/// no transcript ScrollView), and the conversation is installed only AFTER
/// the view has appeared — mirroring how the real app boots into the empty
/// agent surface and then asynchronously resumes the last conversation,
/// creating the transcript ScrollView fresh with a full transcript already
/// in it. The synchronous `agentPreviewRoot` seed can't exercise that path.
@available(iOS 17.0, *)
private struct DelayedAgentPreview: View {
    let seed: AppStore.AgentPreviewSeed
    @State private var store: AppStore = .preview(agentPreview: nil)

    var body: some View {
        AgentView(menuOpen: .constant(false))
            .environment(store)
            .environment(\.appearanceStore, AppearanceStore(mode: .dark))
            .task {
                try? await Task.sleep(nanoseconds: 700_000_000)
                store.installAgentPreview(seed)
            }
    }
}

/// Demo-only whole-interface zoom. When `DEMO_UI_SCALE` is set in the
/// launch environment (only the demo recording does this — see
/// `DemoRecorderTests`), the entire UI is magnified by that factor so
/// every label, title, agent message and citation metadatum is easier to
/// read in the recorded video. The real app, and any build that doesn't
/// set the variable, runs at 1×.
///
/// This is one knob, not a restyle of the ~260 fixed `.system(size:)`
/// fonts: the interface lays out against a proportionally smaller logical
/// size and is then scaled back up to fill the screen, so spacing, icons
/// and text all grow together. The trade-off is that scaling rasterised
/// content can soften text slightly versus re-rendering each font larger.
@available(iOS 17.0, *)
private struct DemoUIScaleModifier: ViewModifier {
    static let scale: CGFloat = {
        guard let raw = ProcessInfo.processInfo.environment["DEMO_UI_SCALE"],
              let value = Double(raw), value > 0
        else { return 1 }
        return CGFloat(value)
    }()

    func body(content: Content) -> some View {
        if Self.scale == 1 {
            content
        } else {
            // Lay the interface out against the SAFE-AREA-sized region
            // (the GeometryReader is safe-area-bounded — we deliberately
            // do NOT ignore the safe area here) divided by the scale, then
            // scale it back up to fill that region. The status-bar and
            // home-indicator zones stay outside, so the zoomed content
            // never slides under the chrome — the agent toolbar/title sit
            // below the status bar and the composer above the home
            // indicator, exactly as at 1×, just larger. The recording's
            // chrome crop then trims the device furniture without clipping
            // app content.
            GeometryReader { geo in
                content
                    .frame(
                        width: geo.size.width / Self.scale,
                        height: geo.size.height / Self.scale
                    )
                    .scaleEffect(Self.scale, anchor: .topLeading)
            }
        }
    }
}

@available(iOS 17.0, *)
extension View {
    /// Apply the demo-only whole-interface zoom. No-op unless
    /// `DEMO_UI_SCALE` is set, so it never affects the shipping app.
    func demoUIScale() -> some View {
        modifier(DemoUIScaleModifier())
    }
}
#endif

/// Top-level app state — view-facing facade that wires three
/// coordinators and re-exposes their @Observable surface so SwiftUI
/// views observing `AppStore` keep working without traversing into
/// the coordinator graph manually.
///
/// The former 1267-line god class is split into:
///   - `PairingCoordinator` — `service`, `pairing`, pair / unpair / repair.
///   - `SyncCoordinator` — `core`, `buffer`, `bgCoordinator`, syncAll /
///     drainPending / lifecycle forwarding.
///   - `AdminCoordinator` — `admin`, `searchClient`, `deviceSocket`,
///     refreshSources / handleEvent / applySyncStatusBroadcast.
///
/// HealthKit-specific state stays directly on `AppStore` because the
/// user-facing toggles (Apple Health enable, per-category opt-in)
/// thread through several coordinators (rebuild collector with /
/// without `AppleHealthSource`; register source with the gateway via
/// admin; track stale-sync reminder on completed sync events).
/// Centralising HK on the facade keeps that orchestration in one place.
@available(iOS 17.0, *)
@MainActor
@Observable
public final class AppStore {
    // MARK: - Coordinators

    @ObservationIgnored
    private let pairingCoord: PairingCoordinator
    @ObservationIgnored
    private let syncCoord: SyncCoordinator
    @ObservationIgnored
    private let adminCoord: AdminCoordinator
    @ObservationIgnored
    private let agentCoord: AgentCoordinator
    @ObservationIgnored
    private let notesCoord = NotesCoordinator(locationProvider: NoteLocationProvider.shared)
    @ObservationIgnored
    private let pushRegistrationCoordinator = PushRegistrationCoordinator()
    @ObservationIgnored
    private var pushRegistrationAttempts = PushRegistrationAttemptGate()
    @ObservationIgnored
    private var pushConfigurationChecks = PushConfigurationCheckGate()
    @ObservationIgnored
    private var pushCallbackRequests = PushCallbackRequestGate()
    @ObservationIgnored
    private var notificationDrainTask: Task<Void, Never>?
    /// The most recent pairing-transition work spawned by `reload()` /
    /// `pair(raw:)`. Nothing cancels these tasks — a superseded teardown still
    /// has to finish releasing the credentials it captured — so the handle
    /// exists purely so lifecycle tests can await the transition instead of
    /// racing it.
    @ObservationIgnored
    private var pairingRuntimeTask: Task<Void, Never>?
    @ObservationIgnored
    private var notificationDrainAgain = false
    @ObservationIgnored
    private let localSourceMembership = LocalSourceMembershipCoordinator()
    public internal(set) var pendingLocalSourceDepartures: Set<String> = []
    public internal(set) var pendingLocalSourceResumes: Set<String> = []
    @ObservationIgnored var localSourceActionIds: [String: UUID] = [:]
    @ObservationIgnored private var localSourceActionScope: [String] = []

    #if DEBUG
    /// Permission states a preview shows instead of the simulator's.
    struct PreviewPermissions {
        var photos: PhotosAccessState?
        var locationVisits: LocationVisitsPermissionState?
    }

    @ObservationIgnored var previewPermissions = PreviewPermissions()
    #endif

    // MARK: - Facade-only observable state

    /// Last user-visible error string — single funnel from every
    /// coordinator's `onError` callback. Surfaced by the Status tab
    /// banner and the Settings re-pair prompt.
    public private(set) var lastError: String?

    /// User has opted in to Apple Health from the Status tab (or was
    /// migrated from the legacy auto-onboarding flow). Drives whether
    /// the collector instantiates `AppleHealthSource` and whether the
    /// gateway carries an `apple-health:local` row. Mirror of
    /// `HealthSettings.appleHealthEnabled`.
    public internal(set) var appleHealthEnabled: Bool = false

    /// Which categories are active in the rotation. Persisted via
    /// HealthSettings. Default: everything.
    public internal(set) var enabledCategories: Set<HealthCategory> =
        HealthSettings.defaultEnabledCategories

    /// User has opted in to Activity Segments from the Status tab.
    /// Drives whether the collector instantiates `ActivitySegmentsSource`
    /// and whether the gateway carries an `activity-segments:local` row.
    /// Mirror of `ActivitySegmentsSettings.enabled`. Off by default —
    /// unlike Apple Health, there's no legacy auto-onboarded install to
    /// migrate forward.
    public internal(set) var activitySegmentsEnabled: Bool = false

    /// User has opted in to Location Visits from the Settings tab. Drives
    /// whether the collector instantiates `CoreLocationVisitsSource`, starts
    /// visit monitoring, and whether the gateway carries a
    /// `core-location-visits:local` row. Mirror of
    /// `CoreLocationVisitsSettings.enabled`. Off by default — location is the
    /// most sensitive signal the app captures.
    public internal(set) var coreLocationVisitsEnabled: Bool = false

    /// User has opted in to the Photos source from the Settings
    /// tab. Drives whether the collector instantiates `PhotosSource`,
    /// installs the `PhotoLibraryObserver`, and whether the gateway
    /// carries a `photos:local` row. Mirror of `PhotosSettings.enabled`.
    public internal(set) var photosEnabled: Bool = false

    /// Current OS capability snapshot for every enabled phone-hosted source.
    /// This drives the global warning independently of gateway reachability.
    @ObservationIgnored
    let permissionHealthCoordinator = PermissionHealthCoordinator()

    var sourcePermissionHealthEvaluation: PermissionHealthCoordinator.Evaluation {
        permissionHealthCoordinator.evaluation
    }

    var sourcePermissionHealthDelivery: PermissionHealthCoordinator.Delivery {
        permissionHealthCoordinator.delivery
    }

    public var sourcePermissionHealth: [SourcePermissionHealthReport] {
        permissionHealthCoordinator.reports
    }

    public var degradedSourcePermissions: [SourcePermissionProblem] {
        sourcePermissionHealth.flatMap { report in
            report.attentionCapabilities.map {
                SourcePermissionProblem(
                    sourceId: report.sourceId,
                    displayName: report.displayName,
                    capability: $0
                )
            }
        }
    }

    public var unknownSourcePermissions: [SourcePermissionProblem] {
        sourcePermissionHealth.flatMap { report in
            report.capabilities
                .filter { $0.state == .unknown }
                .map {
                    SourcePermissionProblem(
                        sourceId: report.sourceId,
                        displayName: report.displayName,
                        capability: $0
                    )
                }
        }
    }

    /// How push notifications will actually reach the user, captured after the
    /// permission request. `.ok` unless permission is denied, iOS Scheduled
    /// Summary is batching, or alerts are off — surfaced in Settings so the
    /// user isn't left wondering why pushes never arrive.
    public private(set) var pushDeliveryHealth: PushDeliveryHealth = .ok
    /// Gateway push selection for this pairing and app identity. A selected
    /// path does not prove end-to-end APNs delivery.
    public private(set) var pushGatewayConfiguration: PushGatewayConfiguration = .notChecked
    public private(set) var pushConfigurationAppId: String?
    public private(set) var pushRegistrationFailure: String?
    public private(set) var pushGatewayRegistrationFailure: String?

    /// Presented only when this published app identity needs the owner's
    /// device-scoped permission before content-blind relay enrollment.
    public private(set) var relayPushConsentRequest: RelayPushConsentRequest?

    /// Turns phone-hosted sources on, and keeps why an attempt left one off.
    @ObservationIgnored
    public let localSourceActivator: LocalSourceActivator
    /// Which device id the local source switches and setup record belong to.
    @ObservationIgnored
    var localSourceOwner: LocalSourceOwnerRecord

    /// Why the last attempt to turn on a phone-hosted source left it off, by
    /// source id. Settings shows each beside that source's switch.
    public var localSourceEnableIssues: [String: String] {
        localSourceActivator.issues
    }

    /// Sources an activation is running for.
    public var localSourceActivationsInFlight: Set<String> {
        localSourceActivator.inFlight
    }

    /// Post-pairing phone setup, and the presentation gate it holds.
    @ObservationIgnored
    public let phoneSetup: PhoneSetupCoordinator

    @ObservationIgnored
    private let notificationPermissions: any NotificationPermissionCenter

    // MARK: - Forwarded reads from coordinators

    public var pairing: Pairing? {
        pairingCoord.pairing
    }

    public var isRepairing: Bool {
        pairingCoord.isRepairing
    }

    public var pairingRecovery: PairingRecovery? {
        pairingCoord.recovery
    }

    public var lastSyncAt: Date? {
        syncCoord.lastSyncAt
    }

    public var bufferedBatches: Int {
        syncCoord.bufferedBatches
    }

    public var isSyncing: Bool {
        syncCoord.isSyncing
    }

    public var lastSyncSummaries: [CollectorCore.SyncSummary] {
        syncCoord.lastSyncSummaries
    }

    public var syncProgress: CollectorCore.Progress? {
        syncCoord.syncProgress
    }

    /// Sources the gateway refused with 403 on the most recent drain — this
    /// device's token is missing their `write:<source-type>` scope. See
    /// `SyncCoordinator.blockedSourceIds`.
    public var blockedSourceIds: [String] {
        syncCoord.blockedSourceIds
    }

    /// Age of the oldest batch still waiting to upload, or `nil` when nothing
    /// is buffered. See `SyncCoordinator.oldestBufferedAge`.
    public var oldestBufferedAge: TimeInterval? {
        syncCoord.oldestBufferedAge
    }

    /// Batches set aside as undeliverable. See
    /// `SyncCoordinator.quarantinedBatches`.
    public var quarantinedBatches: Int {
        syncCoord.quarantinedBatches
    }

    /// Where a user-triggered delivery retry is in its cycle. See
    /// `SyncCoordinator.retryPhase`.
    public var pushRetryPhase: PushHealth.RetryPhase {
        syncCoord.retryPhase
    }

    public var sources: [SourceRecord] {
        adminCoord.sources
    }

    /// Sources whose managed gateway data is still being purged.
    public var pendingSourceRemovals: [PendingSourceRemoval] {
        adminCoord.pendingSourceRemovals
    }

    /// Gateway-internal sources (a dataset the gateway hosts itself): read-only rows.
    public var internalSources: [InternalSource] {
        adminCoord.internalSources
    }

    public func isInternalSource(_ sourceId: String) -> Bool {
        adminCoord.isInternalSource(sourceId)
    }

    public func internalSourceRecord(for sourceId: String) -> SourceRecord {
        adminCoord.internalSourceRecord(for: sourceId)
    }

    public var syncStatusesBySource: [String: SourceSyncStatus] {
        adminCoord.syncStatusesBySource
    }

    /// The status for this phone's contribution when a source has several
    /// members, otherwise the source-level status.
    public func localSyncStatus(sourceId: String) -> SourceSyncStatus? {
        guard let status = syncStatusesBySource[sourceId] else { return nil }
        guard let deviceId = pairing?.deviceId else { return status }
        return status.status(forDeviceId: deviceId)
    }

    public var deviceNamesById: [String: String] {
        adminCoord.deviceNamesById
    }

    public var sourcesLoading: Bool {
        adminCoord.sourcesLoading
    }

    public var sourcesError: Error? {
        adminCoord.sourcesError
    }

    public var wsConnected: Bool {
        adminCoord.wsConnected
    }

    public var wsState: DeviceSocket.ConnectionState {
        adminCoord.wsState
    }

    public var sourceIconByType: [String: String] {
        adminCoord.sourceIconByType
    }

    public var sourceIconById: [String: String] {
        adminCoord.sourceIconById
    }

    public var sourceLabelByType: [String: String] {
        adminCoord.sourceLabelByType
    }

    public var sourceLabelById: [String: String] {
        adminCoord.sourceLabelById
    }

    /// Per-source brand bg color hex, keyed by type or full id. See
    /// `AdminCoordinator.sourceBgColorByType` for the contract.
    public var sourceBgColorByType: [String: String] {
        adminCoord.sourceBgColorByType
    }

    public var sourceBgColorById: [String: String] {
        adminCoord.sourceBgColorById
    }

    public var sourceAccentColorByType: [String: String] {
        adminCoord.sourceAccentColorByType
    }

    public var sourceAccentColorById: [String: String] {
        adminCoord.sourceAccentColorById
    }

    /// Look up a friendly source label (e.g. "Apple Health" for
    /// `apple-health:local`). Falls back to a humanised slug
    /// when the source-meta registry hasn't published a label —
    /// either because pairing just completed and the fetch hasn't
    /// landed, or the source intentionally didn't publish one.
    public func sourceLabel(forSourceId sourceId: String) -> String? {
        adminCoord.sourceLabel(forSourceId: sourceId)
    }

    /// Provider-declared unit noun for a source ("emails", "messages",
    /// "activities", …). Resolved from the descriptor cache loaded at
    /// startup so source-specific labels remain owned by the provider
    /// package — see `SourceDescriptor.unitName`.
    ///
    /// Takes the descriptor id (matches `AgentDocRef.sourceType`), not
    /// the full per-account sourceId.
    public func sourceUnitName(forSourceType sourceType: String) -> String? {
        adminCoord.sourceUnitName(forSourceType: sourceType)
    }

    public var statusSnapshot: StatusSnapshot? {
        adminCoord.statusSnapshot
    }

    /// Whether the paired gateway runs in experimental mode. Drives the
    /// gating of not-yet-battle-tested UI (the Watches menu entry, the Deep
    /// Research slash command). Defaults to `false` until `/status` has been
    /// fetched, and for any gateway that omits the field — so experimental UI
    /// stays hidden by default.
    public var experimentalEnabled: Bool {
        adminCoord.statusSnapshot?.experimental ?? false
    }

    /// Whether the paired gateway runs in developer mode (`OMNESIS_DEV_MODE`).
    /// Reveals the developer-annotation capture affordance (shake-to-annotate).
    /// Defaults to `false` until `/status` has been fetched, and for any gateway
    /// that omits the field — so the affordance stays hidden by default.
    public var developerEnabled: Bool {
        adminCoord.statusSnapshot?.developer ?? false
    }

    /// The entity the foreground detail view is showing, published via
    /// `.devTarget(_:)`. Shake-to-annotate reads this to attach a developer
    /// annotation to whatever the operator is looking at; `nil` means no
    /// entity is in focus and the composer files a free-form note. Only
    /// meaningful in developer mode.
    ///
    /// Backed by an identity-keyed stack so nested navigation (a detail view
    /// pushing another detail view, then popping back) restores the right
    /// target instead of clearing it. The top — the most recently appeared,
    /// still-present view — wins.
    public var currentDevTarget: DevAnnotationTarget? {
        devTargetStack.last?.target
    }

    private var devTargetStack: [(id: UUID, target: DevAnnotationTarget)] = []

    public func pushDevTarget(_ id: UUID, _ target: DevAnnotationTarget) {
        // Update in place if this id is already on the stack, rather than
        // moving it to the top — so a view that re-publishes its target (the
        // agent conversation, whose id/title change while the view stays put)
        // refreshes without stealing top-of-stack from a detail sheet layered
        // above it. First-time publishers (onAppear, after an onDisappear
        // removal) always append.
        if let idx = devTargetStack.firstIndex(where: { $0.id == id }) {
            devTargetStack[idx].target = target
        } else {
            devTargetStack.append((id: id, target: target))
        }
    }

    public func removeDevTarget(_ id: UUID) {
        devTargetStack.removeAll { $0.id == id }
    }

    public var indexStats: IndexStats? {
        adminCoord.indexStats
    }

    /// Read-side client exposed to views. `nil` until pairing completes.
    public var search: SearchClient? {
        adminCoord.search
    }

    /// Admin client exposed to views — used by the Sources detail
    /// screen's Debug action. `nil` until pairing completes.
    public var admin: AdminClient? {
        adminCoord.admin
    }

    /// Watches client exposed to the Watches tab — the read-only window onto
    /// what each Watch V2 watch has found. `nil` until pairing completes.
    public var watches: WatchesClient? {
        adminCoord.watches
    }

    /// Briefs client exposed to views — used by the Briefs feed tab.
    /// `nil` until pairing completes.
    public var briefs: BriefsClient? {
        adminCoord.briefs
    }

    /// Privacy client exposed to the paired owner's Privacy controls. Its
    /// admin-only routes manage named policy families, immutable history, and
    /// owner approvals.
    public var privacy: PrivacyClient? {
        adminCoord.privacy
    }

    /// Paired-owner client for reviewing an MCP authorization after the user
    /// enters the short code displayed by the initiating client.
    public var access: AccessClient? {
        adminCoord.access
    }

    /// What the navigation menu shows for Omnesis Briefs, derived from the
    /// paired gateway's feature gate. Both available states navigate to the
    /// feed; `.needsAttention` adds the setup warning while historical briefs
    /// remain readable.
    public var briefsMenuEntry: BriefsMenuEntry {
        BriefsMenuEntry(status: adminCoord.statusSnapshot?.briefs)
    }

    /// Count of unread Briefs awaiting attention — drives the small badge
    /// on the drawer's Briefs entry. Refreshed when the drawer opens (the
    /// same refresh-on-open cadence as the feed); 0 when the feature is
    /// inactive. In-app only — never an OS app-icon badge or a push.
    public var briefsUnreadCount: Int {
        adminCoord.briefsUnreadCount
    }

    /// Refresh the unread-Briefs badge count. Called when the menu drawer
    /// opens. Best-effort; failures zero the badge.
    public func refreshBriefsUnreadCount() async {
        await adminCoord.refreshBriefsUnreadCount()
    }

    /// Agent coordinator — observable handle for the Agent tab. Always
    /// present so views can bind to it; `agent.sessionId` stays nil
    /// until pairing + the gateway agent harness handshake complete.
    public var agent: AgentCoordinator {
        agentCoord
    }

    /// Notes coordinator — observable handle for the "Tell Omnesis"
    /// capture surface and its exceptional unsent-note diagnostics.
    /// Always present; its client stays nil until pairing completes,
    /// and saves fall back to the durable pending queue.
    public var notes: NotesCoordinator {
        notesCoord
    }

    // MARK: - HealthKit internals

    @ObservationIgnored
    let healthSettings: HealthSettings
    #if canImport(HealthKit)
    @ObservationIgnored
    private var healthKitClient: HealthKitClient?
    @ObservationIgnored
    private var backgroundDelivery: BackgroundDeliveryInstaller?
    /// The category change being applied; a newer change cancels it.
    @ObservationIgnored
    private var categoryRebuildTask: Task<Void, Never>?
    #endif

    // MARK: - Photos internals

    @ObservationIgnored
    var photosSettings = PhotosSettings()
    #if canImport(Photos)
    @ObservationIgnored
    private var photosSource: PhotosSource?
    @ObservationIgnored
    private var photoLibraryObserver: PhotoLibraryObserver?
    @ObservationIgnored
    private var photosAssetIndex: AnalyzedAssetStore?
    #endif
    #if canImport(UserNotifications)
    @ObservationIgnored
    private let staleSyncReminder = StaleSyncReminder()
    #endif

    // MARK: - Activity Segments internals

    @ObservationIgnored
    let activitySegmentsSettings = ActivitySegmentsSettings()

    // MARK: - Location Visits internals

    @ObservationIgnored
    let coreLocationVisitsSettings = CoreLocationVisitsSettings()

    // Long-lived visit-monitoring provider, created once when Location
    // Visits is enabled and reused across collector rebuilds (like
    // `backgroundDelivery`). Owns the `CLLocationManager`; the source reads
    // its durable buffer. `nil` while the source is off.
    #if os(iOS) && canImport(CoreLocation)
    @ObservationIgnored
    var visitProvider: CoreLocationVisitProvider?
    #endif

    /// Shared deep-link router for inbound push notifications. The
    /// AppDelegate writes into it on tap; HomeView observes
    /// `pendingTarget` to flip the active section, and the destination
    /// views (Watches, Briefs, Privacy, Agent) consume it.
    @ObservationIgnored
    public let notificationRouter = NotificationRouter()

    /// Whether the home notification warning was dismissed for the current
    /// degraded-delivery epoch. Persisted so a relaunch does not resurface
    /// it; cleared when delivery is observed healthy again (see
    /// `NotificationWarningDismissal`).
    public var notificationWarningDismissed: Bool = false
    @ObservationIgnored
    private let notificationWarningDefaults: KeyValueDefaults

    /// Scene-lifecycle request consumed by HomeView. Kept on the facade so a
    /// cold-launch decision can supersede AgentCoordinator's asynchronous
    /// default bootstrap through the same explicit-session generation guard
    /// used by push taps and conversation-list selections.
    private(set) var foregroundConversationRequest: ForegroundConversationRequest?
    @ObservationIgnored
    private let foregroundConversationStore: ForegroundConversationStore
    @ObservationIgnored
    private var currentHomeTab: HomeTab = .agent
    @ObservationIgnored
    private var foregroundDecisionPending = true
    @ObservationIgnored
    private var foregroundRequestId = 0

    /// Chosen interface appearance (System / Light / Dark). Injected
    /// into the environment at the window root and read by
    /// `.omnesisColorScheme()` on every presentation surface and by the
    /// Settings appearance picker.
    @ObservationIgnored
    public let appearance = AppearanceStore.forLaunchEnvironment()

    public convenience init(
        service: PairingService = PairingService(),
        healthSettings: HealthSettings = HealthSettings(),
        photosSettings: PhotosSettings = PhotosSettings(),
        localSourceOwner: LocalSourceOwnerRecord = LocalSourceOwnerRecord()
    ) {
        self.init(
            service: service,
            healthSettings: healthSettings,
            photosSettings: photosSettings,
            foregroundConversationStore: ForegroundConversationStore(),
            localSourceOwner: localSourceOwner
        )
    }

    init(
        service: PairingService,
        healthSettings: HealthSettings,
        photosSettings: PhotosSettings,
        foregroundConversationStore: ForegroundConversationStore,
        phoneSetupProgress: PhoneSetupProgressStore = PhoneSetupProgressStore(),
        notificationPermissions: any NotificationPermissionCenter = SystemNotificationPermissionCenter(),
        localSourceActivator: LocalSourceActivator? = nil,
        localSourceOwner: LocalSourceOwnerRecord = LocalSourceOwnerRecord(),
        notificationWarningDefaults: KeyValueDefaults = UserDefaults.standard,
        loadPersistedPairing: Bool = true
    ) {
        self.localSourceActivator = localSourceActivator ?? LocalSourceActivator()
        self.localSourceOwner = localSourceOwner
        self.foregroundConversationStore = foregroundConversationStore
        phoneSetup = PhoneSetupCoordinator(progressStore: phoneSetupProgress)
        self.notificationPermissions = notificationPermissions
        self.notificationWarningDefaults = notificationWarningDefaults
        self.notificationWarningDismissed =
            (notificationWarningDefaults.object(forKey: NotificationWarningDismissal.defaultsKey) as? Bool) ?? false
        self.healthSettings = healthSettings
        // Migration: pre-flag users had `hasRequested == true` and were
        // implicitly enabled. Carry that forward so an update doesn't
        // silently disable Apple Health on someone who was happily
        // syncing. New installs see the flag unset and stay disabled
        // until they tap "Enable Apple Health" on the Status tab.
        if !healthSettings.appleHealthEnabledHasBeenSet,
           healthSettings.hasRequestedHealthKitAuthorization {
            healthSettings.appleHealthEnabled = true
        }
        appleHealthEnabled = healthSettings.appleHealthEnabled
        enabledCategories = healthSettings.enabledCategories
        activitySegmentsEnabled = activitySegmentsSettings.enabled
        coreLocationVisitsEnabled = coreLocationVisitsSettings.enabled
        self.photosSettings = photosSettings
        photosEnabled = photosSettings.enabled

        // Build coordinators. Two-phase init: the coordinators exist
        // first (so their closures' `self` captures are valid), then
        // we wire the error/lifecycle hooks via `setOn*` setters.
        pairingCoord = PairingCoordinator(service: service)
        syncCoord = SyncCoordinator()
        adminCoord = AdminCoordinator()
        agentCoord = AgentCoordinator()

        // Wire the closures now that `self` exists.
        installCoordinatorHooks()
        phoneSetup.install(host: self, steps: PhoneSetupRegistry.ios(host: self))
        self.localSourceActivator.install(makeLocalSourceActivationEnvironment())

        #if canImport(UIKit)
        // HKObserver wakes frequently fire while the phone is locked,
        // and HealthKit refuses to serve queries against locked data
        // (HKError.errorDatabaseInaccessible). AppleHealthSource bails
        // out gracefully in that case — we use this notification to
        // retry the moment the phone unlocks and keys become available.
        // See #75 — this only re-syncs; a pairing read that failed while
        // the phone was locked is not re-read here.
        NotificationCenter.default.addObserver(
            forName: UIApplication.protectedDataDidBecomeAvailableNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { [weak self] in
                await self?.syncAll()
            }
        }
        #endif
        if loadPersistedPairing {
            reload()
        }
    }

    /// Replace the coordinator hook closures with implementations that
    /// can see `self`. Called once at init right after the
    /// `pairingCoord` / `syncCoord` / `adminCoord` properties are set
    /// — captures use `[weak self]` so the closures don't pin AppStore
    /// past its natural lifetime.
    private func installCoordinatorHooks() {
        pairingCoord.setOnError { [weak self] msg in self?.lastError = msg }
        syncCoord.setOnError { [weak self] msg in self?.lastError = msg }
        syncCoord.setOnLifecycleApplied { [weak self] event, generation in
            await self?.handleLifecycleEvent(event, generation: generation)
        }
        syncCoord.setOnPhotosBackfillRequested { [weak self] in
            await self?.runPhotosBackfillTask()
        }
        adminCoord.setOnError { [weak self] msg in self?.lastError = msg }
        adminCoord.setOnPushAvailable { [weak self] in
            self?.requestNotificationDrain()
        }
        adminCoord.setOnSourcesRemoved { [weak self] sourceIds, revision in
            guard let self, self.adminCoord.sourceRemovalDeliveryIsCurrent(revision) else { return }
            // Apply the authoritative cohort synchronously. The registry can
            // still contain a shared source whose membership this phone lost.
            for sourceId in sourceIds {
                self.handleSourceRejected(sourceId: sourceId, reason: "removed", dropCachedSource: false)
            }
        }
        adminCoord.setOnConnected { [weak self] in
            await self?.reconcileLocalSourceMembership()
        }
        // A gateway-driven "Sync now" for an iOS-hosted source lands here and
        // is answered by the same collector the in-app button drives.
        adminCoord.setOnSyncRequested { [weak self] sourceId in
            guard let self else { return .notHosted }
            guard let core = await MainActor.run(body: { self.syncCoord.core }) else {
                // Hosted, but the collector is rebuilt on every pairing change
                // and source toggle — reporting "not hosted" here would send
                // the operator looking for a source that is present.
                return .skipped(reason: "the collector is still starting up")
            }
            guard await core.registeredSourceIds().contains(sourceId) else { return .notHosted }
            // Started, not finished: a full Apple Health cycle far outruns the
            // gateway's 30s command timeout, so the ack reports the kick-off.
            Task { await self.syncCoord.syncOne(sourceId: sourceId) }
            return .triggered
        }
    }

    /// AppStore-level lifecycle handler: schedules the stale-sync
    /// reminder for completed Apple-Health syncs (HealthKit ownership
    /// stays on AppStore) and forwards the event to AdminCoordinator
    /// for WS emit + local cache update.
    private func handleLifecycleEvent(
        _ event: CollectorCore.Lifecycle,
        generation: Int
    ) async {
        guard syncCoord.isCollectorGenerationCurrent(generation) else { return }
        // A push rejection is not a sync status — handle it and return rather
        // than forwarding it to the gateway as a `sync.status` event.
        if case .sourceRejected(_, let reason) = event {
            if reason == "removed" {
                // A retiring collector can reject a write while a new local
                // activation is awaiting its retirement barrier. Reconcile
                // current authority outside that callback to avoid deadlock.
                Task { await adminCoord.refreshSources() }
            }
            return
        }
        #if canImport(UserNotifications)
        // Each successful Apple Health sync re-arms the stale-sync
        // reminder N hours out.
        if case .completed(let sourceId, _, _, _, _) = event,
           sourceId.hasPrefix("apple-health:") {
            await staleSyncReminder.scheduleReminder()
            guard syncCoord.isCollectorGenerationCurrent(generation) else { return }
        }
        #endif
        guard syncCoord.isCollectorGenerationCurrent(generation) else { return }
        await adminCoord.forwardLifecycle(event)
        let finishedSourceId: String? = switch event {
        case .completed(let sourceId, _, _, _, _), .error(let sourceId, _, _), .idle(let sourceId, _): sourceId
        case .started, .progress, .sourceRejected: nil
        }
        if let finishedSourceId, Self.managedLocalSourceIds.contains(finishedSourceId) {
            // A permission-driven collector replacement waits for this core
            // to quiesce. Schedule it after the lifecycle callback returns so
            // the core is never waiting on its own retirement barrier.
            Task { await refreshSourcePermissionHealth() }
        }
    }

    /// The iOS-local sources AppStore owns end-to-end (opt-in flag →
    /// collector membership → gateway registration), by exact source id.
    /// The gateway registry also lists other devices' sources of the same
    /// types (`apple-health:<account>` hosted by another phone), and this
    /// phone not hosting one of those says nothing about its own source, so
    /// membership is never decided by type prefix.
    static let managedLocalSourceIds: Set<String> = [
        "apple-health:local", "activity-segments:local", "photos:local", "core-location-visits:local",
    ]

    /// React to the gateway rejecting pushes for a source it removed/paused.
    /// A `removed` source is disabled locally so it stops producing and the
    /// Status/Settings toggle reflects reality; the gateway already deleted
    /// the row, so we don't round-trip a `removeSource`. A `paused` source
    /// is left enabled — its buffered data is retained for resume (see
    /// `Uploader`) and the sources list already shows the paused pill via WS.
    private func handleSourceRejected(sourceId: String, reason: String, dropCachedSource: Bool = true) {
        guard reason == "removed", !adminCoord.isSourceResumePending(sourceId),
              Self.managedLocalSourceIds.contains(sourceId)
        else { return }

        switch sourceId {
        case "apple-health:local" where appleHealthEnabled:
            healthSettings.appleHealthEnabled = false
            appleHealthEnabled = false
        case "activity-segments:local" where activitySegmentsEnabled:
            activitySegmentsSettings.enabled = false
            activitySegmentsEnabled = false
        case "core-location-visits:local" where coreLocationVisitsEnabled:
            coreLocationVisitsSettings.enabled = false
            coreLocationVisitsEnabled = false
        case "photos:local" where photosEnabled:
            photosSettings.disable()
            photosEnabled = false
        default:
            return
        }
        // This callback is emitted from the collector being replaced. Let it
        // finish before the replacement waits on quiescence.
        Task { await rebuildCollectorWithCurrentSources() }
        if dropCachedSource { adminCoord.dropSourceLocally(sourceId: sourceId) }
        AppLog.make(category: "app").notice(
            "A phone-hosted source was removed in Omnesis — disabled locally to stop pushing"
        )
    }

    // MARK: - Push notifications (APNs)

    /// Wire the `UIApplicationDelegateAdaptor`-vended AppDelegate to
    /// AppStore methods. Called once from `OmnesisApp.body.task`
    /// after SwiftUI instantiates the delegate.
    public func bindAppDelegate(_ delegate: OmnesisAppDelegate) {
        delegate.onDidRegisterToken = { [weak self] tokenData in
            Task { @MainActor [weak self] in
                guard let self, self.acceptPushTokenCallback() else { return }
                await self.handlePushTokenRegistered(tokenData: tokenData)
            }
        }
        delegate.onDidFailRegister = { [weak self] error in
            AppLog.make(category: "push").warning(
                "APNs registration failed: \(String(describing: error))"
            )
            Task { @MainActor [weak self] in
                self?.recordPushRegistrationFailure(error)
            }
        }
        delegate.onDidReceiveTarget = { [weak self] target in
            Task { @MainActor [weak self] in
                self?.notificationRouter.pendingTarget = target
            }
        }
        delegate.onDidReceiveRelayChallenge = { [weak self] nonce in
            guard let self, let pairing = await self.pairingCoord.pairing else { return false }
            do {
                return try await self.pushRegistrationCoordinator.receiveRelayChallenge(
                    nonce: nonce,
                    pairing: pairing
                )
            } catch {
                AppLog.make(category: "push").warning(
                    "Relay challenge failed: \(String(describing: error))"
                )
                return false
            }
        }
        // Once delegate hooks are in place, kick off an APNs
        // registration attempt if pairing is already loaded. iOS
        // is happy to re-issue (or refresh) the device token across
        // launches — we POST the latest hex to the gateway every time
        // so a stale registration after a re-pair is corrected
        // automatically.
        if pairing != nil {
            Task { await self.requestPushAndRegister() }
        }
    }

    /// Register this pairing for pushes once the user has decided on
    /// notifications, and refresh how delivery will behave. This never shows
    /// the iOS prompt: `requestNotificationPermission()` does, when the user
    /// asks for notifications in phone setup or Settings.
    ///
    /// Called on launch (when already paired), after every pairing change,
    /// and on every return to the foreground.
    public func requestPushAndRegister() async {
        #if DEBUG
        // Demo automation: no push registration, so nothing push-related (a
        // relay consent sheet, a delivery warning) appears over a screen
        // recording on a simulator that allowed notifications before.
        if ProcessInfo.processInfo.environment["DEMO_AUTO_SEND"] != nil {
            return
        }
        #endif
        // The plan query needs pairing and app identity, not a device token.
        // Start it even when iOS permission or APNs registration fails.
        Task { await self.refreshPushGatewayConfiguration() }
        #if canImport(UserNotifications) && canImport(UIKit)
        // Capture how delivery will actually behave (denied / Scheduled Summary
        // batching / alerts off) so Settings can warn the user instead of
        // silently registering a token that never visibly delivers.
        await refreshPushDeliveryHealth()
        guard pushDeliveryHealth.registersPushTokenAutomatically else { return }
        beginPushCallbackRequest()
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }

    /// Show the iOS notification prompt, then register for pushes if allowed.
    /// Returns whether notifications are allowed afterwards.
    public func requestNotificationPermission() async -> Bool {
        #if canImport(UserNotifications) && canImport(UIKit)
        do {
            // iOS only shows its prompt while notifications are undecided.
            let undecided = await notificationPermissions.deliveryHealth().setupPermission == .notDetermined
            _ = try await SystemPromptActivity.shared.during(undecided) {
                try await notificationPermissions.requestAuthorization()
            }
        } catch {
            AppLog.make(category: "push").warning(
                "Notification permission request errored: \(String(describing: error))"
            )
        }
        await requestPushAndRegister()
        return pushDeliveryHealth.setupPermission == .authorized
        #else
        return false
        #endif
    }

    func beginPushCallbackRequest() {
        pushCallbackRequests.begin(pairing: pairingCoord.pairing)
    }

    func acceptPushTokenCallback() -> Bool {
        guard pushCallbackRequests.consume(pairing: pairingCoord.pairing) else { return false }
        pushRegistrationFailure = nil
        return true
    }

    func recordPushRegistrationFailure(_ error: Error) {
        guard pushCallbackRequests.consume(pairing: pairingCoord.pairing) else { return }
        pushRegistrationFailure = error.localizedDescription
    }

    public func refreshPushGatewayConfiguration() async {
        guard let pairing = pairingCoord.pairing,
              let appId = Bundle.main.bundleIdentifier else {
            pushGatewayConfiguration = .notChecked
            pushConfigurationAppId = nil
            return
        }
        let check = pushConfigurationChecks.begin(pairing: pairing, appId: appId)
        pushGatewayConfiguration = .checking
        pushConfigurationAppId = appId
        do {
            let configuration = try await pushRegistrationCoordinator.configuration(
                pairing: pairing,
                appId: appId
            )
            guard pushConfigurationChecks.isCurrent(
                check, pairing: pairingCoord.pairing, appId: Bundle.main.bundleIdentifier
            ) else { return }
            pushGatewayConfiguration = configuration
            if configuration != .relayConsentRequired,
               relayPushConsentRequest?.matches(pairing: pairing, appId: appId) == true {
                relayPushConsentRequest = nil
            }
        } catch {
            guard pushConfigurationChecks.isCurrent(
                check, pairing: pairingCoord.pairing, appId: Bundle.main.bundleIdentifier
            ) else { return }
            pushGatewayConfiguration = .gatewayUnavailable
        }
    }

    /// Re-read the OS notification settings and update `pushDeliveryHealth`.
    /// Called after the permission request; safe to call again (e.g. when the
    /// app returns to the foreground and the user may have changed Settings).
    public func refreshPushDeliveryHealth() async {
        #if canImport(UserNotifications)
        let health = await notificationPermissions.deliveryHealth()
        pushDeliveryHealth = health
        if NotificationWarningDismissal.shouldResetDismissal(health: health), notificationWarningDismissed {
            notificationWarningDismissed = false
            notificationWarningDefaults.set(false, forKey: NotificationWarningDismissal.defaultsKey)
        }
        reportPushDeliveryHealth(health)
        #endif
    }

    /// Dismiss the home notification warning for the current degraded-delivery
    /// epoch. It reappears only after the app observes healthy delivery again.
    public func dismissNotificationWarning() {
        notificationWarningDismissed = true
        notificationWarningDefaults.set(true, forKey: NotificationWarningDismissal.defaultsKey)
    }

    /// Send health after updating local UI state. The child task deliberately
    /// does not hold up permission or foreground work, and checks the pairing
    /// both before dispatch and before logging failure so an old session never
    /// contaminates the current session's state. Foreground refreshes provide
    /// an opportunistic retry after transient network failures.
    private func reportPushDeliveryHealth(_ health: PushDeliveryHealth) {
        guard let pairing = pairingCoord.pairing else { return }
        Task { @MainActor [weak self] in
            guard let self, self.pairingCoord.pairing == pairing else { return }
            do {
                try await AdminClient(
                    baseURL: pairing.url,
                    token: pairing.token,
                    session: OmnesisURLSession.shared
                ).reportPushHealth(deviceId: pairing.deviceId, status: health.gatewayStatus)
            } catch {
                guard self.pairingCoord.pairing == pairing else { return }
                AppLog.make(category: "push").debug(
                    "Push delivery health report deferred: \(String(describing: error))"
                )
            }
        }
    }

    private func handlePushTokenRegistered(tokenData: Data) async {
        guard let pairing = pairingCoord.pairing,
              let bundleId = Bundle.main.bundleIdentifier
        else { return }
        let attempt = pushRegistrationAttempts.begin()
        pushRegistrationFailure = nil
        pushGatewayRegistrationFailure = nil
        do {
            let provisioner = NotificationClaimCredentialProvisioner(
                pairing: pairing,
                store: NotificationClaimCredentials.sharedKeychain(),
                session: OmnesisURLSession.shared
            )
            do {
                try await provisioner.ensure()
                guard pushRegistrationAttemptIsCurrent(attempt, pairing: pairing) else { return }
            } catch {
                guard pushRegistrationAttemptIsCurrent(attempt, pairing: pairing) else { return }
                // Gateways predating private wake-and-claim cannot mint the
                // narrow credential or answer push-plan. Preserve their rich
                // APNs payload route, but do not register a modern private wake
                // unless claim authority was provisioned successfully.
                let usedLegacy = try await pushRegistrationCoordinator
                    .registerLegacyIfPushPlanUnavailable(
                        pairing: pairing,
                        tokenData: tokenData,
                        bundleId: bundleId,
                        environment: PushRegistrar.environment
                    )
                if usedLegacy {
                    guard pushRegistrationAttemptIsCurrent(attempt, pairing: pairing) else { return }
                    relayPushConsentRequest = nil
                    AppLog.make(category: "push").info(
                        "Legacy APNs push registration reconciled (\(PushRegistrar.environment))"
                    )
                    return
                }
                throw error
            }
            guard pushRegistrationAttemptIsCurrent(attempt, pairing: pairing) else { return }
            try await pushRegistrationCoordinator.register(
                pairing: pairing,
                tokenData: tokenData,
                bundleId: bundleId,
                environment: PushRegistrar.environment
            )
            guard pushRegistrationAttemptIsCurrent(attempt, pairing: pairing) else { return }
            relayPushConsentRequest = nil
            pushGatewayRegistrationFailure = nil
            await refreshPushGatewayConfiguration()
            AppLog.make(category: "push").info(
                "APNs push registration reconciled (\(PushRegistrar.environment))"
            )
            requestNotificationDrain()
        } catch PushRegistrationError.unavailable(let reasonCode, _) where reasonCode == "relay-disabled" {
            guard pushRegistrationAttemptIsCurrent(attempt, pairing: pairing) else { return }
            relayPushConsentRequest = RelayPushConsentRequest(pairing: pairing, appId: bundleId)
            pushConfigurationChecks.invalidate()
            pushGatewayConfiguration = .relayConsentRequired
            pushConfigurationAppId = bundleId
        } catch PushRegistrationError.unavailable(let reasonCode, let reason) {
            guard pushRegistrationAttemptIsCurrent(attempt, pairing: pairing) else { return }
            if relayPushConsentRequest?.matches(pairing: pairing, appId: bundleId) == true {
                relayPushConsentRequest = nil
            }
            pushConfigurationChecks.invalidate()
            pushGatewayConfiguration = reasonCode == "no-direct-credential"
                ? .noDirectCredential : .unavailable(reason)
            pushConfigurationAppId = bundleId
            AppLog.make(category: "push").warning(
                "Failed to report APNs token: \(reason)"
            )
        } catch {
            guard pushRegistrationAttemptIsCurrent(attempt, pairing: pairing) else { return }
            recordPushGatewayRegistrationFailure(error)
            AppLog.make(category: "push").warning(
                "Failed to report APNs token: \(String(describing: error))"
            )
        }
    }

    private func recordPushGatewayRegistrationFailure(_ error: Error) {
        if let registrationError = error as? PushRegistrationError {
            switch registrationError {
            case .invalidURL, .invalidResponse:
                pushGatewayRegistrationFailure = "The gateway returned an invalid push response. Update the gateway and try again."
            case .serverError(let status, _):
                pushGatewayRegistrationFailure = "The gateway refused push registration (HTTP \(status)). "
                    + "Check the gateway configuration or repair pairing."
            case .unavailable:
                break
            }
        } else {
            pushGatewayRegistrationFailure = "Could not finish push registration with the gateway. Check the connection and try again."
        }
    }

    public func allowRelayPush(_ request: RelayPushConsentRequest) async throws {
        guard let pairing = pairingCoord.pairing,
              relayPushConsentRequest == request,
              request.matches(pairing: pairing, appId: request.appId)
        else { throw PushRegistrationError.invalidResponse }
        let attempt = pushRegistrationAttempts.begin()
        do {
            try await pushRegistrationCoordinator.allowRelay(pairing: pairing, appId: request.appId)
        } catch let error as PushRegistrationError {
            do {
                try await retryConsentAfterHello(
                    error,
                    attempt: attempt,
                    pairing: pairing,
                    request: request
                )
            } catch {
                logConsentFailure(error)
                throw error
            }
        } catch {
            logConsentFailure(error)
            throw error
        }
        guard pushRegistrationAttemptIsCurrent(attempt, pairing: pairing),
              relayPushConsentRequest == request
        else { return }
        relayPushConsentRequest = nil
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Replays a refused consent save after the socket hello lands. The tap
    /// can outrun the hello that refreshes the gateway's stored app identity,
    /// but the reverse ordering happens too: the hello can land after the
    /// gateway decides yet before the 400 reaches the phone. The retry
    /// decision therefore never consults pre-failure hello state — the
    /// bounded wait below confirms it either way (immediately when already
    /// connected), so both orderings get exactly one retry. Deterministic
    /// refusals surface immediately: no hello will change them.
    private func retryConsentAfterHello(
        _ error: PushRegistrationError,
        attempt: UInt64,
        pairing: Pairing,
        request: RelayPushConsentRequest
    ) async throws {
        guard case .serverError(let status, let body) = error,
              RelayConsentRetryPolicy.shouldRetry(status: status, body: body),
              pushRegistrationAttemptIsCurrent(attempt, pairing: pairing),
              await waitForHelloConfirmation(),
              let current = pairingCoord.pairing,
              relayPushConsentRequest == request,
              request.matches(pairing: current, appId: request.appId),
              pushRegistrationAttemptIsCurrent(attempt, pairing: current)
        else { throw error }
        try Task.checkCancellation()
        try await pushRegistrationCoordinator.allowRelay(pairing: current, appId: request.appId)
    }

    private func waitForHelloConfirmation() async -> Bool {
        guard let socket = adminCoord.deviceSocket else { return false }
        return await socket.waitUntilConnected()
    }

    private func logConsentFailure(_ error: Error) {
        if let registration = error as? PushRegistrationError,
           case .serverError(let status, let body) = registration {
            AppLog.make(category: "push").warning(
                "Relay consent save failed: status \(status) reason \(RelayConsentSaveMessage.refusalReason(in: body) ?? "unknown")"
            )
        } else {
            AppLog.make(category: "push").warning(
                "Relay consent save failed: \(String(describing: error))"
            )
        }
    }

    public func dismissRelayPushConsent(_ request: RelayPushConsentRequest) {
        if relayPushConsentRequest == request {
            pushRegistrationAttempts.invalidate()
            relayPushConsentRequest = nil
        }
    }

    private func pushRegistrationAttemptIsCurrent(_ attempt: UInt64, pairing: Pairing) -> Bool {
        pushRegistrationAttempts.isCurrent(attempt) && pairingCoord.pairing == pairing
    }

    // MARK: - Pairing (delegates to PairingCoordinator + orchestrates)

    public func reload() {
        pushRegistrationAttempts.invalidate()
        pushCallbackRequests.invalidate()
        pushConfigurationChecks.invalidate()
        pushGatewayConfiguration = .notChecked
        pushConfigurationAppId = nil
        pushRegistrationFailure = nil
        pushGatewayRegistrationFailure = nil
        relayPushConsentRequest = nil
        let state = pairingCoord.reload()
        if let pairing = pairingCoord.pairing, localSourceOwner.deviceId == nil {
            // A launch that finds a pairing and no recorded owner gives the pairing the local source state.
            localSourceOwner.deviceId = pairing.deviceId
        }
        if pairingCoord.pairing != nil {
            holdPhoneSetupEvaluation()
            pairingRuntimeTask = Task { await rebuildAfterPairingChange() }
        } else {
            let shouldWipeBuffer = switch state {
            case .some(.legacyPairingRequiresRepair): true
            case .some(.paired), .some(.unpaired), .none: false
            }
            pairingRuntimeTask = Task { await tearDownAfterPairingLoss(wipeBuffer: shouldWipeBuffer) }
        }
    }

    /// Tear down clients that captured a pairing which is no longer usable.
    /// Legacy shared-credential recovery also drops buffered uploads tied to
    /// the old device identity. User-authored notes and HealthKit/source
    /// preferences survive, matching an intentional re-pair.
    private func tearDownAfterPairingLoss(wipeBuffer: Bool) async {
        adminCoord.stopAdmin()
        agentCoord.teardown()
        notesCoord.teardown()
        await syncCoord.tearDownCollector()
        if wipeBuffer {
            PairingCoordinator.wipeBufferDirectory()
        }
        await rebuildCollectorWithCurrentSources()
        adminCoord.clearCaches()
        pendingLocalSourceDepartures = []
        pendingLocalSourceResumes = []
        localSourceActionIds.removeAll()
    }

    /// Synchronous pair entrypoint. Only supports V1 payloads; V2 needs
    /// `pairAsync(raw:)`.
    public func pair(raw: String) {
        if let pairing = pairingCoord.pair(raw: raw) {
            pushRegistrationAttempts.invalidate()
            pushCallbackRequests.invalidate()
            pushConfigurationChecks.invalidate()
            pushGatewayConfiguration = .notChecked
            pushConfigurationAppId = nil
            pushRegistrationFailure = nil
            pushGatewayRegistrationFailure = nil
            relayPushConsentRequest = nil
            claimLocalSources(for: pairing)
            holdPhoneSetupEvaluation()
            pairingRuntimeTask = Task { await rebuildAfterPairingChange() }
        }
    }

    /// Async pair entrypoint. Handles the V2 exchange-code handshake
    /// (POST /devices/pair). Also falls back to V1 for legacy QR payloads.
    public func pairAsync(raw: String) async {
        if let pairing = await pairingCoord.pairAsync(raw: raw) {
            pushRegistrationAttempts.invalidate()
            pushCallbackRequests.invalidate()
            pushConfigurationChecks.invalidate()
            pushGatewayConfiguration = .notChecked
            pushConfigurationAppId = nil
            pushRegistrationFailure = nil
            pushGatewayRegistrationFailure = nil
            relayPushConsentRequest = nil
            claimLocalSources(for: pairing)
            holdPhoneSetupEvaluation()
            await rebuildAfterPairingChange()
        }
    }

    public func unpair() async {
        pushRegistrationAttempts.invalidate()
        pushCallbackRequests.invalidate()
        pushConfigurationChecks.invalidate()
        pushGatewayConfiguration = .notChecked
        pushConfigurationAppId = nil
        pushRegistrationFailure = nil
        pushGatewayRegistrationFailure = nil
        relayPushConsentRequest = nil
        let stagedRevocation = pairingCoord.stageUnpair()
        guard stagedRevocation != nil || pairingCoord.pairing == nil else { return }
        adminCoord.stopAdmin()
        agentCoord.teardown()
        NotificationClaimCredentials.clear()
        clearPushRegistrationAfterPairingLoss()
        // Wipe the pending notes queue only once the pairing is
        // actually cleared — notes are user-authored content, and a
        // failed clear (still paired) must not have pre-discarded them.
        notesCoord.teardownAndWipeQueue()
        resetLocalSourceOptIns()
        #if canImport(UserNotifications)
        // Drop any pending stale-sync reminder so the user doesn't
        // get nagged about an app they've intentionally stopped using.
        Task { await staleSyncReminder.cancelReminder() }
        #endif
        await syncCoord.tearDownCollector()
        #if os(iOS) && canImport(CoreLocation)
        // Stop visit monitoring so the CLLocationManager doesn't keep
        // running (and holding the Always-location indicator) after unpair,
        // and wipe the durable buffer so a fresh pairing (whose sync cursor
        // is gateway-side and starts empty) doesn't re-flush a previous
        // session's places.
        visitProvider?.stop()
        visitProvider = nil
        VisitStore().reset()
        #endif
        adminCoord.clearCaches()
        lastError = nil
        localSourceOwner.deviceId = nil
        permissionHealthCoordinator.reset()
        relayPushConsentRequest = nil
        await retryPendingDeviceRevocation()
    }

    /// Retry the securely journaled self-revocation. Success and credentials
    /// invalidated by a repair both settle the job; transport/5xx failures stay
    /// durable for the next foreground or process launch.
    func retryPendingDeviceRevocation() async {
        while let pending = pairingCoord.pendingRevocation() {
            let session: URLSessionLike = if pending.tlsMode == .pinnedLeaf, let fingerprint = pending.fingerprint {
                PinnedSession(fingerprintHex: fingerprint).session
            } else {
                URLSession.shared
            }
            do {
                try await AdminClient(
                    baseURL: pending.url,
                    token: pending.token,
                    pairingGeneration: pending.pairingGeneration,
                    session: session
                ).revokeDevice(id: pending.deviceId)
                pairingCoord.settlePendingRevocation(pending)
            } catch GatewayClient.Error.unauthorized,
                GatewayClient.Error.forbidden,
                GatewayClient.Error.notFound {
                pairingCoord.settlePendingRevocation(pending)
            } catch GatewayClient.Error.serverError(let status, _) where status == 409 {
                pairingCoord.settlePendingRevocation(pending)
            } catch {
                AppLog.make(category: "pairing").debug(
                    "Gateway self-unpair remains queued: \(String(describing: error), privacy: .private)"
                )
                return
            }
        }
    }

    /// Re-pair with a new (or same) gateway. Like `unpair()` but keeps the
    /// HealthKit permission flag so the user doesn't have to re-see the
    /// pre-permissions screen — iOS HealthKit grants are system-level and
    /// already in place. Wipes the offline buffer because buffered batches
    /// are scoped to the old pairing's token / sourceId and can't be
    /// drained against a fresh pairing.
    public func beginRepair() async {
        pushRegistrationAttempts.invalidate()
        pushCallbackRequests.invalidate()
        pushConfigurationChecks.invalidate()
        pushGatewayConfiguration = .notChecked
        pushConfigurationAppId = nil
        pushRegistrationFailure = nil
        pushGatewayRegistrationFailure = nil
        relayPushConsentRequest = nil
        adminCoord.stopAdmin()
        agentCoord.teardown()
        // Notes queue survives the re-pair (it delivers to the next
        // gateway) — only the client is dropped.
        notesCoord.teardown()
        guard pairingCoord.clear() else { return }
        phoneSetup.endForPairingLoss()
        NotificationClaimCredentials.clear()
        clearPushRegistrationAfterPairingLoss()
        await syncCoord.tearDownCollector()
        PairingCoordinator.wipeBufferDirectory()
        adminCoord.clearCaches()
        pendingLocalSourceDepartures = []
        pendingLocalSourceResumes = []
        localSourceActionIds.removeAll()
        lastError = nil
        relayPushConsentRequest = nil
        pairingCoord.enterRepairMode()
        // Keep enabledCategories as-is — re-pairing doesn't revoke HealthKit
        // permissions.
    }

    /// Actor cleanup cannot be synchronous from these UI entrypoints. Recheck
    /// pairing state on the main actor before enqueueing it: if a fast repair
    /// already installed a new session, its registration must win rather than
    /// be erased by delayed cleanup from the old one.
    private func clearPushRegistrationAfterPairingLoss() {
        Task { @MainActor [weak self] in
            guard let self, self.pairingCoord.pairing == nil else { return }
            try? await self.pushRegistrationCoordinator.clear()
        }
    }

    // MARK: - HealthKit authorization + background delivery

    /// Request HealthKit read access for the Health categories that are on.
    /// Turning a category on later asks again for that category's types.
    @discardableResult
    public func requestHealthKitAuthorization() async -> Bool {
        #if canImport(HealthKit)
        let authorizer: any HealthReadAuthorizing = healthKitClient ?? HealthKitClient()
        return await requestHealthKitAuthorization(using: authorizer)
        #else
        healthSettings.hasRequestedHealthKitAuthorization = true
        return false
        #endif
    }

    #if canImport(HealthKit)
    /// Testable authorization boundary. A disabled source intentionally has no
    /// collector-owned HealthKit client, so authorization may use a temporary
    /// read-only client before the source is committed and constructed.
    func requestHealthKitAuthorization(using authorizer: any HealthReadAuthorizing) async -> Bool {
        do {
            let types = TypeCatalog.readObjectTypes(in: enabledCategories)
            // HealthKit only shows its sheet for types it has not asked about.
            let showsSheet = await authorizer.shouldRequestAuthorization(for: types)
            try await SystemPromptActivity.shared.during(showsSheet) {
                try await authorizer.requestAuthorization(for: types)
            }
            healthSettings.hasRequestedHealthKitAuthorization = true
            if appleHealthEnabled { await startHealthKitObservers() }
            return true
        } catch {
            lastError = "HealthKit authorization failed: \(error)"
            return false
        }
    }
    #endif

    // MARK: - Apple Health opt-in / opt-out

    /// Enable Apple Health from Settings or phone setup.
    @discardableResult
    public func enableAppleHealth(
        activationChoice: MobileSourceActivationChoice? = nil
    ) async
        -> MobileSourceEnableResult {
        await activateLocalSource(
            AppleHealthSetupStep.sourceId,
            contract: appleHealthHostedSourceContract,
            copy: AppleHealthSetupStep.copy,
            choice: activationChoice,
            steps: LocalSourceActivationPlan.steps(
                authorize: {
                    guard self.healthDataAvailable else { return .unavailable(reason: PhoneSetupCopy.notAvailableReason) }
                    guard !self.enabledCategories.isEmpty else {
                        return .failed(message: AppleHealthSetupStep.noCategoriesMessage)
                    }
                    #if canImport(HealthKit)
                    // A category can hold no type this iOS version can read.
                    guard !TypeCatalog.readObjectTypes(in: self.enabledCategories).isEmpty else {
                        return .failed(message: AppleHealthSetupStep.unreadableCategoriesMessage)
                    }
                    #endif
                    // Apple hides per-type denials, so a completed request grants
                    // whatever HealthKit access the user allowed.
                    return await self.requestHealthKitAuthorization()
                        ? .granted(.full)
                        : .failed(message: "iOS couldn't show the Health access sheet. Try again.")
                },
                switchOn: {
                    self.healthSettings.appleHealthEnabled = true
                    self.appleHealthEnabled = true
                },
                rebuildCollector: { await self.rebuildCollectorWithCurrentSources() },
                afterRebuild: { await self.startHealthKitObservers() }
            )
        )
    }

    /// Disable Apple Health and take this device off the source's hosts.
    public func disableAppleHealth() async {
        // Nothing still turning the source on may host it again.
        localSourceActivator.abandon(AppleHealthSetupStep.sourceId)
        guard pairingCoord.pairing != nil else {
            healthSettings.appleHealthEnabled = false
            appleHealthEnabled = false
            await rebuildCollectorWithCurrentSources()
            await refreshSourcePermissionHealth()
            return
        }
        let sourceId = "apple-health:local"
        await stopLocalSourceContribution(sourceId)
        healthSettings.appleHealthEnabled = false
        appleHealthEnabled = false
        await rebuildCollectorWithCurrentSources()
        adminCoord.dropSourceLocally(sourceId: sourceId)
        await refreshSourcePermissionHealth()
    }

    /// Toggle whether a category is part of the sync rotation. The collector
    /// is rebuilt with the new catalog first. HealthKit was only asked for the
    /// categories that were on at the time, so turning one on then asks for
    /// its types, and background delivery is reinstalled for the new catalog.
    public func setCategory(_ category: HealthCategory, enabled: Bool) {
        healthSettings.setCategory(category, enabled: enabled)
        enabledCategories = healthSettings.enabledCategories
        guard appleHealthEnabled else { return }
        categoryRebuildTask?.cancel()
        categoryRebuildTask = Task {
            await rebuildCollectorWithCurrentSources()
            guard !Task.isCancelled else { return }
            #if canImport(HealthKit)
            if let installed = backgroundDelivery {
                backgroundDelivery = nil
                await installed.uninstall()
            }
            #endif
            guard !Task.isCancelled else { return }
            if enabled {
                await requestHealthKitAuthorization()
            }
            // A newer change starts the observers itself.
            guard !Task.isCancelled else { return }
            await startHealthKitObservers()
        }
    }

    // MARK: - Activity Segments opt-in / opt-out

    /// Enable Activity Segments from Settings or phone setup. Core Motion has
    /// no request call, so `MotionAuthorization` asks with a short activity
    /// query before anything is committed.
    @discardableResult
    public func enableActivitySegments(
        activationChoice: MobileSourceActivationChoice? = nil
    ) async
        -> MobileSourceEnableResult {
        await activateLocalSource(
            MovementSetupStep.sourceId,
            contract: activitySegmentsHostedSourceContract,
            copy: MovementSetupStep.copy,
            choice: activationChoice,
            steps: LocalSourceActivationPlan.steps(
                authorize: { await MotionAuthorization.request().setupAuthorization ?? .notAllowed },
                switchOn: {
                    self.activitySegmentsSettings.enabled = true
                    self.activitySegmentsEnabled = true
                },
                rebuildCollector: { await self.rebuildCollectorWithCurrentSources() }
            )
        )
    }

    /// Disable Activity Segments and take this device off the source's hosts.
    public func disableActivitySegments() async {
        // Nothing still turning the source on may host it again.
        localSourceActivator.abandon(MovementSetupStep.sourceId)
        guard pairingCoord.pairing != nil else {
            activitySegmentsSettings.enabled = false
            activitySegmentsEnabled = false
            await rebuildCollectorWithCurrentSources()
            await refreshSourcePermissionHealth()
            return
        }
        let sourceId = "activity-segments:local"
        await stopLocalSourceContribution(sourceId)
        activitySegmentsSettings.enabled = false
        activitySegmentsEnabled = false
        await rebuildCollectorWithCurrentSources()
        adminCoord.dropSourceLocally(sourceId: sourceId)
        await refreshSourcePermissionHealth()
    }

    // MARK: - Location Visits opt-in / opt-out

    /// Enable Location Visits from Settings or phone setup. Location access is
    /// asked for explicitly (While Using, then Always) before anything is
    /// committed; rebuilding the collector only starts visit monitoring.
    @discardableResult
    public func enableCoreLocationVisits(
        activationChoice: MobileSourceActivationChoice? = nil
    ) async
        -> MobileSourceEnableResult {
        await activateLocalSource(
            PlacesSetupStep.sourceId,
            contract: coreLocationVisitsHostedSourceContract,
            copy: PlacesSetupStep.copy,
            choice: activationChoice,
            steps: LocalSourceActivationPlan.steps(
                authorize: { await LocationVisitsAuthorization.request().setupAuthorization ?? .notAllowed },
                switchOn: {
                    self.coreLocationVisitsSettings.enabled = true
                    self.coreLocationVisitsEnabled = true
                },
                rebuildCollector: { await self.rebuildCollectorWithCurrentSources() }
            )
        )
    }

    /// Disable Location Visits and take this device off the source's hosts.
    public func disableCoreLocationVisits() async {
        // Nothing still turning the source on may host it again.
        localSourceActivator.abandon(PlacesSetupStep.sourceId)
        guard pairingCoord.pairing != nil else {
            coreLocationVisitsSettings.enabled = false
            coreLocationVisitsEnabled = false
            await rebuildCollectorWithCurrentSources()
            await refreshSourcePermissionHealth()
            return
        }
        let sourceId = "core-location-visits:local"
        await stopLocalSourceContribution(sourceId)
        coreLocationVisitsSettings.enabled = false
        coreLocationVisitsEnabled = false
        await rebuildCollectorWithCurrentSources()
        adminCoord.dropSourceLocally(sourceId: sourceId)
        await refreshSourcePermissionHealth()
    }

    /// Install HKObserverQuery + enableBackgroundDelivery for every
    /// type. iOS will wake the app when HealthKit gets new samples and
    /// we'll drive a collector sync pass. Safe to call multiple times.
    private func startHealthKitObservers() async {
        #if canImport(HealthKit)
        guard let client = healthKitClient, syncCoord.core != nil else { return }
        let filteredCatalog = TypeCatalog.v1.filter {
            enabledCategories.contains($0.category)
        }
        let installer = backgroundDelivery ?? BackgroundDeliveryInstaller(
            client: client, catalog: filteredCatalog
        )
        backgroundDelivery = installer
        await installer.install { [weak self] in
            // The closure is `@Sendable` (runs in the global actor
            // context). Hop to the main actor to fire-and-forget a sync
            // on the main-actor-isolated coordinator. `Task<Void, Never>`
            // pins the overload (throwing vs non-throwing) and the
            // `_ =` discards the value so `MainActor.run`'s closure
            // returns `Void` — without that, type inference flips and
            // the closure body becomes `Task<Void, Never>` instead.
            await MainActor.run { [weak self] in
                _ = Task<Void, Never> { [weak self] in
                    await self?.syncCoord.syncOne(sourceId: "apple-health:local")
                }
            }
        }
        #endif
    }

    // MARK: - Photos opt-in / opt-out

    /// Enable the Photos source from Settings or phone setup. A limited
    /// library is a grant: it syncs the photos the user selected.
    @discardableResult
    public func enablePhotos(
        activationChoice: MobileSourceActivationChoice? = nil
    ) async
        -> MobileSourceEnableResult {
        await activateLocalSource(
            PhotosSetupStep.sourceId,
            contract: photosHostedSourceContract,
            copy: PhotosSetupStep.copy,
            choice: activationChoice,
            steps: LocalSourceActivationPlan.steps(
                authorize: {
                    await self.requestPhotosAuthorization()
                    return PhotosAuthorization.current.setupAuthorization ?? .notAllowed
                },
                switchOn: {
                    self.photosSettings.enable()
                    self.photosEnabled = true
                },
                // Rebuilding installs the library observer for an enabled source.
                rebuildCollector: { await self.rebuildCollectorWithCurrentSources() }
            )
        )
    }

    /// Disable the Photos source and take this device off its hosts.
    public func disablePhotos() async {
        // Nothing still turning the source on may host it again.
        localSourceActivator.abandon(PhotosSetupStep.sourceId)
        uninstallPhotoLibraryObserver()
        guard pairingCoord.pairing != nil else {
            photosSettings.disable()
            photosEnabled = false
            await rebuildCollectorWithCurrentSources()
            await refreshSourcePermissionHealth()
            return
        }
        let sourceId = "photos:local"
        await stopLocalSourceContribution(sourceId)
        photosSettings.disable()
        photosEnabled = false
        await rebuildCollectorWithCurrentSources()
        adminCoord.dropSourceLocally(sourceId: sourceId)
        await refreshSourcePermissionHealth()
    }

    /// Request Photos library read access (`PHAccessLevel.readWrite` —
    /// the level that grants read; see `PhotosAuthorization`).
    @discardableResult
    public func requestPhotosAuthorization() async -> Bool {
        #if canImport(Photos)
        let granted = await PhotosAuthorization.requestAuthorization()
        await refreshPhotosAccessState()
        return granted
        #else
        false
        #endif
    }

    /// Install the foreground `PHPhotoLibraryChangeObserver` if Photos is
    /// enabled and the collector core exists. Safe to call multiple
    /// times — a fresh observer replaces any previous one.
    private func installPhotoLibraryObserverIfNeeded() {
        #if canImport(Photos)
        guard photosEnabled, syncCoord.core != nil else { return }
        photoLibraryObserver?.uninstall()
        let observer = PhotoLibraryObserver(onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                await PhotosPermissionTransitionCoordinator.authorizationChanged(
                    access: PhotosAuthorization.current,
                    settings: self.photosSettings,
                    rebuild: { await self.rebuildCollectorWithCurrentSources() },
                    refresh: { await self.refreshSourcePermissionHealth() },
                    sync: { await self.syncCoord.syncOne(sourceId: "photos:local") }
                )
            }
        }, onRemoval: { [weak self] in
            Task { @MainActor [weak self] in
                await self?.performSafePhotosReconcile(stampSchedule: false)
            }
        })
        observer.install()
        photoLibraryObserver = observer
        #endif
    }

    private func uninstallPhotoLibraryObserver() {
        #if canImport(Photos)
        photoLibraryObserver?.uninstall()
        photoLibraryObserver = nil
        #endif
    }

    /// Called from the Photos `BGProcessingTask` handler (wired via
    /// `SyncCoordinator.setOnPhotosBackfillRequested`): drives the
    /// regular cursor-driven sync, then the throttled whole-library
    /// reconcile-deletion backstop (at most once/day).
    private func runPhotosBackfillTask() async {
        #if canImport(Photos)
        guard photosEnabled else { return }
        await syncCoord.syncOne(sourceId: "photos:local")
        let now = Date()
        let due = photosSettings.lastReconcileAt.map { now.timeIntervalSince($0) >= 24 * 60 * 60 } ?? true
        guard due else { return }
        await performSafePhotosReconcile(stampSchedule: true, now: now)
        #endif
    }

    #if canImport(Photos)
    /// Observe access changes before rebuilding. The access epoch is carried
    /// inside the source cursor, so a restored Full grant starts a complete
    /// replay without an out-of-band cursor reset racing an older save.
    private func refreshPhotosAccessState() async {
        guard photosEnabled else { return }
        let restored = photosSettings.observeAccess(PhotosAuthorization.current)
        if restored {
            await rebuildCollectorWithCurrentSources()
        }
    }

    private func performSafePhotosReconcile(stampSchedule: Bool, now: Date = Date()) async {
        guard photosEnabled, let photosSource else { return }
        do {
            let outcome = try await photosSource.reconcileDeletions()
            if stampSchedule, outcome == .performed {
                photosSettings.recordReconcile(outcome, at: now)
            }
        } catch {
            AppLog.make(category: "app").warning(
                "Photos reconcile-deletions failed: \(String(describing: error))"
            )
        }
    }
    #endif

    // MARK: - Sync / drain (delegate to SyncCoordinator)

    public func syncAll() async {
        await syncCoord.syncAll()
    }

    /// Run one source hosted by this phone. Lifecycle events optimistically
    /// update `syncStatusesBySource`, so every settings card reflects progress.
    public func syncSource(sourceId: String) async {
        await syncCoord.syncOne(sourceId: sourceId)
    }

    /// Re-evaluate every source-owned capability using current OS state, then
    /// best-effort replace each gateway snapshot. A 404 means an older gateway
    /// or a source row still being registered; local remediation stays visible
    /// and the next foreground refresh retries.
    public func refreshSourcePermissionHealth() async {
        let pairing = pairingCoord.pairing
        let client = pairing.map {
            AdminClient(baseURL: $0.url, token: $0.token, session: OmnesisURLSession.shared)
        }
        await permissionHealthCoordinator.refresh(
            sources: sourcePermissionHealthChecks(),
            report: client.map { client in
                { [weak self] report in
                    guard await MainActor.run(body: { self?.pairingCoord.pairing == pairing }) else { return }
                    try await client.reportPermissionHealth(report)
                }
            }
        )
    }

    private func sourcePermissionHealthChecks() -> [PermissionHealthCoordinator.SourceCheck] {
        var checks: [PermissionHealthCoordinator.SourceCheck] = []
        let now = Date()
        let backgroundRefresh = BackgroundRefreshPermissionState.current

        checks.append(.init(enabled: appleHealthEnabled) {
            AppleHealthPermissionHealth.report(backgroundRefresh: backgroundRefresh, checkedAt: now)
        })
        #if canImport(CoreMotion) && os(iOS)
        checks.append(.init(enabled: activitySegmentsEnabled) {
            ActivitySegmentsPermissionHealth.report(
                state: MotionAuthorization.current, backgroundRefresh: backgroundRefresh, checkedAt: now
            )
        })
        #endif
        #if os(iOS) && canImport(CoreLocation)
        checks.append(.init(enabled: coreLocationVisitsEnabled) {
            CoreLocationVisitsPermissionHealth.report(
                state: LocationVisitsAuthorization.current,
                precise: LocationVisitsAuthorization.isPrecise,
                checkedAt: now
            )
        })
        #endif
        #if canImport(Photos)
        checks.append(.init(enabled: photosEnabled) { [weak self] in
            guard let self else { return nil }
            await self.refreshPhotosAccessState()
            return PhotosPermissionHealth.report(
                access: PhotosAuthorization.current,
                backgroundRefresh: backgroundRefresh,
                checkedAt: now
            )
        })
        #endif
        return checks
    }

    /// Drain both queues, returning what the *buffer* drain amounted to —
    /// the one the delivery-health warning is about. The notes queue drains
    /// alongside it and reports through its own surface.
    @discardableResult
    public func drainPending() async -> DrainOutcome {
        let outcome = await syncCoord.drainPending()
        await notesCoord.drainPending()
        return outcome
    }

    /// Drain because the user asked, reporting through `pushRetryPhase`. See
    /// `SyncCoordinator.retryDelivery`.
    public func retryPushDelivery() async {
        await syncCoord.retryDelivery()
    }

    /// Delete the batches the uploader gave up on. See
    /// `SyncCoordinator.discardQuarantined`.
    public func discardQuarantined() async {
        await syncCoord.discardQuarantined()
    }

    // MARK: - Scene lifecycle

    /// HomeView reports its section whenever it changes. We persist only when
    /// the scene actually backgrounds, so a transient inactive phase (system
    /// sheet, notification shade) cannot move the one-hour clock.
    func homeTabChanged(_ tab: HomeTab) {
        currentHomeTab = tab
    }

    private func applyForegroundConversationPolicyIfNeeded() {
        guard foregroundDecisionPending else { return }
        foregroundDecisionPending = false
        // A launch caused by an explicit destination owns navigation from the
        // outset. Check here as well as in HomeView: the destination view may
        // consume a queued push during its own onAppear before the parent's
        // automatic-request observer runs.
        guard notificationRouter.pendingTarget == nil,
              !CaptureRouter.shared.isFresh() else { return }
        foregroundRequestId &+= 1
        foregroundConversationRequest = ForegroundConversationRequest(
            id: foregroundRequestId,
            action: foregroundConversationStore.action()
        )
    }

    func onActive() async {
        await retryPendingDeviceRevocation()
        // Decide navigation before any sync/network await. This gives the
        // explicit fresh/exact-conversation choice a generation immediately,
        // so bootstrap or foreground reconciliation cannot land over it.
        applyForegroundConversationPolicyIfNeeded()
        // A request that arrived while the app was away is offered by the
        // home banner. The read runs beside the foreground work rather than
        // ahead of it, so a gateway that is slow to answer cannot hold up
        // push registration, permission health, or the sync below.
        Task { await adminCoord.refreshPendingAccessRequests() }
        // Re-evaluate notification settings on every foreground transition:
        // users can change permission, alerts, or Scheduled Summary while the
        // app is backgrounded. Reporting is detached from this foreground
        // sequence and doubles as an opportunistic retry.
        await requestPushAndRegister()
        requestNotificationDrain()
        permissionHealthCoordinator.allowReportingAgain()
        await refreshSourcePermissionHealth()
        await reconcileLocalSourceMembership()
        localSourceActivator.clearIssues(forEnabled: Set(enabledLocalSourceIds()))
        // When app comes foreground: pull any new HealthKit samples via
        // syncAll (also drains the buffer afterwards inside syncOne).
        // Previously this only called drainPending, which uploaded
        // already-buffered batches but did NOT read new samples — so
        // opening the app didn't actually feel "live" until the user
        // tapped Sync Now. We still call refreshSources to kick the
        // admin registry.
        await syncAll()
        await adminCoord.refreshSources()
        await adminCoord.refreshGatewayStats()
        // Deliver any notes captured while backgrounded / offline (the
        // Siri intent queues without waking the UI).
        await notesCoord.drainPending()
        // Reconnect the agent SSE stream immediately — it was suspended while
        // backgrounded, so a turn that completed in the meantime would
        // otherwise sit invisible until the idle watchdog or next launch.
        agentCoord.onForeground()
        // Frontmost again. Whether that means a conversation is being read is
        // the transcript surface's answer, not this one's.
        agentCoord.appActiveChanged(true)
    }

    /// Coalesce socket and foreground triggers into one bounded FIFO drain.
    /// A trigger arriving during the network round trip requests one follow-up
    /// pass; every pass re-checks the captured pairing before rendering.
    private func requestNotificationDrain() {
        notificationDrainAgain = true
        guard notificationDrainTask == nil else { return }
        notificationDrainTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.notificationDrainTask = nil }
            while self.notificationDrainAgain {
                self.notificationDrainAgain = false
                await self.drainNotificationBatch()
            }
        }
    }

    private func drainNotificationBatch() async {
        #if canImport(UserNotifications)
        guard let pairing = pairingCoord.pairing,
              let stored = try? NotificationClaimCredentials.stored(
                  keychain: NotificationClaimCredentials.sharedKeychain()
              ),
              stored.deviceId == pairing.deviceId,
              let claimer = NotificationClaimCredentials.load()
        else { return }
        let center = UNUserNotificationCenter.current()
        _ = await drainClaimedNotifications(
            session: pairing,
            maxItems: 20,
            isCurrent: { [weak self] captured in
                await MainActor.run { self?.pairingCoord.pairing == captured }
            },
            claim: { try await claimer.claim() },
            render: { claimed in
                let content = UNMutableNotificationContent()
                applyClaimedNotification(claimed, to: content)
                content.sound = .default
                try await center.add(
                    UNNotificationRequest(
                        identifier: claimed.localRequestIdentifier,
                        content: content,
                        trigger: nil
                    )
                )
            },
            confirm: { try await claimer.confirm(id: $0) },
            canPresent: { await NotificationPresentationPolicy.canVisiblyPresent(using: center) }
        )
        #endif
    }

    func onBackground() async {
        // Withdraw first: leaving the app means nothing is being read, and
        // waiting behind a full sync risks the app suspending before the mark
        // goes out. An answer arriving right after the phone goes in a pocket
        // must count as unread.
        agentCoord.appActiveChanged(false)
        let state: ForegroundConversationState = if currentHomeTab == .agent {
            agentCoord.sessionId.map(ForegroundConversationState.conversation) ?? .fresh
        } else {
            .outsideAgent
        }
        foregroundConversationStore.save(state: state)
        foregroundDecisionPending = true
        await syncCoord.onBackground()
    }

    /// Call once at `@main` launch so BGTaskScheduler can register our
    /// handler before UIApplication finishes launch.
    public func registerBackgroundTasks() {
        syncCoord.registerBackgroundTasks()
    }

    // MARK: - Admin (delegate to AdminCoordinator)

    public func refreshSources() async {
        await adminCoord.refreshSources()
    }

    public func refreshGatewayStats() async {
        await adminCoord.refreshGatewayStats()
    }

    public func triggerSync(sourceId: String) async throws {
        try await adminCoord.triggerSync(sourceId: sourceId)
    }

    public func setEnabled(sourceId: String, enabled: Bool) async throws {
        try await adminCoord.setEnabled(sourceId: sourceId, enabled: enabled)
    }

    public func removeSource(sourceId: String) async throws {
        try await adminCoord.removeSource(sourceId: sourceId)
    }

    public func resync(sourceId: String) async throws {
        try await adminCoord.resync(sourceId: sourceId)
    }

    /// Groups the source list by type for display — mirrors how the
    /// portal's Sources view is laid out.
    public var groupedSources: [SourceGroup] {
        var grouped: [String: [SourceRecord]] = [:]
        for s in sources {
            grouped[s.type, default: []].append(s)
        }
        return grouped
            .map { SourceGroup(type: $0.key, sources: $0.value.sorted { $0.accountId < $1.accountId }) }
            .sorted { $0.displayName < $1.displayName }
    }

    public struct SourceGroup: Hashable {
        public let type: String
        public let sources: [SourceRecord]
        public var displayName: String {
            humanName(for: type)
        }
    }

    // MARK: - Cross-coordinator orchestration

    /// Run after a successful pair / pair-async / reload to spin up the
    /// collector and admin clients on the new pairing.
    private func rebuildAfterPairingChange() async {
        await rebuildCollectorWithCurrentSources()
        guard let pairing = pairingCoord.pairing else { return }
        await restoreLocalSourceIntentState(pairing: pairing)
        guard pairingCoord.pairing?.pairingGeneration == pairing.pairingGeneration,
              pairingCoord.pairing?.url == pairing.url else { return }
        adminCoord.rebuildAdmin(pairing: pairing) { [weak self] admin, p in
            // Drained before registration, not alongside it: an intent an
            // earlier pairing of this gateway left behind has to settle (or
            // be dropped as stale) before this pairing states which sources
            // it hosts, or it would undo the registration that just ran.
            // A re-pair that adopts the same device id can still
            // replay a queued detach, which pauses the source.
            await self?.reconcileLocalSourceMembership()
            await self?.registerLocalSources(admin: admin, pairing: p)
            self?.permissionHealthCoordinator.allowReportingAgain()
        }
        evaluatePhoneSetup(for: pairing)
        agentCoord.rebuild(pairing: pairing)
        notesCoord.rebuild(baseURL: pairing.url, token: pairing.token, deviceId: pairing.deviceId)
        // Deliver notes captured while unpaired / before this launch.
        Task { await self.notesCoord.drainPending() }
        // Register on every fresh pair so a new pairing's device id gets the
        // APNs token when notifications are already allowed — iOS re-fires
        // `didRegister…` with the same (or rotated) token.
        Task { await self.requestPushAndRegister() }
    }

    /// Build the iOS-side source list from the user's HK toggles and
    /// hand it to `SyncCoordinator.rebuildCollector`. Tearing down the
    /// HealthKit observer / client when AppleHealth is disabled also
    /// happens here so all HK lifecycle stays on AppStore.
    private func rebuildCollectorWithCurrentSources() async {
        guard let pairing = pairingCoord.pairing else {
            await syncCoord.tearDownCollector()
            #if canImport(HealthKit)
            healthKitClient = nil
            if let bd = backgroundDelivery {
                Task { await bd.uninstall() }
            }
            backgroundDelivery = nil
            #endif
            #if canImport(Photos)
            uninstallPhotoLibraryObserver()
            photosSource = nil
            photosAssetIndex = nil
            #endif
            #if os(iOS) && canImport(CoreLocation)
            visitProvider?.stop()
            visitProvider = nil
            #endif
            return
        }
        var sources: [any OmnesisSource] = []
        #if canImport(HealthKit)
        // Apple Health is opt-in (user taps "Enable Apple Health" on
        // the Status tab). Skip the source if the flag is off so we
        // don't instantiate `AppleHealthSource`, install background
        // observers, or push an `apple-health:local` row to the
        // gateway.
        if HealthKitClient.isAvailable, appleHealthEnabled {
            let client = HealthKitClient()
            healthKitClient = client
            let filteredCatalog = TypeCatalog.v1.filter {
                enabledCategories.contains($0.category)
            }
            sources.append(
                AppleHealthSource(
                    client: client,
                    catalog: filteredCatalog
                )
            )
        } else {
            // Tear down any observers we may have installed earlier
            // (e.g. when toggling the flag back off in Settings).
            healthKitClient = nil
            if let bd = backgroundDelivery {
                Task { await bd.uninstall() }
            }
            backgroundDelivery = nil
        }
        #endif
        #if os(iOS)
        // Activity Segments is opt-in (user taps the toggle on the
        // Status tab) — same gating rationale as Apple Health above.
        if activitySegmentsEnabled {
            sources.append(ActivitySegmentsSource())
        }
        #endif
        #if os(iOS) && canImport(CoreLocation)
        // Location Visits is opt-in. When on, reuse (or create) the
        // long-lived visit-monitoring provider, start it wired to nudge a
        // sync on each new visit, and hand the source that provider plus the
        // on-device reverse geocoder. When off, stop monitoring and drop it.
        if coreLocationVisitsEnabled {
            let provider = visitProvider ?? CoreLocationVisitProvider()
            visitProvider = provider
            provider.start(onVisit: { [weak self] in
                Task { @MainActor [weak self] in
                    await self?.syncCoord.syncOne(sourceId: "core-location-visits:local")
                }
            }, onAuthorizationChanged: { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    await self.refreshSourcePermissionHealth()
                }
            })
            sources.append(
                CoreLocationVisitsSource(
                    provider: provider,
                    resolver: ReverseGeocodeVisitPlaceResolver()
                )
            )
        } else if let provider = visitProvider {
            provider.stop()
            visitProvider = nil
        }
        #endif
        #if canImport(Photos)
        // Photos is opt-in (user taps "Enable Photos" on the Settings
        // tab). Skip the source if the flag is off so we don't
        // instantiate `PhotosSource`, install the library observer, or
        // push a `photos:local` row to the gateway.
        if photosEnabled {
            let assetIndex = photosAssetIndex ?? AnalyzedAssetStore(directory: AnalyzedAssetStore.defaultDirectory())
            photosAssetIndex = assetIndex
            let source = PhotosSource(
                library: PHPhotoLibraryReader(),
                assetIndex: assetIndex,
                gateway: GatewayClient(baseURL: pairing.url, token: pairing.token),
                accessEpoch: photosSettings.accessEpoch
            )
            photosSource = source
            sources.append(source)
        } else {
            uninstallPhotoLibraryObserver()
            photosSource = nil
            photosAssetIndex = nil
        }
        #endif
        await syncCoord.rebuildCollector(pairing: pairing, sources: sources)
        #if canImport(Photos)
        if photosEnabled {
            installPhotoLibraryObserverIfNeeded()
        }
        #endif
    }

    func enabledLocalSourceIds() -> [String] {
        var ids: [String] = []
        if appleHealthEnabled {
            ids.append("apple-health:local")
        }
        if activitySegmentsEnabled {
            ids.append("activity-segments:local")
        }
        if coreLocationVisitsEnabled {
            ids.append("core-location-visits:local")
        }
        if photosEnabled {
            ids.append("photos:local")
        }
        return ids
    }

    /// Stop hosting a source the user just turned off. The durable record
    /// is the disable transaction; the gateway call is intentionally
    /// detached so an unreachable gateway cannot hold the local switch on,
    /// and the foreground / WS-reconnect hooks retry the same intent.
    private func stopLocalSourceContribution(_ sourceId: String) async {
        guard let pairing = pairingCoord.pairing else { return }
        prepareLocalSourceActionScope(pairing: pairing)
        let operationId = UUID()
        localSourceActionIds[sourceId] = operationId
        await localSourceMembership.record(
            .detach,
            sourceId: sourceId,
            gateway: pairing.url,
            deviceId: pairing.deviceId,
            pairingGeneration: pairing.pairingGeneration,
            operationId: operationId
        )
        pendingLocalSourceDepartures.insert(sourceId)
        Task { await reconcileLocalSourceMembership() }
    }

    /// Turn on one phone-hosted source through `LocalSourceActivator`, the
    /// path Settings and phone setup share.
    private func activateLocalSource(
        _ sourceId: String,
        contract: HostedSourceContract,
        copy: PhoneSetupCopy,
        choice: MobileSourceActivationChoice?,
        steps: MobileSourceActivationSteps
    ) async
        -> MobileSourceEnableResult {
        adminCoord.beginSourceActivation(sourceId)
        defer { adminCoord.endSourceActivation(sourceId) }
        lastError = nil
        return await localSourceActivator.activate(
            sourceId,
            mode: contract.multiDeviceMode,
            copy: copy,
            choice: choice,
            steps: steps
        )
    }

    private func commitMobileSourceActivation(
        sourceId: String,
        desiredMode: SourceMultiDeviceMode,
        choice: MobileSourceActivationChoice?,
        pairing: Pairing,
        admin: AdminClient
    ) async throws {
        let source = try await admin.listSources().first { $0.id == sourceId }
        let outcome = try await MobileSourceActivation.execute(
            source: source,
            deviceId: pairing.deviceId,
            desiredMode: desiredMode,
            choice: choice,
            operations: MobileSourceActivationOperations(
                setMode: { sourceId, mode in
                    _ = try await admin.patchSource(
                        sourceId: sourceId,
                        multiDeviceMode: mode
                    )
                },
                join: { sourceId, deviceId in
                    _ = try await admin.joinSource(sourceId: sourceId, deviceId: deviceId)
                },
                transfer: { sourceId, deviceId in
                    _ = try await admin.patchSource(sourceId: sourceId, deviceId: deviceId)
                }
            )
        )
        switch outcome {
        case .ready:
            await adminCoord.refreshSources()
        case .incompatible(let current, let desired):
            throw MobileSourceActivationError.incompatibleMode(current, desired)
        case .keptOther, .choiceRequired:
            throw MobileSourceActivationError.hostChanged
        }
    }

    /// Host a source the user just turned back on: rejoin its host list, and
    /// unpause a source this device paused when it left as the only host.
    /// Recording it supersedes a detach the gateway has not seen yet, so a
    /// switch flipped off and on again while offline settles as "on" rather
    /// than replaying the detach afterwards. The pass is awaited (unlike the
    /// detach) so registration and the first sync normally run against a
    /// source the gateway already accepts; when an earlier pass is still in
    /// flight it carries the resume out instead, and registration is
    /// idempotent either way.
    ///
    /// Only the explicit switch calls this — a source the operator paused on
    /// purpose must stay paused across app launches and reconnects.
    ///
    /// False while the durable activation is deferred, or after a permanent
    /// refusal. Deferred activations remain visible and retry on reconnect;
    /// permanent refusals put the local switch back off.
    private func resumeLocalSourceContribution(_ sourceId: String, pairing: Pairing) async -> Bool {
        adminCoord.invalidateSourceRegistryRead()
        pendingLocalSourceDepartures.remove(sourceId)
        prepareLocalSourceActionScope(pairing: pairing)
        let operationId = UUID()
        localSourceActionIds[sourceId] = operationId
        await localSourceMembership.record(
            .resume,
            sourceId: sourceId,
            gateway: pairing.url,
            deviceId: pairing.deviceId,
            pairingGeneration: pairing.pairingGeneration,
            operationId: operationId
        )
        let refused = await reconcileLocalSourceMembership()
        guard pairingCoord.pairing?.pairingGeneration == pairing.pairingGeneration,
              pairingCoord.pairing?.deviceId == pairing.deviceId,
              pairingCoord.pairing?.url == pairing.url else { return false }
        return !refused.contains(sourceId) && !pendingLocalSourceResumes.contains(sourceId)
    }

    private func prepareLocalSourceActionScope(pairing: Pairing) {
        let scope = [pairing.url.absoluteString, pairing.deviceId, pairing.pairingGeneration ?? ""]
        if localSourceActionScope != scope {
            localSourceActionIds.removeAll()
            localSourceActionScope = scope
        }
    }

    private func restoreLocalSourceIntentState(pairing: Pairing) async {
        let queued = await localSourceMembership.pending(gateway: pairing.url)
        guard pairingCoord.pairing?.pairingGeneration == pairing.pairingGeneration,
              pairingCoord.pairing?.deviceId == pairing.deviceId,
              pairingCoord.pairing?.url == pairing.url else { return }
        let current = queued.filter {
            ($0.deviceId == nil || $0.deviceId == pairing.deviceId) && $0.pairingGeneration == pairing.pairingGeneration
        }
        prepareLocalSourceActionScope(pairing: pairing)
        for intent in current where localSourceActionIds[intent.sourceId] == nil {
            localSourceActionIds[intent.sourceId] = intent.operationId
        }
        pendingLocalSourceDepartures = Set(current.filter { $0.operation == .detach }.map(\.sourceId))
        pendingLocalSourceResumes = Set(current.filter { $0.operation == .resume }.map(\.sourceId))
        adminCoord.setPendingSourceResumes(pendingLocalSourceResumes)
    }

    /// Carry out whatever the outbox still owes the paired gateway: leave a
    /// source's host list (pausing it when this device is the only host),
    /// or rejoin and unpause one. Once anything settles the registry is
    /// refetched, so a source that stayed — paused, or hosted elsewhere —
    /// reappears in the list.
    /// Returns the sources whose resume the gateway refused for good, so an
    /// opt-in that is waiting on this pass can stop.
    @discardableResult
    private func reconcileLocalSourceMembership() async -> Set<String> {
        guard let pairing = pairingCoord.pairing, let admin = adminCoord.admin else {
            pendingLocalSourceDepartures = []
            pendingLocalSourceResumes = []
            localSourceActionIds.removeAll()
            return []
        }
        await restoreLocalSourceIntentState(pairing: pairing)
        guard pairingCoord.pairing?.pairingGeneration == pairing.pairingGeneration,
              pairingCoord.pairing?.deviceId == pairing.deviceId,
              pairingCoord.pairing?.url == pairing.url else { return [] }
        let pass = await localSourceMembership.reconcile(
            gateway: pairing.url,
            deviceId: pairing.deviceId,
            pairingGeneration: pairing.pairingGeneration,
            using: LocalSourceMembershipCoordinator.Executor(
                isCurrentSession: { [weak self] in
                    await MainActor.run {
                        self?.pairingCoord.pairing?.pairingGeneration == pairing.pairingGeneration
                            && self?.pairingCoord.pairing?.deviceId == pairing.deviceId
                            && self?.pairingCoord.pairing?.url == pairing.url
                    }
                },
                sources: { try await admin.listSources() },
                create: { sourceId, deviceId in
                    let accountId = sourceAccountOf(sourceId)
                    guard !accountId.isEmpty else { throw GatewayClient.Error.invalidResponse }
                    _ = try await admin.createSource(type: sourceTypeOf(sourceId), accountId: accountId, deviceId: deviceId)
                },
                join: { sourceId, deviceId in
                    _ = try await admin.joinSource(sourceId: sourceId, deviceId: deviceId)
                },
                detach: { sourceId, deviceId in
                    _ = try await admin.detachSourceMember(sourceId: sourceId, deviceId: deviceId)
                },
                setEnabled: { sourceId, enabled in
                    _ = try await admin.patchSource(sourceId: sourceId, enabled: enabled)
                }
            )
        )
        await restoreLocalSourceIntentState(pairing: pairing)
        guard pairingCoord.pairing?.pairingGeneration == pairing.pairingGeneration,
              pairingCoord.pairing?.deviceId == pairing.deviceId,
              pairingCoord.pairing?.url == pairing.url else { return [] }
        let refusedResumes = pass.refusals.filter { $0.operation == .resume }
        for refusal in refusedResumes {
            guard pairingCoord.pairing?.pairingGeneration == pairing.pairingGeneration,
                  pairingCoord.pairing?.deviceId == pairing.deviceId,
                  pairingCoord.pairing?.url == pairing.url else { return [] }
            if localSourceActionIds[refusal.sourceId] == refusal.operationId {
                await abandonRefusedLocalSource(refusal, pairing: pairing)
            }
        }
        if pass.settled {
            await adminCoord.refreshSources()
        }
        let refused = Set(refusedResumes.filter { localSourceActionIds[$0.sourceId] == $0.operationId }.map(\.sourceId))
        if !refused.isEmpty {
            phoneSetup.reconcileRecordedOutcomes()
        }
        await localSourceActivator.settlePendingRegistrations(stillPending: pendingLocalSourceResumes, refused: refused)
        return refused
    }

    /// A resume the gateway refused for good means this phone hosts nothing,
    /// whatever the switch reads — most often because the source's type takes
    /// one host at a time and another device has it. Put the switch back where
    /// the truth is and say why, rather than leaving an on switch that feeds
    /// nothing. No detach is queued: the gateway already says this device is
    /// not a host.
    private func abandonRefusedLocalSource(
        _ refusal: LocalSourceMembershipCoordinator.Refusal,
        pairing: Pairing
    ) async {
        guard isCurrentLocalSourceRefusal(refusal, pairing: pairing) else { return }
        switch refusal.sourceId {
        case "apple-health:local":
            healthSettings.appleHealthEnabled = false
            appleHealthEnabled = false
        case "activity-segments:local":
            activitySegmentsSettings.enabled = false
            activitySegmentsEnabled = false
        case "core-location-visits:local":
            coreLocationVisitsSettings.enabled = false
            coreLocationVisitsEnabled = false
        case "photos:local":
            uninstallPhotoLibraryObserver()
            photosSettings.disable()
            photosEnabled = false
        default:
            return
        }
        await rebuildCollectorWithCurrentSources()
        guard isCurrentLocalSourceRefusal(refusal, pairing: pairing) else { return }
        adminCoord.dropSourceLocally(sourceId: refusal.sourceId)
        lastError = Self.refusedResumeMessage(refusal.code)
        await refreshSourcePermissionHealth()
    }

    private func isCurrentLocalSourceRefusal(
        _ refusal: LocalSourceMembershipCoordinator.Refusal,
        pairing: Pairing
    )
        -> Bool {
        pairingCoord.pairing?.pairingGeneration == pairing.pairingGeneration
            && pairingCoord.pairing?.deviceId == pairing.deviceId
            && pairingCoord.pairing?.url == pairing.url
            && localSourceActionIds[refusal.sourceId] == refusal.operationId
    }

    /// Phone-side copy for a refusal code. The gateway's own message names
    /// source ids and, for some refusals, a command line — neither of which
    /// helps here, so the code is turned into a sentence this screen can act
    /// on instead.
    private static func refusedResumeMessage(_ code: String) -> String {
        switch code {
        case "SOURCE_ALREADY_HOSTED":
            "Another device already syncs that source, and it takes one host at a time. Turned it back off on this phone."
        case "DEVICE_CANNOT_HOST_TYPE":
            "This phone can't host that source. Turned it back off."
        case "DEVICE_REVOKED":
            "This phone's pairing was revoked — re-pair from Settings to sync sources again."
        default:
            "The gateway won't have this phone host that source. Turned it back off."
        }
    }

    /// Explicit activation registers its source. Background startup never
    /// creates registrations, so an old cached row cannot clear a removal
    /// tombstone committed after the read. Existing hosts may refresh icons.
    /// Returns why the gateway rejected registering `allowCreationFor`.
    @discardableResult
    private func registerLocalSources(admin: AdminClient, pairing: Pairing, allowCreationFor: String? = nil) async -> String? {
        guard let core = syncCoord.core else { return nil }
        let ids = await core.registeredSourceIds()
        guard let currentSources = try? await admin.listSources() else { return nil }
        var rejection: String?
        for sourceId in ids {
            let type = sourceTypeOf(sourceId)
            let accountId = sourceAccountOf(sourceId)
            guard !accountId.isEmpty else { continue }
            do {
                let existing = currentSources.first { $0.id == sourceId }
                if MobileSourceActivation.mayCreateRegistration(
                    source: existing,
                    deviceId: pairing.deviceId,
                    sourceId: sourceId,
                    allowCreationFor: allowCreationFor
                ) {
                    _ = try await admin.createSource(
                        type: type,
                        accountId: accountId,
                        deviceId: pairing.deviceId,
                        enabled: true
                    )
                } else if existing?.hosts(pairing.deviceId) != true {
                    continue
                }
            } catch {
                if let gatewayError = error as? GatewayClient.Error,
                   gatewayError.gatewayCode == "SOURCE_REMOVAL_IN_PROGRESS" {
                    let message = "This source is still being removed. Wait for gateway cleanup to finish, then enable it again."
                    if sourceId == allowCreationFor {
                        rejection = message
                    } else {
                        lastError = message
                    }
                    handleSourceRejected(sourceId: sourceId, reason: "removed")
                    continue
                }
                // Non-fatal — sync still works, source just won't appear
                // in portal until the next pairing.
                AppLog.make(category: "app").warning(
                    "Could not register \(sourceId, privacy: .private): \(String(describing: error), privacy: .private)"
                )
            }

            if let identity = identityForSourceType(type) {
                await adminCoord.pushSourceIdentity(
                    pairing: pairing,
                    sourceId: sourceId,
                    identity: identity
                )
            }
        }
        return rejection
    }

    /// What a phone-hosted source is called and what it looks like.
    ///
    /// These four types have no provider package, so nothing else in the
    /// system knows their name or their glyph: whatever the phone declares is
    /// the whole of their identity. A type absent from this table is hosted
    /// somewhere else and declares its own.
    ///
    /// The gateway's `icon-normalizer` rasterizes whatever icon shape is
    /// pushed — `data:image/svg+xml;…` URI, hosted URL, or raw base64 — into a
    /// uniform PNG data URI stored in `sync_state.icon`.
    private func identityForSourceType(_ type: String) -> PhoneSourceIdentity? {
        switch type {
        case "apple-health":
            PhoneSourceIdentity(label: "Apple Health", icon: AppleHealthIcon.dataUri)
        case "activity-segments":
            PhoneSourceIdentity(label: "Activity Segments", icon: ActivitySegmentsIcon.dataUri)
        case "core-location-visits":
            PhoneSourceIdentity(label: "Location Visits", icon: CoreLocationVisitsIcon.dataUri)
        case "photos":
            PhoneSourceIdentity(label: "Photos", icon: PhotosIcon.dataUri)
        default: nil
        }
    }
}

// MARK: - Local source activation

@available(iOS 17.0, *)
extension AppStore {
    /// The app operations `LocalSourceActivator` drives.
    private func makeLocalSourceActivationEnvironment() -> LocalSourceActivationEnvironment {
        LocalSourceActivationEnvironment(
            isGatewayReady: { [weak self] in
                self?.pairingCoord.pairing != nil && self?.adminCoord.admin != nil
            },
            pairingKey: { [weak self] in
                self?.pairingCoord.pairing.map { "\($0.deviceId)|\($0.pairingGeneration ?? "")" }
            },
            isConnected: { [weak self] in
                if case .connected? = self?.adminCoord.wsState { return true }
                return false
            },
            isLocallyEnabled: { [weak self] sourceId in
                self?.enabledLocalSourceIds().contains(sourceId) ?? false
            },
            inspect: { [weak self] sourceId, mode, choice in
                guard let self, let pairing = self.pairingCoord.pairing, let admin = self.adminCoord.admin else {
                    throw GatewayClient.Error.invalidResponse
                }
                // Protected-data access is requested only after the hosting
                // choice is resolved; the mutation is committed afterwards.
                let source = try await admin.listSources().first { $0.id == sourceId }
                return try MobileSourceActivation.inspect(
                    source: source,
                    deviceId: pairing.deviceId,
                    desiredMode: mode,
                    choice: choice
                )
            },
            commit: { [weak self] sourceId, mode, choice in
                guard let self, let pairing = self.pairingCoord.pairing, let admin = self.adminCoord.admin else {
                    throw GatewayClient.Error.invalidResponse
                }
                try await self.commitMobileSourceActivation(
                    sourceId: sourceId,
                    desiredMode: mode,
                    choice: choice,
                    pairing: pairing,
                    admin: admin
                )
            },
            resume: { [weak self] sourceId in
                guard let self, let pairing = self.pairingCoord.pairing else { return .refused(message: nil) }
                let accepted = await self.resumeLocalSourceContribution(sourceId, pairing: pairing)
                return self.localSourceResumeResult(sourceId, accepted: accepted)
            },
            retryResume: { [weak self] sourceId in
                guard let self, let pairing = self.pairingCoord.pairing else { return .refused(message: nil) }
                let refused = await self.reconcileLocalSourceMembership()
                // A pass that finished under another pairing says nothing about this one.
                guard self.pairingCoord.pairing?.pairingGeneration == pairing.pairingGeneration,
                      self.pairingCoord.pairing?.deviceId == pairing.deviceId
                else { return .refused(message: nil) }
                let accepted = !refused.contains(sourceId) && !self.pendingLocalSourceResumes.contains(sourceId)
                return self.localSourceResumeResult(sourceId, accepted: accepted)
            },
            register: { [weak self] sourceId in
                guard let self, let pairing = self.pairingCoord.pairing, let admin = self.adminCoord.admin else {
                    return LocalSourceActivator.notConnectedMessage
                }
                return await self.registerLocalSources(admin: admin, pairing: pairing, allowCreationFor: sourceId)
            },
            startContributing: { [weak self] sourceId in
                self?.permissionHealthCoordinator.allowReportingAgain(for: sourceId)
                Task { [weak self] in
                    await self?.syncAll()
                    await self?.refreshSourcePermissionHealth()
                }
            },
            completionEnded: { [weak self] _ in
                self?.phoneSetup.reconcileRecordedOutcomes()
            },
            sleep: { duration in _ = try? await Task.sleep(for: duration) }
        )
    }

    /// Where a resume stands. A refusal has already turned the switch back off
    /// and left its reason in `lastError`, which moves into the per-source
    /// issue instead of showing twice.
    private func localSourceResumeResult(_ sourceId: String, accepted: Bool) -> LocalSourceResumeResult {
        if accepted { return .accepted }
        if pendingLocalSourceResumes.contains(sourceId) { return .deferred }
        let reason = lastError
        lastError = nil
        return .refused(message: reason)
    }
}

@available(iOS 17.0, *)
extension AppStore {
    /// Count of privacy decisions waiting on the owner — held answers, plus
    /// requests for a standing watch wherever that surface exists. Drives the
    /// badge on the drawer's Privacy entry. Refreshed when the drawer opens;
    /// in-app only, never an OS app-icon badge or a push.
    public var privacyPendingCount: Int {
        adminCoord.privacyPendingCount
    }

    /// Refresh the Privacy badge count. The coordinator is the only writer of
    /// that number: the drawer asks on open, the Privacy feed asks after it
    /// loads, a review asks after it is decided, and the foreground lookup
    /// asks before offering a decision. Best-effort; failures zero the badge.
    public func refreshPrivacyPendingCount() async {
        await adminCoord.refreshPrivacyPendingCount()
    }

    /// Authorization requests waiting on the owner, newest first — what the
    /// home banner offers to review. Refreshed on every foreground and after
    /// a review sheet closes; never polled.
    public var pendingAccessRequests: [AccessPendingRequest] {
        adminCoord.pendingAccessRequests
    }

    /// Refresh the waiting access requests from the gateway's overview.
    /// Best-effort; failures empty the list.
    public func refreshPendingAccessRequests() async {
        await adminCoord.refreshPendingAccessRequests()
    }
}

#if DEBUG
@available(iOS 17.0, *)
extension AppStore {
    /// Whether any transport runtime still holds credentials captured from
    /// a pairing. Used by lifecycle regression tests.
    var pairingTransportRuntimeActiveForTesting: Bool {
        adminCoord.admin != nil || agentCoord.client != nil || syncCoord.core != nil
    }

    /// Wait for the pairing transition `reload()` / `pair(raw:)` started to
    /// finish. Both spawn their runtime build-up or tear-down as a task, so a
    /// test that inspects the runtime on the very next line would otherwise
    /// read the state from before the transition. Returns immediately when no
    /// transition is in flight.
    ///
    /// Covers those two entry points only: `pairAsync`, `unpair` and
    /// `beginRepair` do their work inline, and the build-up itself spawns
    /// untracked follow-on work (note drain, push registration) that this does
    /// not wait for.
    func awaitPairingRuntimeForTesting() async {
        await pairingRuntimeTask?.value
    }

    /// Replaces the gateway client the runtime built, so a test never reaches
    /// the network through it.
    func injectAdminClientForTesting(_ client: AdminClient) {
        adminCoord.injectAdminClientForTesting(client)
    }

    /// Run the real source-registry refresh against a stubbed admin client,
    /// as the phone identified by `localDeviceId`, so the removal
    /// reconciliation that follows it can be asserted without pairing.
    func refreshSourcesForTesting(client: AdminClient, localDeviceId: String) async {
        // Init's `reload()` tears an unpaired runtime down in a task that
        // clears the admin client; let it finish before installing the stub.
        await awaitPairingRuntimeForTesting()
        adminCoord.installPreviewState(
            sources: [],
            statusesBySource: [:],
            deviceNames: [:],
            statusSnapshot: nil,
            indexStats: nil,
            wsState: nil,
            sourceIconByType: [:],
            localDeviceId: localDeviceId
        )
        adminCoord.injectAdminClientForTesting(client)
        await adminCoord.refreshSources()
    }

    /// Build a fully-populated `AppStore` for SwiftUI previews + the
    /// snapshot-test harness. Skips the real pairing reload, then
    /// stamps in whatever fixture state the caller wants. Lives here
    /// so it can write `private(set)` properties on the coordinators
    /// via the test-only setters in each coordinator's `#if DEBUG`
    /// extension.
    @MainActor
    static func preview(
        sources: [SourceRecord] = [],
        internalSources: [InternalSource] = [],
        statusesBySource: [String: SourceSyncStatus] = [:],
        pairedDeviceId: String? = nil,
        deviceNames: [String: String] = [:],
        statusSnapshot: StatusSnapshot? = nil,
        indexStats: IndexStats? = nil,
        wsState: DeviceSocket.ConnectionState? = nil,
        sourceIconByType: [String: String] = [:],
        sourceUnitNameByType: [String: String] = PreviewMocks.agentSourceUnitNames,
        sourceBgColorByType: [String: String] = PreviewMocks.sourceBgColorByType,
        sourceAccentColorByType: [String: String] = PreviewMocks.sourceAccentColorByType,
        sourcesError: Error? = nil,
        appleHealthEnabled: Bool = true,
        activitySegmentsEnabled: Bool = false,
        coreLocationVisitsEnabled: Bool = false,
        photosEnabled: Bool = false,
        pushDeliveryHealth: PushDeliveryHealth = .ok,
        pushGatewayConfiguration: PushGatewayConfiguration = .notChecked,
        pushConfigurationAppId: String? = nil,
        pushRegistrationFailure: String? = nil,
        pushGatewayRegistrationFailure: String? = nil,
        sourcePermissionHealth: [SourcePermissionHealthReport]? = nil,
        sourcePermissionHealthLoading: Bool = false,
        sourcePermissionHealthDeferred: Set<String> = [],
        pairingRecovery: PairingRecovery? = nil,
        briefsUnreadCount: Int = 0,
        privacyPendingCount: Int = 0,
        pendingAccessRequests: [AccessPendingRequest] = [],
        agentPreview: AgentPreviewSeed? = nil,
        pendingLocalSourceDepartures: Set<String> = [],
        pendingSourceRemovals: [PendingSourceRemoval] = [],
        pendingLocalSourceResumes: Set<String> = [],
        localSourceEnableIssues: [String: String] = [:],
        photosAccess: PhotosAccessState? = nil,
        locationVisitsPermission: LocationVisitsPermissionState? = nil
    )
        -> AppStore {
        let store = AppStore(
            service: PairingService(),
            healthSettings: HealthSettings(),
            photosSettings: PhotosSettings(),
            foregroundConversationStore: ForegroundConversationStore(),
            loadPersistedPairing: false
        )
        store.adminCoord.installPreviewState(
            sources: sources,
            internalSources: internalSources,
            statusesBySource: statusesBySource,
            deviceNames: deviceNames,
            statusSnapshot: statusSnapshot,
            indexStats: indexStats,
            wsState: wsState,
            sourceIconByType: sourceIconByType,
            sourceUnitNameByType: sourceUnitNameByType,
            sourceBgColorByType: sourceBgColorByType,
            sourceAccentColorByType: sourceAccentColorByType,
            briefsUnreadCount: briefsUnreadCount,
            privacyPendingCount: privacyPendingCount,
            pendingAccessRequests: pendingAccessRequests,
            pendingSourceRemovals: pendingSourceRemovals
        )
        if let sourcesError {
            store.adminCoord.installPreviewSourcesError(sourcesError)
        }
        store.pendingLocalSourceResumes = pendingLocalSourceResumes
        store.localSourceActivator.installPreviewIssues(localSourceEnableIssues)
        store.previewPermissions = PreviewPermissions(photos: photosAccess, locationVisits: locationVisitsPermission)
        store.pendingLocalSourceDepartures = pendingLocalSourceDepartures
        store.appleHealthEnabled = appleHealthEnabled
        store.activitySegmentsEnabled = activitySegmentsEnabled
        store.coreLocationVisitsEnabled = coreLocationVisitsEnabled
        store.photosEnabled = photosEnabled
        store.pushDeliveryHealth = pushDeliveryHealth
        store.pushGatewayConfiguration = pushGatewayConfiguration
        store.pushConfigurationAppId = pushConfigurationAppId
        store.pushRegistrationFailure = pushRegistrationFailure
        store.pushGatewayRegistrationFailure = pushGatewayRegistrationFailure
        if sourcePermissionHealthLoading {
            store.permissionHealthCoordinator.installLoadingPreview()
        } else if let sourcePermissionHealth {
            store.permissionHealthCoordinator.installPreview(sourcePermissionHealth)
        }
        if !sourcePermissionHealthDeferred.isEmpty {
            store.permissionHealthCoordinator.installDeliveryErrorPreview(
                sourceIds: sourcePermissionHealthDeferred
            )
        }
        let previewPairing = pairedDeviceId.map { deviceId in
            Pairing(
                url: URL(string: "https://gateway.example.com")!,
                token: "omn_preview",
                accountId: "preview-account",
                deviceId: deviceId,
                gatewayName: "Preview Gateway"
            )
        }
        store.pairingCoord.installPreviewState(pairing: previewPairing, recovery: pairingRecovery)
        if let seed = agentPreview {
            store.installAgentPreview(seed)
        }
        return store
    }

    /// Installs a seeded transcript onto the live coordinator. Exposed so
    /// `DelayedAgentPreview` (a sibling type that can't reach the private
    /// `agentCoord`) can replay it asynchronously to mimic cold-launch.
    func installAgentPreview(_ seed: AgentPreviewSeed) {
        agentCoord.installPreviewState(
            sessionId: seed.sessionId,
            model: seed.model,
            backend: seed.backend,
            title: seed.title,
            turns: seed.turns,
            citations: seed.citations,
            conversations: seed.conversations,
            busy: seed.busy,
            terminalFailure: seed.terminalFailure,
            connected: seed.connected,
            planItems: seed.planItems,
            conversationsNextCursor: seed.conversationsNextCursor,
            transcriptNextCursor: seed.transcriptNextCursor
        )
        if seed.trailAnnotations != .empty || !seed.recordCitations.isEmpty {
            agentCoord.installPreviewTimeline(
                annotations: seed.trailAnnotations,
                recordCitations: seed.recordCitations
            )
        }
    }

    /// Bundle of agent preview state — kept as a single record so the
    /// snapshot tests can declare one constant per scenario instead of
    /// threading every parameter through `.preview(...)`.
    struct AgentPreviewSeed {
        /// Nil for the landing — a session is minted lazily on the first send.
        var sessionId: String? = "s_preview"
        var model: String = "claude-sonnet-4-6"
        var backend: String = "anthropic"
        var title: String = ""
        var turns: [AgentTurn] = []
        var citations: [AgentCitation] = []
        var conversations: [ConversationSummary] = []
        var conversationsNextCursor: String?
        var transcriptNextCursor: String?
        var busy: Bool = false
        var terminalFailure: AgentConversationTerminalFailure?
        /// Enables the normal idle composer without starting a preview network stream.
        var connected: Bool = false
        var planItems: [AgentPlanItem] = []
        /// Annotation buckets (`annotate`) so previews can exercise the
        /// Citations drawer's Timeline tab without driving a live SSE stream.
        /// Empty by default so the Timeline renders empty.
        var trailAnnotations: AgentTrailAnnotations = .empty
        /// Directly-cited analytics rows so previews can exercise
        /// the record-only Timeline row without a live SSE stream.
        var recordCitations: [AgentTrailRecord] = []
    }
}
#endif

@available(iOS 17.0, *)
struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        RootContent()
            // Shake-to-annotate (developer mode only): a hidden channel for filing
            // data-quality notes on the current entity for later engineering review.
            .developerAnnotationCapture()
            // A Settings run's cover times out only while the scene is active.
            .onChange(of: scenePhase, initial: true) { _, phase in
                store.phoneSetup.sceneDidChange(isActive: phase == .active)
            }
            // The consent sheet waits its turn in the deferred-presentation queue,
            // which home drives.
            .sheet(item: Binding(
                get: { store.phoneSetup.deferredPresentations.current == .relayConsent ? store.relayPushConsentRequest : nil },
                set: { request in
                    if request == nil, store.phoneSetup.deferredPresentations.current == .relayConsent,
                       let current = store.relayPushConsentRequest {
                        store.dismissRelayPushConsent(current)
                    }
                }
            )) { request in
                RelayPushConsentSheet(
                    appId: request.appId,
                    onAllow: { try await store.allowRelayPush(request) },
                    onNotNow: { store.dismissRelayPushConsent(request) }
                )
                .omnesisColorScheme()
            }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("HomeView — fully populated") {
    let store = AppStore.preview(
        sources: PreviewMocks.sources,
        statusesBySource: PreviewMocks.syncStatuses,
        deviceNames: PreviewMocks.deviceNames,
        statusSnapshot: PreviewMocks.statusSnapshot,
        indexStats: PreviewMocks.indexStats
    )
    return HomeView()
        .environment(store)
        .environment(store.notificationRouter)
}

@available(iOS 17.0, *)
#Preview("HomeView — Apple push setup needed") {
    let store = AppStore.preview(
        sources: PreviewMocks.sources,
        statusesBySource: PreviewMocks.syncStatuses,
        deviceNames: PreviewMocks.deviceNames,
        statusSnapshot: PreviewMocks.statusSnapshot,
        indexStats: PreviewMocks.indexStats,
        pushGatewayConfiguration: .noDirectCredential,
        pushConfigurationAppId: PreviewMocks.independentlySignedAppId
    )
    return HomeView()
        .environment(store)
        .environment(store.notificationRouter)
}

@available(iOS 17.0, *)
#Preview("RootView — onboarding") {
    let store = AppStore()
    return RootView()
        .environment(store)
        .environment(store.notificationRouter)
}

/// JSON shape read from the `-pairingFile` launch argument. Allows
/// XCUITest automation to pair the app without a QR scan.
struct AutomationPairingConfig: Decodable {
    let url: String
    let token: String
    var deviceId: String?
    var name: String?
    /// TLS leaf-cert SHA-256 fingerprint (lowercase hex). Required
    /// when the demo gateway uses HTTPS with a self-signed cert.
    var fingerprint: String?
    /// Explicit transport trust mode. Omitted fixtures infer pinned trust from
    /// a fingerprint and legacy behavior otherwise.
    var tlsMode: String?
    /// DEBUG automation only: least-privilege token placed in the extension's
    /// separate keychain group for notification claim/confirm requests.
    var claimToken: String?
}
#endif
#endif
