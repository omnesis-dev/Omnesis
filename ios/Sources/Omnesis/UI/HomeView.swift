// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// A sheet the queue asked for that never appeared, kept so its retry turn can
/// ask for it again.
@available(iOS 17.0, *)
private enum StalledHomeSheet {
    case settings(SettingsDestination)
    case accessAuthorization(AccessAuthorizationPresentation)
    case privacyApproval(PrivacyApprovalPresentation)
}

/// One review sheet: opened on a scanned code, on the code form, or straight
/// onto a request the overview lists as waiting.
@available(iOS 17.0, *)
private struct AccessAuthorizationPresentation: Identifiable {
    let id = UUID()
    let initialCode: String?
    var requestId: String?
}

/// One waiting privacy decision, opened by the app rather than by the owner.
@available(iOS 17.0, *)
private struct PrivacyApprovalPresentation: Identifiable {
    let id: String
}

// MARK: - Deferred presentations

@available(iOS 17.0, *)
extension HomeView {
    /// Keeps the deferred-presentation queue moving: requests arrive from
    /// routers and the store, and turns pass as the gate opens and the screen
    /// frees. Kept apart from `homeChrome` so neither chain is too long for
    /// the type checker.
    private func tracksDeferredPresentations(_ content: some View) -> some View {
        content
            .onChange(of: router.pendingTarget) { _, target in
                guard target != nil else { return }
                invalidateAutomaticForegroundWork()
                requestDeferred(.pushTarget)
            }
            .onChange(of: store.relayPushConsentRequest) { _, request in
                // A request that arrives or goes while setup is open adds or drops its step.
                store.phoneSetup.syncAutomaticSteps()
                if request == nil {
                    store.phoneSetup.withdrawDeferredPresentation(.relayConsent)
                    store.phoneSetup.finishDeferredPresentation(.relayConsent)
                    presentDeferred()
                } else {
                    requestDeferred(.relayConsent)
                }
            }
            .onChange(of: store.phoneSetup.isGateActive) { _, _ in
                presentDeferred()
            }
            .onChange(of: screen) { old, new in
                guard new.isFree else { return }
                store.phoneSetup.settleDeferredPresentations(on: new)
                // A sheet that just closed presents the next one from its dismissal.
                guard DeferredPresentationQueue.presentsWhenScreenChanges(from: old, to: new) else { return }
                presentDeferred()
            }
    }

    /// What home has on screen, as the deferred-presentation queue reads it.
    private var screen: DeferredPresentationScreen {
        DeferredPresentationScreen(
            settings: settingsDestination != nil,
            accessAuthorization: accessAuthorizationPresentation != nil,
            privacyApproval: privacyApprovalPresentation != nil,
            privacyLookup: privacyApprovalLookupInFlight,
            capture: showCapture,
            relayConsent: store.relayPushConsentRequest != nil
        )
    }

    /// Whether anything home presents is on screen.
    private var isScreenFree: Bool {
        screen.isFree
    }

    private func closeHomeSheets() {
        settingsDestination = nil
        accessAuthorizationPresentation = nil
        privacyApprovalPresentation = nil
    }

    private func requestDeferred(_ presenter: DeferredPresenter) {
        let gateOpen = !store.phoneSetup.isGateActive
        guard DeferredPresentationQueue.admits(presenter, gateOpen: gateOpen, screenIsFree: isScreenFree) else { return }
        store.phoneSetup.requestDeferredPresentation(presenter)
        // Something the user just asked for replaces whatever sheet home has up.
        // That sheet is still leaving the screen, so the request presents from
        // its dismissal rather than now.
        if DeferredPresentationQueue.preempts(presenter, gateOpen: gateOpen), screen.hasSheet {
            closeHomeSheets()
            return
        }
        presentDeferred()
    }

    /// One of home's sheets has finished leaving the screen.
    private func sheetDidDismiss() {
        presentDeferred()
    }

