// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import SwiftUI
import UIKit
import XCTest

// This catalogue holds one test per screen state, and the app has hundreds of
// them: its length is the point, and every view added to the app lengthens it.
// The length rules are turned off here rather than re-recorded on every
// addition — splitting the catalogue would instead scatter the visual net
// across classes the snapshot script does not run.
// swiftlint:disable file_length

/// Render every catalogued view to a PNG in `/tmp/omnesis-snapshots/`
/// so an automated agent (or the user) has a quick visual feedback loop
/// without having to launch Xcode and step through previews by hand.
///
/// Each test corresponds to one screen at one state. Output is keyed by
/// the test method name so re-running overwrites in-place. iPhone 15
/// (393×852) is the default canvas — run on the iPhone 17 simulator
/// for repeatable rasterisation.
@MainActor
// swiftlint:disable:next type_body_length
final class PreviewSnapshotTests: XCTestCase {
    private static let outputDir = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
    private static let canvasSize = CGSize(width: 393, height: 852)

    /// PNGs successfully written this run / by the current test. A snapshot suite
    /// that silently renders or writes nothing (a broken render, a swallowed write
    /// failure) would otherwise pass while asserting nothing — the tearDowns below
    /// fail loud on exactly that.
    private static var pngsWrittenThisRun = 0
    private var pngsWrittenThisTest = 0
    private static var previousPermissionRequestsDisabledForSnapshots = false

    enum SnapshotError: Error { case encodeFailed(String) }

    override class func setUp() {
        super.setUp()
        previousPermissionRequestsDisabledForSnapshots = SpeechRecognizer.permissionRequestsDisabledForSnapshots
        SpeechRecognizer.permissionRequestsDisabledForSnapshots = true
        try? FileManager.default.createDirectory(
            at: outputDir, withIntermediateDirectories: true
        )
    }

    override func tearDown() {
        // Every snapshot test must produce at least one PNG; a test that renders
        // nothing is a silent no-op. Subset-safe — holds under `-only-testing`.
        XCTAssertGreaterThanOrEqual(
            pngsWrittenThisTest,
            1,
            "\(name) wrote no snapshot PNG — the render or write silently did nothing"
        )
        pngsWrittenThisTest = 0
        super.tearDown()
    }

    // `class func` (not `static`) is required to override XCTestCase.tearDown();
    // swiftlint's static_over_final_class rule can't express that override exception.
    // swiftlint:disable:next static_over_final_class
    override class func tearDown() {
        SpeechRecognizer.permissionRequestsDisabledForSnapshots = previousPermissionRequestsDisabledForSnapshots
        // Belt-and-braces: the run as a whole must have produced images.
        XCTAssertGreaterThanOrEqual(
            pngsWrittenThisRun,
            1,
            "PreviewSnapshotTests produced no PNGs this run — the snapshot suite is a silent no-op"
        )
        super.tearDown()
    }

    /// Encode + write a snapshot PNG, fail-loud. Throws on encode or write failure
    /// rather than swallowing it — a silently-dropped write would leave the visual
    /// feedback loop asserting nothing. Static so the integrity test can exercise
    /// the same write path; the instance wrapper also bumps the counters.
    static func writeSnapshotPNG(_ image: UIImage, to url: URL) throws {
        guard let data = image.pngData() else {
            throw SnapshotError.encodeFailed(url.lastPathComponent)
        }
        try data.write(to: url)
    }

    private func writeSnapshotPNG(_ image: UIImage, to url: URL) throws {
        try Self.writeSnapshotPNG(image, to: url)
        Self.pngsWrittenThisRun += 1
        pngsWrittenThisTest += 1
    }

    // MARK: - Snapshot helper

    /// Render any SwiftUI view to PNGs in BOTH appearance modes so the
    /// adaptive `Theme` palette is verified in light and dark. The dark
    /// render keeps the historical filename (`<name>.png`); the light
    /// render is suffixed (`<name>-light.png`).
    ///
    /// Keep `size.height` at or under 2600pt. Past that the simulator's
    /// `drawHierarchy` capture below silently yields a blank page rather than
    /// failing, so an oversized canvas reads as a passing test with an empty
    /// PNG. A view too tall for one canvas gets a narrower fixture instead.
    private func snapshot(
        _ view: some View,
        name: String,
        size: CGSize = canvasSize,
        ignoresSafeArea: Bool = false
    ) {
        render(view, name: name, size: size, scheme: .dark, ignoresSafeArea: ignoresSafeArea)
        render(view, name: "\(name)-light", size: size, scheme: .light, ignoresSafeArea: ignoresSafeArea)
    }

    /// A system sheet is presented asynchronously and only after its host is
    /// attached to a window. This variant exercises the real detent, drag
    /// indicator, and presentation background before capturing both themes.
    private func snapshotPresented(
        _ view: some View,
        name: String
    ) {
        renderInWindow(view, name: name, scheme: .dark, capturePresentedChrome: true)
        renderInWindow(view, name: "\(name)-light", scheme: .light, capturePresentedChrome: true)
    }

    /// Render a view into a single PNG forced to `scheme`. Uses
    /// `UIHostingController` + `drawHierarchy` so we don't depend on
    /// third-party snapshot libs. The matching `AppearanceStore` is
    /// injected so any in-view `.omnesisColorScheme()` agrees with the
    /// forced trait collection instead of fighting it.
    /// `ignoresSafeArea` lays the view out with no safe-area inset. A hosting
    /// controller outside a window otherwise reserves one at the bottom, which
    /// hides the foot of a full-screen page that pins its actions there.
    private func render(
        _ view: some View,
        name: String,
        size: CGSize,
        scheme: ColorScheme,
        ignoresSafeArea: Bool = false
    ) {
        let isDark = scheme == .dark
        let host = UIHostingController(rootView:
            view
                .environment(\.appearanceStore, AppearanceStore(mode: isDark ? .dark : .light))
                .frame(width: size.width, height: size.height)
                .preferredColorScheme(scheme)
        )
        host.overrideUserInterfaceStyle = isDark ? .dark : .light
        if ignoresSafeArea {
            host.safeAreaRegions = []
        }
        host.view.backgroundColor = isDark
            ? UIColor(red: 0x0D / 255, green: 0x11 / 255, blue: 0x17 / 255, alpha: 1)
            : UIColor(red: 1, green: 1, blue: 1, alpha: 1)
        host.view.frame = CGRect(origin: .zero, size: size)

        // Force a layout pass — drawHierarchy without afterScreenUpdates
        // sometimes captures pre-layout content otherwise.
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()

        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { _ in
            host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }

        let url = Self.outputDir.appendingPathComponent("\(name).png")
        do {
            try writeSnapshotPNG(image, to: url)
            print("📸 \(url.path)")
        } catch {
            XCTFail("snapshot write failed for \(name): \(error)")
        }
    }

    private var canvasSize: CGSize {
        Self.canvasSize
    }