    /// Checks, once a sheet has had time to appear, that it did.
    private func scheduleStalledPresentationCheck() {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(Int(DeferredPresentationQueue.appearanceTimeout * 1000) + 100))
            expireStalledPresentation()
        }
    }

    /// A sheet the queue asked for that never came up gives its turn back and
    /// is asked for once more. Nothing presented, so nothing will dismiss:
    /// the queue moves on straight away.
    private func expireStalledPresentation() {
        guard store.phoneSetup.expireUnappearedDeferredPresentation(on: screen) != nil else { return }
        if let settingsDestination {
            stalledSheet = .settings(settingsDestination)
        } else if let accessAuthorizationPresentation {
            stalledSheet = .accessAuthorization(accessAuthorizationPresentation)
        } else if let privacyApprovalPresentation {
            stalledSheet = .privacyApproval(privacyApprovalPresentation)
        }
        closeHomeSheets()
        Task { @MainActor in presentDeferred() }
    }

    /// Asks again for a sheet that stalled on this presenter's previous turn.
    private func resumeStalledSheet(for presenter: DeferredPresenter) -> Bool {
        switch (presenter, stalledSheet) {
        case (.pushTarget, .settings(let destination)?):
            settingsDestination = destination
        case (.pushTarget, .accessAuthorization(let presentation)?),
             (.accessAuthorization, .accessAuthorization(let presentation)?):
            accessAuthorizationPresentation = presentation
        case (.privacyApproval, .privacyApproval(let presentation)?):
            privacyApprovalPresentation = presentation
        default:
            return false
        }
        stalledSheet = nil
        return true
    }

    /// Presents waiting automatic presentations one at a time, once phone setup
    /// has released the screen and nothing else is on it. A turn whose
    /// presentation has already gone ends first, so it cannot hold the queue,
    /// and a presenter that leaves nothing on screen hands the turn straight on.
    private func presentDeferred() {
        store.phoneSetup.settleDeferredPresentations(on: screen)
        while let presenter = store.phoneSetup.nextDeferredPresentation(screenIsFree: isScreenFree) {
            guard !present(presenter) else { return }
            store.phoneSetup.finishDeferredPresentation(presenter)
        }
    }

    /// Returns whether the presenter put something on screen that closes later.
    /// A sheet it asks for is checked for appearing.
    private func present(_ presenter: DeferredPresenter) -> Bool {
        let presented = resumeStalledSheet(for: presenter) || presentFresh(presenter)
        if presented, screen.hasSheet(for: presenter) {
            store.phoneSetup.markDeferredPresenting(presenter)
            scheduleStalledPresentationCheck()
        }
        if presented, presenter == .capture {
            // Capture is an overlay inside home: it is on screen at once.
            store.phoneSetup.deferredPresentationDidAppear(.capture)
        }
        return presented
    }

    private func presentFresh(_ presenter: DeferredPresenter) -> Bool {
        switch presenter {
        case .pushTarget: routePendingTarget()
        case .accessAuthorization: presentScannedAccessAuthorization()
        case .capture: presentPendingCapture()
        case .relayConsent: store.relayPushConsentRequest != nil
        case .privacyApproval: startPrivacyApprovalLookup()
        case .composerFocus: focusComposer()
        }
    }

    /// Send a pending push target to its destination.
    private func routePendingTarget() -> Bool {
        guard let target = router.pendingTarget else { return false }
        if case .accessAuthorization = target {
            _ = router.consume()
            accessAuthorizationPresentation = AccessAuthorizationPresentation(initialCode: nil)
            return true
        } else if case .sourcePermission(let sourceId, let affectedDeviceId, let sourceName, let affectedDeviceName) = target {
            _ = router.consume()
            settingsDestination = sourcePermissionDestination(
                sourceId: sourceId,
                affectedDeviceId: affectedDeviceId,
                sourceName: sourceName,
                affectedDeviceName: affectedDeviceName
            )
            return true
        }
        selection = homeTab(for: target)
        return false
    }

    private func presentPendingCapture() -> Bool {
        guard let surface = pendingCaptureSurface else { return false }
        pendingCaptureSurface = nil
        captureSurface = surface
        showCapture = true
        return true
    }

    private func focusComposer() -> Bool {
        agentComposerFocusRequest &+= 1
        return false
    }

    /// Queue a QR handoff once HomeView exists. The root records these before
    /// a paired cold launch finishes constructing its home hierarchy.
    private func consumeAccessAuthorizationRequest() {
        guard accessAuthorizationRouter.requestCount > consumedAccessAuthorizationRequests else { return }
        consumedAccessAuthorizationRequests = accessAuthorizationRouter.requestCount
        requestDeferred(.accessAuthorization)
    }

    private func presentScannedAccessAuthorization() -> Bool {
        guard let pairing = store.pairing,
              let code = accessAuthorizationRouter.consume(
                  pairingKey: OmnesisApp.accessAuthorizationPairingKey(pairing)
              )
        else { return false }
        accessAuthorizationPresentation = AccessAuthorizationPresentation(initialCode: code)
        return true
    }
}

/// App home, post-onboarding. Renders the `HomeTab` sections (see
/// HomeTab.swift); the left-side `MainMenuDrawer` is the only
/// navigation chrome.
@available(iOS 17.0, *)
struct HomeView: View {
    @Environment(NotificationRouter.self) private var router
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: HomeTab = .demoInitialOrAgent
    @State private var menuOpen: Bool = false
    /// Settings is one sheet with an optional initial push destination. The
    /// drawer gear opens its root; setup shortcuts can land one level deeper
    /// while preserving a visible back control to Settings.
    @State private var settingsDestination: SettingsDestination?
    /// Quick-capture presentation shared by the drawer row and the Lock
    /// Screen / Control Center control.
    @State private var showCapture: Bool = false
    /// Generic access-request notifications carry no request authority. A tap
    /// presents the code-gated owner flow; details remain hidden until the
    /// paired phone submits the short code shown by the MCP client.
    @State private var accessAuthorizationPresentation: AccessAuthorizationPresentation?
    /// Which waiting access requests the home banner was dismissed for.
    @State private var accessBannerState = AccessPendingRequestBannerState()
    /// A privacy decision that was already waiting when the app became active.
    /// `PrivacyApprovalAutoOpenPolicy` decides whether it may be offered.
    @State private var privacyApprovalPresentation: PrivacyApprovalPresentation?
    /// One ledger read at a time, and one offer per session — a re-render, a
    /// second foreground transition, or the first render racing the scene
    /// phase must not each mint a presentation.
    @State private var privacyApprovalLookupInFlight = false
    @State private var privacyApprovalOffered = false
    /// Set while the scene is in the background, so the return to `.active`
    /// that follows can be told from the inactive-to-active flicker of a
    /// system alert, Control Center or an incoming-call banner.
    @State private var sceneWasBackgrounded = false
    @State private var captureSurface: NoteSurface = .app
    /// `CaptureRouter.requestCount` values already turned into a
    /// presentation, so re-renders don't re-present.
    @State private var consumedCaptureRequests: Int = 0
    @State private var consumedAccessAuthorizationRequests: Int = 0
    @State private var consumedForegroundRequest: Int = 0
    @State private var agentComposerFocusRequest: Int = 0
    @State private var automaticForegroundTask: Task<Void, Never>?
    /// The surface a queued capture request opens.
    @State private var pendingCaptureSurface: NoteSurface?
    @State private var stalledSheet: StalledHomeSheet?
    private let captureRouter = CaptureRouter.shared
    private let accessAuthorizationRouter = AccessAuthorizationDeepLinkRouter.shared

    init() {
        // Match the navigation bar to the page background so the headers
        // don't look like a separate strip.
        let navAppearance = UINavigationBarAppearance()
        navAppearance.configureWithOpaqueBackground()
        navAppearance.backgroundColor = Theme.UIKit.bgPrimary
        navAppearance.titleTextAttributes = [
            .foregroundColor: Theme.UIKit.textPrimary,
        ]
        navAppearance.largeTitleTextAttributes = [
            .foregroundColor: Theme.UIKit.textPrimary,
        ]
        navAppearance.shadowColor = .clear
        UINavigationBar.appearance().standardAppearance = navAppearance
        UINavigationBar.appearance().scrollEdgeAppearance = navAppearance
        UINavigationBar.appearance().compactAppearance = navAppearance
    }

    private func closeCapture() {
        showCapture = false
    }

    var body: some View {
        tracksDeferredPresentations(homeChrome)
    }