    /// Render a view inside a real, full-screen key window on the
    /// simulator and pump the run loop, so geometry-driven content that
    /// resolves over a render cycle — like the agent transcript's bottom
    /// fade (composer anchor preference → `composerTopY` → mask) — is
    /// laid out before capture. The default offscreen `render` does a
    /// single synchronous layout pass, which can capture the fade in its
    /// pre-resolution (fully opaque) state.
    ///
    /// Caveat: the XCTest host window reports ZERO safe-area insets, so
    /// this still does NOT reproduce device safe areas. It guards that
    /// the fade RESOLVES and renders; it cannot catch a mask that clips
    /// the home-indicator strip. That safe-area-specific behaviour is
    /// verified by hand against a real app process via the
    /// `DEMO_AGENT_PREVIEW=tall` launch route (see `OmnesisApp`).
    private func renderInWindow(
        _ view: some View,
        name: String,
        scheme: ColorScheme = .dark,
        capturePresentedChrome: Bool = false,
        settle: TimeInterval = 0.6
    ) {
        let isDark = scheme == .dark
        let screen = UIScreen.main.bounds
        let window = UIWindow(frame: screen)
        let host = UIHostingController(rootView:
            view
                .environment(\.appearanceStore, AppearanceStore(mode: isDark ? .dark : .light))
                .preferredColorScheme(scheme)
        )
        host.overrideUserInterfaceStyle = isDark ? .dark : .light
        window.overrideUserInterfaceStyle = isDark ? .dark : .light
        window.rootViewController = host
        window.makeKeyAndVisible()
        window.layoutIfNeeded()

        // Pump the run loop so geometry preferences (composer top edge)
        // propagate and SwiftUI re-renders the mask before capture.
        RunLoop.current.run(until: Date().addingTimeInterval(settle))

        let renderer = UIGraphicsImageRenderer(size: screen.size)
        let image = renderer.image { context in
            if capturePresentedChrome {
                // The alert lives above the hosting view. The XCTest unit-test
                // host cannot use XCUIScreen, and Core Animation omits the
                // system button-label glyphs, but this strongest available
                // capture still proves presentation, copy, dimming, and both
                // action affordances.
                window.layer.render(in: context.cgContext)
            } else {
                host.view.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
        }
        let url = Self.outputDir.appendingPathComponent("\(name).png")
        do {
            try writeSnapshotPNG(image, to: url)
            print("📸 \(url.path) — safeArea \(window.safeAreaInsets)")
        } catch {
            XCTFail("snapshot write failed for \(name): \(error)")
        }
        window.isHidden = true
    }

    // MARK: - Sources tab

    // MARK: - Push health banner

    /// The banner is the only surface that tells the user their phone has
    /// stopped delivering data — every other indicator reads healthy in that
    /// state, because the sync itself succeeded and only the upload failed.
    private func pushHealthCanvas(
        blockedSourceIds: [String] = [],
        bufferedBatches: Int = 0,
        oldestBufferedAge: TimeInterval? = nil,
        quarantinedBatches: Int = 0,
        retryPhase: PushHealth.RetryPhase = .idle,
        labelForSourceId: @escaping (String) -> String = { $0 }
    )
        -> some View {
        Form {
            Section {
                PushHealthBanner(
                    blockedSourceIds: blockedSourceIds,
                    bufferedBatches: bufferedBatches,
                    oldestBufferedAge: oldestBufferedAge,
                    quarantinedBatches: quarantinedBatches,
                    labelForSourceId: labelForSourceId,
                    retryPhase: retryPhase,
                    onRetry: {},
                    onDiscardUndelivered: {}
                )
            }
            .listRowBackground(Theme.bgSecondary)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bgPrimary)
    }

    func testPushHealthBannerBlockedSingleSource() {
        snapshot(
            pushHealthCanvas(
                blockedSourceIds: ["core-location-visits:local"],
                bufferedBatches: 12,
                oldestBufferedAge: 60 * 60,
                labelForSourceId: { _ in "Location Visits" }
            ),
            name: "175-push-health-blocked-single"
        )
    }

    func testPushHealthBannerBlockedMultipleSourcesWithBacklog() {
        snapshot(
            pushHealthCanvas(
                blockedSourceIds: ["core-location-visits:local", "photos:local"],
                bufferedBatches: 340,
                oldestBufferedAge: 3 * 24 * 60 * 60,
                labelForSourceId: { $0.hasPrefix("photos") ? "Photos" : "Location Visits" }
            ),
            name: "176-push-health-blocked-multiple"
        )
    }

    func testPushHealthBannerBacklogOnly() {
        snapshot(
            pushHealthCanvas(
                blockedSourceIds: [],
                bufferedBatches: 87,
                oldestBufferedAge: 3 * 24 * 60 * 60,
                labelForSourceId: { $0 }
            ),
            name: "177-push-health-backlog-only"
        )
    }

    /// A blocked source with nothing else wrong: the backlog row stays away.
    func testPushHealthBannerBlockedWithEmptyQueue() {
        snapshot(
            pushHealthCanvas(
                blockedSourceIds: ["core-location-visits:local"],
                bufferedBatches: 1,
                oldestBufferedAge: nil,
                labelForSourceId: { _ in "Location Visits" }
            ),
            name: "178-push-health-blocked-empty-queue"
        )
    }

    /// Batches the uploader gave up on. Nothing is queued and nothing is
    /// blocked, so this row carries the whole message on its own.
    func testPushHealthBannerUndeliveredOnly() {
        snapshot(
            pushHealthCanvas(quarantinedBatches: 3),
            name: "184-push-health-undelivered-only"
        )
    }

    /// Singular copy — the count reads "1 batch", not "1 batches".
    func testPushHealthBannerUndeliveredSingle() {
        snapshot(
            pushHealthCanvas(quarantinedBatches: 1),
            name: "185-push-health-undelivered-single"
        )
    }

    /// Both rows at once: some data is still queued and aging, some has
    /// already been given up on.
    func testPushHealthBannerBacklogAndUndelivered() {
        snapshot(
            pushHealthCanvas(
                bufferedBatches: 9,
                oldestBufferedAge: 12 * 60 * 60,
                quarantinedBatches: 2
            ),
            name: "186-push-health-backlog-and-undelivered"
        )
    }

    /// A blocked source plus batches already given up on — the tallest the
    /// banner gets. The backlog row is deliberately absent despite a stale
    /// queue: a blocked source's batches sit at the head of the FIFO and age
    /// without bound, so reporting them would raise a second alarm whose
    /// Retry cannot help.
    func testPushHealthBannerBlockedAndUndelivered() {
        snapshot(
            pushHealthCanvas(
                blockedSourceIds: ["photos:local"],
                bufferedBatches: 41,
                oldestBufferedAge: 2 * 24 * 60 * 60,
                quarantinedBatches: 5,
                labelForSourceId: { _ in "Photos" }
            ),
            name: "187-push-health-blocked-and-undelivered"
        )
    }

    /// A retry in flight: the button is replaced by a spinner, so the row
    /// changes height while a drain runs.
    func testPushHealthBannerRetryRunning() {
        snapshot(
            pushHealthCanvas(
                bufferedBatches: 87,
                oldestBufferedAge: 3 * 24 * 60 * 60,
                retryPhase: .running
            ),
            name: "189-push-health-retry-running"
        )
    }

    /// A finished retry in its real context — the relabelled "Try again"
    /// button with the outcome beneath it.
    func testPushHealthBannerRetryReported() {
        snapshot(
            pushHealthCanvas(
                bufferedBatches: 87,
                oldestBufferedAge: 3 * 24 * 60 * 60,
                retryPhase: .reported(.refused)
            ),
            name: "190-push-health-retry-reported"
        )
    }

    /// What a finished retry leaves on screen. Only ever one at a time in the
    /// app; rendered together so their length and wrapping can be compared.
    /// The button's state machine can't be reached by a static render, which
    /// is why the line is its own view.
    func testPushHealthRetryOutcomes() {
        snapshot(
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(
                            [
                                DrainOutcome.delivered, .refused, .paused, .blocked,
                                .unreachable, .stalled, .busy, .idle, .failed,
                            ],
                            id: \.self
                        ) { outcome in
                            RetryStatusLine(outcome: outcome)
                        }
                    }
                }
                .listRowBackground(Theme.bgSecondary)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bgPrimary),
            name: "188-push-health-retry-outcomes"
        )
    }

    func testSourcesPopulated() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        )
        snapshot(SourcesView(menuOpen: .constant(false)).environment(store), name: "01-sources-populated")
    }

    func testSourcesEmpty() {
        let store = AppStore.preview()
        snapshot(SourcesView(menuOpen: .constant(false)).environment(store), name: "02-sources-empty")
    }

    func testSourcesFirstLoadError() {
        // Empty + no loading + sourcesError set → full-screen
        // GatewayErrorView in the Sources tab. Locks in the
        // empty-with-error branch in `SourcesView.content`.
        let store = AppStore.preview(sourcesError: URLError(.cannotConnectToHost))
        snapshot(
            SourcesView(menuOpen: .constant(false)).environment(store),
            name: "02b-sources-first-load-error"
        )
    }

    func testSourcesInlineRefreshBanner() {
        // Populated list + sourcesError set → inline warning banner
        // above the list (cached rows still showing). Locks in the
        // `inlineRefreshErrorText` mapping for the unreachable bucket.
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            sourcesError: URLError(.notConnectedToInternet)
        )
        snapshot(
            SourcesView(menuOpen: .constant(false)).environment(store),
            name: "02c-sources-inline-refresh-banner"
        )
    }

    /// Gateway-internal source (quick-capture notes, …): a read-only row —
    /// counters, no host device, no sync actions — inside the regular list.
    func testSourcesWithInternalRow() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            internalSources: [InternalSource(id: "omnesis-notes")],
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        )
        snapshot(SourcesView(menuOpen: .constant(false)).environment(store), name: "02d-sources-internal-row")
    }

    func testSourceDetailSyncing() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            indexStats: PreviewMocks.indexStats
        )
        let view = NavigationStack {
            SourceDetailView(sourceId: PreviewMocks.sourceGmail.id)
        }
        snapshot(view.environment(store), name: "03-source-detail-syncing")
    }

    /// Gateway-internal source detail: no sync/pause/debug/resync/remove
    /// actions — Recent items is the whole card — and the About card names
    /// the gateway as host.
    func testSourceDetailInternal() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            internalSources: [InternalSource(id: "omnesis-notes")],
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        )
        let view = NavigationStack {
            SourceDetailView(sourceId: "omnesis-notes")
        }
        snapshot(view.environment(store), name: "05c-source-detail-internal")
    }

    func testSourceDetailMultipleHosts() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            indexStats: PreviewMocks.indexStats
        )
        let view = NavigationStack {
            SourceDetailView(sourceId: PreviewMocks.sourceAppleHealth.id)
        }
        snapshot(view.environment(store), name: "03b-source-detail-multiple-hosts")
    }

    func testSourceDetailError() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames
        )
        let view = NavigationStack {
            SourceDetailView(sourceId: PreviewMocks.sourceWhatsApp.id)
        }
        snapshot(view.environment(store), name: "04-source-detail-error")
    }

    func testSourceDetailSynced() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            indexStats: PreviewMocks.indexStats
        )
        let view = NavigationStack {
            SourceDetailView(sourceId: PreviewMocks.sourceAppleNotes.id)
        }
        snapshot(view.environment(store), name: "05-source-detail-synced")
    }

    /// Forward-looking consent-expiry (#927): a healthy-but-expiring source
    /// shows the amber "expiring" pill and a warning icon beside its host
    /// device.
    func testSourceDetailAuthExpiring() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            indexStats: PreviewMocks.indexStats
        )
        let view = NavigationStack {
            SourceDetailView(sourceId: PreviewMocks.sourceExpiring.id)
        }
        snapshot(view.environment(store), name: "05b-source-detail-auth-expiring")
    }

    /// A stalled local feed: the source syncs fine, but the app that maintains
    /// the file it reads isn't running. The "stale" pill and a warning icon
    /// beside the host device say so.
    func testSourceDetailStale() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            indexStats: PreviewMocks.indexStats
        )
        let view = NavigationStack {
            SourceDetailView(sourceId: PreviewMocks.sourceStale.id)
        }
        snapshot(view.environment(store), name: "05c-source-detail-stale")
    }

    /// A source two Macs contribute to: each host device carries the icons for
    /// its own notices — an info note beside studio-desk, a warning and a note
    /// beside travel-laptop.
    func testSourceDetailMemberNotices() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            indexStats: PreviewMocks.indexStats
        )
        let view = NavigationStack {
            SourceDetailView(sourceId: PreviewMocks.sourceSharedVault.id)
        }
        snapshot(view.environment(store), name: "05d-source-detail-member-notices")
    }

    /// The half-sheet a device's notice icon opens: title, detail, numbered
    /// steps and when it was first seen, most severe first.
    func testSourceNoticesSheetOneDevice() {
        snapshotPresented(
            Color.clear.sheet(isPresented: .constant(true)) {
                SourceNoticesSheet(sections: [PreviewMocks.noticeSectionsMultiMember[1]])
            },
            name: "05e-source-notices-sheet"
        )
    }

    /// A dozen notices on one device, the first with a title that wraps.
    func testSourceNoticesSheetMany() {
        snapshotPresented(
            Color.clear.sheet(isPresented: .constant(true)) {
                SourceNoticesSheet(sections: PreviewMocks.noticeSectionsMany)
            },
            name: "05h-source-notices-sheet-many"
        )
    }

    /// An older gateway serves no notices: the one shown is derived from the
    /// status's state and message.
    func testSourceNoticesSheetOlderGateway() {
        snapshotPresented(
            Color.clear.sheet(isPresented: .constant(true)) {
                SourceNoticesSheet(sections: PreviewMocks.noticeSectionsLegacy)
            },
            name: "05i-source-notices-sheet-older-gateway"
        )
    }

    /// The list row's single icon stands for every device, so its sheet has
    /// one section per device.
    func testSourceNoticesSheetEveryDevice() {
        snapshotPresented(
            Color.clear.sheet(isPresented: .constant(true)) {
                SourceNoticesSheet(sections: PreviewMocks.noticeSectionsMultiMember)
            },
            name: "05f-source-notices-sheet-every-device"
        )
    }

    /// The notice icons by themselves: per-severity groups with counts beside
    /// a device, a double-digit count, an older gateway's derived notice, and
    /// the row's single summary icon.
    func testSourceNoticeIcons() {
        snapshot(
            SourceNoticeIconsGallery(),
            name: "05g-source-notice-icons",
            size: CGSize(width: 393, height: 300)
        )
    }

    // MARK: - Onboarding + pairing

    func testOnboarding() {
        let store = AppStore.preview()
        snapshot(OnboardingView().environment(store), name: "06-onboarding")
    }

    func testOnboardingLegacyPairingRecovery() {
        let store = AppStore.preview(
            pairingRecovery: PairingRecovery(
                gatewayURL: URL(string: "https://gateway.example:7600")
            )
        )
        snapshot(
            OnboardingView().environment(store),
            name: "06b-onboarding-pairing-recovery"
        )
    }

    func testPairing() {
        let store = AppStore.preview()
        snapshot(PairingView().environment(store), name: "07-pairing")
    }

    func testPairingManualEntryRecoveryURL() {
        snapshot(
            PairingManualEntryView(
                gatewayURL: .constant("https://gateway.example:7600"),
                pairingCode: .constant(""),
                isPairing: false,
                onCancel: {},
                onPair: {}
            ),
            name: "07b-pairing-manual-recovery-url"
        )
    }

    func testPairingConfirmationSystemTrust() {
        snapshot(
            PairingConfirmationSheet(
                payload: .v4(PreviewMocks.pairingPayloadV4System),
                isPairing: false,
                onCancel: {},
                onConfirm: {}
            ),
            name: "07c-pairing-confirm-system-trust"
        )
    }

    // MARK: - Search tab

    func testSearchEmpty() {
        // Experimental mode used to plant a capture button in this
        // toolbar. Keep it enabled so the snapshot proves Search now
        // retains only its own navigation chrome.
        let store = AppStore.preview(statusSnapshot: PreviewMocks.statusSnapshotExperimental)
        snapshot(SearchView(menuOpen: .constant(false)).environment(store), name: "10-search-empty")
    }

    func testSearchResults() {
        // We don't drive the live search field — just snapshot the
        // result-row composition directly so we can see the actual rows.
        let store = AppStore.preview()
        let body = NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Spacing.md) {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(PreviewMocks.searchResults.enumerated()), id: \.element.id) { idx, item in
                            SearchResultRow(item: item, store: store)
                                .padding(.horizontal, Theme.Spacing.md)
                                .padding(.vertical, 10)
                            if idx < PreviewMocks.searchResults.count - 1 {
                                Divider().background(Theme.borderLight).padding(.leading, 44)
                            }
                        }
                    }
                    .background(Theme.bgSecondary)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.large)
                            .stroke(Theme.border, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
                    SearchPipelineFooter(response: PreviewMocks.searchResponseVerbose)
                }
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.vertical, Theme.Spacing.sm)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Search")
        }
        // Taller canvas so the pipeline footer appears in-frame.
        snapshot(body.environment(store), name: "11-search-results", size: CGSize(width: 393, height: 1400))
    }

    func testSearchPipelineFooter() {
        let view = ScrollView {
            SearchPipelineFooter(response: PreviewMocks.searchResponseVerbose)
                .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        snapshot(view, name: "12-search-pipeline-footer", size: CGSize(width: 393, height: 900))
    }

    // MARK: - People tab

    // MARK: - Watches

    func testWatchesList() {
        // Every state a watch can be in, together, because the whole purpose of
        // the screen is telling them apart at a glance: running and quiet,
        // running and productive, held by a failure, finished — and the last
        // row an integration asked for, which wakes it rather than the reader.
        // Both of those last two facts are indicators on the row: a watch is a
        // watch however it was asked for, and the list never splits on it.
        snapshot(
            NavigationStack {
                WatchesListContent(
                    watches: PreviewMocks.watches,
                    loading: false,
                    loadError: nil,
                    onSelect: { _ in },
                    onRetry: {}
                )
                .navigationTitle("Watches")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "70-watches-list"
        )
    }

    func testWatchesEmpty() {
        // The state a new install sits in, and the one most likely to read as
        // a broken screen if the copy is wrong.
        snapshot(
            NavigationStack {
                WatchesListContent(
                    watches: [],
                    loading: false,
                    loadError: nil,
                    onSelect: { _ in },
                    onRetry: {}
                )
                .navigationTitle("Watches")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "71-watches-empty"
        )
    }

    func testWatchDetailFirings() {
        // Opened by hand. The fixture arrives oldest-first, as the route hands
        // it over, so this also proves the screen orders it newest-first — and
        // the bottom firing is about something a month older than the moment it
        // was noticed, the case the row's second line exists for.
        snapshot(
            NavigationStack {
                WatchDetailContent(
                    watch: PreviewMocks.watches[0],
                    firings: PreviewMocks.watchFirings,
                    firingSeq: nil,
                    loading: false,
                    loadError: nil,
                    onRetry: {}
                )
                .navigationTitle("listing-unanswered")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "72-watch-detail"
        )
    }

    func testWatchDetailDefinitionOpen() {
        // The definition, as stored. Rendered verbatim and monospaced: its
        // shape is how it is read, and a wrapped brace tree is a different
        // document.
        snapshot(
            NavigationStack {
                WatchDetailContent(
                    watch: PreviewMocks.watches[0],
                    firings: PreviewMocks.watchFirings,
                    firingSeq: nil,
                    loading: false,
                    loadError: nil,
                    onRetry: {},
                    definition: """
                    {
                      "watch" : {
                        "name" : "an-invoice-arrived",
                        "nodes" : [
                          {
                            "id" : "invoice_email",
                            "type" : "source.document_event"
                          }
                        ]
                      }
                    }
                    """,
                    definitionExpanded: true
                )
                .navigationTitle("an-invoice-arrived")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "72b-watch-detail-definition"
        )
    }

    func testWatchDetailDeliveryOutcomes() {
        // The row this ledger exists for: a firing that happened and a
        // notification that never arrived. Without the second line, that is
        // indistinguishable from a watch that never fired.
        snapshot(
            NavigationStack {
                WatchDetailContent(
                    watch: PreviewMocks.watches[0],
                    firings: [
                        WatchFiringRecord(
                            seq: 41,
                            firedAt: "2026-08-09T12:32:00.000Z",
                            noticedAt: nil,
                            delivery: WatchFiringDelivery(kind: "omnesis-notify", delivered: 2)
                        ),
                        WatchFiringRecord(
                            seq: 40,
                            firedAt: "2026-08-08T10:50:00.000Z",
                            noticedAt: nil,
                            delivery: WatchFiringDelivery(
                                kind: "omnesis-notify",
                                delivered: 0,
                                attempted: 2,
                                error: "APNs delivery failed for all 2 device(s)"
                            )
                        ),
                        WatchFiringRecord(
                            seq: 39,
                            firedAt: "2026-08-07T20:20:00.000Z",
                            noticedAt: nil,
                            delivery: WatchFiringDelivery(
                                kind: "agent-wake",
                                delivered: 0,
                                attempted: 0,
                                error: "this watch has no anchor, so no agent can be woken for it"
                            )
                        ),
                    ],
                    firingSeq: nil,
                    loading: false,
                    loadError: nil,
                    onRetry: {}
                )
                .navigationTitle("an-invoice-arrived")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "72c-watch-detail-delivery"
        )
    }

    func testWatchDetailFromNotification() {
        // Where a notification tap lands: the firing the banner was about,
        // marked. The usual case — the newest line, because a watch fires and
        // speaks in the same moment.
        snapshot(
            NavigationStack {
                WatchDetailContent(
                    watch: PreviewMocks.watches[0],
                    firings: PreviewMocks.watchFirings,
                    firingSeq: PreviewMocks.watchFirings.last?.seq,
                    loading: false,
                    loadError: nil,
                    onRetry: {}
                )
                .navigationTitle("listing-unanswered")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "74-watch-detail-from-notification"
        )
    }

    func testWatchDetailFromOlderNotification() {
        // A tap that came late, on a banner later firings have buried. The mark
        // has to be on the oldest line, not simply on the top of the list.
        snapshot(
            NavigationStack {
                WatchDetailContent(
                    watch: PreviewMocks.watches[0],
                    firings: PreviewMocks.watchFirings,
                    firingSeq: PreviewMocks.watchFirings.first?.seq,
                    loading: false,
                    loadError: nil,
                    onRetry: {}
                )
                .navigationTitle("listing-unanswered")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "75-watch-detail-from-older-notification"
        )
    }

    func testWatchDetailNotifiedFiringMissing() {
        // A key this app could not place against the page it read. The ledger
        // renders as it always does and nothing is marked — the landing has to
        // stay honest rather than guess a line.
        snapshot(
            NavigationStack {
                WatchDetailContent(
                    watch: PreviewMocks.watches[0],
                    firings: PreviewMocks.watchFirings,
                    firingSeq: 1,
                    loading: false,
                    loadError: nil,
                    onRetry: {}
                )
                .navigationTitle("listing-unanswered")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "76-watch-detail-notified-firing-missing"
        )
    }

    func testWatchDetailDisclosure() {
        // A watch that wakes an agent: what it is allowed to say, and one
        // ledger of firings holding both what it caught and what it sent.
        snapshot(
            NavigationStack {
                WatchDetailContent(
                    watch: PreviewMocks.watches[4],
                    firings: PreviewMocks.watchFirings,
                    firingSeq: nil,
                    loading: false,
                    loadError: nil,
                    onRetry: {},
                    disclosure: PreviewMocks.watchDisclosure,
                    disclosed: true,
                    egress: PreviewMocks.subscriptionFirings,
                    onRevoke: {}
                )
                .navigationTitle("invoice-due")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "77-watch-detail-disclosure",
            size: CGSize(width: 393, height: 1400)
        )
    }

    func testWatchDetailDisclosureOperatorAuthored() {
        // The operator's own watch that still wakes an agent. Nothing was put
        // to them for approval because the request was theirs, and it has not
        // reached out — which must not read as something missing.
        snapshot(
            NavigationStack {
                WatchDetailContent(
                    watch: PreviewMocks.watches[4],
                    firings: [],
                    firingSeq: nil,
                    loading: false,
                    loadError: nil,
                    onRetry: {},
                    disclosure: PreviewMocks.watchDisclosureUnapproved,
                    disclosed: true,
                    onRevoke: {}
                )
                .navigationTitle("invoice-due")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "77b-watch-detail-disclosure-operator",
            size: CGSize(width: 393, height: 1200)
        )
    }

    func testWatchDetailDisclosureRevoked() {
        // A terminal record: nothing left to revoke, and the ledger of what it
        // already sent still standing. Losing that would leave disclosures
        // nothing on any screen accounts for.
        snapshot(
            NavigationStack {
                WatchDetailContent(
                    watch: PreviewMocks.watches[4],
                    firings: PreviewMocks.watchFirings,
                    firingSeq: nil,
                    loading: false,
                    loadError: nil,
                    onRetry: {},
                    disclosure: PreviewMocks.watchDisclosureRevoked,
                    disclosed: true,
                    egress: PreviewMocks.subscriptionFirings,
                    onRevoke: {}
                )
                .navigationTitle("invoice-due")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "77c-watch-detail-disclosure-revoked",
            size: CGSize(width: 393, height: 1400)
        )
    }

    func testWatchDetailQuiet() {
        // For most watches this is correct and permanent, so it must not read
        // like an error.
        snapshot(
            NavigationStack {
                WatchDetailContent(
                    watch: PreviewMocks.watches[1],
                    firings: [],
                    firingSeq: nil,
                    loading: false,
                    loadError: nil,
                    onRetry: {}
                )
                .navigationTitle("large-payment")
                .navigationBarTitleDisplayMode(.inline)
            },
            name: "73-watch-detail-quiet"
        )
    }

    func testPeopleList() {
        let store = AppStore.preview()
        snapshot(
            PeoplePreviewWrapper().environment(store),
            name: "20-people-list"
        )
    }

    func testMergeShortcutPills() {
        // The two count buttons at the top of the People list, across the
        // count edge cases that change copy/layout (typical, singular,
        // zero, very large → scales down).
        let store = AppStore.preview()
        func row(candidates: Int, rules: Int) -> some View {
            HStack(spacing: 12) {
                MergeShortcutPill(
                    count: candidates,
                    noun: "merge candidate",
                    systemImage: "person.2.badge.gearshape",
                    action: {}
                )
                MergeShortcutPill(
                    count: rules,
                    noun: "merge rule",
                    systemImage: "arrow.triangle.merge",
                    action: {}
                )
            }
        }
        let view = VStack(spacing: 12) {
            row(candidates: 133, rules: 415)
            row(candidates: 1, rules: 0)
            row(candidates: 0, rules: 1)
            row(candidates: 12048, rules: 9999)
            Spacer()
        }
        .padding()
        snapshot(view.environment(store), name: "20a-merge-shortcut-pills")
    }

    func testPersonDetail() {
        let store = AppStore.preview()
        let view = NavigationStack {
            PersonDetailPreviewWrapper()
        }
        snapshot(view.environment(store), name: "21-person-detail")
    }

    func testListPagingFooterStates() {
        let view = VStack(spacing: Theme.Spacing.lg) {
            ListPagingFooter(
                state: CursorPagingState(nextCursor: "documents-next"),
                label: "Load more documents",
                retry: {}
            )
            ListPagingFooter(
                state: CursorPagingState(
                    nextCursor: "documents-next",
                    isLoadingMore: true
                ),
                label: "Load more documents",
                retry: {}
            )
            ListPagingFooter(
                state: CursorPagingState(
                    nextCursor: "documents-next",
                    paginationError: URLError(.timedOut)
                ),
                label: "Load more documents",
                retry: {}
            )
        }
        .padding(Theme.Spacing.lg)
        .background(Theme.bgPrimary)
        snapshot(view, name: "21c-list-paging-footer-states")
    }

    /// The self person's annotations render under the "Profile" title — the
    /// user's own durable facts (the self-memory surface).
    func testPersonDetailProfile() {
        let store = AppStore.preview()
        let view = ScrollView {
            AnnotationsSection(title: "Profile", annotations: PreviewMocks.personAnnotations)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        snapshot(view.environment(store), name: "21a-person-annotations-profile")
    }

    /// Another person's annotations render under the "What Omnesis has learned
    /// about <name>" title. A long name exercises the 2-line title wrap; the
    /// fixture also includes a no-evidence-quote row and a long wrapping claim.
    func testPersonDetailLearnedAbout() {
        let store = AppStore.preview()
        let view = ScrollView {
            AnnotationsSection(
                title: "What Omnesis has learned about Maximilian Aurelius Bartholomew Hawthorne-Featherstonehaugh",
                annotations: PreviewMocks.personAnnotations
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        snapshot(view.environment(store), name: "21b-person-annotations-learned-about")
    }

    func testPersonDetailLoadingWithPreset() {
        // Reproduce the loading state — used to surface the "black column"
        // background bug. Renders with a preset name so we get the header
        // row visible alongside the spinner.
        let store = AppStore.preview()
        let view = NavigationStack {
            PersonDetailLoadingPreview(presetName: "Alice Liddell")
        }
        snapshot(view.environment(store), name: "23-person-detail-loading")
    }

    func testPersonDetailLoadingNoPreset() {
        let store = AppStore.preview()
        let view = NavigationStack {
            PersonDetailLoadingPreview(presetName: nil)
        }
        snapshot(view.environment(store), name: "24-person-detail-loading-no-name")
    }

    func testPeopleEmpty() {
        let store = AppStore.preview()
        // Plain `PeopleView` with no fixture wrapper — shows the empty
        // / loading state since no people are populated by the preview
        // store.
        snapshot(PeopleView(menuOpen: .constant(false)).environment(store), name: "22-people-empty")
    }

    func testPersonDetailMergedFrom() {
        // Canonical with 4 merged-in losers — snapshots the concise
        // affordance + header.
        let store = AppStore.preview()
        let view = NavigationStack {
            PersonDetailMergePreview(person: PreviewMocks.personDetailWithMerges)
        }
        snapshot(view.environment(store), name: "26-person-detail-merged-from")
    }

    func testPersonDetailMergedInto() {
        // Loser row — snapshots the "merged into [canonical]" banner.
        let store = AppStore.preview()
        let view = NavigationStack {
            PersonDetailMergePreview(person: PreviewMocks.personDetailLoser)
        }
        snapshot(view.environment(store), name: "27-person-detail-merged-into")
    }

    func testMergedFromSheet() {
        // The bottom sheet contents themselves (rows + source-icon
        // strips + chevrons + "merged X ago").
        let store = AppStore.preview()
        let view = MergedFromSheet(
            merged: PreviewMocks.personDetailWithMerges.mergedFrom ?? [],
            canonicalName: PreviewMocks.personDetailWithMerges.canonicalName
        )
        snapshot(view.environment(store), name: "28-merged-from-sheet")
    }

    func testMergeRulesList() {
        // Read-only merge-rules viewer: partial-page stats are labelled as
        // loaded results above a user single-pair rule, a system rule, and a
        // three-rule cluster-merge card.
        let store = AppStore.preview()
        let view = NavigationStack {
            MergeRulesList(
                identities: MergeIdentity.build(from: PreviewMocks.mergeRules, filter: .all, query: ""),
                query: .constant(""),
                filter: .constant(.all),
                paging: CursorPagingState(nextCursor: "preview-next")
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Merge rules")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "29-merge-rules-list")
    }

    func testMergeRulesEmpty() {
        // Empty-state copy + icon when the people graph has no merges.
        let store = AppStore.preview()
        let view = NavigationStack {
            MergeRulesList(
                identities: [],
                query: .constant(""),
                filter: .constant(.all)
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Merge rules")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "29b-merge-rules-empty")
    }

    func testMergeRulesEmptyTruncated() {
        let store = AppStore.preview()
        let view = NavigationStack {
            MergeRulesList(
                identities: [],
                query: .constant(""),
                filter: .constant(.all),
                paging: CursorPagingState(isTruncated: true)
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Merge rules")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "29c-merge-rules-empty-truncated")
    }

    func testMergeCandidatesList() {
        // Merge-candidate review queue: stats bar, hint, a two-member
        // cluster and a three-member cluster with checkable members + the
        // Merge / Dismiss actions.
        let store = AppStore.preview()
        let view = NavigationStack {
            MergeCandidatesList(
                page: PreviewMocks.mergeCandidates,
                status: .constant(.pending),
                query: .constant(""),
                paging: CursorPagingState(nextCursor: "preview-next")
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Merge candidates")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "30-merge-candidates-list")
    }

    func testMergeCandidatesEmpty() {
        // Empty-state copy + icon when there are no pending candidates.
        let store = AppStore.preview()
        let empty = MergeCandidatesPage(
            items: [],
            counts: MergeCandidateCounts(pending: 0, accepted: 12, denied: 4)
        )
        let view = NavigationStack {
            MergeCandidatesList(
                page: empty,
                status: .constant(.pending),
                query: .constant("")
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Merge candidates")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "30b-merge-candidates-empty")
    }

    func testPeopleListLongName() throws {
        // Long display name + max source icons — verifies the row
        // keeps the doc-count column readable and ellipses the name.
        let store = AppStore.preview()
        let long = try XCTUnwrap(PreviewMocks.peopleSummaries.first { $0.id == "p-long" })
        let me = try XCTUnwrap(PreviewMocks.peopleSummaries.first { $0.isSelf })
        let view = VStack(spacing: 0) {
            PersonRow(person: long)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, 10)
            Divider().background(Theme.borderLight).padding(.leading, 56)
            PersonRow(person: me)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, 10)
        }
        .frame(maxWidth: .infinity)
        .background(Theme.bgSecondary)
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view.environment(store), name: "25-people-list-long-name", size: CGSize(width: 393, height: 240))
    }

    // MARK: - Device management (read-only)

    func testDevicesList() {
        // Read-only device list grouped into Live connections / Other devices,
        // each card showing a kind glyph, activity status, and hostname / cap
        // sub-line, all collapsed (tap to reveal
        // tokens). No "This device" pin here (no session device id).
        let store = AppStore.preview()
        let view = NavigationStack {
            DevicesList(
                devices: PreviewMocks.devices,
                tokensByDevice: PreviewMocks.deviceTokens
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Devices")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "54-devices-list")
    }

    func testDevicesListThisDevice() {
        // Same list with the current device pinned: a "This device" group at
        // the top (accent border + badge), then Live connections, then a
        // collapsed Other devices group — the full three-bucket layout.
        let store = AppStore.preview()
        let view = NavigationStack {
            DevicesList(
                devices: PreviewMocks.devices,
                // Deliberately pin the phone fixture with no live socket: rendering
                // this active app as inactive was the reported regression.
                thisDeviceId: PreviewMocks.devicePhone.id,
                tokensByDevice: PreviewMocks.deviceTokens
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Devices")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "54c-devices-list-this-device")
    }

    func testDevicesListRevoked() {
        // A revoked phone in the list: the stats bar gains a "revoked" chip and
        // the device sorts into the Other devices group (never Live, even with
        // a socket still draining). The group is opened, since the revoked card
        // — the only place a Forget affordance exists — is what this case is
        // about. The card is also rendered on its own, expanded, so the Revoked
        // badge, the "Revoked … ago" status line and the forget-only menu are
        // visible without a tap.
        let store = AppStore.preview()
        let list = NavigationStack {
            DevicesList(
                devices: PreviewMocks.devicesWithRevoked,
                thisDeviceId: PreviewMocks.devicePhone.id,
                tokensByDevice: PreviewMocks.deviceTokens,
                startOtherExpanded: true
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Devices")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(list.environment(store), name: "192-devices-list-revoked")
        let card = DeviceCard(device: PreviewMocks.deviceRevoked, tokens: [], startExpanded: true)
            .padding()
            .background(Theme.bgPrimary)
        snapshot(card.environment(store), name: "192b-devices-card-revoked", size: CGSize(width: 393, height: 220))
    }

    func testDevicesListForgetRefused() {
        // The gateway refused to forget a device that still hosts sources. The
        // refusal has to land on the revoked card the Forget menu sits on — at
        // the bottom of the list, inside the Other devices group — not on a
        // banner pinned to the top of the scroll content, hundreds of points
        // above it. The copy names a remedy this phone actually offers.
        let store = AppStore.preview()
        let list = NavigationStack {
            DevicesList(
                devices: PreviewMocks.devicesWithRevoked,
                thisDeviceId: PreviewMocks.devicePhone.id,
                tokensByDevice: PreviewMocks.deviceTokens,
                startOtherExpanded: true,
                seededFailure: DevicesList.SeededFailure(
                    deviceId: PreviewMocks.deviceRevoked.id,
                    text: "This device still hosts sources. Remove them from the Sources screen first, then forget it."
                )
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Devices")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(list.environment(store), name: "192c-devices-forget-refused")
    }

    func testDevicesEmpty() {
        // Empty-state copy + icon when no devices are paired.
        let store = AppStore.preview()
        let view = NavigationStack {
            DevicesList(devices: [], tokensByDevice: [:])
                .background(Theme.bgPrimary.ignoresSafeArea())
                .navigationTitle("Devices")
                .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "54b-devices-empty")
    }

    func testDeviceCardExpandedWithTokens() {
        // A single device card in its expanded state: paired / last-activity
        // times plus its credentials, each with scope chips and
        // created / used times, and under the list the CLI footnote naming
        // where an extra credential comes from. Renders the card
        // pre-expanded so the token rows (otherwise behind an interaction)
        // appear in-frame.
        let store = AppStore.preview()
        let view = ScrollView {
            DeviceCard(
                device: PreviewMocks.deviceCollector,
                tokens: PreviewMocks.deviceTokens["dev-collector-1"],
                startExpanded: true
            )
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        snapshot(view.environment(store), name: "55-device-card-expanded", size: CGSize(width: 393, height: 480))
    }

    func testDeviceCardExpandedNoTokens() {
        // Expanded card for a device with zero tokens — the "No tokens"
        // inline notice instead of the credentials list, still followed by
        // the CLI footnote: the pointer belongs to every live device, not
        // only to one that already holds a credential.
        let store = AppStore.preview()
        let view = ScrollView {
            DeviceCard(
                device: PreviewMocks.deviceAgent,
                tokens: [],
                startExpanded: true
            )
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        snapshot(view.environment(store), name: "55b-device-card-no-tokens", size: CGSize(width: 393, height: 320))
    }

    func testDeviceCardLoadingTokens() {
        // Expanded card before its credential fetch resolves: the spinner row
        // stands in for the list, and the CLI footnote waits for the list it
        // belongs under rather than sitting beside the spinner.
        let store = AppStore.preview()
        let view = ScrollView {
            DeviceCard(
                device: PreviewMocks.devicePhone,
                tokens: nil,
                startExpanded: true
            )
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        snapshot(view.environment(store), name: "55c-device-card-loading", size: CGSize(width: 393, height: 320))
    }

    func testPairDeviceForm() {
        // Pair-a-device form: the kind picker and the generate action. The
        // gateway grants the kind's scopes, so no scope editor appears; the
        // paired device names itself.
        let store = AppStore.preview()
        let view = NavigationStack {
            PairDeviceForm()
                .background(Theme.bgPrimary.ignoresSafeArea())
                .navigationTitle("Pair a device")
                .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "58-pair-form", size: CGSize(width: 393, height: 400))
    }

    func testRepairDeviceForm() {
        let store = AppStore.preview()
        let view = NavigationStack {
            RepairDeviceForm(device: PreviewMocks.deviceRevoked)
                .background(Theme.bgPrimary.ignoresSafeArea())
                .navigationTitle("Repair device")
                .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "58b-repair-form", size: CGSize(width: 393, height: 400))
    }

    func testPairDeviceResult() {
        // Pairing result: the one-time code, expiry, host picker, and the
        // generated QR (encoded from a fixed payload so the QR is stable).
        let store = AppStore.preview()
        let view = NavigationStack {
            PairingResultView(
                pending: PreviewMocks.pendingPairing,
                kind: "ios",
                identities: PreviewMocks.networkIdentities,
                encodeQr: { code, url in
                    "{\"v\":4,\"gatewayUrl\":\"\(url)\",\"pairingCode\":\"\(code)\",\"tls\":{\"mode\":\"system\"}}"
                },
                // Seed the resolved payload so the QR renders in the captured
                // frame (the async .task wouldn't complete before the snapshot).
                initialPayload: #"{"v":4,"gatewayUrl":"https://gateway.example:7600","pairingCode":"7K3M-9QX2","tls":{"mode":"system"}}"#
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Pair a device")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "59-pair-result", size: CGSize(width: 393, height: 620))
    }

    func testRepairDeviceResult() {
        let store = AppStore.preview()
        let payload = #"{"v":4,"gatewayUrl":"https://gateway.example:7600","pairingCode":"7K3M-9QX2","tls":{"mode":"system"}}"#
        let view = NavigationStack {
            PairingResultView(
                pending: PreviewMocks.pendingPairing,
                kind: "ios",
                identities: PreviewMocks.networkIdentities,
                repairDeviceName: PreviewMocks.deviceRevoked.name,
                initialPayload: payload
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Repair device")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "59a-repair-result", size: CGSize(width: 393, height: 620))
    }

    func testPairAgentResult() {
        let store = AppStore.preview()
        let view = NavigationStack {
            PairingResultView(
                pending: PreviewMocks.pendingPairing,
                kind: "agent",
                identities: PreviewMocks.networkIdentities,
                gatewayOrigin: URL(string: "https://gateway.example:7600")
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Connect an agent")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(store), name: "59b-pair-agent-result", size: CGSize(width: 393, height: 620))
    }

    // MARK: - Document detail

    func testDocumentDetail() {
        let store = AppStore.preview()
        let view = NavigationStack {
            DocumentDetailPreviewWrapper()
        }
        snapshot(view.environment(store), name: "30-document-detail")
    }

    /// Durable memory renders for self, people and documents in stable mode.
    func testStableMemoryAnnotationPanels() {
        let store = AppStore.preview()
        XCTAssertFalse(store.experimentalEnabled)
        for (name, section) in [
            ("30m-stable-self-memory", AnnotationsSection(title: "Profile", annotations: PreviewMocks.personAnnotations)),
            ("30m-stable-person-memory", AnnotationsSection(
                title: "What Omnesis has learned about Maya Reeves", annotations: PreviewMocks.personAnnotations
            )),
            ("30m-stable-document-memory", AnnotationsSection(title: "Enriched by Omnesis", annotations: PreviewMocks.documentAnnotations)),
        ] {
            let view = ScrollView {
                section
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.Spacing.lg)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            snapshot(view.environment(store), name: name)
        }
    }

    /// A document's annotations include an evidence quote plus a no-quote row.
    func testDocumentDetailEnriched() {
        let store = AppStore.preview()
        let view = ScrollView {
            AnnotationsSection(title: "Enriched by Omnesis", annotations: PreviewMocks.documentAnnotations)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        snapshot(view.environment(store), name: "30e-document-annotations-enriched")
    }

    func testMarkdownKitchenSink() {
        let view = ScrollView {
            MarkdownView(text: """
            # Top-level heading

            A paragraph with **bold**, *italic*, and `inline code`. Also a [link](https://example.com).

            ## Lists

            - First item
            - Second **bold** item
            - Third with `code`

            1. Ordered one
            2. Ordered two

            ### Quote

            > A wise person once said something quotable.

            ## Code

            ```
            let x = 42
            print(x)
            ```

            End paragraph.
            """)
            .padding()
        }
        snapshot(view, name: "32-markdown-kitchen-sink")
    }

    /// A four-column table whose widest row is wider than the phone: every
    /// column renders, the long cell wraps at the column cap rather than
    /// stretching its column into one line, and the overflow scrolls inside
    /// the table's own bounds instead of clipping the page.
    private let markdownWideTable = """
    ## Quarterly budget review

    | Line item | Owner | Q3 actual | Notes |
    | --- | --- | --- | --- |
    | Venue hire | Maya Reeves | 4,200 | Deposit paid in July; balance due at the end of the quarter |
    | Catering | Jamie Lopez | 1,850 | Vegetarian option added after the survey |
    | Travel and accommodation for the visiting speakers and the two facilitators | David Lin | 6,300 | Booked through the agency |
    | Printing | Sarah Mendez | 310 | — |

    Totals are reconciled monthly.
    """

    func testMarkdownTableWide() {
        let view = ScrollView {
            MarkdownView(text: markdownWideTable)
                .padding()
        }
        snapshot(view, name: "32a-markdown-table-wide", size: CGSize(width: 393, height: 600))
    }

    /// A cell holding one 400-character token with no break opportunity: the
    /// column stops at the cap and the token is broken across lines inside it
    /// rather than stretching the column to the token's length.
    func testMarkdownTableLongToken() {
        let token = String(repeating: "abcdefghij", count: 40)
        let view = ScrollView {
            MarkdownView(text: """
            | Key | Value |
            | --- | --- |
            | Digest | \(token) |
            | Owner | Maya Reeves |
            """)
            .padding()
        }
        snapshot(view, name: "32c-markdown-table-long-token", size: CGSize(width: 393, height: 700))
    }

    /// The same table read right to left: the first column sits against the
    /// trailing edge and the header rule still spans every column.
    func testMarkdownTableRightToLeft() {
        let view = ScrollView {
            MarkdownView(text: """
            | Line item | Owner | Q3 actual |
            | --- | --- | --- |
            | Venue hire | Maya Reeves | 4,200 |
            | Catering | Jamie Lopez | 1,850 |
            """)
            .padding()
        }
        .environment(\.layoutDirection, .rightToLeft)
        snapshot(view, name: "32d-markdown-table-right-to-left", size: CGSize(width: 393, height: 300))
    }

    /// The same table on a canvas wide enough to hold it: every column is
    /// present, the columns line up across rows, and the header rule spans
    /// the whole table — the part a phone-width capture leaves off-screen.
    func testMarkdownTableWideUnclipped() {
        let view = ScrollView {
            MarkdownView(text: markdownWideTable)
                .padding()
        }
        snapshot(view, name: "32b-markdown-table-wide-unclipped", size: CGSize(width: 1000, height: 400))
    }

    func testInspectorMetadataTab() {
        let view = DocumentInspectorSheet(
            doc: PreviewMocks.documentDetail,
            people: PreviewMocks.documentPeople,
            refs: PreviewMocks.documentRefs,
            attachments: PreviewMocks.documentAttachments,
            initialTab: .metadata
        )
        .environment(AppStore.preview())
        snapshot(view, name: "31-inspector-metadata-tab")
    }

    func testInspectorGraphTab() {
        let view = DocumentInspectorSheet(
            doc: PreviewMocks.documentDetail,
            people: PreviewMocks.documentPeople,
            refs: PreviewMocks.documentRefs,
            attachments: PreviewMocks.documentAttachments,
            initialTab: .graph
        )
        .environment(AppStore.preview())
        snapshot(view, name: "31b-inspector-graph-tab")
    }

    func testInspectorGraphTabWithNearDupes() {
        // Every paged graph edge section labels its count as loaded, and the
        // summary does the same while any next cursor remains.
        let view = DocumentInspectorSheet(
            doc: PreviewMocks.documentDetail,
            people: PreviewMocks.documentPeople,
            refs: PreviewMocks.documentRefs,
            attachments: PreviewMocks.documentAttachments,
            nearDupes: PreviewMocks.documentNearDupes,
            outboundPaging: CursorPagingState(nextCursor: "outbound-next"),
            inboundPaging: CursorPagingState(nextCursor: "inbound-next"),
            nearDupesPaging: CursorPagingState(nextCursor: "similar-next"),
            initialTab: .graph
        )
        .environment(AppStore.preview())
        snapshot(view, name: "31c-inspector-graph-tab-with-near-dupes")
    }

    /// Graph tab with a cross-store `same-entity` bound row (#450, #644):
    /// the "Same entity" section leads, showing the Strava analytics
    /// table's display name + headline fields above the other edge types.
    func testInspectorGraphTabSameEntity() {
        let view = DocumentInspectorSheet(
            doc: PreviewMocks.documentDetail,
            people: PreviewMocks.documentPeople,
            refs: PreviewMocks.documentRefs,
            attachments: PreviewMocks.documentAttachments,
            nearDupes: PreviewMocks.documentNearDupes,
            boundRows: PreviewMocks.documentGraphBoundRows,
            initialTab: .graph
        )
        .environment(AppStore.preview())
        snapshot(view, name: "31d-inspector-graph-tab-same-entity")
    }

    // MARK: - Source recent items

    func testSourceRecentDocuments() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames
        )
        let view = NavigationStack {
            SourceRecentPreviewWrapper(arm: .documents(PreviewMocks.recentDocuments))
        }
        snapshot(view.environment(store), name: "40-source-recent-documents")
    }

    func testSourceRecentAnalytics() {
        let store = AppStore.preview()
        let view = NavigationStack {
            SourceRecentPreviewWrapper(arm: PreviewMocks.recentAnalytics)
        }
        snapshot(view.environment(store), name: "41-source-recent-analytics")
    }

    func testSourceRecentEmpty() {
        let store = AppStore.preview()
        let view = NavigationStack {
            SourceRecentPreviewWrapper(arm: .empty)
        }
        snapshot(view.environment(store), name: "42-source-recent-empty")
    }

    func testSourceRecentEmptyPageLoadingContinuation() {
        let view = NavigationStack {
            SourceRecentPreviewWrapper(
                arm: .documents([]),
                paging: CursorPagingState(nextCursor: "next-page", isLoadingMore: true)
            )
        }
        snapshot(
            view.environment(AppStore.preview()),
            name: "42a-source-recent-empty-page-loading"
        )
    }

    func testWholeSourceCleanupPending() {
        snapshot(SourcesView(menuOpen: .constant(false)).environment(AppStore.preview(
            pendingSourceRemovals: [PreviewMocks.pendingSourceRemoval]
        )), name: "50i-whole-source-cleanup-pending")
    }

    func testOfflineSourceActivationPending() {
        snapshot(SettingsView(initialDestination: .root, previewData: true).environment(AppStore.preview(
            pendingLocalSourceResumes: [PreviewMocks.sourceAppleHealth.id]
        )), name: "50j-offline-source-activation-pending")
    }

    func testOfflineDeparturePending() {
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(AppStore.preview(
                appleHealthEnabled: false,
                pendingLocalSourceDepartures: [PreviewMocks.sourceAppleHealth.id]
            )),
            name: "50h-offline-departure-pending",
            size: CGSize(width: 393, height: 1100)
        )
    }

    func testDeviceDepartureConsequences() {
        snapshotPresented(
            Color.clear.sheet(isPresented: .constant(true)) {
                SourceDepartureConfirmation(sourceName: humanName(for: PreviewMocks.sourceAppleHealth.type), onConfirm: {})
            },
            name: "50f-device-departure-consequences"
        )
    }

    func testWholeSourceRemovalConsequences() {
        snapshotPresented(
            Color.clear.sheet(isPresented: .constant(true)) {
                SourceDepartureConfirmation(
                    sourceName: humanName(for: PreviewMocks.sourceAppleHealth.type),
                    wholeSource: true,
                    onConfirm: {}
                )
            },
            name: "50g-whole-source-removal-consequences"
        )
    }

    // MARK: - Settings

    func testSettingsConnected() async throws {
        let sourceId = "apple-health:local"
        let coordinator = AdminCoordinator()
        coordinator.installPreviewState(
            sources: [],
            statusesBySource: [sourceId: PreviewMocks.syncStatusLocalHealth],
            deviceNames: [:],
            statusSnapshot: nil,
            indexStats: nil,
            wsState: nil,
            sourceIconByType: [:],
            localDeviceId: "dev_iphone"
        )
        await coordinator.forwardLifecycle(.started(
            sourceId: sourceId,
            displayName: "Apple Health",
            startedAt: Date()
        ))
        coordinator.simulateSyncStatusBroadcastForTesting(.object([
            "sourceId": .string(sourceId),
            "deviceId": .string("dev_tablet"),
            "state": .string("error"),
            "errorMessage": .string("Permission required"),
        ]))
        let merged = try XCTUnwrap(coordinator.syncStatusesBySource[sourceId])
        XCTAssertEqual(merged.members?.count, 2)
        XCTAssertEqual(merged.status(forDeviceId: "dev_iphone")?.state, "syncing")
        XCTAssertEqual(merged.status(forDeviceId: "dev_tablet")?.state, "error")
        coordinator.simulateSyncStatusBroadcastForTesting(.object([
            "sourceId": .string(sourceId),
            "state": .string("syncing"),
        ]))
        let afterAnonymousEcho = try XCTUnwrap(coordinator.syncStatusesBySource[sourceId])
        XCTAssertEqual(afterAnonymousEcho.members?.count, 2)
        XCTAssertEqual(afterAnonymousEcho.status(forDeviceId: "dev_iphone")?.state, "syncing")
        XCTAssertEqual(afterAnonymousEcho.status(forDeviceId: "dev_tablet")?.state, "error")

        let store = AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        )
        XCTAssertEqual(store.localSyncStatus(sourceId: sourceId)?.state, "synced")
        XCTAssertEqual(store.syncStatusesBySource[sourceId]?.state, "syncing")
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "50-settings-connected"
        )
    }

    func testSettingsGatewayUnreachable() {
        snapshot(
            SettingsView(initialDestination: .root, previewData: true)
                .environment(AppStore.preview(
                    pairedDeviceId: "dev_iphone",
                    wsState: .failed("Connection timed out")
                )),
            name: "50b-settings-gateway-unreachable"
        )
    }

    func testSettingsNotificationTextUnavailable() {
        snapshot(
            SettingsView(
                initialDestination: .notifications,
                previewData: true,
                previewClaimReason: .unreachable
            )
            .environment(AppStore.preview(pairedDeviceId: "dev_iphone")),
            name: "50c-settings-notification-text-unavailable"
        )
    }

    func testSettingsSourceStatusLoading() {
        let store = AppStore.preview(
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "50c-settings-source-status-loading"
        )
    }

    func testSettingsSourceStatusSyncing() {
        let syncing = SourceSyncStatus(
            sourceId: "apple-health:local",
            deviceId: "dev_iphone",
            state: "syncing",
            unitName: "sample",
            progress: .init(
                phase: "incremental",
                total: nil,
                processed: 42,
                percentComplete: nil,
                message: nil
            ),
            startedAt: Int64(Date().timeIntervalSince1970 * 1000),
            lastSyncAt: nil,
            errorMessage: nil,
            erroredAt: nil,
            lastUpdated: Int64(Date().timeIntervalSince1970 * 1000)
        )
        let store = AppStore.preview(
            statusesBySource: [syncing.sourceId: syncing],
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "50d-settings-source-status-syncing"
        )
    }

    func testSettingsConfigureModelsStack() {
        snapshot(
            SettingsView(initialDestination: .models(initialRole: nil), previewData: true)
                .environment(AppStore.preview()),
            name: "50a-settings-configure-models"
        )
    }

    func testSettingsConfigureBackgroundAgentPicker() {
        snapshotPresented(
            SettingsView(
                initialDestination: .models(initialRole: "background-agent"),
                previewData: true
            )
            .environment(AppStore.preview()),
            name: "50e-settings-configure-background-agent"
        )
    }

    func testSettingsConfigureDevicesStack() {
        snapshot(
            SettingsView(initialDestination: .devices, previewData: true)
                .environment(AppStore.preview()),
            name: "50b-settings-configure-devices"
        )
    }

    func testSettingsPoliciesStack() {
        snapshot(
            SettingsView(initialDestination: .policies, previewData: true)
                .environment(AppStore.preview()),
            name: "50e-settings-policies"
        )
    }

    func testSettingsAppleHealthDisabled() {
        let store = AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "52-settings-apple-health-disabled"
        )
    }

    // MARK: - Phone setup

    private func phoneSetupSnapshot(
        _ coordinator: PhoneSetupCoordinator,
        name: String,
        promptVisible: Bool? = nil,
        dynamicTypeSize: DynamicTypeSize = .large
    ) {
        snapshot(
            PhoneSetupView(coordinator: coordinator)
                .environment(\.phoneSetupMotion, false)
                .environment(\.phoneSetupPromptVisible, promptVisible)
                .environment(\.dynamicTypeSize, dynamicTypeSize),
            name: name,
            ignoresSafeArea: true
        )
    }

    private var phoneSetupSources: [String] {
        [AppleHealthSetupStep.sourceId, PlacesSetupStep.sourceId, PhotosSetupStep.sourceId, MovementSetupStep.sourceId]
    }

    func testPhoneSetupConnected() {
        phoneSetupSnapshot(PhoneSetupPreview.coordinator(screen: .connected), name: "240-phone-setup-connected")
    }

    func testPhoneSetupChooseFresh() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .choose,
            selection: [AppleHealthSetupStep.sourceId, PhotosSetupStep.sourceId, NotificationsSetupStep.stepId]
        )
        phoneSetupSnapshot(coordinator, name: "241-phone-setup-choose-fresh")
    }

    func testPhoneSetupChooseSomeAlreadyOn() {
        let host = PhoneSetupPreviewHost()
        host.appleHealthEnabled = true
        host.notificationPermission = .authorized
        let coordinator = PhoneSetupPreview.coordinator(host: host, screen: .choose, selection: [PlacesSetupStep.sourceId])
        phoneSetupSnapshot(coordinator, name: "242-phone-setup-choose-some-on")
    }

    func testPhoneSetupChooseUnavailable() {
        let host = PhoneSetupPreviewHost()
        host.healthDataAvailable = false
        host.motionActivityPermission = .unavailable
        host.notificationPermission = .denied
        phoneSetupSnapshot(
            PhoneSetupPreview.coordinator(host: host, screen: .choose),
            name: "243-phone-setup-choose-unavailable"
        )
    }

    func testPhoneSetupStepAppleHealth() {
        let host = PhoneSetupPreviewHost()
        host.enabledCategories.remove(.nutrition)
        let coordinator = PhoneSetupPreview.coordinator(host: host, screen: .step(index: 0), selection: phoneSetupSources)
        phoneSetupSnapshot(coordinator, name: "244-phone-setup-step-apple-health")
    }

    func testPhoneSetupStepPlaces() {
        let coordinator = PhoneSetupPreview.coordinator(screen: .step(index: 1), selection: phoneSetupSources)
        phoneSetupSnapshot(coordinator, name: "245-phone-setup-step-places")
    }

    func testPhoneSetupStepPhotos() {
        let coordinator = PhoneSetupPreview.coordinator(screen: .step(index: 2), selection: phoneSetupSources)
        phoneSetupSnapshot(coordinator, name: "246-phone-setup-step-photos")
    }

    func testPhoneSetupStepMovement() {
        let coordinator = PhoneSetupPreview.coordinator(screen: .step(index: 3), selection: phoneSetupSources)
        phoneSetupSnapshot(coordinator, name: "247-phone-setup-step-movement")
    }

    func testPhoneSetupStepNotifications() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .step(index: 1),
            selection: [AppleHealthSetupStep.sourceId, NotificationsSetupStep.stepId]
        )
        phoneSetupSnapshot(coordinator, name: "248-phone-setup-step-notifications")
    }

    func testPhoneSetupStepWaitingForIOS() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [PlacesSetupStep.sourceId],
            busyStepId: PlacesSetupStep.sourceId
        )
        phoneSetupSnapshot(coordinator, name: "249-phone-setup-step-waiting-for-ios", promptVisible: true)
    }

    func testPhoneSetupOutcomeOn() {
        let host = PhoneSetupPreviewHost()
        host.appleHealthEnabled = true
        host.statuses[AppleHealthSetupStep.sourceId] = PhoneSetupLiveStatus(
            headline: "Syncing…",
            count: "1,284 samples processed",
            kind: .syncing,
            fraction: 0.38
        )
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 0),
            selection: [AppleHealthSetupStep.sourceId, PlacesSetupStep.sourceId],
            outcomes: [AppleHealthSetupStep.sourceId: .on]
        )
        phoneSetupSnapshot(coordinator, name: "250-phone-setup-outcome-on")
    }

    func testPhoneSetupOutcomeLimited() {
        let host = PhoneSetupPreviewHost()
        host.photosEnabled = true
        host.photosAccess = .limited
        host.statuses[PhotosSetupStep.sourceId] = PhoneSetupLiveStatus(headline: "Up to date", kind: .upToDate)
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 0),
            selection: [PhotosSetupStep.sourceId, MovementSetupStep.sourceId],
            outcomes: [PhotosSetupStep.sourceId: .limited]
        )
        phoneSetupSnapshot(coordinator, name: "251-phone-setup-outcome-limited")
    }

    func testPhoneSetupOutcomePartial() {
        let host = PhoneSetupPreviewHost()
        host.coreLocationVisitsEnabled = true
        host.locationVisitsPermission = .whenInUse
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 0),
            selection: [PlacesSetupStep.sourceId],
            outcomes: [PlacesSetupStep.sourceId: .partial]
        )
        phoneSetupSnapshot(coordinator, name: "252-phone-setup-outcome-partial")
    }

    func testPhoneSetupOutcomeNotAllowed() {
        let host = PhoneSetupPreviewHost()
        host.motionActivityPermission = .denied
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 1),
            selection: [PlacesSetupStep.sourceId, MovementSetupStep.sourceId],
            outcomes: [MovementSetupStep.sourceId: .notAllowed]
        )
        phoneSetupSnapshot(coordinator, name: "253-phone-setup-outcome-not-allowed")
    }

    func testPhoneSetupOutcomeChoiceRequired() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [AppleHealthSetupStep.sourceId],
            outcomes: [AppleHealthSetupStep.sourceId: .choiceRequired(.replicated)]
        )
        phoneSetupSnapshot(coordinator, name: "254-phone-setup-outcome-choice-required")
    }

    func testPhoneSetupOutcomeFailed() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [PhotosSetupStep.sourceId],
            outcomes: [
                PhotosSetupStep.sourceId: .failed(message: "Couldn't reach your gateway to turn this on. Nothing was changed."),
            ]
        )
        phoneSetupSnapshot(coordinator, name: "255-phone-setup-outcome-failed")
    }

    func testPhoneSetupOutcomeUnavailable() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [MovementSetupStep.sourceId],
            outcomes: [MovementSetupStep.sourceId: .unavailable(reason: PhoneSetupCopy.notAvailableReason)]
        )
        phoneSetupSnapshot(coordinator, name: "256-phone-setup-outcome-unavailable")
    }

    func testPhoneSetupRelayConsentStep() {
        let host = PhoneSetupPreviewHost()
        host.notificationPermission = .authorized
        host.relayPushConsentRequest = PhoneSetupPreview.relayConsentRequest
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 1),
            selection: [NotificationsSetupStep.stepId, RelayConsentSetupStep.stepId]
        )
        phoneSetupSnapshot(coordinator, name: "257-phone-setup-relay-consent-step")
    }

    func testPhoneSetupRelayConsentAnswered() {
        let answers: [(PhoneSetupOutcome, String)] = [
            (.on, "278a-phone-setup-relay-consent-on"),
            (.notAllowed, "278b-phone-setup-relay-consent-off"),
        ]
        for (answer, name) in answers {
            let host = PhoneSetupPreviewHost()
            host.notificationPermission = .authorized
            let coordinator = PhoneSetupPreview.coordinator(
                host: host,
                screen: .step(index: 1),
                selection: [NotificationsSetupStep.stepId, RelayConsentSetupStep.stepId],
                outcomes: [RelayConsentSetupStep.stepId: answer]
            )
            phoneSetupSnapshot(coordinator, name: name)
        }
    }

    func testPhoneSetupNotificationsOff() {
        let host = PhoneSetupPreviewHost()
        host.notificationPermission = .denied
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 0),
            selection: [NotificationsSetupStep.stepId],
            outcomes: [NotificationsSetupStep.stepId: .notAllowed]
        )
        phoneSetupSnapshot(coordinator, name: "258-phone-setup-notifications-off")
    }

    func testPhoneSetupFinishContributing() {
        let host = PhoneSetupPreviewHost()
        host.appleHealthEnabled = true
        host.photosEnabled = true
        host.photosAccess = .limited
        host.notificationPermission = .authorized
        host.statuses[AppleHealthSetupStep.sourceId] = PhoneSetupLiveStatus(
            headline: "Syncing…",
            count: "3,912 samples processed",
            kind: .syncing,
            fraction: 0.64
        )
        host.statuses[PhotosSetupStep.sourceId] = PhoneSetupLiveStatus(headline: "Up to date", kind: .upToDate)
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .finish,
            selection: [
                AppleHealthSetupStep.sourceId,
                PhotosSetupStep.sourceId,
                MovementSetupStep.sourceId,
                NotificationsSetupStep.stepId,
            ],
            outcomes: [
                AppleHealthSetupStep.sourceId: .on,
                PhotosSetupStep.sourceId: .limited,
                MovementSetupStep.sourceId: .notAllowed,
                NotificationsSetupStep.stepId: .on,
            ]
        )
        phoneSetupSnapshot(coordinator, name: "259-phone-setup-finish-contributing")
    }

    func testPhoneSetupFinishAllSet() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .finish,
            selection: [MovementSetupStep.sourceId],
            outcomes: [MovementSetupStep.sourceId: .notAllowed]
        )
        phoneSetupSnapshot(coordinator, name: "260-phone-setup-finish-all-set")
    }

    func testPhoneSetupStepPhotosLargeText() {
        let coordinator = PhoneSetupPreview.coordinator(screen: .step(index: 0), selection: [PhotosSetupStep.sourceId])
        phoneSetupSnapshot(coordinator, name: "261-phone-setup-step-photos-large-text", dynamicTypeSize: .accessibility1)
    }

    func testPhoneSetupNotificationsOnWithoutRelay() {
        let host = PhoneSetupPreviewHost()
        host.notificationPermission = .authorized
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 0),
            selection: [NotificationsSetupStep.stepId],
            outcomes: [NotificationsSetupStep.stepId: .on]
        )
        phoneSetupSnapshot(coordinator, name: "263-phone-setup-notifications-on-no-relay")
    }

    func testPhoneSetupStepBusySpinnerOnly() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [PhotosSetupStep.sourceId],
            busyStepId: PhotosSetupStep.sourceId
        )
        phoneSetupSnapshot(coordinator, name: "264-phone-setup-step-busy-spinner", promptVisible: false)
    }

    func testPhoneSetupPhotosTwoOptionChoice() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [PhotosSetupStep.sourceId],
            outcomes: [PhotosSetupStep.sourceId: .choiceRequired(.exclusive)]
        )
        phoneSetupSnapshot(coordinator, name: "265-phone-setup-photos-choice")
    }

    func testPhoneSetupAppleHealthZeroCategories() {
        let host = PhoneSetupPreviewHost()
        host.enabledCategories = []
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 0),
            selection: [AppleHealthSetupStep.sourceId]
        )
        phoneSetupSnapshot(coordinator, name: "266-phone-setup-apple-health-no-categories")
    }

    func testPhoneSetupSettingsSingleStep() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [MovementSetupStep.sourceId],
            outcomes: [MovementSetupStep.sourceId: .on],
            presentation: .settingsStep
        )
        phoneSetupSnapshot(coordinator, name: "267-phone-setup-settings-single-step")
    }

    func testPhoneSetupChooseLargeText() {
        let coordinator = PhoneSetupPreview.coordinator(screen: .choose, selection: [PhotosSetupStep.sourceId])
        phoneSetupSnapshot(coordinator, name: "268-phone-setup-choose-large-text", dynamicTypeSize: .accessibility1)
    }

    func testPhoneSetupOutcomeLargeText() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [PlacesSetupStep.sourceId],
            outcomes: [PlacesSetupStep.sourceId: .notAllowed]
        )
        phoneSetupSnapshot(coordinator, name: "269-phone-setup-outcome-large-text", dynamicTypeSize: .accessibility1)
    }

    func testPhoneSetupFinishSentByAnotherDevice() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .finish,
            selection: [PhotosSetupStep.sourceId],
            outcomes: [PhotosSetupStep.sourceId: .skipped]
        )
        phoneSetupSnapshot(coordinator, name: "270-phone-setup-finish-sent-by-another-device")
    }

    /// The Settings placements phone setup adds, in the real Settings screen:
    /// limited Photos, a source's last enable issue, and Places waiting for a
    /// location decision. The canvas is tall enough to reach Photos.
    func testSettingsPhoneSetupPlacements() {
        let store = AppStore.preview(
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false,
            coreLocationVisitsEnabled: true,
            photosEnabled: true,
            pushDeliveryHealth: .notDetermined,
            localSourceEnableIssues: [
                MovementSetupStep.sourceId: "Couldn't reach your gateway to turn this on. Nothing was changed.",
            ],
            photosAccess: .limited,
            locationVisitsPermission: .notDetermined
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "271-settings-phone-setup-placements",
            size: CGSize(width: 393, height: 2400)
        )
    }

    /// Photos in the real Settings screen while the library is limited to a
    /// selection, with the reason its last enable failed beside the switch.
    func testSettingsPhotosLimitedPlacement() {
        let store = AppStore.preview(
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false,
            photosEnabled: true,
            localSourceEnableIssues: [
                PhotosSetupStep.sourceId: "Couldn't reach your gateway to turn this on. Nothing was changed.",
            ],
            photosAccess: .limited
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "272-settings-photos-limited",
            size: CGSize(width: 393, height: 2600)
        )
    }

    func testPhoneSetupPhotosNotAllowedSaysWhatToChangeInSettings() {
        let host = PhoneSetupPreviewHost()
        host.photosAccess = .denied
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 0),
            selection: [PhotosSetupStep.sourceId],
            outcomes: [PhotosSetupStep.sourceId: .notAllowed]
        )
        phoneSetupSnapshot(coordinator, name: "273-phone-setup-photos-not-allowed")
    }

    func testPhoneSetupOutcomeContinuingAfterSettings() {
        let host = PhoneSetupPreviewHost()
        host.locationVisitsPermission = .always
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 0),
            selection: [PlacesSetupStep.sourceId],
            outcomes: [PlacesSetupStep.sourceId: .notAllowed],
            busyStepId: PlacesSetupStep.sourceId
        )
        phoneSetupSnapshot(coordinator, name: "274-phone-setup-outcome-continuing", promptVisible: false)
    }

    func testPhoneSetupNotificationsTurningOn() {
        let coordinator = PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [NotificationsSetupStep.stepId],
            busyStepId: NotificationsSetupStep.stepId
        )
        phoneSetupSnapshot(coordinator, name: "275-phone-setup-notifications-turning-on", promptVisible: false)
    }

    /// The outcome changes in place, as when Places carries on by itself after
    /// the user returns from Settings, with motion on. The capture waits past
    /// the draw-in, so it must show the full ring and check.
    func testPhoneSetupRingIsDrawnAfterAnInPlaceSuccess() {
        for scheme in [ColorScheme.dark, .light] {
            let host = PhoneSetupPreviewHost()
            host.coreLocationVisitsEnabled = true
            host.locationVisitsPermission = .always
            let before = PhoneSetupPreview.coordinator(
                host: host,
                screen: .step(index: 0),
                selection: [PlacesSetupStep.sourceId],
                outcomes: [PlacesSetupStep.sourceId: .notAllowed]
            )
            let after = PhoneSetupPreview.coordinator(
                host: host,
                screen: .step(index: 0),
                selection: [PlacesSetupStep.sourceId],
                outcomes: [PlacesSetupStep.sourceId: .on]
            ).flow
            renderInWindow(
                PhoneSetupInPlaceOutcomeProbe(coordinator: before, changed: after),
                name: scheme == .dark ? "276-phone-setup-ring-after-in-place-success" : "276-phone-setup-ring-after-in-place-success-light",
                scheme: scheme,
                settle: 2.2
            )
        }
    }

    func testPhoneSetupBackgroundRefreshPage() {
        let host = PhoneSetupPreviewHost()
        host.backgroundRefreshStatus = .denied
        host.isLowPowerModeEnabled = true
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 3),
            selection: [
                AppleHealthSetupStep.sourceId,
                PhotosSetupStep.sourceId,
                MovementSetupStep.sourceId,
                BackgroundRefreshSetupStep.stepId,
            ]
        )
        phoneSetupSnapshot(coordinator, name: "277-phone-setup-background-refresh")
    }

    func testPhoneSetupBackgroundRefreshOn() {
        let host = PhoneSetupPreviewHost()
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 1),
            selection: [PhotosSetupStep.sourceId, BackgroundRefreshSetupStep.stepId],
            outcomes: [BackgroundRefreshSetupStep.stepId: .on]
        )
        phoneSetupSnapshot(coordinator, name: "277a-phone-setup-background-refresh-on")
    }

    func testPhoneSetupBackgroundRefreshStillOff() {
        let host = PhoneSetupPreviewHost()
        host.backgroundRefreshStatus = .denied
        let coordinator = PhoneSetupPreview.coordinator(
            host: host,
            screen: .step(index: 1),
            selection: [PhotosSetupStep.sourceId, BackgroundRefreshSetupStep.stepId],
            outcomes: [BackgroundRefreshSetupStep.stepId: .notAllowed]
        )
        phoneSetupSnapshot(coordinator, name: "277b-phone-setup-background-refresh-still-off")
    }

    func testPhoneSetupSettingsRows() {
        let view = Form {
            Section("This iPhone") {
                PhoneSetupSettingsRow(summary: PhoneSetupSourceSummary(enabled: 1, available: 4)) {}
            }
            .listRowBackground(Theme.bgSecondary)
            Section("Photos") {
                PhoneSetupWhatsSent(copy: PhotosSetupStep.copy, isExpanded: true)
            }
            .listRowBackground(Theme.bgSecondary)
            Section("Movement") {
                PhoneSetupWhatsSent(copy: MovementSetupStep.copy)
            }
            .listRowBackground(Theme.bgSecondary)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bgPrimary)
        snapshot(view, name: "262-phone-setup-settings-rows")
    }

    func testSettings() {
        let store = AppStore.preview()
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "51-settings"
        )
    }

    /// The About section sits at the foot of a screen far taller than the
    /// canvas, so it gets its own render rather than never being looked at.
    func testSettingsAbout() {
        let form = Form { AboutSection(versions: PreviewMocks.appVersionInfo) }
            .scrollContentBackground(.hidden)
            .background(Theme.bgPrimary)
        snapshot(form, name: "51a-settings-about", size: CGSize(width: 393, height: 320))
    }

    /// The alert bubble itself doesn't appear in the PNG this produces:
    /// `render()` hosts the view in a bare `UIHostingController` with no
    /// window scene, and `UIAlertController` presentation is a no-op
    /// without one — true for every `.alert(...)` in this codebase, not
    /// specific to this view. This still catches a crash on the
    /// alert-presented code path, and the `#Preview` it mirrors renders
    /// correctly (alert included) in Xcode's own interactive canvas.
    /// Uses a taller canvas than the default so the render reaches all
    /// the way down to the Mood row this alert gates.
    func testSettingsMoodConsentAlert() {
        let store = AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats
        )
        snapshot(
            SettingsView(
                initialDestination: .root,
                previewData: true,
                previewMoodConsentAlertPresented: true
            ).environment(store),
            name: "123-settings-mood-consent-alert",
            size: CGSize(width: 393, height: 1500)
        )
    }

    func testSettingsActivitySegmentsEnabled() {
        let store = AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false,
            activitySegmentsEnabled: true
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "124-settings-activity-segments-enabled"
        )
    }

    func testSettingsLocationVisitsEnabled() {
        let store = AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false,
            coreLocationVisitsEnabled: true
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "137-settings-location-visits-enabled"
        )
    }

    /// The phone's own Places row with a failed sync: the headline carries the
    /// error icon, and the line under it stays the last-sync time.
    func testSettingsLocationVisitsErrorNotice() {
        let store = AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false,
            coreLocationVisitsEnabled: true
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "137b-settings-location-visits-error-notice",
            size: CGSize(width: 393, height: 2600)
        )
    }

    func testSettingsPushPermissionDenied() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushDeliveryHealth: .permissionDenied
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "134-settings-push-denied"
        )
    }

    func testSettingsPushScheduledSummary() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushDeliveryHealth: .scheduledSummary
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "135-settings-push-scheduled-summary"
        )
    }

    func testSettingsPushAlertsOff() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushDeliveryHealth: .alertsOff
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "136-settings-push-alerts-off"
        )
    }

    func testSettingsDirectPushSetupMissing() {
        let store = AppStore.preview(
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushGatewayConfiguration: .noDirectCredential,
            pushConfigurationAppId: PreviewMocks.independentlySignedAppId
        )
        snapshot(
            SettingsView(initialDestination: .notifications, previewData: true).environment(store),
            name: "138-settings-direct-push-missing"
        )
    }

    func testSettingsPushGatewayUnavailableLargeText() {
        let store = AppStore.preview(
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushGatewayConfiguration: .gatewayUnavailable,
            pushRegistrationFailure: "No valid aps-environment entitlement"
        )
        snapshot(
            SettingsView(initialDestination: .notifications, previewData: true)
                .environment(store)
                .dynamicTypeSize(.accessibility2),
            name: "139-settings-push-unavailable-large-text",
            size: CGSize(width: 393, height: 1000)
        )
    }

    func testSettingsDirectPushSelectedNarrow() {
        let store = AppStore.preview(
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushGatewayConfiguration: .direct,
            pushConfigurationAppId: PreviewMocks.independentlySignedAppId
        )
        snapshot(
            SettingsView(initialDestination: .notifications, previewData: true).environment(store),
            name: "140-settings-direct-push-narrow",
            size: CGSize(width: 320, height: 852)
        )
    }

    func testRelayPushConsent() {
        snapshot(
            RelayPushConsentSheet(
                appId: PreviewMocks.relayPushAppId,
                onAllow: {},
                onNotNow: {}
            ),
            name: "232-relay-push-consent"
        )
    }

    func testRelayPushConsentSaving() {
        snapshot(
            RelayPushConsentSheet(
                appId: PreviewMocks.relayPushAppId,
                initialWorking: true,
                onAllow: {},
                onNotNow: {}
            ),
            name: "232b-relay-push-consent-saving"
        )
    }

    func testRelayPushConsentError() {
        snapshot(
            RelayPushConsentSheet(
                appId: PreviewMocks.relayPushAppId,
                initialErrorMessage: PreviewMocks.relayPushConsentError,
                onAllow: {},
                onNotNow: {}
            ),
            name: "232c-relay-push-consent-error"
        )
    }

    func testRelayPushConsentAccessibility() {
        snapshot(
            RelayPushConsentSheet(
                appId: PreviewMocks.relayPushAppId,
                onAllow: {},
                onNotNow: {}
            )
            .environment(\.dynamicTypeSize, .accessibility3),
            name: "232d-relay-push-consent-accessibility",
            size: CGSize(width: 393, height: 1400)
        )
    }

    func testSettingsDeveloperMode() {
        // Paired to a gateway in developer mode: the Gateway section grows a
        // "Health sample probe" entry under Configure Devices. Tall canvas so
        // the render reaches that row — on the default one it sits below the
        // fold and the case would assert nothing.
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshotDeveloper,
            indexStats: PreviewMocks.indexStats
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "193-settings-developer-mode",
            size: CGSize(width: 393, height: 1300)
        )
    }

    func testSettingsPhotosEnabledFooter() {
        // Photos on: its section's footer carries the leave-the-source copy.
        // Tall canvas so the render reaches the Photos section at the bottom.
        let store = AppStore.preview(
            statusesBySource: PreviewMocks.syncStatuses,
            pairedDeviceId: "dev_iphone",
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            appleHealthEnabled: false,
            photosEnabled: true,
            photosAccess: .full
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "193b-settings-photos-enabled",
            size: CGSize(width: 393, height: 1300)
        )
    }

    func testHealthSampleProbe() {
        // The developer probe: samples grouped per HealthKit type, uuid + end
        // date in monospace, Copy all in the toolbar, and a read-access
        // request at the foot of the list — a type with no grant reads the
        // same as a type with no data. Then the empty state, which names both
        // causes, and the same screen mid-request.
        let store = AppStore.preview(statusSnapshot: PreviewMocks.statusSnapshotDeveloper)
        let populated = NavigationStack {
            HealthSampleProbeView(previewRows: PreviewMocks.healthSampleProbeRows)
        }
        // Tall canvas so the render reaches the request section under the
        // last type group.
        snapshot(
            populated.environment(store),
            name: "194-health-sample-probe",
            size: CGSize(width: 393, height: 1100)
        )
        let empty = NavigationStack {
            HealthSampleProbeView(previewRows: [])
        }
        snapshot(empty.environment(store), name: "194b-health-sample-probe-empty")
        let requesting = NavigationStack {
            HealthSampleProbeView(previewRows: [], previewRequesting: true)
        }
        snapshot(requesting.environment(store), name: "194c-health-sample-probe-requesting")
    }

    // MARK: - HomeView (full app shell)

    func testHomeViewShell() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        let view = HomeView()
            .environment(store)
            .environment(store.notificationRouter)
        snapshot(view, name: "00-home-view-shell")
    }

    func testRootViewOnboarding() {
        // Fresh AppStore (no `.preview()` fixtures) means `pairing == nil`,
        // so RootView routes to OnboardingView — mirrors the
        // "RootView — onboarding" #Preview in App.swift.
        let store = AppStore()
        snapshot(RootView().environment(store), name: "61-rootview-onboarding")
    }

    // MARK: - Briefs feed

    /// The Briefs list: every card glanceable at once — unread dot +
    /// semibold title on fresh briefs, plain-text one-line descriptions,
    /// relative times. The first row is marked viewed so both row states
    /// render side by side.
    func testBriefsListPopulated() {
        var feed = BriefsFeedState(briefs: PreviewMocks.briefs)
        _ = feed.markViewed(id: PreviewMocks.briefs.first?.id ?? "")
        let view = NavigationStack {
            BriefsListContent(
                feed: feed,
                loading: false,
                loadError: nil,
                onOpen: { _ in },
                onQuickClear: { _ in },
                onAsk: { _ in },
                onMoreOptions: { _ in },
                onRetry: {},
                onRefresh: {},
                paging: CursorPagingState(nextCursor: "preview-next")
            )
            .navigationTitle("Briefs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        }
        snapshot(view, name: "113-briefs-list-populated")
    }

    /// A parked background agent does not cover or replace historical briefs.
    /// The amber banner stays above the populated feed and links to setup.
    func testBriefsListNeedsBackgroundAgent() {
        let view = NavigationStack {
            BriefsListContent(
                feed: BriefsFeedState(briefs: PreviewMocks.briefs),
                loading: false,
                loadError: nil,
                onOpen: { _ in },
                onQuickClear: { _ in },
                onAsk: { _ in },
                onMoreOptions: { _ in },
                onRetry: {},
                onRefresh: {},
                showsModelWarning: true
            )
            .navigationTitle("Briefs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        }
        snapshot(view, name: "130-briefs-list-needs-background-agent")
    }

    /// A never-configured install can have no historical cards; the warning
    /// still leaves the empty-state message centered in the remaining space.
    func testBriefsListEmptyNeedsBackgroundAgent() {
        let view = NavigationStack {
            BriefsListContent(
                feed: BriefsFeedState(briefs: []),
                loading: false,
                loadError: nil,
                onOpen: { _ in },
                onQuickClear: { _ in },
                onAsk: { _ in },
                onMoreOptions: { _ in },
                onRetry: {},
                onRefresh: {},
                showsModelWarning: true
            )
            .navigationTitle("Briefs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        }
        snapshot(view, name: "131-briefs-list-empty-needs-background-agent")
    }

    /// Detail sheet while the talk-back thread is opening: spinner in
    /// the talk button's circle.
    func testBriefDetailOpeningThread() {
        let view = BriefDetailSheet(
            brief: PreviewMocks.briefLoop,
            store: AppStore.preview(sources: PreviewMocks.sources),
            openingThread: true
        )
        .environment(AppStore.preview(sources: PreviewMocks.sources))
        snapshot(view, name: "125-brief-detail-opening-thread")
    }

    /// Detail sheet mid-dictation: the mic is the accent-filled pulsing
    /// circle and the live transcript renders under the action row.
    func testBriefDetailDictating() {
        let view = BriefDetailSheet(
            brief: PreviewMocks.briefInfo,
            store: AppStore.preview(sources: PreviewMocks.sources),
            speech: SpeechRecognizer.preview(
                state: .listening,
                transcript: "Push the reminder to Friday and tell Maya I confirmed"
            )
        )
        .environment(AppStore.preview(sources: PreviewMocks.sources))
        snapshot(view, name: "132-brief-detail-dictating")
    }

    /// The stacked detail sheet's content: title, markdown description,
    /// glass action row, divider, long-form body + citations.
    func testBriefDetailSheet() {
        let view = BriefDetailSheet(
            brief: PreviewMocks.briefLoop,
            store: AppStore.preview(sources: PreviewMocks.sources)
        )
        .environment(AppStore.preview(sources: PreviewMocks.sources))
        snapshot(view, name: "114-brief-detail-sheet")
    }

    /// The health-trends brief, opened. Also the still the website's Brain
    /// page shows — `scripts/shot-website-brief.sh` renders this one case and
    /// copies the PNG into `website/media/`, so the site never carries a
    /// hand-drawn mock of a screen the app does not produce.
    func testBriefDetailHealthTrend() {
        let view = BriefDetailSheet(
            brief: PreviewMocks.briefHealthRecovery,
            store: AppStore.preview(sources: PreviewMocks.sources)
        )
        .environment(AppStore.preview(sources: PreviewMocks.sources))
        // A shorter canvas than the default 393x852: this brief's content ends
        // around 640pt, and the website places the render inside a phone beside
        // three paragraphs — a full-length screen towers over them.
        snapshot(view, name: "140-brief-detail-health-trend", size: CGSize(width: 393, height: 760))
    }

    /// A row transformed into the recording strip (swipe-mic dictation):
    /// accent mic circle, live transcript, send affordance.
    func testBriefsListRowDictating() {
        let view = NavigationStack {
            BriefsListContent(
                feed: BriefsFeedState(briefs: PreviewMocks.briefs),
                loading: false,
                loadError: nil,
                onOpen: { _ in },
                onQuickClear: { _ in },
                onAsk: { _ in },
                onDictate: { _ in },
                onMoreOptions: { _ in },
                speech: SpeechRecognizer.preview(
                    state: .listening,
                    transcript: "Push the reminder to Friday and tell Maya I confirmed"
                ),
                dictatingBriefId: PreviewMocks.briefs.first?.id,
                onRetry: {},
                onRefresh: {}
            )
            .navigationTitle("Briefs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        }
        snapshot(view, name: "133-briefs-list-row-dictating")
    }

    func testBriefsListEmpty() {
        let view = NavigationStack {
            BriefsListContent(
                feed: BriefsFeedState(briefs: []),
                loading: false,
                loadError: nil,
                onOpen: { _ in },
                onQuickClear: { _ in },
                onAsk: { _ in },
                onMoreOptions: { _ in },
                onRetry: {},
                onRefresh: {}
            )
            .navigationTitle("Briefs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        }
        snapshot(view, name: "115-briefs-feed-empty")
    }

    func testBriefsListEmptyPageLoading() {
        let view = NavigationStack {
            BriefsListContent(
                feed: BriefsFeedState(briefs: []),
                loading: false,
                loadError: nil,
                onOpen: { _ in },
                onQuickClear: { _ in },
                onAsk: { _ in },
                onMoreOptions: { _ in },
                onRetry: {},
                onRefresh: {},
                paging: CursorPagingState(
                    nextCursor: "preview-next",
                    isLoadingMore: true
                )
            )
            .navigationTitle("Briefs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        }
        snapshot(view, name: "115a-briefs-feed-empty-page-loading")
    }

    func testBriefsListError() {
        let view = NavigationStack {
            BriefsListContent(
                feed: BriefsFeedState(briefs: []),
                loading: false,
                loadError: URLError(.cannotConnectToHost),
                onOpen: { _ in },
                onQuickClear: { _ in },
                onAsk: { _ in },
                onMoreOptions: { _ in },
                onRetry: {},
                onRefresh: {}
            )
            .environment(AppStore.preview())
            .navigationTitle("Briefs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        }
        snapshot(view, name: "116-briefs-feed-error")
    }

    /// The brief card pinned above a talk-back thread's messages —
    /// description-only variant (no long-form body, so no details fold).
    func testBriefContextCardDescriptionOnly() {
        let view = ScrollView {
            BriefContextCard(
                snapshot: BriefOriginSnapshot(
                    title: "Return the borrowed projector",
                    description: "You told **Maya** you'd bring the projector back to Studio Northstar this week.",
                    body: nil
                )
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        snapshot(view, name: "126-brief-context-card-description-only")
    }

    /// Long-form body present but collapsed behind "Show details" — the
    /// default state the thread opens in.
    func testBriefContextCardCollapsedBody() {
        let view = ScrollView {
            BriefContextCard(
                snapshot: BriefOriginSnapshot(
                    title: "Marathon entry closes Friday 17 Oct",
                    description: "The **marathon** early-bird entry closes on Friday — you said you wanted in this year.",
                    body: PreviewMocks.briefLongBody
                )
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        snapshot(view, name: "127-brief-context-card-collapsed")
    }

    /// A long title wrapping across lines, dark mode, with a markdown
    /// body — the extremes of the card's text layout.
    func testBriefContextCardLongTitleDark() {
        let view = ScrollView {
            BriefContextCard(
                snapshot: BriefOriginSnapshot(
                    title: "Confirm the Q4 budget review agenda with Jamie Lopez before Thursday's planning meeting",
                    description: "Jamie asked for the agenda by **Thursday 09:00** and the shared doc still has last quarter's items.",
                    body: "The draft agenda lives in the shared planning doc."
                )
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(\.colorScheme, .dark)
        snapshot(view, name: "128-brief-context-card-long-title-dark")
    }

    /// Interactive-memory action with its outcome row frozen visible.
    func testEphemeralActionCardDone() {
        let view = ScrollView {
            AgentEphemeralActionCard(
                call: PreviewMocks.agentToolCallMemoryReplaceComplete,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
        snapshot(view, name: "129-ephemeral-action-card-done")
    }

    /// Still running: spinner in the header, no outcome row yet.
    func testEphemeralActionCardRunning() {
        let view = ScrollView {
            AgentEphemeralActionCard(
                call: PreviewMocks.agentToolCallLoopSearchRunning,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
        snapshot(view, name: "130-ephemeral-action-card-running")
    }

    /// Failed action: the card rolls the error line in warning color.
    func testEphemeralActionCardError() {
        let view = ScrollView {
            AgentEphemeralActionCard(
                call: PreviewMocks.agentToolCallTimeIndexError,
                freeze: true
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
        snapshot(view, name: "131-ephemeral-action-card-error")
    }

    /// A `search_many` batch call projects one per-child ephemeral card:
    /// two resolved children render their results, one is still running.
    func testAgentBatchSearchManyCards() {
        let view = ScrollView {
            AgentPartView(part: .tool(PreviewMocks.agentToolCallSearchManyRunning), freeze: true)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
        snapshot(view, name: "171-agent-batch-search-many-cards", size: CGSize(width: 393, height: 900))
    }

    /// A settled `search_many` on a non-streaming backend (Anthropic /
    /// DeepSeek-over-http): empty `children`, a `.searchBatch` result with three
    /// items. Proves `AgentBatchToolCards` projects three settled cards off the
    /// result alone, so cards render even though no `agent.tool.child.*` events
    /// ever arrived.
    func testAgentBatchSearchManySettledCards() {
        let view = ScrollView {
            AgentPartView(part: .tool(PreviewMocks.agentToolCallSearchManySettled), freeze: true)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
        snapshot(view, name: "171b-agent-batch-search-many-settled", size: CGSize(width: 393, height: 900))
    }

    /// A pending `search_many` on a non-streaming backend: empty `children`, no
    /// result yet, three queries in `args`. Proves three "searching…" spinner
    /// cards render during the tool call so the turn looks alive.
    func testAgentBatchSearchManyPendingCards() {
        let view = ScrollView {
            AgentPartView(part: .tool(PreviewMocks.agentToolCallSearchManyPending), freeze: true)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
        snapshot(view, name: "171c-agent-batch-search-many-pending", size: CGSize(width: 393, height: 900))
    }

    /// A pending `annotate_many` batch is silent apart from a "Citing N" pill
    /// sized to the batch.
    func testAgentAnnotateManyPill() {
        let view = ScrollView {
            AgentPartView(part: .tool(PreviewMocks.agentToolCallAnnotateManyPending))
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
        snapshot(view, name: "172-agent-annotate-many-pill")
    }

    /// The turn-level working dots, revealed below a finished in-flight text
    /// block — the beat where no per-item card is on screen. `initiallyRevealed`
    /// forces the reveal since the synchronous snapshot render captures before
    /// the debounce `.task` fires.
    func testAgentWorkingIndicator() {
        let view = ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnInFlightText)
                AgentWorkingIndicator(active: true, version: 0, initiallyRevealed: true)
            }
            .padding()
        }
        .background(Theme.bgPrimary)
        snapshot(view, name: "173-agent-working-indicator", size: CGSize(width: 393, height: 300))
    }

    /// LIVE reveal regression (not just eligibility): mounts the indicator
    /// UNSEEDED (`initiallyRevealed` defaults to false) in a real key window and
    /// pumps the run loop past the reveal debounce, so the dots can appear only
    /// if the debounce `.task` actually fired from a hidden start. A seeded
    /// snapshot cannot catch a reveal task that never runs — the historical
    /// no-op, where the task hung off a `Group` whose sole child was
    /// `if revealed { … }` and so was attached to nothing while hidden. If this
    /// captures blank, the reveal machinery is broken again. Invented data only.
    func testAgentWorkingIndicatorLiveReveal() {
        let view = VStack(alignment: .leading, spacing: 10) {
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnInFlightText)
            AgentWorkingIndicator(active: true, version: 0)
            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.bgPrimary)
        renderInWindow(view, name: "173b-agent-working-indicator-live-reveal")
    }

    /// A mid-turn interleaved-thinking (Anthropic-style) beat: the user's
    /// question, a live thinking block, a `search_many` batch card, and — below
    /// them — the turn-level working dots for the gap where the model is
    /// thinking again before the answer with no card to signal it. Regression
    /// net for both fixes landing together: the transcript streams its cards
    /// during the turn (not all at `message.end`), and the working dots appear
    /// when the visible tail carries no self-animating affordance.
    /// `initiallyRevealed` / `freeze` force the async states to render in the
    /// synchronous snapshot pass. Invented data only.
    func testAgentInterleavedThinkingWithWorkingIndicator() {
        let view = ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                AgentTurnBubble(turn: .user(id: "u-0", text: "What did Maya Reeves send about the Q4 budget?"))
                AgentPartView(
                    part: .thinking("Maya's note referenced the Stellar Sound invoice — let me pull both."),
                    thinkingActive: true
                )
                AgentPartView(part: .tool(PreviewMocks.agentToolCallSearchManyRunning), freeze: true)
                AgentWorkingIndicator(active: true, version: 0, initiallyRevealed: true)
            }
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "174-agent-interleaved-working-indicator",
            size: CGSize(width: 393, height: 700)
        )
    }

    /// The below-the-fold half of a card: long-form body ending in
    /// tappable citations (source icon + title each). In the feed this
    /// region only exists past the scroll fold, so it gets its own
    /// direct render.
    func testBriefsDetailsSection() {
        let view = ScrollView {
            BriefDetailsSection(
                brief: PreviewMocks.briefLoop,
                store: AppStore.preview(sources: PreviewMocks.sources),
                onOpenCitation: { _ in }
            )
            .padding(.top, Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary)
        snapshot(view, name: "120-briefs-details-section")
    }

    /// A row whose Loop-Agent-authored description carries markdown:
    /// `**bold**` must render as plain text in the row (markers
    /// stripped), while the detail sheet renders real emphasis — both
    /// covered here via the row list.
    func testBriefsListMarkdownRow() {
        let view = NavigationStack {
            BriefsListContent(
                feed: BriefsFeedState(briefs: [PreviewMocks.briefMarkdown, PreviewMocks.briefReminder]),
                loading: false,
                loadError: nil,
                onOpen: { _ in },
                onQuickClear: { _ in },
                onAsk: { _ in },
                onMoreOptions: { _ in },
                onRetry: {},
                onRefresh: {}
            )
            .navigationTitle("Briefs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        }
        snapshot(view, name: "121-briefs-list-markdown-row")
    }

    /// The below-the-fold body rendered from markdown: the bullet list,
    /// inline emphasis, and the link must render as formatted content
    /// rather than raw `-`/`**`/`[]()` syntax.
    func testBriefsDetailsSectionMarkdown() {
        let view = ScrollView {
            BriefDetailsSection(
                brief: PreviewMocks.briefMarkdown,
                store: AppStore.preview(sources: PreviewMocks.sources),
                onOpenCitation: { _ in }
            )
            .padding(.top, Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary)
        snapshot(view, name: "122-briefs-details-section-markdown")
    }

    /// Loop-kind dismiss modal with the snooze section open: reasons
    /// read "Already handled" (never "Acknowledged") + the four
    /// re-surface choices.
    func testBriefsDismissSheetLoopSnooze() {
        let view = BriefDismissSheet(
            brief: PreviewMocks.briefLoop,
            initialReason: .snoozed
        ) { _, _, _ in }
        snapshot(view, name: "117-briefs-dismiss-loop-snooze")
    }

    /// Info-kind dismiss modal: reasons read "Acknowledged" (never
    /// "Already handled"), nothing selected yet, Dismiss disabled.
    func testBriefsDismissSheetInfo() {
        let view = BriefDismissSheet(brief: PreviewMocks.briefInfo) { _, _, _ in }
        snapshot(view, name: "118-briefs-dismiss-info")
    }

    /// Briefs-active gateway: the Briefs row appears directly under
    /// Search. The other drawer
    /// snapshots (76–79) omit it entirely.
    func testMainMenuDrawerBriefs() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshotBriefsActive,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        let view = ZStack(alignment: .leading) {
            Theme.bgDrawer.ignoresSafeArea()
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
        }
        snapshot(view.environment(store), name: "119-main-menu-drawer-briefs")
    }

    /// Briefs switched on but its background-agent model cannot run: the row
    /// stays, carrying the drawer's amber attention triangle. Queued notes are
    /// installed too, so the drawer's other warning row renders at the same
    /// time — the one state where the two shapes of the shared affordance (a
    /// marker inside the row, and Tell Omnesis's separately-tappable triangle)
    /// can be compared for alignment.
    func testMainMenuDrawerBriefsNeedsAttention() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshotBriefsNeedsAttention,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        store.notes.installPreviewState(pending: PreviewMocks.pendingNotes)
        let view = ZStack(alignment: .leading) {
            Theme.bgDrawer.ignoresSafeArea()
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
        }
        snapshot(view.environment(store), name: "191-main-menu-drawer-briefs-needs-attention")
    }

    // MARK: - Theme + components

    func testThemePalette() {
        let view = VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                OmnesisPill(text: "synced", colors: Theme.pillColor(forState: "synced", paused: false))
                OmnesisPill(text: "syncing", colors: Theme.pillColor(forState: "syncing", paused: false))
                OmnesisPill(text: "error", colors: Theme.pillColor(forState: "error", paused: false))
                OmnesisPill(text: "needs auth", colors: Theme.pillColor(forState: "needs-auth", paused: false))
                OmnesisPill(text: "expiring", colors: Theme.pillColor(forState: "auth-expiring", paused: false))
                OmnesisPill(text: "paused", colors: Theme.pillColor(forState: "synced", paused: true))
            }
            OmnesisCard {
                Text("Card surface")
                    .foregroundStyle(Theme.textPrimary)
            }
            ForEach(["email", "note", "event", "conversation", "bookmark", "task"], id: \.self) { type in
                HStack(spacing: 8) {
                    Theme.docTypeAccent(type).frame(width: 3, height: 18)
                    Text(type)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textPrimary)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
        snapshot(view, name: "60-theme-palette")
    }

    // MARK: - Agent tab

    func testAgentTranscriptRich() {
        var seed = PreviewMocks.agentRichTranscript
        seed.transcriptNextCursor = "preview-next"
        let store = AppStore.preview(agentPreview: seed)
        snapshot(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "70-agent-transcript-rich",
            size: CGSize(width: 393, height: 1600)
        )
    }

    /// An existing pinned chat shows the overflow and the new-chat action
    /// merged into one capsule; both keep independent full-size tap targets.
    func testAgentPinnedConversationActions() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentPinnedTranscript)
        snapshot(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "70e-agent-pinned-conversation-actions",
            size: CGSize(width: 393, height: 852)
        )
    }

    func testAgentContextWindowReached() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentContextWindowExceeded)
        renderInWindow(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "70c-agent-context-window-reached"
        )
        renderInWindow(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "70c-agent-context-window-reached-light",
            scheme: .light
        )
    }

    func testAgentOutputTruncated() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentOutputTruncated)
        renderInWindow(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "70d-agent-output-truncated"
        )
        renderInWindow(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "70d-agent-output-truncated-light",
            scheme: .light
        )
    }

    /// Bottom-fade regression: a transcript long enough to fill the
    /// viewport down through the composer band, rendered at device
    /// height so the floating composer sits at the bottom. The
    /// transcript's alpha mask should leave content fully opaque until
    /// just above the composer, then ramp to ~40% by the bottom edge.
    func testAgentTranscriptBottomFade() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentTallTranscript)
        // Rendered in a live key window so the device's real safe-area
        // insets apply: the fade mask must span the home-indicator strip
        // below the composer (edge-to-edge). An offscreen render reports
        // zero safe area and cannot catch a mask that clips there.
        renderInWindow(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "70b-agent-transcript-bottom-fade"
        )
    }

    /// Live thinking indicator: a turn whose trailing part is a thinking
    /// block (no stopReason). Renders the animated "Thinking" row with
    /// chevron + dots and no leading bar.
    func testAgentThinkingLive() {
        snapshot(
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnThinkingLive)
                .padding(16),
            name: "79-agent-thinking-live",
            size: CGSize(width: 393, height: 160)
        )
    }

    /// Completed turn that reasoned first: the thinking block is no longer
    /// live and has collapsed to nothing, so only the answer text shows.
    func testAgentThinkingDoneCollapses() {
        snapshot(
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnThinkingDone)
                .padding(16),
            name: "80-agent-thinking-done-collapses",
            size: CGSize(width: 393, height: 160)
        )
    }

    func testAgentEmptyConnected() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentEmptyConnected)
        snapshot(AgentView(menuOpen: .constant(false)).environment(store), name: "71-agent-empty-connected")
    }

    /// Exact first-send state while `POST /agent/sessions` is held in flight:
    /// no session identity yet, but the optimistic user bubble and the normal
    /// debounced working dots are already on the transcript. A real window and
    /// run-loop pump let the unseeded dots reveal through their production path.
    func testAgentFirstSendMinting() {
        let store = AppStore.preview(agentPreview: nil)
        store.installAgentPreview(PreviewMocks.agentFirstSendMinting)
        XCTAssertNil(store.agent.sessionId)
        XCTAssertEqual(store.agent.turns.count, 1)
        XCTAssertTrue(store.agent.busy)
        XCTAssertTrue(store.agent.workingIndicatorActive)
        let view = AgentView(menuOpen: .constant(false)).environment(store)
        renderInWindow(view, name: "71b-agent-first-send-minting")
        renderInWindow(
            view,
            name: "71b-agent-first-send-minting-light",
            scheme: .light
        )
        XCTAssertTrue(store.agent.busy)
        XCTAssertEqual(store.agent.turns.count, 1)
    }

    func testAgentBusyStreaming() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentBusyStreaming)
        snapshot(AgentView(menuOpen: .constant(false)).environment(store), name: "72-agent-busy-streaming")
    }

    /// `.alert` is presented by UIKit outside an offscreen SwiftUI view tree,
    /// so this state must use the real-window renderer and a pumped run loop.
    /// That is the strongest deterministic snapshot available for system
    /// alert chrome; ordinary `snapshot(...)` captures only the host view.
    func testAgentCancelFailureAlert() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentBusyStreaming)
        store.agent.installPreviewCancelError(URLError(.cannotConnectToHost))
        renderInWindow(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "72b-agent-cancel-failure-alert",
            capturePresentedChrome: true
        )
    }

    func testAgentTranscriptLoadingSkeleton() {
        let store = AppStore.preview(agentPreview: .init())
        store.agent.installPreviewTranscriptLoading(title: "Trip planning")
        snapshot(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "74-agent-transcript-loading"
        )
    }

    func testAgentFatalError() {
        let store = AppStore.preview(agentPreview: .init())
        store.agent.installPreviewFatal(error: GatewayClient.Error.serverError(
            status: 503,
            body: "Anthropic API key not configured. Set it from the portal's Settings → Models tab."
        ))
        snapshot(AgentView(menuOpen: .constant(false)).environment(store), name: "73-agent-fatal-error")
    }

    func testAgentFatalGatewayUnreachable() {
        let store = AppStore.preview(agentPreview: .init())
        store.agent.installPreviewFatal(error: URLError(.cannotConnectToHost))
        snapshot(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "73b-agent-fatal-gateway-unreachable"
        )
    }

    // MARK: - Agent tab — iPad-landscape split (sidePanel mode)

    /// A rich transcript seed carrying voucher-journey annotations so both
    /// halves of the iPad split have content: the conversation on the
    /// left, the docked Timeline on the right.
    private func iPadSplitSeed() -> AppStore.AgentPreviewSeed {
        var seed = PreviewMocks.agentRichTranscript
        seed.trailAnnotations = PreviewMocks.trailVoucherAnnotations
        return seed
    }

    /// iPad landscape with the Timeline open — the conversation shrinks
    /// to the leading ~⅔ and the docked Timeline column fills the
    /// trailing ~⅓, both legible at once. The headline new layout.
    func testAgentIPadLandscapeSplitOpen() {
        AgentLayout.idiomOverride = true
        defer { AgentLayout.idiomOverride = nil }
        let store = AppStore.preview(agentPreview: iPadSplitSeed())
        let view = AgentView(
            menuOpen: .constant(false),
            previewLayoutMode: .sidePanel,
            previewCitationsOpen: true,
            previewWidth: 1366
        ).environment(store)
        snapshot(view, name: "76-agent-ipad-landscape-split-open", size: CGSize(width: 1366, height: 1024))
    }

    /// iPad landscape with the Timeline closed — the conversation spans
    /// the full width, no sticky-tab gutter (those belong to overlay
    /// mode). Confirms the split collapses cleanly to a plain chat.
    func testAgentIPadLandscapeSplitClosed() {
        AgentLayout.idiomOverride = true
        defer { AgentLayout.idiomOverride = nil }
        let store = AppStore.preview(agentPreview: iPadSplitSeed())
        let view = AgentView(
            menuOpen: .constant(false),
            previewLayoutMode: .sidePanel,
            previewCitationsOpen: false,
            previewWidth: 1366
        ).environment(store)
        snapshot(view, name: "77-agent-ipad-landscape-split-closed", size: CGSize(width: 1366, height: 1024))
    }

    /// iPad portrait keeps the iPhone overlay: opening the Timeline
    /// slides a near-full-width drawer over the conversation. Verifies
    /// iPad-portrait == iPhone behaviour.
    func testAgentIPadPortraitOverlay() {
        AgentLayout.idiomOverride = true
        defer { AgentLayout.idiomOverride = nil }
        let store = AppStore.preview(agentPreview: iPadSplitSeed())
        let view = AgentView(
            menuOpen: .constant(false),
            previewLayoutMode: .overlay,
            previewCitationsOpen: true,
            previewWidth: 1024
        ).environment(store)
        snapshot(view, name: "78-agent-ipad-portrait-overlay", size: CGSize(width: 1024, height: 1366))
    }

    /// The docked Timeline rendered at its clamped column width in
    /// isolation — scrutinises row legibility, header, and the leading
    /// edge highlight at ~⅓-iPad width.
    func testCitationsDrawerDockedColumn() {
        let store = AppStore.preview(agentPreview: iPadSplitSeed())
        let view = HStack(spacing: 0) {
            Theme.bgPrimary
            CitationsDrawer(
                trailAnnotations: store.agent.trailAnnotations,
                isOpen: .constant(true),
                presentation: .docked
            )
            .frame(width: 460)
        }
        .environment(store)
        snapshot(view, name: "79-citations-drawer-docked-column", size: CGSize(width: 1024, height: 1024))
    }

    // MARK: - Shared gateway-error view

    func testGatewayErrorUnreachable() {
        snapshot(
            GatewayErrorView(
                context: "load watches",
                error: URLError(.cannotConnectToHost),
                onRetry: {}
            )
            .environment(AppStore.preview()),
            name: "80-gateway-error-unreachable"
        )
    }

    func testGatewayErrorCertificate() {
        snapshot(
            GatewayErrorView(
                context: "load people",
                error: URLError(.serverCertificateUntrusted),
                onRetry: {}
            )
            .environment(AppStore.preview()),
            name: "80b-gateway-error-certificate"
        )
    }

    func testGatewayErrorUnauthorized() {
        snapshot(
            GatewayErrorView(
                context: "load watches",
                error: GatewayClient.Error.unauthorized,
                onRetry: {}
            )
            .environment(AppStore.preview()),
            name: "81-gateway-error-unauthorized"
        )
    }

    func testGatewayErrorServerBody() {
        // The body is the gateway's error envelope, exactly as the transport
        // throws it: what the user reads has to be the message inside, never
        // the JSON around it.
        snapshot(
            GatewayErrorView(
                context: "load watches",
                error: GatewayClient.Error.serverError(
                    status: 500,
                    body: #"{"error":"Indexer is rebuilding the embeddings table; try again shortly.","code":"SERVICE_UNAVAILABLE"}"#
                ),
                onRetry: {}
            )
            .environment(AppStore.preview()),
            name: "82-gateway-error-server-body"
        )
    }

    func testGatewayErrorNoModelAssigned() {
        // First-run "no agent model assigned yet" state: friendly sparkles
        // framing (no warning triangle) and a "Set up agent model" jump
        // into Models — the env handler stands in for HomeView's wiring.
        snapshot(
            GatewayErrorView(
                context: "start the agent",
                error: GatewayClient.Error.serverError(
                    status: 503,
                    body: "Agent disabled. Set inference.assignments.agent in omnesis.json to enable it."
                ),
                onRetry: {}
            )
            .environment(AppStore.preview())
            .environment(\.openModelSettings) {},
            name: "83-gateway-error-no-model-assigned"
        )
    }

    func testAgentConversationsPopulated() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich)
        let view = NavigationStack { AgentConversationsListView() }
        snapshot(view.environment(store), name: "74-agent-conversations-populated")
    }

    func testAgentConversationsEmpty() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack { AgentConversationsListView() }
        snapshot(view.environment(store), name: "75-agent-conversations-empty")
    }

    func testAgentConversationsInitialError() {
        let store = AppStore.preview(agentPreview: .init())
        store.agent.installPreviewState(
            sessionId: "preview-session",
            model: "preview-model",
            backend: "preview-backend",
            title: "Preview",
            turns: [],
            citations: [],
            conversations: [],
            conversationsError: URLError(.timedOut)
        )
        let view = NavigationStack { AgentConversationsListView() }
        snapshot(view.environment(store), name: "75a-agent-conversations-error")
    }

    func testMainMenuDrawerAgentSelected() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich)
        let view = ZStack(alignment: .leading) {
            Theme.bgDrawer.ignoresSafeArea()
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
        }
        snapshot(view.environment(store), name: "76-main-menu-drawer-agent")
    }

    func testMainMenuDrawerSourcesSelected() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich)
        let view = ZStack(alignment: .leading) {
            Theme.bgDrawer.ignoresSafeArea()
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.sources),
                onOpenSettings: {}
            )
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
        }
        snapshot(view.environment(store), name: "77-main-menu-drawer-sources")
    }

    func testMainMenuDrawerEmptyConversations() {
        let store = AppStore.preview(agentPreview: .init())
        let view = ZStack(alignment: .leading) {
            Theme.bgDrawer.ignoresSafeArea()
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
        }
        snapshot(view.environment(store), name: "78-main-menu-drawer-empty")
    }

    /// Experimental gateway: the gated rows appear in the continuous menu.
    /// The non-experimental drawers above (76–78) omit them entirely.
    func testMainMenuDrawerExperimental() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshotExperimental,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        let view = ZStack(alignment: .leading) {
            Theme.bgDrawer.ignoresSafeArea()
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
        }
        snapshot(view.environment(store), name: "79-main-menu-drawer-experimental")
    }

    // MARK: - Menu reveal

    /// The whole composition, fully open: the menu underneath, the Agent
    /// surface moved aside with its corners rounded and its strip still
    /// standing on the trailing edge. This is the frame that proves the
    /// layering — the drawer-only snapshots above (76–79) cannot.
    func testMenuRevealOpen() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich)
        let view = MenuRevealContainer(isOpen: .constant(true)) {
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
        } content: {
            AgentView(menuOpen: .constant(true))
        }
        snapshot(view.environment(store), name: "80-menu-reveal-open")
    }

    /// Frozen part-way through the travel. A released drag settles to one end
    /// or the other, so this state exists only under the finger — and it is
    /// where the scrim ramp and the corner radius are most likely to look
    /// wrong.
    func testMenuRevealMidDrag() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich)
        let view = MenuRevealContainer(isOpen: .constant(false), progressOverride: 0.45) {
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
        } content: {
            AgentView(menuOpen: .constant(false))
        }
        snapshot(view.environment(store), name: "81-menu-reveal-mid-drag")
    }

    /// Closed. The app must fill the screen with no rounded corners, no wash,
    /// and no sign that anything sits behind it.
    func testMenuRevealClosed() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich)
        let view = MenuRevealContainer(isOpen: .constant(false)) {
            MainMenuDrawer(
                isOpen: .constant(false),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
        } content: {
            AgentView(menuOpen: .constant(false))
        }
        snapshot(view.environment(store), name: "82-menu-reveal-closed")
    }

    /// Open over a different section, with the experimental rows present —
    /// the most navigation rows the menu ever carries.
    func testMenuRevealOpenOverBriefs() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshotExperimental,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        let view = MenuRevealContainer(isOpen: .constant(true)) {
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.briefs),
                onOpenSettings: {}
            )
        } content: {
            BriefsView(menuOpen: .constant(true))
        }
        snapshot(
            view.environment(store).environment(store.notificationRouter),
            name: "83-menu-reveal-briefs"
        )
    }

    /// A history long enough to overflow the menu, so the action bar actually
    /// has content passing behind it: this is what proves the fade reads and
    /// that the bar's inset keeps the last row reachable rather than stranding
    /// it underneath. The shorter fixture never scrolls at menu width.
    func testMenuRevealOverflowingHistory() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshotExperimental,
            agentPreview: PreviewMocks.agentConversationsOverflowing
        )
        let view = MenuRevealContainer(isOpen: .constant(true)) {
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
        } content: {
            AgentView(menuOpen: .constant(true))
        }
        snapshot(view.environment(store), name: "84-menu-reveal-overflowing")
    }

    /// The same overflowing history scrolled to its end — where the last
    /// conversation meets the action bar. Nothing else in the suite reaches
    /// the bottom of a scroll view.
    func testMenuRevealOverflowingHistoryScrolledToEnd() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshotExperimental,
            agentPreview: PreviewMocks.agentConversationsOverflowing
        )
        let view = MenuRevealContainer(isOpen: .constant(true)) {
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
            .defaultScrollAnchor(.bottom)
        } content: {
            AgentView(menuOpen: .constant(true))
        }
        snapshot(view.environment(store), name: "85-menu-reveal-overflowing-end")
    }

    /// iPad landscape. The menu is ~1066pt wide there, which throws the Ask
    /// capsule and the Settings button to opposite ends of the action bar —
    /// a layout no phone-width render can show.
    func testMenuRevealOpenIPadLandscape() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich)
        let view = MenuRevealContainer(isOpen: .constant(true)) {
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
        } content: {
            AgentView(menuOpen: .constant(true))
        }
        snapshot(
            view.environment(store),
            name: "86-menu-reveal-ipad-landscape",
            size: CGSize(width: 1366, height: 1024)
        )
    }

    /// The attention banner rides with the app rather than hanging over the
    /// menu, so it has to be checked in the revealed state — the existing
    /// banner snapshot only covers the menu closed.
    func testMenuRevealOpenWithAttentionBanner() {
        let store = AppStore.preview(
            sourcePermissionHealth: PreviewMocks.sourcePermissionHealth,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        let view = MenuRevealContainer(isOpen: .constant(true)) {
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
        } content: {
            AgentView(menuOpen: .constant(true))
                .safeAreaInset(edge: .top, spacing: 0) {
                    AppAttentionBanner(
                        problems: store.degradedSourcePermissions,
                        notificationWarning: nil,
                        onOpenPermissions: {},
                        onOpenNotificationSettings: {}
                    )
                }
        }
        snapshot(view.environment(store), name: "87-menu-reveal-attention-banner")
    }

    func testAgentEphemeralSearchSlotMid() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralSearchCard(
                    call: PreviewMocks.agentToolCallSearchComplete,
                    initialIndex: 1,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "76-agent-ephemeral-search-slot")
    }

    func testAgentEphemeralSearchPending() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralSearchCard(
                    call: PreviewMocks.agentToolCallSearchPending,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "76b-agent-ephemeral-search-pending")
    }

    func testAgentEphemeralSqlRowSlot() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralSqlCard(
                    call: PreviewMocks.agentToolCallSqlComplete,
                    initialSqlIndex: 11,
                    initialRowIndex: 0,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "77-agent-ephemeral-sql-row-slot")
    }

    /// Regression: an eight-column result must clip to the available
    /// width inside the table's horizontal scroll instead of stretching
    /// the whole transcript wider than the viewport.
    func testAgentEphemeralSqlWideTable() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralSqlCard(
                    call: PreviewMocks.agentToolCallSqlWide,
                    initialSqlIndex: 11,
                    initialRowIndex: 0,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "77c-agent-ephemeral-sql-wide-table")
    }

    func testAgentEphemeralSqlQueryOnly() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralSqlCard(
                    call: PreviewMocks.agentToolCallSqlQueryOnly,
                    initialSqlIndex: 5,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "77b-agent-ephemeral-sql-query-only")
    }

    func testAgentEphemeralDocumentSlot() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralDocumentCard(
                    call: PreviewMocks.agentToolCallDocumentComplete,
                    initialIndex: 3,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78-agent-ephemeral-document-slot")
    }

    func testAgentEphemeralPeopleSlot() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralPeopleCard(
                    call: PreviewMocks.agentToolCallPeopleComplete,
                    initialIndex: 1,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78b-agent-ephemeral-people-slot")
    }

    func testAgentEphemeralPeoplePending() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralPeopleCard(
                    call: PreviewMocks.agentToolCallPeoplePending,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78c-agent-ephemeral-people-pending")
    }

    func testAgentEphemeralPeopleEmpty() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralPeopleCard(
                    call: PreviewMocks.agentToolCallPeopleEmpty,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78d-agent-ephemeral-people-empty")
    }

    func testAgentEphemeralUrlLookupHit() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralUrlLookupCard(
                    call: PreviewMocks.agentToolCallUrlLookupHit,
                    initialIndex: 0,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78e-agent-ephemeral-url-lookup-hit")
    }

    func testAgentEphemeralUrlLookupMiss() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralUrlLookupCard(
                    call: PreviewMocks.agentToolCallUrlLookupMiss,
                    initialIndex: 0,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78f-agent-ephemeral-url-lookup-miss")
    }

    func testAgentEphemeralUrlLookupPending() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralUrlLookupCard(
                    call: PreviewMocks.agentToolCallUrlLookupPending,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78g-agent-ephemeral-url-lookup-pending")
    }

    // MARK: - Agent tab — loop cards (search_loops / fetch_loop)

    /// Search result row carrying the inline "in N loop(s)" chip — the
    /// frozen slot sits on the doc referenced by two tracked loops.
    func testAgentEphemeralSearchDocRowLoopChips() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralSearchCard(
                    call: PreviewMocks.agentToolCallSearchWithLoops,
                    initialIndex: 0,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78h-agent-ephemeral-search-loop-chips")
    }

    func testAgentEphemeralDocumentLoopChip() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralDocumentCard(
                    call: PreviewMocks.agentToolCallDocumentWithLoops,
                    initialIndex: 0,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78i-agent-ephemeral-document-loop-chip")
    }

    func testAgentEphemeralLoopSearchSlot() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralLoopSearchCard(
                    call: PreviewMocks.agentToolCallLoopSearch,
                    initialIndex: 0,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78j-agent-ephemeral-loop-search-slot")
    }

    func testAgentEphemeralLoopSearchEmpty() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralLoopSearchCard(
                    call: PreviewMocks.agentToolCallLoopSearchEmpty,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78k-agent-ephemeral-loop-search-empty")
    }

    func testAgentEphemeralLoopFetchPopulated() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralLoopFetchCard(
                    call: PreviewMocks.agentToolCallLoopFetch,
                    initialIndex: 0,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78l-agent-ephemeral-loop-fetch-populated")
    }

    func testAgentEphemeralLoopFetchNoMatch() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentEphemeralLoopFetchCard(
                    call: PreviewMocks.agentToolCallLoopFetchEmpty,
                    freeze: true
                )
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "78m-agent-ephemeral-loop-fetch-no-match")
    }

    // MARK: - Agent tab — sub-agent card (#748)

    /// Compact researcher cards cover live, completed, and grounded-partial states.
    func testAgentSubAgentCardStates() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    AgentSubAgentCard(card: PreviewMocks.agentSubagentCardRunning)
                    AgentSubAgentCard(card: PreviewMocks.agentSubagentCardComplete)
                    AgentSubAgentCard(card: PreviewMocks.agentSubagentCardPartial)
                    AgentSubAgentCard(card: PreviewMocks.agentSubagentCardProviderFailure)
                }
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "82-agent-subagent-card-collapsed", size: CGSize(width: 393, height: 520))
    }

    /// Many distinct source counts wrap below the header without squeezing its
    /// title, live status, or token count on a narrow phone-sized canvas.
    func testAgentSubAgentCardManySourcesWraps() {
        let sourceTypes = Set(PreviewMocks.agentSubagentCardManySources.docs.map { sourceTypeFromId($0.sourceId) })
        let iconByType = Dictionary(uniqueKeysWithValues: sourceTypes.map {
            ($0, PreviewMocks.agentSourceLayoutIcon)
        })
        let store = AppStore.preview(sourceIconByType: iconByType, agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentSubAgentCard(card: PreviewMocks.agentSubagentCardManySources)
                    .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "82e-agent-subagent-card-many-sources", size: CGSize(width: 320, height: 320))
    }

    /// Count badges remain legible and continue wrapping at an accessibility
    /// Dynamic Type size without displacing the stable header controls.
    func testAgentSubAgentCardManySourcesAccessibilitySize() {
        let sourceTypes = Set(PreviewMocks.agentSubagentCardManySources.docs.map { sourceTypeFromId($0.sourceId) })
        let iconByType = Dictionary(uniqueKeysWithValues: sourceTypes.map {
            ($0, PreviewMocks.agentSourceLayoutIcon)
        })
        let store = AppStore.preview(sourceIconByType: iconByType, agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentSubAgentCard(card: PreviewMocks.agentSubagentCardManySources)
                    .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        .environment(\.dynamicTypeSize, .accessibility3)
        snapshot(view, name: "82f-agent-subagent-card-many-sources-accessibility", size: CGSize(width: 320, height: 640))
    }

    /// The bespoke research working-set surface mid-run (#748): three
    /// researchers side by side in a horizontal rail, each accumulating its
    /// own source-tinted document chips, two still searching and one done.
    /// Verifies the panels read distinctly (not the citation drawer) and the
    /// chips are source-tinted via the registry.
    func testAgentResearchWorkspaceLive() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            VStack {
                Spacer()
                ResearchWorkspaceView(panels: PreviewMocks.researchPanelsLive)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "83-agent-research-workspace-live", size: CGSize(width: 393, height: 420))
    }

    /// The working-set surface as the run finishes (#748): every researcher has
    /// a terminal status + a distilled summary, the frame just before the
    /// surface collapses into the written-back report.
    func testAgentResearchWorkspaceFinishing() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            VStack {
                Spacer()
                ResearchWorkspaceView(panels: PreviewMocks.researchPanelsFinishing)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "83b-agent-research-workspace-finishing", size: CGSize(width: 393, height: 380))
    }

    /// The working-set surface when one researcher has accumulated MANY docs
    /// (#890): the per-panel doc list must scroll WITHIN the panel and the band
    /// must stay a fixed bottom rail — never grow into a full-screen overlay
    /// that buries the conversation. The surrounding frame is full phone height
    /// so a regression (an unbounded panel) would visibly eat the screen.
    func testAgentResearchWorkspaceManyDocs() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            VStack {
                Spacer()
                ResearchWorkspaceView(panels: PreviewMocks.researchPanelsManyDocs)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "83c-agent-research-workspace-many-docs", size: CGSize(width: 393, height: 760))
    }

    func testAgentToolResultProvenance() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentToolResultView(result: PreviewMocks.agentToolEventTrail)
                    .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "79-agent-tool-event-trail")
    }

    func testAgentToolResultError() {
        let view = NavigationStack {
            ScrollView {
                AgentToolResultView(result: .error(
                    code: "sql_failed",
                    message: "Parser Error: syntax error at or near \"FORM\""
                ))
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        snapshot(view, name: "81-agent-tool-error")
    }

    /// Forward-compat inline notice — the demo build renders this in
    /// place of a tool result whose `kind` postdates this binary.
    /// Production collapses the same case to EmptyView; the snapshot
    /// pins the demo styling so we can spot regressions.
    func testAgentToolResultUnknownPartNotice() {
        let view = NavigationStack {
            ScrollView {
                AgentUnknownPartNotice(label: "tool result", kind: "trigger.upserted")
                    .padding()
            }
            .background(Theme.bgPrimary)
        }
        snapshot(view, name: "81c-agent-tool-unknown-notice")
    }

    /// Multi-line DuckDB binder error — pins the vertical-layout +
    /// `fixedSize(horizontal:false, vertical:true)` fix that prevents
    /// the parent HStack from blowing up its width to fit the message
    /// on a single line.
    func testAgentToolResultErrorMultiLine() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentToolResultView(result: .error(
                    code: "sql_failed",
                    message: """
                    Binder Error: Referenced column "metric_slug" not found in FROM clause!
                    LINE 9:   AND metric_slug = 'heart_rate'
                                  ^
                    Candidate bindings: "metric", "slug", "metric_id"
                    """
                ))
                .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "81b-agent-tool-error-multiline")
    }

    /// Provenance trail with all three steps carrying a documentId —
    /// each row should render with a trailing chevron and route through
    /// `DocumentLink` (Task 26).
    func testAgentProvenanceTappable() {
        let store = AppStore.preview(agentPreview: .init())
        let view = NavigationStack {
            ScrollView {
                AgentToolResultView(result: PreviewMocks.agentToolEventTrail)
                    .padding()
            }
            .background(Theme.bgPrimary)
        }
        .environment(store)
        snapshot(view, name: "79b-agent-event-trail-fallback")
    }

    func testAgentBubbleAssistantTable() {
        let store = AppStore.preview(agentPreview: .init())
        let view = ScrollView {
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnWithTable)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "82-agent-bubble-table")
    }

    func testAgentBubbleAssistantRunning() {
        let store = AppStore.preview(agentPreview: .init())
        let view = ScrollView {
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnRunning)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "83-agent-bubble-running")
    }

    /// Mid-cite snapshot: a streaming assistant turn paused on a cite
    /// tool_use whose args (the verbatim quote) are still streaming.
    /// The inline "citing…" pill at the cite slot tells the user the
    /// pause is intentional. Pins the muted styling of the pill so a
    /// future change to the cite render path doesn't accidentally let
    /// it grow into a louder card.
    func testAgentBubbleMidCitation() {
        let store = AppStore.preview(agentPreview: .init())
        let view = ScrollView {
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnMidCite)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "83b-agent-bubble-mid-cite")
    }

    /// A turn the model provider rejected. The humanized sentence stays the
    /// loud line; the code + provider disposition sit beneath it in a quiet
    /// monospaced line an operator can act on.
    func testAgentBubbleProviderFailure() {
        let store = AppStore.preview(agentPreview: .init())
        let view = ScrollView {
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnProviderFailure)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "83c-agent-bubble-provider-failure")
    }

    /// The same surface with no provider envelope — the code stands alone, and
    /// the block must not render an empty second line.
    func testAgentBubbleFailureCodeOnly() {
        let store = AppStore.preview(agentPreview: .init())
        let view = ScrollView {
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnFailureCodeOnly)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "83d-agent-bubble-failure-code-only")
    }

    /// A reply the user stopped, reopened: the partial answer stays and the
    /// stop shows as one quiet italic line — no warning icon, no danger chip.
    func testAgentBubbleReopenedStopped() {
        let store = AppStore.preview(agentPreview: .init())
        let view = ScrollView {
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnReopenedStopped)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "83f-agent-bubble-reopened-stopped")
    }

    /// The failure block at an accessibility Dynamic Type size: the detail
    /// line must wrap rather than clip the code off the right edge.
    func testAgentBubbleProviderFailureAccessibilitySize() {
        let store = AppStore.preview(agentPreview: .init())
        let view = ScrollView {
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnProviderFailure)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        .environment(\.dynamicTypeSize, .accessibility3)
        snapshot(
            view,
            name: "83e-agent-bubble-provider-failure-accessibility",
            size: CGSize(width: 320, height: 700)
        )
    }

    func testAgentBubbleUser() {
        let view = ScrollView {
            AgentTurnBubble(turn: .user(
                id: "u-0",
                text: "How has my heart rate been compared to last month?"
            ))
            .padding()
        }
        .background(Theme.bgPrimary)
        snapshot(view, name: "84-agent-bubble-user")
    }

    // MARK: - Watch action cards

    func testAgentWatchCardCreated() {
        let store = AppStore.preview(agentPreview: .init())
        let call = AgentToolCall(
            toolCallId: "tu_trg_created",
            tool: "watch_create",
            args: JSONAny(value: NSNull()),
            argsSummary: "create Email digest",
            argsKnown: true,
            result: .watchUpserted(
                watchId: "wat_email_digest",
                name: "Email digest",
                action: "created",
                enabled: true,
                summary: "Notify when a new invoice email arrives in Gmail"
            ),
            durationMs: 120
        )
        let view = ScrollView {
            AgentWatchCard(call: call)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        .environment(NotificationRouter())
        snapshot(view, name: "88-agent-watch-card-created")
    }

    func testAgentWatchCardUpdated() {
        let store = AppStore.preview(agentPreview: .init())
        let call = AgentToolCall(
            toolCallId: "tu_trg_updated",
            tool: "watch_create",
            args: JSONAny(value: NSNull()),
            argsSummary: "update Daily summary",
            argsKnown: true,
            result: .watchUpserted(
                watchId: "wat_daily_summary",
                name: "Daily summary",
                action: "updated",
                enabled: true,
                summary: nil
            ),
            durationMs: 90
        )
        let view = ScrollView {
            AgentWatchCard(call: call)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        .environment(NotificationRouter())
        snapshot(view, name: "89-agent-watch-card-updated")
    }

    func testAgentWatchCardToggledOff() {
        let store = AppStore.preview(agentPreview: .init())
        let call = AgentToolCall(
            toolCallId: "tu_trg_off",
            tool: "trigger_toggle",
            args: JSONAny(value: NSNull()),
            argsSummary: "disable Workout reminder",
            argsKnown: true,
            result: .triggerToggled(
                triggerId: "trg_workout",
                name: "Workout reminder",
                enabled: false
            ),
            durationMs: 40
        )
        let view = ScrollView {
            AgentWatchCard(call: call)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        .environment(NotificationRouter())
        snapshot(view, name: "90-agent-watch-card-toggled-off")
    }

    func testAgentWatchCardPending() {
        let store = AppStore.preview(agentPreview: .init())
        let call = AgentToolCall(
            toolCallId: "tu_trg_pending",
            tool: "watch_create",
            args: JSONAny(value: NSNull()),
            argsSummary: "create",
            argsKnown: true,
            result: nil,
            durationMs: nil
        )
        let view = ScrollView {
            AgentWatchCard(call: call)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        .environment(NotificationRouter())
        snapshot(view, name: "91-agent-watch-card-pending")
    }

    func testAgentWatchCardError() {
        let store = AppStore.preview(agentPreview: .init())
        let call = AgentToolCall(
            toolCallId: "tu_trg_err",
            tool: "watch_create",
            args: JSONAny(value: NSNull()),
            argsSummary: "create",
            argsKnown: true,
            result: .error(
                code: "non_ios_actions",
                message: "every action in a trigger the agent manages must be `notify-ios`; got exec"
            ),
            durationMs: 8
        )
        let view = ScrollView {
            AgentWatchCard(call: call)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        .environment(NotificationRouter())
        snapshot(view, name: "92-agent-watch-card-error")
    }

    func testCitationsDrawerOpenEmpty() {
        let store = AppStore.preview(agentPreview: .init())
        let view = ZStack {
            Theme.bgPrimary.ignoresSafeArea()
            Text("Conversation behind the drawer…")
                .foregroundStyle(Theme.textMuted)
            CitationsDrawer(isOpen: .constant(true))
        }
        .environment(store)
        snapshot(view, name: "89-citations-drawer-open-empty")
    }

    // MARK: - Citations drawer — unified Timeline

    private func voucherTrailSeed() -> AppStore.AgentPreviewSeed {
        AppStore.AgentPreviewSeed(
            trailAnnotations: PreviewMocks.trailVoucherAnnotations
        )
    }

    /// Drawer open on the unified Timeline. Voucher-journey fixture
    /// exercises every annotation shape (event-level note + doc quote
    /// + doc note + doc note-only) across Gmail and WhatsApp spine
    /// colours.
    func testCitationsDrawerTimelineVoucherJourney() {
        let store = AppStore.preview(agentPreview: voucherTrailSeed())
        let view = ZStack {
            Theme.bgPrimary.ignoresSafeArea()
            CitationsDrawer(
                trailAnnotations: store.agent.trailAnnotations,
                isOpen: .constant(true)
            )
        }
        .environment(store)
        snapshot(view, name: "100-citations-drawer-timeline-voucher")
    }

    /// Trail with zero events + no annotations — exercises the
    /// "The agent has not referenced any document yet." empty state.
    func testCitationsDrawerTimelineEmpty() {
        let store = AppStore.preview(agentPreview: .init())
        let view = ZStack {
            Theme.bgPrimary.ignoresSafeArea()
            CitationsDrawer(
                trailAnnotations: .empty,
                isOpen: .constant(true)
            )
        }
        .environment(store)
        snapshot(view, name: "101-citations-drawer-timeline-empty")
    }

    /// Drawer CLOSED on the Timeline — exercises the per-event
    /// sticky-tab strip peeking out from behind the panel border.
    func testCitationsDrawerTimelineClosed() {
        let store = AppStore.preview(agentPreview: voucherTrailSeed())
        let view = ZStack {
            Theme.bgPrimary.ignoresSafeArea()
            Text("Conversation behind the drawer…")
                .foregroundStyle(Theme.textMuted)
            CitationsDrawer(
                trailAnnotations: store.agent.trailAnnotations,
                isOpen: .constant(false)
            )
        }
        .environment(store)
        snapshot(view, name: "103-citations-drawer-timeline-closed-tabs")
    }

    /// Sticky source tabs rendered directly so the fill surface is
    /// visible (the frame-reporting that places them on the closed
    /// drawer doesn't run in a static snapshot). Confirms the tab takes
    /// a light surface in light mode rather than a dark brand chip.
    func testStickyTabsSurface() {
        let store = AppStore.preview(agentPreview: voucherTrailSeed())
        let events = Array(PreviewMocks.trailVoucherJourney.prefix(4))
        let view = ZStack {
            Theme.bgPrimary.ignoresSafeArea()
            HStack(spacing: 12) {
                ForEach(Array(events.enumerated()), id: \.0) { _, ev in
                    TimelineEventStickyTab(event: ev, onTap: {})
                }
            }
        }
        .environment(store)
        snapshot(view, name: "108-sticky-tabs", size: CGSize(width: 240, height: 80))
    }

    /// Long Timeline with mixed sources — exercises long-list rendering +
    /// multi-source spine accent changes over many annotated documents.
    func testCitationsDrawerTimelineLong() {
        let seed = AppStore.AgentPreviewSeed(
            trailAnnotations: PreviewMocks.trailLongMultiAuthorAnnotations
        )
        let store = AppStore.preview(agentPreview: seed)
        let view = ZStack {
            Theme.bgPrimary.ignoresSafeArea()
            CitationsDrawer(
                trailAnnotations: store.agent.trailAnnotations,
                isOpen: .constant(true)
            )
        }
        .environment(store)
        snapshot(view, name: "102-citations-drawer-timeline-long")
    }

    // MARK: - TrailTimelineView (renderer in isolation)

    func testTrailTimelineViewVoucherJourney() {
        let store = AppStore.preview()
        let view = ScrollView {
            TrailTimelineView(
                events: PreviewMocks.trailVoucherJourney,
                annotations: PreviewMocks.trailVoucherAnnotations
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "103-trail-timeline-voucher-journey")
    }

    func testTrailTimelineViewSingleEventWithAttachment() {
        let store = AppStore.preview()
        let view = ScrollView {
            TrailTimelineView(
                events: [PreviewMocks.trailVoucherJourney[0]],
                annotations: PreviewMocks.trailVoucherAnnotations
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "104-trail-timeline-single-event")
    }

    func testTrailTimelineViewLongTrail() {
        let store = AppStore.preview()
        let view = ScrollView {
            TrailTimelineView(
                events: PreviewMocks.trailLong,
                annotations: .empty
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "105-trail-timeline-long")
    }

    func testTrailTimelineViewUrlRepresentations() {
        let store = AppStore.preview()
        let view = ScrollView {
            TrailTimelineView(
                events: PreviewMocks.trailUrlRepresentations,
                annotations: .empty
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(
            view,
            name: "105b-trail-timeline-url-representations",
            size: CGSize(width: 320, height: 640)
        )
    }

    func testTrailTimelineViewMultiAuthor() {
        let store = AppStore.preview()
        let view = ScrollView {
            TrailTimelineView(
                events: PreviewMocks.trailLong,
                annotations: PreviewMocks.trailLongMultiAuthorAnnotations
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "107-trail-timeline-multi-author")
    }

    func testTrailTimelineViewEmpty() {
        let store = AppStore.preview()
        let view = TrailTimelineView(events: [], annotations: .empty)
            .padding()
            .background(Theme.bgPrimary)
            .environment(store)
        snapshot(view, name: "106-trail-timeline-empty", size: CGSize(width: 393, height: 280))
    }

    // MARK: - Record citations (#757)

    /// A record-only citation: a cited DuckDB row binding no document.
    /// Renders the database glyph, derived title, table label, and key
    /// columns with NO tap target (no bound doc → no dead link).
    func testTrailTimelineRecordOnly() {
        let store = AppStore.preview()
        let view = ScrollView {
            TrailTimelineView(events: PreviewMocks.trailRecordOnly, annotations: .empty)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "109-trail-timeline-record-only", size: CGSize(width: 393, height: 320))
    }

    /// A deduped doc+record entity: one row headed by the document card
    /// with the record's declared key fields inline below it (the title
    /// is the doc's, so it is not re-printed).
    func testTrailTimelineDocPlusRecord() {
        let store = AppStore.preview()
        let view = ScrollView {
            TrailTimelineView(events: PreviewMocks.trailDocPlusRecord, annotations: .empty)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "110-trail-timeline-doc-plus-record", size: CGSize(width: 393, height: 320))
    }

    /// A mixed trail: a document, a bound record-only event (tappable
    /// title), and a record with empty key fields + a long title —
    /// chronologically interleaved by semantic time. The `snapshot`
    /// helper renders both dark + a `-light` variant, so this single
    /// test covers both colour schemes.
    func testTrailTimelineMixedRecords() {
        let store = AppStore.preview()
        let view = ScrollView {
            TrailTimelineView(events: PreviewMocks.trailMixedRecords, annotations: .empty)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "111-trail-timeline-mixed-records", size: CGSize(width: 393, height: 560))
    }

    /// Self-authored conversation quote renders as a right-aligned "sent"
    /// bubble (tail on the trailing edge), the other party's quote as the
    /// left-aligned "received" bubble — driven by `quoteIsSelf`. Uses a
    /// clean, fully-invented two-message conversation so the chat-bubble
    /// path renders both directions.
    func testTrailTimelineSelfBubble() {
        let store = AppStore.preview()
        let people = [
            AgentTrailEventPerson(personId: "p-self", name: "You", role: "participant", isSelf: true),
            AgentTrailEventPerson(personId: "p-maya", name: "Maya Reeves", role: "participant", isSelf: false),
        ]
        let events = [
            AgentTrailEvent(
                eventId: "evt-conv-1",
                at: "2026-05-14T15:40:46Z",
                kind: "document",
                doc: AgentTrailEventDoc(
                    documentId: "evt-conv-1",
                    title: "Maya Reeves — 2026-05-14",
                    sourceId: "whatsapp-messages:+44…",
                    sourceUrl: nil,
                    appUrl: nil,
                    documentType: "conversation",
                    mimeType: nil
                ),
                attachments: [],
                people: people,
                related: []
            ),
            AgentTrailEvent(
                eventId: "evt-conv-2",
                at: "2026-05-16T16:29:34Z",
                kind: "document",
                doc: AgentTrailEventDoc(
                    documentId: "evt-conv-2",
                    title: "Maya Reeves — 2026-05-16",
                    sourceId: "whatsapp-messages:+44…",
                    sourceUrl: nil,
                    appUrl: nil,
                    documentType: "conversation",
                    mimeType: nil
                ),
                attachments: [],
                people: people,
                related: []
            ),
        ]
        var ann = AgentTrailAnnotations()
        ann.applyDocAnnotation(
            documentId: "evt-conv-1",
            ref: nil,
            quote: "Can you resend the booking link? I can't find it.",
            note: nil,
            quoteAuthor: "Maya",
            quoteIsSelf: false
        )
        ann.applyDocAnnotation(
            documentId: "evt-conv-2",
            ref: nil,
            quote: "Just sent it over.",
            note: nil,
            quoteAuthor: "You",
            quoteIsSelf: true
        )
        let view = ScrollView {
            TrailTimelineView(events: events, annotations: ann)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "108-trail-timeline-self-bubble")
    }

    // MARK: - Models view (#11), agent model header (#13), provider glyphs (#6)

    func testModelsViewConfigured() {
        // Full capability list: enabled (embedder, agent,
        // privacy reviewer), unresolved (transcriber), and
        // configured-but-unavailable (OCR).
        let view = NavigationStack {
            ModelsView(previewOverview: ModelsPreviewData.overview())
                .environment(AppStore.preview())
        }
        snapshot(view, name: "110-models-configured")
    }

    func testModelsContentList() {
        // The pure capability list (no nav chrome) — exercises every card state.
        let view = NavigationStack {
            ModelsContent(overview: ModelsPreviewData.overview())
                .background(Theme.bgPrimary.ignoresSafeArea())
                .navigationTitle("Models")
                .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(AppStore.preview()), name: "111-models-capability-list")
    }

    func testModelsViewLoading() {
        let view = NavigationStack {
            ModelsView(previewOverview: nil, previewLoading: true)
                .environment(AppStore.preview())
        }
        snapshot(view, name: "111b-models-loading")
    }

    func testModelBehaviorEditorSavedOverrides() {
        let view = ModelBehaviorEditor(
            assignment: "openai/gpt-example-frontier",
            metadata: PreviewMocks.modelReasoningControls,
            initialValues: PreviewMocks.modelReasoningValues
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111g-model-behavior-saved", size: CGSize(width: 393, height: 620))
    }

    func testModelBehaviorEditorProviderDefaults() {
        let view = ModelBehaviorEditor(
            assignment: "openai/gpt-example-frontier",
            metadata: PreviewMocks.modelReasoningControls,
            initialValues: ModelBehaviorValues()
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111h-model-behavior-defaults", size: CGSize(width: 393, height: 620))
    }

    func testModelBehaviorEditorSaveError() {
        let view = ModelBehaviorEditor(
            assignment: "openai/gpt-example-frontier",
            metadata: PreviewMocks.modelReasoningControls,
            initialValues: PreviewMocks.modelReasoningValues,
            previewError: "The model changed while these settings were open. Reload and try again."
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111i-model-behavior-error", size: CGSize(width: 393, height: 620))
    }

    func testModelBehaviorEditorLightAppearance() {
        let view = ModelBehaviorEditor(
            assignment: "openai/gpt-example-frontier",
            metadata: PreviewMocks.modelReasoningControls,
            initialValues: PreviewMocks.modelReasoningValues
        )
        .padding()
        .background(Theme.bgPrimary)
        .preferredColorScheme(.light)
        snapshot(view, name: "111j-model-behavior-light", size: CGSize(width: 393, height: 620))
    }

    func testModelBehaviorEditorExclusiveOptions() {
        let view = ModelBehaviorEditor(
            assignment: "openrouter/fictional-reasoning-model",
            metadata: PreviewMocks.modelExclusiveReasoningControls,
            initialValues: ModelBehaviorValues(reasoningEffort: "high")
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111k-model-behavior-exclusive", size: CGSize(width: 393, height: 620))
    }

    func testModelBehaviorEditorOffDisablesCompactEffort() {
        let view = ModelBehaviorEditor(
            assignment: "openai/gpt-example-frontier",
            metadata: ModelBehaviorEditor.previewCompactControls,
            initialValues: ModelBehaviorValues(reasoningEnabled: false)
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111p-model-behavior-off-compact", size: CGSize(width: 393, height: 460))
    }

    func testModelBehaviorEditorMissingSavedControlDisablesOfferedControls() {
        let view = ModelBehaviorEditor(
            assignment: "openai/gpt-example-frontier",
            metadata: ModelControls(
                providerId: "openai",
                source: "models.dev",
                reasoning: true,
                controls: [ModelControl(key: "reasoningEnabled", type: "boolean", label: "Reasoning")]
            ),
            initialValues: ModelBehaviorValues(reasoningEffort: "retired-option")
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111r-model-behavior-disabled-until-reset", size: CGSize(width: 393, height: 460))
    }

    func testModelBehaviorEditorConflictKeepsDraftAndDisablesControls() {
        let view = ModelBehaviorEditor(
            assignment: "openai/gpt-example-frontier",
            metadata: ModelBehaviorEditor.previewCompactControls,
            initialValues: ModelBehaviorValues(reasoningEffort: "high"),
            previewConflict: true,
            previewEffortChoice: "medium"
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111s-model-behavior-conflict", size: CGSize(width: 393, height: 490))
    }

    func testAssignedModelCardKeepsControlsWhenBackendUnavailable() {
        let view = AssignedModelBehaviorCard(
            behavior: ModelManagement.ActiveBehavior(
                assignment: "openai/gpt-example-frontier",
                metadata: ModelBehaviorEditor.previewCompactControls,
                values: ModelBehaviorValues(reasoningEffort: "high")
            ),
            display: ModelDisplay(
                providerId: "openai",
                providerLabel: "OpenAI",
                modelName: "GPT Example Frontier",
                available: false,
                configured: true
            ),
            unavailableReason: "Backend unreachable"
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111q-assigned-model-unavailable-controls", size: CGSize(width: 393, height: 540))
    }

    func testAssignedModelCardWithoutConfigurableControls() {
        let view = AssignedModelBehaviorCard(
            behavior: ModelManagement.ActiveBehavior(
                assignment: "northstar/chat-v1",
                metadata: ModelControls(providerId: "unknown", source: "unknown", reasoning: nil, controls: []),
                values: ModelBehaviorValues()
            ),
            display: ModelDisplay(
                providerId: "northstar",
                providerLabel: "Northstar",
                modelName: "Chat V1",
                available: true,
                configured: true
            ),
            unavailableReason: nil
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111t-assigned-model-without-controls", size: CGSize(width: 393, height: 220))
    }

    func testModelBehaviorEditorNoBudgetEnforcement() {
        let view = ModelBehaviorEditor(
            assignment: "nvidia/nemotron-example",
            metadata: PreviewMocks.modelUnlimitedBudgetControls,
            initialValues: ModelBehaviorValues(reasoningBudgetTokens: -1)
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111m-model-behavior-no-budget-enforcement", size: CGSize(width: 393, height: 620))
    }

    func testModelBehaviorEditorCanResetMissingCatalogOptions() {
        let view = ModelBehaviorEditor(
            assignment: "openai/gpt-example-frontier",
            metadata: ModelControls(providerId: "unknown", source: "unknown", reasoning: nil, controls: []),
            initialValues: ModelBehaviorValues(reasoningEffort: "retired-option")
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111n-model-behavior-reset-missing", size: CGSize(width: 393, height: 400))
    }

    func testModelBehaviorEditorBlocksSaveForRetiredEffort() {
        let view = ModelBehaviorEditor(
            assignment: "openai/gpt-example-frontier",
            metadata: PreviewMocks.modelReasoningControls,
            initialValues: ModelBehaviorValues(reasoningEffort: "retired-option"),
            previewReasoningChoice: "on"
        )
        .padding()
        .background(Theme.bgPrimary)
        snapshot(view, name: "111o-model-behavior-retired-effort", size: CGSize(width: 393, height: 620))
    }

    func testProviderSVGDataCanRenderWithoutBundledAssets() {
        let svg = Data("""
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" fill="currentColor"/>
        </svg>
        """.utf8)
        guard let dark = ProviderSVGRenderer.render(svg, colorScheme: .dark),
              let light = ProviderSVGRenderer.render(svg, colorScheme: .light) else {
            XCTFail("Gateway-fetched provider SVG did not rasterize in both themes")
            return
        }
        render(
            Image(uiImage: dark).resizable().scaledToFit(),
            name: "111l-provider-svg-raster-dark",
            size: CGSize(width: 64, height: 64),
            scheme: .dark
        )
        render(
            Image(uiImage: light).resizable().scaledToFit(),
            name: "111l-provider-svg-raster-light",
            size: CGSize(width: 64, height: 64),
            scheme: .light
        )
    }

    // MARK: - Answer privacy

    func testPrivacySubscriptionApprovalPending() {
        let view = NavigationStack {
            PrivacySubscriptionApprovalDetailView(
                previewDetail: PreviewMocks.subscriptionApprovalDetail
            )
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111ts-privacy-subscription-approval",
            size: CGSize(width: 393, height: 1500)
        )
    }

    func testPrivacySubscriptionApprovalRevision() {
        let view = NavigationStack {
            PrivacySubscriptionApprovalDetailView(
                previewDetail: PreviewMocks.subscriptionApprovalRevisionDetail
            )
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111tsb-privacy-subscription-revision",
            size: CGSize(width: 393, height: 1500)
        )
    }

    func testPrivacySubscriptionApprovalLoading() {
        let view = NavigationStack {
            PrivacySubscriptionApprovalDetailView(previewLoading: true)
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111tsc-privacy-subscription-loading")
    }

    func testPrivacySubscriptionApprovalError() {
        let view = NavigationStack {
            PrivacySubscriptionApprovalDetailView(
                previewLoadError: URLError(.cannotConnectToHost)
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111tsd-privacy-subscription-error")
    }

    func testPrivacySubscriptionApprovalActionFailure() {
        let view = NavigationStack {
            PrivacySubscriptionApprovalDetailView(
                previewDetail: PreviewMocks.subscriptionApprovalDetail,
                previewActionError: URLError(.cannotConnectToHost)
            )
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111tse-privacy-subscription-approval-action-failure",
            size: CGSize(width: 393, height: 1500)
        )
    }

    // MARK: - Privacy — the activity feed

    /// The landing: pending exchanges pinned as full review cards, the watch
    /// requests waiting on the same kind of decision, then the flat feed.
    func testPrivacyActivityWithPinnedReview() {
        let view = PrivacyView(
            menuOpen: .constant(false),
            previewExchanges: PreviewMocks.privacyExchangeFeed,
            previewNextCursor: "activity-next",
            previewSubscriptionApprovals: [PreviewMocks.subscriptionApproval],
            previewReviewerHealth: PreviewMocks.privacyReviewerHealthAttention
        )
        .environment(AppStore.preview())
        .environment(NotificationRouter())
        snapshot(view, name: "111p-privacy-activity", size: CGSize(width: 393, height: 2400))
    }

    func testPrivacyActivityEmpty() {
        let view = PrivacyView(menuOpen: .constant(false), previewExchanges: [])
            .environment(AppStore.preview())
            .environment(NotificationRouter())
        snapshot(view, name: "111q-privacy-activity-empty", size: CGSize(width: 393, height: 900))
    }

    /// The review card on its own, so the held answer, the reason and both
    /// decisions can be read at full size.
    func testPrivacyReviewCardPending() {
        let view = ScrollView {
            PrivacyReviewCard(
                review: PrivacyPendingReview(detail: PreviewMocks.privacyApprovalDetail),
                onApprove: {},
                onDeny: {}
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        snapshot(view, name: "111r-privacy-review-card", size: CGSize(width: 393, height: 900))
    }

    func testPrivacyReviewCardCheckUnavailable() {
        let view = ScrollView {
            PrivacyReviewCard(
                review: PrivacyPendingReview(detail: PreviewMocks.privacyUnavailableApproval),
                onApprove: {},
                onDeny: {}
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        snapshot(
            view,
            name: "111rb-privacy-review-card-unavailable",
            size: CGSize(width: 393, height: 900)
        )
    }

    /// The spine while the answer is still held: dashed rail outside, hairline,
    /// solid accented rail through the tinted inside panel, and no second
    /// crossing because nothing left.
    func testPrivacyExchangeSpinePending() {
        let view = NavigationStack {
            PrivacyExchangeDetailView(
                previewExchange: PreviewMocks.privacyExchanges[0],
                previewEvents: PreviewMocks.privacyAuditEvents.filter {
                    $0.taskId == PreviewMocks.privacyExchanges[0].taskId
                }
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111v-privacy-spine-pending", size: CGSize(width: 393, height: 1500))
    }

    /// The full crossing: dashed → hairline → solid → hairline → dashed. This
    /// review names the policy it was judged under, so the decision card
    /// carries the row that opens that policy's text.
    func testPrivacyExchangeSpineShared() {
        let view = NavigationStack {
            PrivacyExchangeDetailView(
                previewExchange: PreviewMocks.privacyExchanges[1],
                previewEvents: PreviewMocks.privacyAuditEvents.filter {
                    $0.taskId == PreviewMocks.privacyExchanges[1].taskId
                }
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111va-privacy-spine-shared", size: CGSize(width: 393, height: 1500))
    }

    /// The release compared with the draft: a matched pair with word spans, a
    /// removed line with no counterpart, a blank line, a pair differing only in
    /// spacing, and a line long enough to wrap. The release step's own body is
    /// absent because the comparison already carries the released text.
    func testPrivacyAnswerComparisonReduced() {
        snapshot(
            comparisonRecord(PreviewMocks.privacyAnswerDiff),
            name: "111wa-privacy-answer-comparison-diff",
            size: CGSize(width: 393, height: 1000)
        )
    }

    /// Nothing was reduced, so the record says so in one line and prints no
    /// second copy of the answer.
    func testPrivacyAnswerComparisonIdentical() {
        snapshot(
            comparisonRecord(.identical),
            name: "111wb-privacy-answer-comparison-identical",
            size: CGSize(width: 393, height: 700)
        )
    }

    func testPrivacyAnswerComparisonDissimilar() {
        snapshot(
            comparisonRecord(.noDiff(reason: .dissimilar)),
            name: "111wc-privacy-answer-comparison-dissimilar",
            size: CGSize(width: 393, height: 800)
        )
    }

    func testPrivacyAnswerComparisonTooLarge() {
        snapshot(
            comparisonRecord(.noDiff(reason: .tooLarge)),
            name: "111wd-privacy-answer-comparison-too-large",
            size: CGSize(width: 393, height: 800)
        )
    }

    /// A two-step task — draft, then release — as it sits on the spine, which
    /// is where a comparison is actually read.
    private func comparisonRecord(_ comparison: PrivacyAnswerComparison) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                ForEach(PreviewMocks.privacyComparisonEvents(comparison)) { event in
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        PrivacyMomentLabel(at: event.createdAt)
                        PrivacyLedgerStep(event: event)
                    }
                }
            }
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.bgPrimary)
    }

    /// The spine's left edge on its own: both rails one width, so the only
    /// differences are the dash pattern and the colour, and each crossing keeps
    /// clear air above and below it. The canvas is tight so the clearance can
    /// be counted off the render.
    func testPrivacySpineCrossings() {
        snapshot(
            PrivacySpineCrossings(),
            name: "111vc-privacy-spine-crossings",
            size: CGSize(width: 393, height: 420)
        )
    }

    /// Prose Omnesis wrote against text it is quoting, in one frame: the
    /// contrast is the whole mechanism, so it is worth a snapshot of its own.
    func testPrivacyQuoteFamily() {
        snapshot(
            PrivacyQuoteGallery(),
            name: "111vd-privacy-quote-family",
            size: CGSize(width: 393, height: 520)
        )
    }

    /// The same gallery at a large accessibility size: the panels must grow
    /// with their text rather than clip it.
    func testPrivacyQuoteFamilyAccessibilitySize() {
        snapshot(
            PrivacyQuoteGallery().environment(\.dynamicTypeSize, .accessibility3),
            name: "111ve-privacy-quote-family-accessibility",
            size: CGSize(width: 320, height: 880)
        )
    }

    /// A request and a draft at the length they actually arrive at: paragraphs
    /// and a list, quoted on the cards inside the machine.
    func testPrivacyExchangeSpineLongDraft() {
        let view = NavigationStack {
            PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyLongDraftExchange)
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111vb-privacy-spine-long-draft",
            size: CGSize(width: 393, height: 1500)
        )
    }

    /// The pinned review card at a large accessibility size: the quoted
    /// question and held answer sit above controls that do scale, so this is
    /// where the card's layout gives out first if it is going to.
    func testPrivacyReviewCardAccessibilitySize() {
        let view = ScrollView {
            PrivacyReviewCard(
                review: PrivacyPendingReview(detail: PreviewMocks.privacyApprovalDetail),
                onApprove: {},
                onDeny: {}
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(\.dynamicTypeSize, .accessibility3)
        snapshot(
            view,
            name: "111rc-privacy-review-card-accessibility",
            size: CGSize(width: 320, height: 700)
        )
    }

    func testPrivacyExchangeFailed() {
        let view = NavigationStack {
            PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyFailedExchange)
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111y-privacy-spine-failed", size: CGSize(width: 393, height: 1300))
    }

    /// A draft killed by something the provider reported: the vetted
    /// disposition line renders under the humanized sentence.
    func testPrivacyExchangeProviderFailed() {
        let view = NavigationStack {
            PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyProviderFailedExchange)
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111yc-privacy-spine-provider-failed",
            size: CGSize(width: 393, height: 1300)
        )
    }

    func testPrivacyExchangeReviewFailed() {
        let view = NavigationStack {
            PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyReviewFailedExchange)
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111yb-privacy-spine-review-failed", size: CGSize(width: 393, height: 1100))
    }

    func testPrivacyExchangeUnattendedDraft() {
        let view = NavigationStack {
            PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyUnattendedDraftExchange)
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111ya-privacy-spine-unattended-draft",
            size: CGSize(width: 393, height: 1200)
        )
    }

    func testPrivacyExchangeDrafting() {
        let view = NavigationStack {
            PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyRunningExchange)
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111yaa-privacy-spine-drafting", size: CGSize(width: 393, height: 1100))
    }

    func testPrivacyExchangeHardStopped() {
        let view = NavigationStack {
            PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyHardStoppedExchange)
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111yb-privacy-spine-hard-stopped",
            size: CGSize(width: 393, height: 1200)
        )
    }

    /// Policy is rendered read-only and points edits to the portal. Reached
    /// from Settings and from the grant it governs, never from the feed.
    func testPrivacyPolicyGrid() {
        let view = NavigationStack {
            PrivacyPolicyPane(previewPolicy: PreviewMocks.privacyPolicy)
                .navigationTitle("Privacy policy")
                .navigationBarTitleDisplayMode(.inline)
                .background(Theme.bgPrimary.ignoresSafeArea())
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111u-privacy-policy", size: CGSize(width: 393, height: 1800))
    }

    /// The document one named policy family carries, pushed the way every
    /// route pushes it — titled with the family's name.
    func testPrivacyPolicyFamily() {
        let view = NavigationStack {
            PrivacyPolicyScreen(previewPolicy: PreviewMocks.privacyPolicyFamily, name: "Work safe")
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111ua-privacy-policy-family", size: CGSize(width: 393, height: 1400))
    }

    /// The same document reached from a record that kept no family name.
    func testPrivacyPolicyFamilyNameless() {
        let view = NavigationStack {
            PrivacyPolicyScreen(previewPolicy: PreviewMocks.privacyPolicyFamily, name: nil)
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111uaa-privacy-policy-family-nameless", size: CGSize(width: 393, height: 600))
    }

    /// The modal form of a review: what the app puts in front of the owner
    /// when a decision was already waiting as they opened the app. Close is
    /// the only way out that is not a decision.
    func testPrivacyApprovalSheet() {
        let view = PrivacyApprovalSheet(previewDetail: PreviewMocks.privacyApprovalDetail)
            .environment(AppStore.preview())
        snapshot(
            view,
            name: "111sg-privacy-approval-sheet",
            size: CGSize(width: 393, height: 1000)
        )
    }

    func testPrivacyApprovalSheetLoading() {
        let view = PrivacyApprovalSheet(previewLoading: true)
            .environment(AppStore.preview())
        snapshot(view, name: "111sh-privacy-approval-sheet-loading", size: CGSize(width: 393, height: 600))
    }

    func testPrivacyApprovalSheetError() {
        let view = PrivacyApprovalSheet(previewLoadError: URLError(.cannotConnectToHost))
            .environment(AppStore.preview())
        snapshot(view, name: "111si-privacy-approval-sheet-error", size: CGSize(width: 393, height: 800))
    }

    func testPrivacyApprovalDeepLink() {
        let view = NavigationStack {
            PrivacyApprovalRoute(previewDetail: PreviewMocks.privacyApprovalDetail)
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111s-privacy-approval-deep-link",
            size: CGSize(width: 393, height: 1000)
        )
    }

    /// The same deep link on a record that kept no policy family: nothing
    /// about the policy is shown, and nothing else moves.
    func testPrivacyApprovalDeepLinkWithoutPolicy() {
        let view = NavigationStack {
            PrivacyApprovalRoute(previewDetail: PreviewMocks.privacyApprovalDetailWithoutPolicy)
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111sfa-privacy-approval-deep-link-no-policy",
            size: CGSize(width: 393, height: 1000)
        )
    }

    /// A link minted while the review was pending, opened after it was decided.
    /// It must report what happened rather than offer the choice again.
    func testPrivacyApprovalAlreadyDecided() {
        let view = NavigationStack {
            PrivacyApprovalRoute(previewDetail: PreviewMocks.privacyDecidedApprovalDetail)
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111sf-privacy-approval-decided",
            size: CGSize(width: 393, height: 600)
        )
    }

    // MARK: - Privacy — the states a screen about explaining itself must explain

    /// Both panes fetch on appear, so both have a first frame with nothing in
    /// it and a frame where the fetch failed. On a screen whose whole job is
    /// accounting for what happened, neither may render as blank.
    func testPrivacyActivityLoading() {
        let view = NavigationStack {
            PrivacyActivityPane(previewExchanges: [], previewLoading: true)
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111pa-privacy-activity-loading",
            size: CGSize(width: 393, height: 400)
        )
    }

    func testPrivacyActivityError() {
        let view = NavigationStack {
            PrivacyActivityPane(
                previewExchanges: [],
                previewLoadError: URLError(.cannotConnectToHost)
            )
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111pb-privacy-activity-error",
            size: CGSize(width: 393, height: 700)
        )
    }

    /// Nothing waiting: no pinned card, no watch requests, just the ledger.
    func testPrivacyActivityFeedWithoutPinnedReview() {
        let view = NavigationStack {
            PrivacyActivityPane(
                previewExchanges: PreviewMocks.privacyExchangeFeed.filter {
                    !privacyExchangeIsPendingReview($0)
                }
            )
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111pc-privacy-activity-feed-only",
            size: CGSize(width: 393, height: 1100)
        )
    }

    /// A narrowed feed keeps the held review above it while showing only the
    /// matching loaded rows and their loaded-result tallies.
    func testPrivacyActivityFailedFilterKeepsPinnedReview() {
        let view = NavigationStack {
            PrivacyActivityPane(
                previewExchanges: PreviewMocks.privacyExchangeFeed,
                previewFilter: .failed
            )
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111pcf-privacy-activity-failed-filter",
            size: CGSize(width: 393, height: 1500)
        )
    }

    func testPrivacyActivityFilterWithoutMatches() {
        let view = NavigationStack {
            PrivacyActivityPane(
                previewExchanges: [PreviewMocks.privacyExchanges[1]],
                previewFilter: .failed
            )
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111pcg-privacy-activity-filter-empty",
            size: CGSize(width: 393, height: 700)
        )
    }

    /// A page consumed entirely by its pinned review cannot claim the ledger
    /// is empty while an older-page cursor remains.
    func testPrivacyActivityOnlyPinnedRowWithOlderPage() {
        let view = NavigationStack {
            PrivacyActivityPane(
                previewExchanges: [PreviewMocks.privacyExchanges[0]],
                previewNextCursor: "older-activity"
            )
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111pch-privacy-activity-only-pinned-with-older-page",
            size: CGSize(width: 393, height: 1400)
        )
    }

    /// A maximum-length OAuth principal at a large accessibility size must not
    /// force the compact feed row or its outcome beyond the phone canvas.
    func testPrivacyActivityFeedExtremePrincipalAccessibilitySize() {
        let view = NavigationStack {
            ScrollView {
                PrivacyFeedRow(exchange: PreviewMocks.privacyExtremePrincipalExchange)
                    .padding(.horizontal, Theme.Spacing.lg)
            }
            .background(Theme.bgPrimary)
        }
        .environment(AppStore.preview())
        .environment(\.dynamicTypeSize, .accessibility3)
        snapshot(
            view,
            name: "111pce-privacy-activity-extreme-principal-accessibility",
            size: CGSize(width: 320, height: 700)
        )
    }

    /// The moment after a decision: the card is gone and the banner says what
    /// became of the answer.
    func testPrivacyActivityJustDecided() {
        let view = NavigationStack {
            PrivacyActivityPane(
                previewExchanges: PreviewMocks.privacyExchangeFeed,
                previewResolution: PreviewMocks.privacyApprovedResolution
            )
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111pd-privacy-activity-decided",
            size: CGSize(width: 393, height: 1600)
        )
    }

    func testPrivacyPolicyLoading() {
        let view = PrivacyPolicyPane(previewPolicy: nil, previewLoading: true)
            .environment(AppStore.preview())
        snapshot(
            view,
            name: "111ub-privacy-policy-loading",
            size: CGSize(width: 393, height: 400)
        )
    }

    func testPrivacyPolicyError() {
        let view = PrivacyPolicyPane(
            previewPolicy: nil,
            previewLoadError: URLError(.cannotConnectToHost)
        )
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "111uc-privacy-policy-error",
            size: CGSize(width: 393, height: 700)
        )
    }

    /// Settings → Policies with several families: the retired one is left
    /// out, the default leads and is captioned, and every row carries its
    /// short revision and how many grants it governs.
    func testPoliciesList() {
        let view = NavigationStack {
            PoliciesListView(
                previewFamilies: PreviewMocks.privacyPolicyFamilies,
                previewDefaultFamilyId: PreviewMocks.privacyDefaultPolicyFamilyId
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111ud-policies-list")
    }

    /// An install whose every family has been retired, or that has none.
    func testPoliciesListEmpty() {
        let view = NavigationStack {
            PoliciesListView(previewFamilies: [])
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111ue-policies-list-empty", size: CGSize(width: 393, height: 500))
    }

    func testPoliciesListLoading() {
        let view = NavigationStack {
            PoliciesListView(previewFamilies: nil, previewLoading: true)
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111uf-policies-list-loading", size: CGSize(width: 393, height: 500))
    }

    func testPoliciesListError() {
        let view = NavigationStack {
            PoliciesListView(previewFamilies: nil, previewLoadError: URLError(.cannotConnectToHost))
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111ug-policies-list-error", size: CGSize(width: 393, height: 700))
    }

    /// A catalogue of one: the default, captioned, with no divider after it.
    func testPoliciesListSingle() {
        let view = NavigationStack {
            PoliciesListView(
                previewFamilies: PreviewMocks.privacyPolicyFamilySingle,
                previewDefaultFamilyId: PreviewMocks.privacyDefaultPolicyFamilyId
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111uh-policies-list-single", size: CGSize(width: 393, height: 500))
    }

    /// A name long enough to wrap: the revision line and the chevron hold.
    func testPoliciesListLongName() {
        let view = NavigationStack {
            PoliciesListView(
                previewFamilies: PreviewMocks.privacyPolicyFamiliesLongName,
                previewDefaultFamilyId: PreviewMocks.privacyDefaultPolicyFamilyId
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111ui-policies-list-long-name", size: CGSize(width: 393, height: 600))
    }

    /// A refresh that failed after a catalogue had loaded: one banner above
    /// the list, the list itself kept.
    func testPoliciesListRefreshFailed() {
        let view = NavigationStack {
            PoliciesListView(
                previewFamilies: PreviewMocks.privacyPolicyFamilies,
                previewDefaultFamilyId: PreviewMocks.privacyDefaultPolicyFamilyId,
                previewLoadError: URLError(.cannotConnectToHost)
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "111uj-policies-list-refresh-failed", size: CGSize(width: 393, height: 700))
    }

    /// The same banner on the document: the text stays, the failure is stated.
    func testPrivacyPolicyRefreshFailed() {
        let view = PrivacyPolicyPane(
            previewPolicy: PreviewMocks.privacyPolicyFamily,
            previewLoadError: URLError(.cannotConnectToHost)
        )
        .environment(AppStore.preview())
        snapshot(view, name: "111uk-privacy-policy-refresh-failed", size: CGSize(width: 393, height: 900))
    }

    // MARK: - Model picker — two-level flow (backend grid → model list)

    /// Pane 1: the backend grid. Tiles for Local, Anthropic, and each HTTP
    /// backend (count or URL subtitle), the "+ Add HTTP backend" button, and the
    /// Clear-assignment affordance.
    func testModelPickerBackendGrid() throws {
        let view = try ModelPickerSheet(
            cap: XCTUnwrap(ModelsPreviewData.capabilities.first { $0.role == "agent" }),
            overview: ModelsPreviewData.overview(),
            system: ModelsPreviewData.systemInfo(),
            currentlyConfigured: true
        )
        snapshot(view.environment(AppStore.preview()), name: "111c-model-picker-backend-grid")
    }

    /// Pane 2: the model list for an HTTP backend — the Back row, the search
    /// field, the role-matching options, and the custom-model-id "Use" affordance.
    func testModelPickerModelList() throws {
        let view = try ModelPickerSheet(
            cap: XCTUnwrap(ModelsPreviewData.capabilities.first { $0.role == "agent" }),
            overview: ModelsPreviewData.overview(),
            system: ModelsPreviewData.systemInfo(),
            currentlyConfigured: true,
            previewSelectedBackend: "vllm"
        )
        snapshot(view.environment(AppStore.preview()), name: "111d-model-picker-model-list")
    }

    /// Pane 1 with "Recently used": the flat provider-glyph + model + Use rows
    /// above the backend grid (not cards). A render smoke test — `snapshot()`
    /// writes PNGs for the self-critique loop and asserts nothing, so the
    /// mapping itself is pinned by `ModelManagementTests` instead.
    func testModelPickerRecentlyUsed() throws {
        let view = try ModelPickerSheet(
            cap: XCTUnwrap(ModelsPreviewData.capabilities.first { $0.role == "agent" }),
            overview: ModelsPreviewData.overview(),
            system: ModelsPreviewData.systemInfo(),
            currentlyConfigured: true,
            previewSelectedBackend: nil,
            previewRecent: ModelsPreviewData.recentEntries()
        )
        snapshot(view.environment(AppStore.preview()), name: "111f-model-picker-recently-used")
    }

    func testModelPickerAssignedWithoutControls() throws {
        let view = try ModelPickerSheet(
            cap: XCTUnwrap(ModelsPreviewData.capabilities.first { $0.role == "agent" }),
            overview: ModelsPreviewData.overviewWithoutControls(),
            system: ModelsPreviewData.systemInfo(),
            currentlyConfigured: true,
            previewSelectedBackend: nil,
            previewRecent: ModelsPreviewData.recentEntries()
        )
        snapshot(view.environment(AppStore.preview()), name: "111u-model-picker-assigned-without-controls")
    }

    /// Pane 2, the Local backend: the install/cancel/uninstall + use list, with
    /// one model installed (Use/Remove), one downloading (progress + Cancel), and
    /// one available with a fit warning (Install).
    func testModelPickerLocalLifecycle() throws {
        let view = try ModelPickerSheet(
            cap: XCTUnwrap(ModelsPreviewData.capabilities.first { $0.role == "embedder" }),
            overview: ModelsPreviewData.overview(),
            system: ModelsPreviewData.systemInfo(),
            currentlyConfigured: true,
            previewSelectedBackend: "local"
        )
        snapshot(view.environment(AppStore.preview()), name: "111e-model-picker-local-lifecycle")
    }

    // MARK: - HTTP-backend management (#727)

    func testBackendsList() {
        // Collapsed summary cards: a reachable backend with a key + models, and an
        // unreachable one — no inline verify rows (those moved to the detail view).
        let view = NavigationStack {
            BackendsContent(
                backends: BackendsPreviewData.backends(),
                presets: BackendsPreviewData.presets()
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Backends")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(AppStore.preview()), name: "112-backends-list")
    }

    func testBackendsEmpty() {
        let view = NavigationStack {
            BackendsContent(backends: [], presets: BackendsPreviewData.presets())
                .background(Theme.bgPrimary.ignoresSafeArea())
                .navigationTitle("Backends")
                .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(AppStore.preview()), name: "112b-backends-empty")
    }

    func testAddBackendSheet() {
        // The add-backend preset grid (first step): one card per provider preset
        // plus the "Custom" card.
        let view = AddBackendSheet(presets: BackendsPreviewData.presets())
        snapshot(view.environment(AppStore.preview()), name: "112c-add-backend-preset-grid")
    }

    func testBackendsWithProviderCredentials() {
        // The full Backends screen body: HTTP backends + the provider-credential
        // section (one configured, one not).
        let view = NavigationStack {
            BackendsContent(
                backends: BackendsPreviewData.backends(),
                credentials: BackendsPreviewData.credentials(),
                presets: BackendsPreviewData.presets()
            )
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Backends")
            .navigationBarTitleDisplayMode(.inline)
        }
        snapshot(view.environment(AppStore.preview()), name: "112d-backends-with-credentials")
    }

    func testSetCredentialSheet() {
        let view = SetCredentialSheet(entry: BackendsPreviewData.credentials()[0])
        snapshot(view.environment(AppStore.preview()), name: "112e-set-credential-form")
    }

    func testCodexSetupPendingLogin() {
        let view = CodexSetupSheet(
            status: CodexBackendStatus(
                configured: true,
                status: "unreachable",
                loggedIn: false,
                models: [],
                reason: "OpenAI login pending."
            ),
            flow: CodexLoginFlow(
                id: "flow_1",
                status: "pending",
                verificationUri: "https://auth.openai.com/codex/device",
                userCode: "ABCD-12345",
                expiresAt: "2026-07-03T12:15:00Z"
            ),
            autoChecking: true
        )
        snapshot(view.environment(AppStore.preview()), name: "112h-codex-setup-pending-login")
    }

    // MARK: - Behavioral capability verify (#727)

    /// The pushed backend detail: the backend header + the "Verify capabilities"
    /// section, one (model, role) row idle, one with an in-verdict supported
    /// result. The verify rows live here now, not inline on the summary card.
    func testBackendDetailVerify() throws {
        let backend = try XCTUnwrap(BackendsPreviewData.backends().first { $0.key == "northstar" })
        let view = NavigationStack {
            BackendDetailView(
                row: backend,
                verifyStates: [
                    "northstar/llama-vision-8b/agent": .verdict(
                        supported: true,
                        detail: "Chat completion returned 1 choice."
                    ),
                ]
            )
            .environment(AppStore.preview())
        }
        snapshot(view.environment(AppStore.preview()), name: "112f-backend-detail-verify")
    }

    /// The four verify states side by side, each a standalone `VerifyRow`:
    /// verified-supported, verified-unsupported, in-flight, and error.
    func testVerifyRowStates() {
        let target = BackendsPreviewData.verifyTarget()
        let view = VStack(alignment: .leading, spacing: 12) {
            VerifyRow(target: target, state: .verdict(supported: true, detail: "embeddings endpoint · dim 1024"))
            VerifyRow(target: target, state: .verdict(supported: false, detail: "HTTP 404: model not found"))
            VerifyRow(target: target, state: .verifying)
            VerifyRow(target: target, state: .error("network error"))
        }
        .padding(Theme.Spacing.lg)
        .frame(width: 380)
        .background(Theme.bgSecondary)
        snapshot(view.environment(AppStore.preview()), name: "112g-verify-row-states")
    }

    func testProviderGlyphs() {
        let ids = ["anthropic", "openai", "google", "mistral", "cerebras", "deepseek", "ollama", "local", "none"]
        let view = VStack(alignment: .leading, spacing: 12) {
            ForEach(ids, id: \.self) { id in
                HStack(spacing: 10) {
                    ProviderIcon(providerId: id, size: 24)
                    Text(id)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.textPrimary)
                }
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgPrimary)
        snapshot(view, name: "112-provider-glyphs", size: CGSize(width: 393, height: 520))
    }

    /// The inspector's Timeline tab with no live gateway: `TimelinePane`
    /// has no reachable trail to fetch, so this captures the "Building
    /// timeline…" loading state. `TimelinePane` is file-private to
    /// `DocumentInspectorSheet`, so its `previewTrail` seam can't be
    /// driven from the test target; the populated row layout is covered
    /// by `testInspectorTimelinePopulated` below via `TrailTimelineView`.
    func testInspectorTimelineTabLoading() {
        let view = DocumentInspectorSheet(
            doc: PreviewMocks.documentDetail,
            people: PreviewMocks.documentPeople,
            refs: PreviewMocks.documentRefs,
            attachments: PreviewMocks.documentAttachments,
            initialTab: .timeline
        )
        .environment(AppStore.preview())
        snapshot(view, name: "31d-inspector-timeline-tab-loading")
    }

    /// Populated Timeline content — the same `TrailTimelineView` the
    /// inspector's Timeline tab embeds, driven by a privacy-clean
    /// invented trail. Covers the row/thread layout the loading
    /// snapshot can't.
    func testInspectorTimelinePopulated() {
        let store = AppStore.preview()
        let view = ScrollView {
            TrailTimelineView(
                events: PreviewMocks.trailLong,
                annotations: .empty
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(store)
        snapshot(view, name: "31e-inspector-timeline-populated")
    }

    // MARK: - Agent plan panel

    func testAgentPlanPanelMidProgress() {
        let view = VStack(spacing: 0) {
            AgentPlanPanel(items: PreviewMocks.agentPlanItemsMixed)
                .padding(.vertical, 8)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
        snapshot(view, name: "90-agent-plan-panel-mid-progress", size: CGSize(width: 393, height: 160))
    }

    func testAgentPlanPanelAllDone() {
        let view = VStack(spacing: 0) {
            AgentPlanPanel(items: PreviewMocks.agentPlanItemsAllDone)
                .padding(.vertical, 8)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
        snapshot(view, name: "91-agent-plan-panel-all-done", size: CGSize(width: 393, height: 160))
    }

    func testAgentPlanPanelSingleInProgress() {
        let view = VStack(spacing: 0) {
            AgentPlanPanel(items: PreviewMocks.agentPlanItemsSingleInProgress)
                .padding(.vertical, 8)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
        snapshot(view, name: "92-agent-plan-panel-single", size: CGSize(width: 393, height: 80))
    }

    func testAgentViewWithPlanPanel() {
        let store = AppStore.preview(agentPreview: PreviewMocks.agentBusyWithPlan)
        snapshot(
            AgentView(menuOpen: .constant(false)).environment(store),
            name: "93-agent-view-with-plan-panel"
        )
    }

    // MARK: - Composer speech states

    func testComposerIdleWithMic() {
        let speech = SpeechRecognizer.preview(state: .idle)
        let view = AgentComposer(
            text: .constant(""),
            busy: false,
            disabled: false,
            speech: speech,
            onSend: { _, _ in },
            onCancel: {},
            focused: FocusState<Bool>().projectedValue
        )
        .background(Theme.bgPrimary)
        .preferredColorScheme(.dark)
        snapshot(view, name: "94-composer-idle-mic", size: CGSize(width: 393, height: 140))
    }

    func testComposerListening() {
        let speech = SpeechRecognizer.preview(state: .listening, transcript: "What did Quentin email me about")
        let view = AgentComposer(
            text: .constant("What did Quentin email me about"),
            busy: false,
            disabled: false,
            speech: speech,
            onSend: { _, _ in },
            onCancel: {},
            focused: FocusState<Bool>().projectedValue
        )
        .background(Theme.bgPrimary)
        .preferredColorScheme(.dark)
        snapshot(view, name: "95-composer-listening", size: CGSize(width: 393, height: 180))
    }

    func testComposerSpeechUnavailable() {
        let speech = SpeechRecognizer.preview(state: .unavailable)
        let view = AgentComposer(
            text: .constant(""),
            busy: false,
            disabled: false,
            speech: speech,
            onSend: { _, _ in },
            onCancel: {},
            focused: FocusState<Bool>().projectedValue
        )
        .background(Theme.bgPrimary)
        .preferredColorScheme(.dark)
        snapshot(view, name: "96-composer-speech-unavailable", size: CGSize(width: 393, height: 140))
    }

    // MARK: - Composer slash-command / Deep Research pill

    /// Typing `/` opens the extensible slash-command menu (one seeded "Deep
    /// research" item: glyph + label + hint).
    func testComposerSlashMenuOpen() {
        let speech = SpeechRecognizer.preview(state: .idle)
        let view = AgentComposer(
            text: .constant("/"),
            busy: false,
            disabled: false,
            experimentalEnabled: true,
            speech: speech,
            onSend: { _, _ in },
            onCancel: {},
            focused: FocusState<Bool>().projectedValue
        )
        .background(Theme.bgPrimary)
        .preferredColorScheme(.dark)
        snapshot(view, name: "97-composer-slash-menu-open", size: CGSize(width: 393, height: 220))
    }

    /// Deep Research armed: the per-message top-left pill (glyph + label + ×)
    /// sits above the field, with the prompt below.
    func testComposerDeepResearchArmed() {
        let speech = SpeechRecognizer.preview(state: .idle)
        let view = AgentComposer(
            text: .constant("How has my running pace trended this year?"),
            busy: false,
            disabled: false,
            speech: speech,
            onSend: { _, _ in },
            onCancel: {},
            focused: FocusState<Bool>().projectedValue,
            previewArmedCommand: SlashCommand.byId("deep-research")
        )
        .background(Theme.bgPrimary)
        .preferredColorScheme(.dark)
        snapshot(view, name: "98-composer-deep-research-armed", size: CGSize(width: 393, height: 180))
    }

    // MARK: - Main menu drawer

    /// The Briefs drawer row carries an unread-count badge when the feature
    /// is enabled and the count is non-zero (in-app only, no OS badge). This
    /// parked state also checks the warning and badge share the trailing row.
    func testMainMenuDrawerBriefsBadge() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshotBriefsNeedsAttention,
            briefsUnreadCount: 3,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        let view = ZStack(alignment: .leading) {
            Theme.bgDrawer.ignoresSafeArea()
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
        }
        snapshot(view.environment(store), name: "99-main-menu-drawer-briefs-badge")
    }

    /// Privacy is an ungated row, and carries the count of decisions waiting
    /// on the owner so a held answer is not found only by going looking.
    func testMainMenuDrawerPrivacyBadge() {
        let store = AppStore.preview(
            privacyPendingCount: 2,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        let view = ZStack(alignment: .leading) {
            Theme.bgDrawer.ignoresSafeArea()
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
        }
        snapshot(view.environment(store), name: "99a-main-menu-drawer-privacy-badge")
    }

    // MARK: - Quick capture ("Tell Omnesis")

    func testCaptureListeningEmpty() {
        let view = CaptureView(speech: .preview(state: .listening))
            .environment(AppStore.preview())
        snapshot(view, name: "137-capture-listening-empty")
    }

    func testCaptureTranscribing() {
        let text = "Remember to book the dentist for Thursday morning and move the team retro to two"
        let view = CaptureView(
            speech: .preview(state: .listening, transcript: text),
            previewText: text
        )
        .environment(AppStore.preview())
        snapshot(view, name: "138-capture-transcribing")
    }

    func testCaptureSpeechUnavailable() {
        let view = CaptureView(speech: .preview(state: .unavailable))
            .environment(AppStore.preview())
        snapshot(view, name: "139-capture-speech-unavailable")
    }

    func testCaptureSavedConfirmation() {
        let view = CaptureView(
            speech: .preview(state: .idle),
            previewText: "Buy a spare charger for the office",
            previewPhase: .done(.saved)
        )
        .environment(AppStore.preview())
        snapshot(view, name: "140-capture-saved")
    }

    func testCaptureQueuedConfirmation() {
        let view = CaptureView(
            speech: .preview(state: .idle),
            previewText: "Buy a spare charger for the office",
            previewPhase: .done(.queued(.unreachable))
        )
        .environment(AppStore.preview())
        snapshot(view, name: "141-capture-queued")
    }

    func testCaptureLongTranscriptStopped() {
        let long = String(
            repeating: "This is a long rambling thought that keeps going and needs to wrap across many lines. ",
            count: 6
        )
        let view = CaptureView(speech: .preview(state: .idle), previewText: long)
            .environment(AppStore.preview())
        snapshot(view, name: "142-capture-long-transcript")
    }

    // MARK: - Unsent-note diagnostics

    /// Direct capture remains visible without experimental mode while the
    /// local queue is healthy.
    func testMainMenuDrawerTellOmnesisEntry() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshot,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        store.notes.installPreviewState(pending: PreviewMocks.freshPendingNotes)
        let view = ZStack(alignment: .leading) {
            Theme.bgDrawer.ignoresSafeArea()
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
        }
        snapshot(view.environment(store), name: "143-main-menu-tell-omnesis")
    }

    /// A stale/failed-redelivery queue adds the independent yellow
    /// warning target to the Tell Omnesis row.
    func testMainMenuDrawerTellOmnesisWarning() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshotExperimental,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        store.notes.installPreviewState(pending: PreviewMocks.pendingNotes)
        let view = ZStack(alignment: .leading) {
            Theme.bgDrawer.ignoresSafeArea()
            MainMenuDrawer(
                isOpen: .constant(true),
                selection: .constant(.agent),
                onOpenSettings: {}
            )
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
        }
        snapshot(view.environment(store), name: "144-main-menu-tell-omnesis-warning")
    }

    func testPendingNotesDiagnosticSheetPopulated() {
        let store = AppStore.preview()
        store.notes.installPreviewState(pending: PreviewMocks.pendingNotes)
        snapshot(
            PendingNotesDiagnosticSheet().environment(store),
            name: "145-unsent-notes-diagnostics",
            size: CGSize(width: 393, height: 852)
        )
    }

    func testPendingNotesDiagnosticSheetClear() {
        snapshot(
            PendingNotesDiagnosticSheet().environment(AppStore.preview()),
            name: "146-unsent-notes-clear",
            size: CGSize(width: 393, height: 600)
        )
    }

    func testPendingNotesDiagnosticSheetPresented() {
        snapshotPresented(
            PendingNotesPresentedPreview(),
            name: "147-unsent-notes-presented"
        )
    }

    /// Queued because the gateway is too old for notes — honest
    /// "Saved on device" copy instead of pretending it'll sync soon.
    func testCaptureQueuedFeatureOff() {
        let view = CaptureView(
            speech: .preview(state: .idle),
            previewText: "Buy a spare charger for the office",
            previewPhase: .done(.queued(.featureOff))
        )
        .environment(AppStore.preview())
        snapshot(view, name: "151-capture-queued-feature-off")
    }

    /// Queued because the pairing token was refused — re-pair copy.
    func testCaptureQueuedUnauthorized() {
        let view = CaptureView(
            speech: .preview(state: .idle),
            previewText: "Buy a spare charger for the office",
            previewPhase: .done(.queued(.unauthorized))
        )
        .environment(AppStore.preview())
        snapshot(view, name: "152-capture-queued-unauthorized")
    }

    /// Deterministic rejection: the note stays in the editor with an
    /// inline warning line above the Done button.
    func testCaptureNoteRejected() {
        let view = CaptureView(
            speech: .preview(state: .idle),
            previewText: "Idea: use the garage wall for the climbing holds",
            previewSaveError: "The gateway rejected this note (422). Edit it and try again."
        )
        .environment(AppStore.preview())
        snapshot(view, name: "153-capture-note-rejected")
    }

    /// The watch-firing card pinned above a thread the agent opened on its
    /// own — the reader's only answer to "why am I reading this".
    func testWatchFiringContextCard() {
        let view = ScrollView {
            WatchFiringContextCard(
                snapshot: PreviewMocks.watchFiringOrigin,
                watchId: PreviewMocks.watchFiringOriginWatchId
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(NotificationRouter())
        snapshot(view, name: "179-watch-firing-context-card")
    }

    /// The same card at its text extremes — a name that wraps and a
    /// condition several lines long — in dark mode.
    func testWatchFiringContextCardLongConditionDark() {
        let view = ScrollView {
            WatchFiringContextCard(
                snapshot: WatchFiringOriginSnapshot(
                    name: "Anything about the Northstar rebuild that needs a decision from me this quarter",
                    condition: "a contractor, the architect or the council sends anything about "
                        + "the Northstar rebuild that needs a decision, a signature or a payment from me",
                    firedAt: 1_789_344_600_000
                ),
                watchId: PreviewMocks.longWatchFiringOriginWatchId
            )
            .padding()
        }
        .background(Theme.bgPrimary)
        .environment(\.colorScheme, .dark)
        .environment(NotificationRouter())
        snapshot(view, name: "180-watch-firing-context-card-long-dark")
    }

    /// An origin created before watch IDs were stored remains readable and
    /// does not imply that tapping can open a watch.
    func testWatchFiringContextCardLegacyOrigin() {
        let view = ScrollView {
            WatchFiringContextCard(snapshot: PreviewMocks.watchFiringOrigin, watchId: nil)
                .padding()
        }
        .background(Theme.bgPrimary)
        .environment(NotificationRouter())
        snapshot(view, name: "181-watch-firing-context-card-legacy")
    }

    /// The custom `omnesis.mic` symbol (Omnesis mark + microphone) the
    /// Control Center button uses. A ControlWidget can't be hosted in a
    /// test, so this renders the compiled symbol as a tinted template at
    /// control-glyph sizes plus a Control-Center-style chip, to confirm
    /// the hand-authored SF Symbols template compiled to a correctly
    /// sized, legible glyph.
    func testControlIconOmnesisMic() {
        let view = VStack(spacing: 28) {
            // Custom symbol vs. the stock mic.badge.plus at identical
            // point sizes — the custom glyph should render at least as
            // large, so it doesn't look shrunken in the control.
            ForEach([34, 48], id: \.self) { pt in
                HStack(spacing: 40) {
                    Image("omnesis.mic")
                        .font(.system(size: CGFloat(pt)))
                        .foregroundStyle(Theme.brandLogo)
                    Image(systemName: "mic.badge.plus")
                        .font(.system(size: CGFloat(pt)))
                        .foregroundStyle(.secondary)
                }
            }
            ZStack {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(.secondary.opacity(0.22))
                    .frame(width: 132, height: 132)
                Image("omnesis.mic")
                    .font(.system(size: 62))
                    .foregroundStyle(.primary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
        snapshot(view, name: "164-control-icon-omnesis-mic", size: CGSize(width: 360, height: 380))
    }

    func testDevAnnotationComposerDocument() {
        let store = AppStore.preview()
        snapshot(
            DevAnnotationComposer(target: .document("doc-1", label: "Re: Q4 budget review"))
                .environment(store),
            name: "70-dev-annotation-composer-document"
        )
    }

    func testDevAnnotationComposerRoute() {
        let store = AppStore.preview()
        snapshot(
            DevAnnotationComposer(target: .route("iOS app"))
                .environment(store),
            name: "71-dev-annotation-composer-route"
        )
    }

    func testSourcePermissionHealthScreen() {
        let store = AppStore.preview(sourcePermissionHealth: PreviewMocks.sourcePermissionHealth)
        snapshot(
            NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }.environment(store),
            name: "181-source-permissions-degraded"
        )
    }

    func testSourcePermissionHealthNotEvaluated() {
        snapshot(
            NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
                .environment(AppStore.preview()),
            name: "183-source-permissions-not-evaluated"
        )
    }

    func testSourcePermissionHealthLoading() {
        snapshot(
            NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
                .environment(AppStore.preview(sourcePermissionHealthLoading: true)),
            name: "184-source-permissions-loading"
        )
    }

    func testSourcePermissionHealthGatewayUpdateDeferred() {
        snapshot(
            NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
                .environment(AppStore.preview(
                    sourcePermissionHealth: PreviewMocks.sourcePermissionHealth,
                    sourcePermissionHealthDeferred: ["fictional-mobile:local"]
                )),
            name: "189-source-permissions-gateway-update-deferred",
            size: CGSize(width: 393, height: 1000)
        )
    }

    func testSourcePermissionHealthFocusedProblemResolved() {
        snapshot(
            NavigationStack {
                SourcePermissionHealthView(
                    refreshOnAppear: false,
                    focusedSourceId: "fictional-mobile:resolved"
                )
            }
            .environment(AppStore.preview(sourcePermissionHealth: PreviewMocks.sourcePermissionHealth)),
            name: "190-source-permissions-focused-resolved"
        )
    }

    func testSourcePermissionHealthHealthy() {
        snapshot(
            NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
                .environment(AppStore.preview(sourcePermissionHealth: [
                    PhotosPermissionHealth.report(access: .full, backgroundRefresh: .available),
                ])),
            name: "185-source-permissions-healthy"
        )
    }

    func testSourcePermissionHealthUnknown() {
        snapshot(
            NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
                .environment(AppStore.preview(sourcePermissionHealth: [
                    AppleHealthPermissionHealth.report(backgroundRefresh: .available),
                ])),
            name: "188-source-permissions-unknown"
        )
    }

    func testSourcePermissionHealthLongCopy() {
        snapshot(
            NavigationStack { SourcePermissionHealthView(refreshOnAppear: false) }
                .environment(AppStore.preview(sourcePermissionHealth: PreviewMocks.longSourcePermissionHealth)),
            name: "186-source-permissions-long-copy",
            size: CGSize(width: 393, height: 1000)
        )
    }

    func testRemoteSourcePermissionDoesNotRenderLocalHealthOrRepairActions() {
        snapshot(
            NavigationStack {
                RemoteSourcePermissionView(
                    sourceId: "fictional-mobile:local",
                    deviceId: "11111111-1111-4111-8111-111111111111",
                    sourceName: "Fictional Mobile Source",
                    deviceName: "Fictional iPhone"
                )
            },
            name: "187-source-permissions-remote-device"
        )
    }

    func testGlobalAttentionBannerComposesNotificationAndSourceWarnings() {
        let store = AppStore.preview(sourcePermissionHealth: PreviewMocks.sourcePermissionHealth)
        snapshot(
            AppAttentionBanner(
                problems: store.degradedSourcePermissions,
                notificationWarning: PushDeliveryHealth.permissionDenied.warning,
                onOpenPermissions: {},
                onOpenNotificationSettings: {}
            ),
            name: "182-global-attention-banner",
            size: CGSize(width: 393, height: 150)
        )
    }

    func testGlobalAttentionBannerNotificationDismissCross() {
        let store = AppStore.preview(sourcePermissionHealth: PreviewMocks.sourcePermissionHealth)
        snapshot(
            AppAttentionBanner(
                problems: store.degradedSourcePermissions,
                notificationWarning: PushDeliveryHealth.permissionDenied.warning,
                onOpenPermissions: {},
                onOpenNotificationSettings: {},
                onDismissNotification: {}
            ),
            name: "182b-global-attention-banner-dismiss",
            size: CGSize(width: 393, height: 150)
        )
    }

    func testHomeShellShowsMissingPushSetupAfterGatewayPlan() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pushGatewayConfiguration: .noDirectCredential,
            pushConfigurationAppId: PreviewMocks.independentlySignedAppId,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        snapshot(
            HomeView()
                .environment(store)
                .environment(store.notificationRouter),
            name: "192-home-push-setup-warning"
        )
    }

    func testSettingsRootShowsPermissionRepairEntry() {
        let store = AppStore.preview(
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            sourcePermissionHealth: PreviewMocks.sourcePermissionHealth
        )
        snapshot(
            SettingsView(initialDestination: .root, previewData: true).environment(store),
            name: "189-settings-source-permission-warning"
        )
    }

    func testHomeShellIntegratesPermissionAttentionBanner() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            sourcePermissionHealth: PreviewMocks.sourcePermissionHealth,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        snapshot(
            HomeView()
                .environment(store)
                .environment(store.notificationRouter),
            name: "190-home-source-permission-banner"
        )
    }

    func testAccessAuthorizationCodeGate() {
        snapshot(
            AccessAuthorizationSheet()
                .environment(AppStore.preview()),
            name: "191-access-authorization-code"
        )
    }

    /// The home screen with one access request waiting: the banner sits
    /// above the section, and above the permission banner when both show.
    func testHomeShellShowsWaitingAccessRequestBanner() {
        let store = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            pendingAccessRequests: [PreviewMocks.accessPendingRequests[0]],
            agentPreview: PreviewMocks.agentConversationsRich
        )
        snapshot(
            HomeView()
                .environment(store)
                .environment(store.notificationRouter),
            name: "197-home-access-request-banner"
        )
        let stacked = AppStore.preview(
            sources: PreviewMocks.sources,
            statusesBySource: PreviewMocks.syncStatuses,
            deviceNames: PreviewMocks.deviceNames,
            statusSnapshot: PreviewMocks.statusSnapshot,
            indexStats: PreviewMocks.indexStats,
            sourcePermissionHealth: PreviewMocks.sourcePermissionHealth,
            pendingAccessRequests: PreviewMocks.accessPendingRequests,
            agentPreview: PreviewMocks.agentConversationsRich
        )
        snapshot(
            HomeView()
                .environment(stacked)
                .environment(stacked.notificationRouter),
            name: "197c-home-access-request-and-permission-banners"
        )
    }

    /// The banner on its own: several requests share one row, a long client
    /// name is cut rather than wrapped, and Configure & Approve moves under
    /// the client name on a narrow screen and at a large type size.
    func testAccessPendingRequestBannerStates() {
        let several = AccessPendingRequestBannerOffer(
            newest: PreviewMocks.accessPendingRequests[0],
            count: PreviewMocks.accessPendingRequests.count
        )
        snapshot(
            AccessPendingRequestBanner(offer: several, onReview: {}, onDismiss: {}),
            name: "197a-access-request-banner-several",
            size: CGSize(width: 393, height: 150)
        )
        let longName = AccessPendingRequestBannerOffer(
            newest: PreviewMocks.accessPendingRequests[1],
            count: 1
        )
        snapshot(
            AccessPendingRequestBanner(offer: longName, onReview: {}, onDismiss: {}),
            name: "197b-access-request-banner-long-client-name",
            size: CGSize(width: 393, height: 150)
        )
        snapshot(
            AccessPendingRequestBanner(offer: several, onReview: {}, onDismiss: {})
                .environment(\.dynamicTypeSize, .accessibility2),
            name: "197d-access-request-banner-large-type",
            size: CGSize(width: 393, height: 360)
        )
        snapshot(
            AccessPendingRequestBanner(offer: several, onReview: {}, onDismiss: {}),
            name: "197f-access-request-banner-narrow",
            size: CGSize(width: 320, height: 150)
        )
    }

    /// A request opened from the banner that the gateway no longer lists:
    /// the sheet falls back to the code form and says the request stopped
    /// waiting, rather than that a code was mistyped.
    func testAccessAuthorizationRequestNoLongerWaiting() {
        snapshot(
            AccessAuthorizationSheet(previewLookupError: AccessAuthorizationLocalError.noLongerPending)
                .environment(AppStore.preview()),
            name: "197e-access-request-no-longer-waiting"
        )
    }

    func testAccessAuthorizationScannedCode() {
        snapshot(
            AccessAuthorizationSheet(
                initialCode: "ABCD-EFGH",
                automaticallyLookup: false
            )
            .environment(AppStore.preview()),
            name: "191a-access-authorization-scanned-code"
        )
    }

    func testAccessAuthorizationPermissionsLargeType() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .permissions
            )
            .environment(AppStore.preview())
            .environment(\.dynamicTypeSize, .accessibility2),
            name: "193-access-authorization-permissions-large-type",
            size: CGSize(width: 393, height: 1500)
        )
    }

    func testAccessAuthorizationNotesOnly() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .notesOnly
            )
            .environment(AppStore.preview()),
            name: "193b-access-authorization-notes-only",
            size: CGSize(width: 393, height: 900)
        )
    }

    func testAccessAuthorizationPermissions() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .permissions
            )
            .environment(AppStore.preview()),
            name: "193a-access-authorization-permissions",
            size: CGSize(width: 393, height: 1100)
        )
    }

    func testAccessAuthorizationDataAndPrivacy() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .data
            )
            .environment(AppStore.preview()),
            name: "193b-access-authorization-data",
            size: CGSize(width: 393, height: 1100)
        )
    }

    func testAccessAuthorizationSharedSources() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .sharedSources
            )
            .environment(AppStore.preview()),
            name: "193d-access-authorization-shared-sources",
            size: CGSize(width: 393, height: 1400)
        )
    }

    func testAccessAuthorizationAllSources() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .allSources
            )
            .environment(AppStore.preview()),
            name: "193f-access-authorization-all-sources",
            size: CGSize(width: 393, height: 1100)
        )
    }

    /// The reviewed branch of Answer privacy: the policy this grant would be
    /// judged against can be opened and read before it is agreed to.
    func testAccessAuthorizationPolicyLink() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverviewWithoutSources,
                mode: .data
            )
            .environment(AppStore.preview()),
            name: "193h-access-authorization-policy-link",
            size: CGSize(width: 393, height: 1200)
        )
    }

    /// The review of a new connection on a new access level.
    func testAccessAuthorizationReview() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .review
            )
            .environment(AppStore.preview()),
            name: "193c-access-authorization-review",
            size: CGSize(width: 393, height: 800)
        )
    }

    func testAccessAuthorizationSuccess() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .success
            )
            .environment(AppStore.preview()),
            name: "193d-access-authorization-success",
            size: CGSize(width: 393, height: 800)
        )
    }

    func testAccessAuthorizationDenied() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .denied
            )
            .environment(AppStore.preview()),
            name: "193e-access-authorization-denied",
            size: CGSize(width: 393, height: 800)
        )
    }

    func testAccessAuthorizationExpired() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.expiredAccessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .review
            )
            .environment(AppStore.preview()),
            name: "193g-access-authorization-expired",
            size: CGSize(width: 393, height: 800)
        )
    }

    func testAccessAuthorizationUnreviewedAcknowledgement() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverviewWithoutSources,
                mode: .unreviewed
            )
            .environment(AppStore.preview()),
            name: "194-access-authorization-unreviewed",
            size: CGSize(width: 393, height: 1200)
        )
    }

    /// A first-time agent: the Connection step opens on a new access level named after it, each name field on its label's line.
    func testAccessAuthorizationConnectionNewLevel() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .connectionNewLevel
            )
            .environment(AppStore.preview()),
            name: "195-access-authorization-connection-new-level",
            size: CGSize(width: 393, height: 1300)
        )
    }

    /// The same step at a large type size: each name label sits above its field.
    func testAccessAuthorizationConnectionNewLevelLargeType() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .connectionNewLevel
            )
            .environment(AppStore.preview())
            .environment(\.dynamicTypeSize, .accessibility2),
            name: "195q-access-authorization-connection-new-level-large-type",
            size: CGSize(width: 393, height: 2800)
        )
    }

    /// A recognised agent: the level its connection uses is listed first, tagged and preselected.
    func testAccessAuthorizationConnectionExistingLevelSuggested() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .connectionExistingLevel
            )
            .environment(AppStore.preview()),
            name: "195a-access-authorization-connection-existing-level-suggested",
            size: CGSize(width: 393, height: 1300)
        )
    }

    /// An agent signing in again on its device: replace mode with its connection preselected, tagged Suggested in its row.
    func testAccessAuthorizationConnectionReplaceSuggested() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .connectionReplaceSuggested
            )
            .environment(AppStore.preview()),
            name: "195b-access-authorization-connection-replace-suggested",
            size: CGSize(width: 393, height: 1000)
        )
    }

    /// Replace mode with another connection picked: the suggestion stays in the recognised connection's row.
    func testAccessAuthorizationConnectionReplaceSuggestedOtherPicked() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .connectionReplaceOtherPicked
            )
            .environment(AppStore.preview()),
            name: "195r-access-authorization-connection-replace-suggested-other-picked",
            size: CGSize(width: 393, height: 1000)
        )
    }

    /// The suggested replace row at a large type size: the Suggested tag moves under the name once both do not fit.
    func testAccessAuthorizationConnectionReplaceSuggestedLargeType() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .connectionReplaceSuggested
            )
            .environment(AppStore.preview())
            .environment(\.dynamicTypeSize, .accessibility2),
            name: "195s-access-authorization-connection-replace-suggested-large-type",
            size: CGSize(width: 393, height: 2400)
        )
    }

    /// Replace mode opened by the owner: live connections with their levels and last use, none picked.
    func testAccessAuthorizationConnectionReplacePicker() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .connectionReplacePicker
            )
            .environment(AppStore.preview()),
            name: "195c-access-authorization-connection-replace-picker",
            size: CGSize(width: 393, height: 1000)
        )
    }

    /// An agent that asks through Answer: the level without Answer is listed but disabled with its reason.
    func testAccessAuthorizationConnectionNeedsAnswer() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequestRequiringAnswer,
                overview: PreviewMocks.accessOverview,
                mode: .connectionExistingLevel
            )
            .environment(AppStore.preview()),
            name: "195d-access-authorization-connection-needs-answer",
            size: CGSize(width: 393, height: 1300)
        )
    }

    /// No levels and no connections: only a new level is offered, and there is no way into replace mode.
    func testAccessAuthorizationConnectionWithoutLevels() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverviewWithoutConnections,
                mode: .connectionNewLevel
            )
            .environment(AppStore.preview()),
            name: "195e-access-authorization-connection-no-levels",
            size: CGSize(width: 393, height: 900)
        )
    }

    /// A level name the gateway refused: the refusal sits under the Access level name field, not in the banner.
    func testAccessAuthorizationLevelNameTaken() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .levelNameTaken
            )
            .environment(AppStore.preview()),
            name: "195f-access-authorization-level-name-taken",
            size: CGSize(width: 393, height: 1300)
        )
    }

    /// A new level name a listed level already has, in another case: the field says so and Continue is disabled.
    func testAccessAuthorizationLevelNameClash() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .levelNameClash
            )
            .environment(AppStore.preview()),
            name: "195p-access-authorization-level-name-clash",
            size: CGSize(width: 393, height: 1300)
        )
    }

    /// The review of a connection on a shared level, with the footnote naming how many others it changes.
    func testAccessAuthorizationExistingLevelReview() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .existingLevelReview
            )
            .environment(AppStore.preview()),
            name: "195g-access-authorization-existing-level-review",
            size: CGSize(width: 393, height: 950)
        )
    }

    /// The review of a replacement: the connection keeps its name and level, and the current sign-in is named.
    func testAccessAuthorizationReplaceReview() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .replaceReview
            )
            .environment(AppStore.preview()),
            name: "195h-access-authorization-replace-review",
            size: CGSize(width: 393, height: 950)
        )
    }

    /// A recognised agent at a large type size: the Suggested tag sits beside the level name while both fit, under it otherwise.
    func testAccessAuthorizationConnectionExistingLevelLargeType() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .connectionExistingLevel
            )
            .environment(AppStore.preview())
            .environment(\.dynamicTypeSize, .accessibility2),
            name: "195j-access-authorization-connection-existing-level-large-type",
            size: CGSize(width: 393, height: 2600)
        )
    }

    /// Replace mode for an agent that asks through Answer: the Notes-only connection is listed, disabled, with its reason.
    func testAccessAuthorizationConnectionReplaceUnavailable() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequestRequiringAnswer,
                overview: PreviewMocks.accessOverviewWithNotesConnection,
                mode: .connectionReplacePicker
            )
            .environment(AppStore.preview()),
            name: "195k-access-authorization-connection-replace-unavailable",
            size: CGSize(width: 393, height: 1200)
        )
    }

    /// Connection and level names at the 120-character limit wrap in the level rows and the name field.
    func testAccessAuthorizationConnectionLongNames() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverviewWithLongNames,
                mode: .connectionLongNames
            )
            .environment(AppStore.preview()),
            name: "195l-access-authorization-connection-long-names",
            size: CGSize(width: 393, height: 1600)
        )
    }

    /// The same 120-character names in the replace list, with the level each connection uses.
    func testAccessAuthorizationConnectionReplaceLongNames() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverviewWithLongNames,
                mode: .connectionLongNamesReplace
            )
            .environment(AppStore.preview()),
            name: "195m-access-authorization-connection-replace-long-names",
            size: CGSize(width: 393, height: 1300)
        )
    }

    /// The review of a 120-character connection on a 120-character level.
    func testAccessAuthorizationLongNamesReview() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverviewWithLongNames,
                mode: .longNamesReview
            )
            .environment(AppStore.preview()),
            name: "195n-access-authorization-long-names-review",
            size: CGSize(width: 393, height: 1150)
        )
    }

    /// The review of a connection on a level no other connection uses: no footnote.
    func testAccessAuthorizationExistingLevelAloneReview() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .existingLevelAloneReview
            )
            .environment(AppStore.preview()),
            name: "195o-access-authorization-existing-level-alone-review",
            size: CGSize(width: 393, height: 900)
        )
    }

    /// A gateway without connection proposals: no Connection step, the permissions flow on its own.
    func testAccessAuthorizationOldGateway() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .oldGateway
            )
            .environment(AppStore.preview()),
            name: "195i-access-authorization-old-gateway",
            size: CGSize(width: 393, height: 1100)
        )
    }

    func testAccessAuthorizationConflict() {
        snapshot(
            AccessAuthorizationSheet(
                previewRequest: PreviewMocks.accessAuthorizationRequest,
                overview: PreviewMocks.accessOverview,
                mode: .conflict
            )
            .environment(AppStore.preview()),
            name: "196-access-authorization-conflict",
            size: CGSize(width: 393, height: 1150)
        )
    }

    // MARK: - Audit — the Direct transcript sessions

    /// The Direct session list: a named agent on a conversation key, an
    /// unnamed workflow session, a heuristic grouping marker, and a
    /// newer-gateway key shown verbatim — each with its call count.
    func testDirectAuditSessions() {
        let view = NavigationStack {
            DirectAuditPane(previewSessions: PreviewMocks.directAuditSessions)
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112i-direct-audit-sessions", size: CGSize(width: 393, height: 900))
    }

    func testDirectAuditSessionsEmpty() {
        let view = NavigationStack {
            DirectAuditPane(previewSessions: [])
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112j-direct-audit-empty", size: CGSize(width: 393, height: 600))
    }

    func testDirectAuditSessionsLoading() {
        let view = NavigationStack {
            DirectAuditPane(previewSessions: [], previewLoading: true)
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112k-direct-audit-loading", size: CGSize(width: 393, height: 400))
    }

    func testDirectAuditSessionsError() {
        let view = NavigationStack {
            DirectAuditPane(
                previewSessions: [],
                previewLoadError: URLError(.cannotConnectToHost)
            )
        }
        .environment(AppStore.preview())
        snapshot(
            view,
            name: "112l-direct-audit-error",
            size: CGSize(width: 393, height: 700)
        )
    }

    /// A gateway from before the Direct boundary: the tab names the remedy
    /// instead of failing, and the Answer tab is unaffected.
    func testDirectAuditSessionsUnsupportedGateway() {
        let view = NavigationStack {
            DirectAuditPane(previewSessions: [], previewUnsupported: true)
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112m-direct-audit-unsupported", size: CGSize(width: 393, height: 600))
    }

    /// The transcript as flat cards: a settled search batch with a failed
    /// child, a person match, a SQL failure, a URL match, and a refused call
    /// reading "No result recorded." — no wrappers, no outcome chips.
    func testDirectTranscriptWithCards() {
        let view = NavigationStack {
            DirectTranscriptView(
                previewSession: PreviewMocks.directAuditSessions[0],
                previewEvents: PreviewMocks.directAuditSessionEvents,
                previewPayloads: PreviewMocks.directAuditPayloads
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112n-direct-transcript", size: CGSize(width: 393, height: 2200))
    }

    /// One call whose payload fetch failed: the inline error banner stands
    /// where the card would, and the settled siblings still render.
    func testDirectTranscriptCallError() {
        let view = NavigationStack {
            DirectTranscriptView(
                previewSession: PreviewMocks.directAuditSessions[0],
                previewEvents: PreviewMocks.directAuditSessionEvents,
                previewPayloads: PreviewMocks.directAuditPayloads.filter { $0.key != "direct_event_preview_02" },
                previewPayloadErrors: ["direct_event_preview_02": "Couldn't connect to gateway."]
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112n2-direct-transcript-call-error", size: CGSize(width: 393, height: 2200))
    }

    func testDirectTranscriptAnswerAttempts() {
        // Attempt 1 pairs tool_use/tool_result parts from the stored wire
        // shape; Attempt 2 settles a fetch. Guards the "No tool calls were
        // recorded" pairing regression.
        let view = NavigationStack {
            PrivacyAgentTranscriptsView(
                traces: PreviewMocks.privacyAgentTraces,
                omittedAttempts: 0
            )
            .padding()
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112n3-transcript-answer-attempts", size: CGSize(width: 393, height: 1200))
    }

    func testDirectTranscriptEmpty() {
        let view = NavigationStack {
            DirectTranscriptView(
                previewSession: PreviewMocks.directAuditSessions[1],
                previewEvents: []
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112o-direct-transcript-empty", size: CGSize(width: 393, height: 500))
    }

    func testDirectTranscriptLoading() {
        let view = NavigationStack {
            DirectTranscriptView(
                previewSession: PreviewMocks.directAuditSessions[0],
                previewEvents: [],
                previewLoading: true
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112p-direct-transcript-loading", size: CGSize(width: 393, height: 500))
    }

    func testDirectTranscriptError() {
        let view = NavigationStack {
            DirectTranscriptView(
                previewSession: PreviewMocks.directAuditSessions[0],
                previewEvents: [],
                previewLoadError: URLError(.cannotConnectToHost)
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112q-direct-transcript-error", size: CGSize(width: 393, height: 700))
    }

    func testDirectTranscriptDeleteFailed() {
        let view = NavigationStack {
            DirectTranscriptView(
                previewSession: PreviewMocks.directAuditSessions[0],
                previewEvents: PreviewMocks.directAuditSessionEvents,
                previewPayloads: PreviewMocks.directAuditPayloads,
                previewDeleteError: "The transcript could not be deleted. Nothing changed."
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112r-direct-transcript-delete-failed", size: CGSize(width: 393, height: 2200))
    }

    /// The flat cards side by side: search batch, person match, SQL rowblock,
    /// error, matched-but-empty, and a future tool's generic header — each
    /// with its instant and raw-JSON affordance on the trailing edge.
    func testDirectToolCards() {
        let view = ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                DirectToolCardView(
                    tool: "search_many",
                    content: PreviewMocks.directSearchCard,
                    timeText: "9:41 AM",
                    rawPayload: PreviewMocks.directAuditPayloads["direct_event_preview_01"]
                )
                DirectToolCardView(
                    tool: "lookup_people",
                    content: PreviewMocks.directPeopleCard,
                    timeText: "9:42 AM",
                    rawPayload: PreviewMocks.directAuditPayloads["direct_event_preview_02"]
                )
                DirectToolCardView(
                    tool: "run_sql",
                    content: PreviewMocks.directSqlCard,
                    timeText: "9:43 AM",
                    rawPayload: PreviewMocks.directAuditPayloads["direct_event_preview_03"]
                )
                DirectToolCardView(
                    tool: "run_sql",
                    content: PreviewMocks.directErrorCard,
                    timeText: "9:44 AM",
                    rawPayload: PreviewMocks.directAuditPayloads["direct_event_preview_03"]
                )
                DirectToolCardView(
                    tool: "lookup_people",
                    content: PreviewMocks.directEmptyCard,
                    timeText: "9:45 AM"
                )
                DirectToolCardView(
                    tool: "future_tool",
                    content: PreviewMocks.directUnknownToolCard,
                    timeText: "9:46 AM",
                    rawPayload: PreviewMocks.directAuditPayloads["direct_event_preview_01"]
                )
            }
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
        snapshot(view, name: "112s-direct-tool-cards", size: CGSize(width: 393, height: 2200))
    }

    /// The full payload behind the trailing raw affordance: scrollable mono
    /// pretty-printed JSON titled "Search — raw JSON", presented as a sheet.
    func testDirectToolCardRawSheet() {
        snapshotPresented(
            DirectRawSheetPresentedPreview(),
            name: "112t-direct-tool-card-raw-sheet"
        )
    }

    /// An exchange with stored agent transcripts: two attempt sections under
    /// the draft card (the first open, with its tool card), the truncated
    /// note, and the omitted-attempt note.
    func testPrivacyExchangeWithAgentTraces() {
        let view = NavigationStack {
            PrivacyExchangeDetailView(
                previewExchange: PreviewMocks.privacyExchangeWithTraces,
                previewEvents: []
            )
        }
        .environment(AppStore.preview())
        snapshot(view, name: "112u-privacy-exchange-traces", size: CGSize(width: 393, height: 2200))
    }
}

/// Integrity guard for the snapshot suite's write path (epic #804, C15b): a write
/// failure must SURFACE, not be swallowed — guards against reverting the render
/// write-site to `try?`. Lives in its own XCTestCase so the per-test "≥1 PNG"
/// gate in `PreviewSnapshotTests` does not apply to a test that writes nothing.
@MainActor
final class PreviewSnapshotWriteIntegrityTests: XCTestCase {
    private func tinyImage() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { ctx in
            UIColor.systemBlue.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
    }

    func testWriteFailsLoudlyOnUnwritablePath() {
        // A path under a directory that does not exist cannot be written; the
        // shared writer must THROW, proving the snapshot suite surfaces — never
        // swallows — a write failure.
        let unwritable = URL(fileURLWithPath: "/nonexistent-\(UUID().uuidString)/snap.png")
        XCTAssertThrowsError(try PreviewSnapshotTests.writeSnapshotPNG(tinyImage(), to: unwritable))
    }

    func testWriteSucceedsToWritablePath() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("omnesis-snap-\(UUID().uuidString).png")
        try PreviewSnapshotTests.writeSnapshotPNG(tinyImage(), to: url)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        try? FileManager.default.removeItem(at: url)
    }
}

/// Shows a step page, then changes its outcome in place a moment later, the
/// way the flow does after the user returns from iOS Settings.
private struct PhoneSetupInPlaceOutcomeProbe: View {
    let coordinator: PhoneSetupCoordinator
    let changed: PhoneSetupFlow

    var body: some View {
        PhoneSetupView(coordinator: coordinator)
            .task {
                try? await Task.sleep(for: .milliseconds(300))
                coordinator.installPreview(flow: changed)
            }
    }
}