    private var homeChrome: some View {
        // The menu is the layer underneath; the section is what moves. The
        // container owns the whole choreography, including the drag that
        // reveals the menu from anywhere in the leading
        // `MenuReveal.gestureFraction` of the screen, whichever section is on
        // show.
        MenuRevealContainer(isOpen: $menuOpen) {
            MainMenuDrawer(
                isOpen: $menuOpen,
                selection: $selection,
                onOpenSettings: { settingsDestination = .root }
            )
        } content: {
            ZStack {
                sectionContent
                    // Attached to the section rather than the whole container so
                    // the banner travels with the app it is reporting on, instead
                    // of hanging over the menu.
                    .safeAreaInset(edge: .top, spacing: 0) { topBanners }

                // Quick capture rises over the section rather than being
                // presented as a full-screen cover. It still arrives from the
                // bottom, but a cover is its own presentation OUTSIDE this
                // container: the swipe that reveals the menu from every other
                // surface would do nothing on it, and the only way back would be
                // the Cancel button. Inside the container it is a surface like
                // any other.
                if showCapture {
                    CaptureView(surface: captureSurface, onClose: closeCapture)
                        .environment(store)
                        .transition(.move(edge: .bottom))
                }
            }
            .animation(.easeInOut(duration: 0.28), value: showCapture)
        }
        // Lets a gateway-error placeholder deep within any section (e.g.
        // the agent's "no model assigned" first-run state) jump straight
        // to Settings → Configure Models, where the assignment is made.
        // HomeView owns the single Settings-sheet presentation so this route
        // and the drawer gear share the same navigation hierarchy.
        .environment(\.openModelSettings) {
            settingsDestination = .models(initialRole: nil)
            withAnimation(MenuReveal.openCloseAnimation) { menuOpen = false }
        }
        .environment(\.openBackgroundAgentModelSettings) {
            settingsDestination = .models(initialRole: "background-agent")
            withAnimation(MenuReveal.openCloseAnimation) { menuOpen = false }
        }
        .sheet(item: $settingsDestination, onDismiss: sheetDidDismiss) { destination in
            SettingsView(initialDestination: destination)
                .environment(store)
                .omnesisColorScheme()
                .onAppear { store.phoneSetup.deferredPresentationDidAppear(.pushTarget) }
        }
        .sheet(
            item: $accessAuthorizationPresentation,
            onDismiss: {
                // Whatever was decided, the banner must describe what is still
                // waiting rather than the request just reviewed.
                Task { await store.refreshPendingAccessRequests() }
                sheetDidDismiss()
            },
            content: { presentation in
                Group {
                    if let requestId = presentation.requestId {
                        AccessAuthorizationSheet(requestId: requestId)
                    } else {
                        AccessAuthorizationSheet(initialCode: presentation.initialCode)
                    }
                }
                .environment(store)
                .omnesisColorScheme()
                .onAppear {
                    store.phoneSetup.deferredPresentationDidAppear(.accessAuthorization)
                    store.phoneSetup.deferredPresentationDidAppear(.pushTarget)
                }
            }
        )
        .sheet(item: $privacyApprovalPresentation, onDismiss: sheetDidDismiss) { presentation in
            PrivacyApprovalSheet(approvalId: presentation.id)
                .environment(store)
                .omnesisColorScheme()
                .onAppear { store.phoneSetup.deferredPresentationDidAppear(.privacyApproval) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                sceneWasBackgrounded = true
                store.phoneSetup.appDidEnterBackground()
            case .active where sceneWasBackgrounded:
                sceneWasBackgrounded = false
                if store.relayPushConsentRequest != nil {
                    requestDeferred(.relayConsent)
                }
                consumePendingPrivacyApproval()
            default:
                break
            }
        }
        // Lets a brief's "Ask the agent" button jump into the talk-back
        // conversation: flip to the Agent section FIRST (the drawer's
        // conversation rows use the same ordering — resuming from a
        // non-Agent section would load the transcript off-screen), then
        // resume the thread. A non-nil `autoSendText` (the mic
        // shortcut's dictated question) is sent as the user's first
        // message once the resume lands, so the agent starts answering
        // the moment the user arrives.
        .environment(\.openAgentConversation) { conversationId, autoSendText in
            invalidateAutomaticForegroundWork()
            selection = .agent
            withAnimation(MenuReveal.openCloseAnimation) { menuOpen = false }
            Task {
                await store.agent.resumeConversation(id: conversationId)
                // Send only if the resume actually LANDED on this thread.
                // The surface adopts the target id optimistically (before the
                // transcript loads), so `sessionId == conversationId` alone is
                // true even for a resume that then failed — gate on the
                // absence of a fatal error too, or the dictated question would
                // post into a thread that never loaded.
                if let autoSendText,
                   store.agent.sessionId == conversationId,
                   store.agent.fatalError == nil {
                    await store.agent.send(text: autoSendText)
                }
            }
        }
        // Quick-capture seam: the drawer opens the surface through this
        // action; the Lock Screen / Control Center control lands in
        // `CaptureRouter` and is folded into the same presentation.
        .environment(\.openCapture) {
            invalidateAutomaticForegroundWork()
            captureSurface = .app
            showCapture = true
        }

        .onChange(of: captureRouter.requestCount) { _, _ in
            invalidateAutomaticForegroundWork()
            consumeCaptureRequests()
        }
        .onChange(of: accessAuthorizationRouter.requestCount) { _, _ in
            invalidateAutomaticForegroundWork()
            consumeAccessAuthorizationRequest()
        }
        .onChange(of: store.foregroundConversationRequest) { _, _ in
            consumeForegroundConversationRequest()
        }
        .onChange(of: selection) { _, tab in
            // Picking a destination is leaving capture. The drawer is reachable
            // from it now, so a section chosen there has to actually arrive
            // rather than land behind the capture surface.
            closeCapture()
            store.homeTabChanged(tab)
        }
        .onOpenURL { url in
            handleCaptureURL(url)
        }
        .tint(Theme.accent)
        .omnesisColorScheme()
        .onChange(of: menuOpen) { _, nowOpen in
            if nowOpen {
                UIApplication.shared.sendAction(
                    #selector(UIResponder.resignFirstResponder),
                    to: nil, from: nil, for: nil
                )
            }
        }
        // Push-notification taps land in NotificationRouter. We watch
        // it at the HomeView level and flip the active section to the
        // target's destination BEFORE that section's view consumes the
        // target — otherwise the user lands on whichever section they
        // had open last and the deep link silently goes nowhere. The
        // flip is unconditional: `homeTab(for:)` is total, and never
        // waits on the app's mirror of `/status` (see HomeTab.swift).
        .onAppear {
            // A turn left over from before this view went away ends here.
            store.phoneSetup.settleDeferredPresentations(on: screen)
            // A target can already be pending when this view (re)appears
            // — e.g. it landed while onboarding was still on screen.
            if router.pendingTarget != nil {
                requestDeferred(.pushTarget)
            }
            if store.relayPushConsentRequest != nil {
                requestDeferred(.relayConsent)
            }
            // A capture request can predate this view (cold launch from
            // the Lock Screen / Control Center control) — consume it on
            // first render.
            consumeCaptureRequests()
            consumeAccessAuthorizationRequest()
            consumePendingPrivacyApproval()
            store.homeTabChanged(selection)
            consumeForegroundConversationRequest()
        }
    }

    /// What sits above the section: a waiting access request first, then
    /// the permission and notification problems.
    private var topBanners: some View {
        VStack(spacing: 0) {
            if let offer = accessBannerState.offer(
                from: store.pendingAccessRequests,
                nowMillis: Int64(Date().timeIntervalSince1970 * 1000)
            ) {
                AccessPendingRequestBanner(
                    offer: offer,
                    onReview: { reviewPendingAccessRequest(offer.newest) },
                    onDismiss: {
                        accessBannerState.dismiss(
                            store.pendingAccessRequests,
                            nowMillis: Int64(Date().timeIntervalSince1970 * 1000)
                        )
                    }
                )
            }
            let showNotificationWarning = NotificationWarningDismissal.shouldShowWarning(
                health: store.pushDeliveryHealth,
                dismissed: store.notificationWarningDismissed
            )
            // Gateway push setup is explained in Settings → Notifications, not here:
            // it asks whoever runs the gateway to act, and a banner over every screen
            // hides the controls beneath it.
            if !store.degradedSourcePermissions.isEmpty || showNotificationWarning {
                AppAttentionBanner(
                    problems: store.degradedSourcePermissions,
                    notificationWarning: showNotificationWarning ? store.pushDeliveryHealth.warning : nil,
                    onOpenPermissions: { settingsDestination = .permissions(sourceId: nil) },
                    onOpenNotificationSettings: {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    },
                    onDismissNotification: showNotificationWarning ? { store.dismissNotificationWarning() } : nil
                )
            }
        }
    }

    /// Open the review sheet on a request the banner named, without a code.
    private func reviewPendingAccessRequest(_ request: AccessPendingRequest) {
        invalidateAutomaticForegroundWork()
        // Only one sheet can be up. The owner asked for this one, so a
        // decision that opened itself gives way.
        privacyApprovalPresentation = nil
        accessAuthorizationPresentation = AccessAuthorizationPresentation(
            initialCode: nil,
            requestId: request.id
        )
    }

    private func sourcePermissionDestination(
        sourceId: String,
        affectedDeviceId: String?,
        sourceName: String?,
        affectedDeviceName: String?
    )
        -> SettingsDestination {
        switch SourcePermissionTapRoute.resolve(
            affectedDeviceId: affectedDeviceId,
            currentDeviceId: store.pairing?.deviceId
        ) {
        case .local: .permissions(sourceId: sourceId)
        case .remote:
            .remotePermissions(
                sourceId: sourceId,
                deviceId: affectedDeviceId ?? "unknown-device",
                sourceName: sourceName ?? "Mobile source",
                deviceName: affectedDeviceName
                    ?? affectedDeviceId.flatMap { store.deviceNamesById[$0] }
                    ?? "Another paired device"
            )
        }
    }

    /// Apply one automatic foreground destination. Explicit push/capture
    /// routing already queued at this point wins; a destination arriving
    /// later wins through its existing onChange handler and the coordinator's
    /// explicit-session generation.
    private func consumeForegroundConversationRequest() {
        #if DEBUG
        // Store-artwork and landing-page automation intentionally chooses a
        // section. The normal cold-launch conversation arbiter must not race
        // that explicit DEBUG-only route back to Agent.
        if ProcessInfo.processInfo.environment["DEMO_INITIAL_TAB"] != nil {
            return
        }
        #endif
        guard let request = store.foregroundConversationRequest,
              request.id > consumedForegroundRequest else { return }
        consumedForegroundRequest = request.id
        guard let action = ForegroundNavigationArbiter.automaticAction(
            request.action,
            pushPending: router.pendingTarget != nil,
            capturePending: showCapture || captureRouter.isFresh()
        ) else { return }

        switch action {
        case .preserve:
            return
        case .resume(let id):
            selection = .agent
            automaticForegroundTask?.cancel()
            automaticForegroundTask = Task { @MainActor in
                await Task.yield()
                guard !Task.isCancelled,
                      router.pendingTarget == nil,
                      !showCapture,
                      !captureRouter.isFresh() else { return }
                await store.agent.resumeConversation(id: id)
            }
        case .fresh:
            selection = .agent
            store.agent.newConversation()
            // A focused composer raises the keyboard, so it waits its turn.
            requestDeferred(.composerFocus)
        }
    }

    /// Queue pending `CaptureRouter` requests for the capture surface. A
    /// request's freshness is judged when home first sees it, so one made
    /// while phone setup holds the screen still opens once setup closes, while
    /// a control tap that sat unconsumed (e.g. filed before pairing, seen only
    /// when this view first appears minutes later) never pops up.
    private func consumeCaptureRequests() {
        guard captureRouter.requestCount > consumedCaptureRequests else { return }
        consumedCaptureRequests = captureRouter.requestCount
        guard captureRouter.isFresh() else { return }
        pendingCaptureSurface = NoteSurface(rawValue: captureRouter.lastSurfaceSlug) ?? .app
        requestDeferred(.capture)
    }

    /// Offer the oldest waiting privacy decision, if the app coming to the
    /// foreground is the whole reason it would be seen.
    /// `PrivacyApprovalAutoOpenPolicy` carries the rule. The gate is re-checked
    /// after the ledger read because a notification tap can land while that
    /// request is in flight — and can be consumed by its destination before
    /// the read returns, which is why the router's consumption trace is read
    /// against the moment the lookup began rather than only what is pending.
    private func consumePendingPrivacyApproval() {
        requestDeferred(.privacyApproval)
    }

    /// Starts looking up a waiting decision to offer. Returns whether the
    /// lookup started; it presents the decision when one is confirmed open.
    private func startPrivacyApprovalLookup() -> Bool {
        #if DEBUG
        // Store-artwork and landing-page automation intentionally chooses what
        // is on screen. A decision that opens itself must not race that.
        if ProcessInfo.processInfo.environment["DEMO_INITIAL_TAB"] != nil {
            return false
        }
        #endif
        // How many are waiting is not known until the ledger is read, so the
        // pre-check asks the rest of the question — is this app in a state
        // where a waiting decision could be offered at all — and stands in a
        // count of one until the real number arrives.
        let lookupStartedAt = Date()
        guard !privacyApprovalLookupInFlight,
              autoOpenPrivacyApprovalAllowed(pendingCount: 1, since: lookupStartedAt),
              let client = store.privacy else { return false }
        privacyApprovalLookupInFlight = true
        Task { @MainActor in
            defer { privacyApprovalLookupInFlight = false }
            await store.refreshPrivacyPendingCount()
            // A read that failed says nothing about the backlog, so the next
            // foreground tries again.
            guard let page = try? await client.listApprovals(status: "pending", limit: 1),
                  let waiting = page.approvals.first
            else { return }
            // The row can expire, or be decided from another device, between
            // the ledger read and this moment. Only a review that is confirmed
            // still open is worth putting in front of the owner; anything else
            // is left for a later foreground, which will offer the next one.
            guard let detail = try? await client.getApproval(id: waiting.id),
                  detail.status == .pending,
                  autoOpenPrivacyApprovalAllowed(pendingCount: page.totalCount, since: lookupStartedAt)
            else { return }
            privacyApprovalOffered = true
            privacyApprovalPresentation = PrivacyApprovalPresentation(id: detail.id)
            store.phoneSetup.markDeferredPresenting(.privacyApproval)
            scheduleStalledPresentationCheck()
        }
        return true
    }

    /// `since` is when the current lookup began: a push target consumed after
    /// that moment counts as an explicit destination even though nothing is
    /// pending any more.
    private func autoOpenPrivacyApprovalAllowed(pendingCount: Int, since lookupStartedAt: Date) -> Bool {
        PrivacyApprovalAutoOpenPolicy.shouldPresent(
            pendingCount: pendingCount,
            paired: store.pairing != nil,
            presentedThisSession: privacyApprovalOffered,
            occupancy: PrivacyApprovalAutoOpenPolicy.Occupancy(
                alreadyPresenting: privacyApprovalPresentation != nil
                    || accessAuthorizationPresentation != nil
                    || settingsDestination != nil
                    || store.phoneSetup.isGateActive,
                pushPending: router.pendingTarget != nil,
                pushRoutedMeanwhile: router.consumedSince(lookupStartedAt),
                capturePending: showCapture || captureRouter.isFresh()
            )
        )
    }

    /// `omnesis://capture[?surface=<slug>]` — the deep link the Lock
    /// Screen / Control Center control's `OpenURLIntent` uses. Other
    /// URLs fall through untouched.
    private func handleCaptureURL(_ url: URL) {
        guard url.host == "capture" || url.path == "/capture" else { return }
        invalidateAutomaticForegroundWork()
        let slug = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "surface" })?.value
        pendingCaptureSurface = slug.flatMap(NoteSurface.init(rawValue:)) ?? .control
        requestDeferred(.capture)
    }

    private func invalidateAutomaticForegroundWork() {
        automaticForegroundTask?.cancel()
        automaticForegroundTask = nil
        agentComposerFocusRequest = 0
    }

    @ViewBuilder
    private var sectionContent: some View {
        switch selection {
        case .agent: AgentView(
                menuOpen: $menuOpen,
                composerFocusRequest: agentComposerFocusRequest
            )
        case .search: SearchView(menuOpen: $menuOpen)
        case .sources: SourcesView(menuOpen: $menuOpen)
        case .people: PeopleView(menuOpen: $menuOpen)
        // A standard section, reached from its drawer row or a push deep-link.
        // It mounts without consulting the app's mirror of /status so a queued
        // target lands even while that mirror is unresolved; against a gateway
        // without the routes it renders its own fetch error.
        case .privacy: PrivacyView(menuOpen: $menuOpen)
        case .briefs: BriefsView(menuOpen: $menuOpen)
        // Ungated here even though the drawer row that browses to it is
        // experimental: a push deep-link must land while the app's mirror of
        // /status is unresolved, so the section has to mount to consume the
        // queued target.
        case .watches: WatchesView(menuOpen: $menuOpen)
        }
    }
}
#endif
